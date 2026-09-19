import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { applyFinanceF201Migration } from './financeF201Migration.js';
import { applyFinanceMigrations } from './migrations.js';
import { createFinanceRuntime } from './runtime.js';

const NOW = new Date('2026-08-02T06:00:00.000Z');
const COOKIE_SECRET = 'finance-f201-api-cookie-secret';
const memoryRuntime = () => ({
  initialize: async () => ({ status: 'disabled', pathSummary: 'test-memory.sqlite' }),
  close: async () => {},
  service: {}
});

async function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-f201-api-'));
  const publicDir = path.join(directory, 'public');
  const databasePath = path.join(directory, 'finance.sqlite');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<main>test</main>');
  const schema = new DatabaseSync(databasePath);
  applyFinanceMigrations(schema);
  applyFinanceF201Migration(schema, { clock: () => new Date(NOW) });
  schema.close();
  const financeRuntime = createFinanceRuntime({
    databasePath,
    f201Enabled: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(directory, 'auth.sqlite'),
      cookieSecret: COOKIE_SECRET,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0,
      privacyRequired: false
    },
    aiService: {
      getStatus: () => ({ available: false }),
      run: async () => ({ ok: false }),
      stream: async () => ({ ok: false })
    },
    memoryRuntime: memoryRuntime(),
    conversationRuntime: null,
    financeRuntime
  });
  await instance.auth.createAccount({
    username: 'owner_a', displayName: 'Owner A', password: 'PasswordA1!',
    role: 'beta_user', quotaProfileId: 'closed_beta_user_v1'
  });
  await instance.auth.createAccount({
    username: 'owner_b', displayName: 'Owner B', password: 'PasswordB1!',
    role: 'beta_user', quotaProfileId: 'closed_beta_user_v1'
  });
  const ownerA = await instance.auth.login({ username: 'owner_a', password: 'PasswordA1!' });
  const ownerB = await instance.auth.login({ username: 'owner_b', password: 'PasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    directory,
    instance,
    financeRuntime,
    ownerA,
    ownerB,
    url: `http://127.0.0.1:${instance.server.address().port}`,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function request(h, pathname, cookie = '', options = {}) {
  return fetch(`${h.url}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...options.headers
    }
  });
}

function createExpense(h, ownerId, mutationRequestId, amountMinor = 1800) {
  return h.financeRuntime.repository.create({
    ownerId,
    mutationRequestId,
    type: 'expense',
    amountMinor,
    currency: 'CNY',
    occurredAt: NOW.toISOString(),
    timezone: 'Asia/Shanghai',
    category: '餐饮',
    note: '早餐',
    sourceMessageId: `source-${mutationRequestId}`
  });
}

function mutation(method, idempotencyKey, expectedVersion, body = {}) {
  return {
    method,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ ...body, expectedVersion })
  };
}

test('F2.0-1 history API requires authentication and binds owner identity to the Session', async () => {
  const h = await harness();
  try {
    const entryA = createExpense(h, h.ownerA.user.id, 'create-owner-a');
    createExpense(h, h.ownerB.user.id, 'create-owner-b', 9900);

    assert.equal((await request(h, '/api/finance/entries?period=all_time')).status, 401);
    const history = await request(
      h,
      `/api/finance/entries?period=all_time&ownerId=${encodeURIComponent(h.ownerB.user.id)}`,
      h.ownerA.setCookie
    );
    assert.equal(history.status, 200);
    const payload = await history.json();
    assert.deepEqual(payload.entries.map((entry) => entry.id), [entryA.id]);

    assert.equal((await request(h, `/api/finance/entries/${entryA.id}`, h.ownerB.setCookie)).status, 404);
    assert.equal((await request(h, `/api/finance/entries/${entryA.id}/revisions`, h.ownerB.setCookie)).status, 404);
    const forgedPatch = await request(
      h,
      `/api/finance/entries/${entryA.id}`,
      h.ownerB.setCookie,
      mutation('PATCH', 'forged-owner-update', 1, {
        ownerId: h.ownerA.user.id,
        amountMinor: 1
      })
    );
    assert.equal(forgedPatch.status, 404);
    assert.equal(
      h.financeRuntime.repository.get({ ownerId: h.ownerA.user.id, id: entryA.id }).amountMinor,
      1800
    );
  } finally {
    await h.close();
  }
});

test('F2.0-1 lifecycle APIs expose Revisions, idempotent replay, and deterministic report membership', async () => {
  const h = await harness();
  try {
    const created = createExpense(h, h.ownerA.user.id, 'create-lifecycle');
    const updateRequest = mutation('PATCH', 'api-update-1', 1, {
      amountMinor: 2400,
      category: '餐饮',
      note: '早餐和咖啡',
      ownerId: h.ownerB.user.id
    });
    const updated = await request(h, `/api/finance/entries/${created.id}`, h.ownerA.setCookie, updateRequest);
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).entry.version, 2);

    const replay = await request(h, `/api/finance/entries/${created.id}`, h.ownerA.setCookie, updateRequest);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).entry.version, 2);

    const revisionsAfterUpdate = await request(
      h,
      `/api/finance/entries/${created.id}/revisions`,
      h.ownerA.setCookie
    );
    assert.equal(revisionsAfterUpdate.status, 200);
    const revisionPayload = await revisionsAfterUpdate.json();
    assert.equal(revisionPayload.revisions.length, 1);
    assert.equal(revisionPayload.revisions[0].mutationType, 'update');
    assert.equal(revisionPayload.revisions[0].before.amountMinor, 1800);
    assert.equal(revisionPayload.revisions[0].after.amountMinor, 2400);

    const archived = await request(
      h,
      `/api/finance/entries/${created.id}/archive`,
      h.ownerA.setCookie,
      mutation('POST', 'api-archive-1', 2)
    );
    assert.equal(archived.status, 200);
    assert.equal((await archived.json()).entry.version, 3);
    const overviewWhileArchived = await request(h, '/api/finance/overview', h.ownerA.setCookie);
    assert.equal((await overviewWhileArchived.json()).summary.expenseMinor, 2400);
    assert.equal(h.financeRuntime.repository.buildMonthlyReportSnapshot({
      ownerId: h.ownerA.user.id, timezone: 'Asia/Shanghai', now: NOW
    }).totals.expenseMinor, 2400);

    const deleted = await request(
      h,
      `/api/finance/entries/${created.id}`,
      h.ownerA.setCookie,
      mutation('DELETE', 'api-delete-1', 3)
    );
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).entry.status, 'deleted');
    const overviewWhileDeleted = await request(h, '/api/finance/overview', h.ownerA.setCookie);
    assert.equal((await overviewWhileDeleted.json()).summary.expenseMinor, 0);
    assert.equal(h.financeRuntime.repository.buildMonthlyReportSnapshot({
      ownerId: h.ownerA.user.id, timezone: 'Asia/Shanghai', now: NOW
    }).totals.expenseMinor, 0);

    const restored = await request(
      h,
      `/api/finance/entries/${created.id}/restore`,
      h.ownerA.setCookie,
      mutation('POST', 'api-restore-1', 4)
    );
    assert.equal(restored.status, 200);
    const restoredEntry = (await restored.json()).entry;
    assert.equal(restoredEntry.status, 'active');
    assert.ok(restoredEntry.archivedAt);

    const unarchived = await request(
      h,
      `/api/finance/entries/${created.id}/unarchive`,
      h.ownerA.setCookie,
      mutation('POST', 'api-unarchive-1', 5)
    );
    assert.equal(unarchived.status, 200);
    assert.equal((await unarchived.json()).entry.archivedAt, null);
    const overviewAfterRestore = await request(h, '/api/finance/overview', h.ownerA.setCookie);
    assert.equal((await overviewAfterRestore.json()).summary.expenseMinor, 2400);
  } finally {
    await h.close();
  }
});

test('F2.0-1 lifecycle APIs map version and idempotency conflicts to 409', async () => {
  const h = await harness();
  try {
    const created = createExpense(h, h.ownerA.user.id, 'create-conflicts');
    const missingIdempotencyKey = await request(
      h,
      `/api/finance/entries/${created.id}`,
      h.ownerA.setCookie,
      { method: 'PATCH', body: JSON.stringify({ expectedVersion: 1, amountMinor: 1900 }) }
    );
    assert.equal(missingIdempotencyKey.status, 400);
    assert.equal((await missingIdempotencyKey.json()).code, 'MUTATION_REQUEST_ID_REQUIRED');

    const first = await request(
      h,
      `/api/finance/entries/${created.id}`,
      h.ownerA.setCookie,
      mutation('PATCH', 'api-conflict-key', 1, { amountMinor: 2000 })
    );
    assert.equal(first.status, 200);

    const stale = await request(
      h,
      `/api/finance/entries/${created.id}`,
      h.ownerA.setCookie,
      mutation('PATCH', 'api-stale-key', 1, { amountMinor: 2100 })
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'FINANCE_VERSION_CONFLICT');

    const changedReplay = await request(
      h,
      `/api/finance/entries/${created.id}`,
      h.ownerA.setCookie,
      mutation('PATCH', 'api-conflict-key', 1, { amountMinor: 9900 })
    );
    assert.equal(changedReplay.status, 409);
    assert.equal((await changedReplay.json()).code, 'FINANCE_IDEMPOTENCY_CONFLICT');
  } finally {
    await h.close();
  }
});

test('F2.0-1 API returns a sanitized 503 when repository storage fails', async () => {
  const h = await harness();
  try {
    h.financeRuntime.repository.queryHistory = () => {
      throw new Error('private sqlite /opt/finance.sqlite');
    };
    const response = await request(h, '/api/finance/entries?period=all_time', h.ownerA.setCookie);
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.doesNotMatch(JSON.stringify(payload), /sqlite|\/opt\/|private/i);
  } finally {
    await h.close();
  }
});
