import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createConversationRuntime } from '../conversation/runtime.js';
import {
  createMockStreamingAiService,
  createMockStreamingProvider
} from '../conversation/testing/mockStreamingProvider.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { createTasksRuntime } from '../tasks/runtime.js';
import { normalizePrivacyPolicy } from './privacyPolicy.js';
import { PrivacyStore } from './privacyStore.js';

const COOKIE_SECRET = 'privacy-http-test-secret-longer-than-32-bytes';
const PRIVACY_VERSION = 'closed-beta-privacy-v1';
const TERMS_VERSION = 'closed-beta-terms-v1';

function seedInvalidatedExport(lifecycle, { id, ownerId, filePath, tokenHash }) {
  const createdAt = '2026-07-29T09:00:00.000Z';
  lifecycle.store.database.prepare(`
    INSERT INTO privacy_export_grants (
      id, owner_id, token_hash, file_path, created_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(id, ownerId, tokenHash, filePath, createdAt, '2026-07-30T09:00:00.000Z');
  lifecycle.store.database.prepare(`
    INSERT INTO privacy_export_invalidations (
      export_id, owner_id, invalidated_at, reason_code, file_path_snapshot
    ) VALUES (?, ?, ?, ?, ?)
  `).run(id, ownerId, createdAt, 'LEGACY_EXPORT_PATH_OUTSIDE_DIRECTORY', filePath);
}

function jsonHeaders(cookie = '') {
  return {
    ...(cookie ? { cookie } : {}),
    'content-type': 'application/json'
  };
}

async function request(baseUrl, pathname, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: jsonHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    response,
    status: response.status,
    body: contentType.includes('application/json') ? await response.json() : await response.text()
  };
}

function createMemoryFixture() {
  const owners = new Map();
  const caches = new Set();
  return {
    seed(ownerId, label) {
      owners.set(ownerId, {
        entities: [{ entityId: `entity-${label}`, ownerUserId: ownerId, type: 'person' }],
        aliases: [{ alias: label, ownerUserId: ownerId }],
        relations: [{ relationId: `relation-${label}`, ownerUserId: ownerId, role: 'mother' }],
        allMemories: [{
          memoryId: `memory-${label}`,
          ownerUserId: ownerId,
          predicate: 'birthday',
          status: 'confirmed',
          structuredValue: { calendar_type: 'gregorian', date: { month: 7, day: 29 } },
          source: { type: 'conversation', id: `source-${label}` }
        }],
        currentMemories: []
      });
      owners.get(ownerId).currentMemories = [...owners.get(ownerId).allMemories];
      caches.add(ownerId);
    },
    exportOwner(ownerId) {
      return structuredClone(owners.get(ownerId) || {
        entities: [], aliases: [], relations: [], allMemories: [], currentMemories: []
      });
    },
    deleteOwner(ownerId) {
      owners.delete(ownerId);
      caches.delete(ownerId);
      return { deleted: true };
    },
    verifyOwnerDeleted(ownerId) {
      return !owners.has(ownerId) && !caches.has(ownerId);
    },
    inspectOwner(ownerId) {
      const value = owners.get(ownerId);
      return value || { entities: [], allMemories: [], currentMemories: [] };
    },
    close() {}
  };
}

async function createHarness({
  privacyVersion = PRIVACY_VERSION,
  termsVersion = TERMS_VERSION,
  privacyDb,
  exportTtlMs = 60_000,
  memory = createMemoryFixture(),
  financeRuntime: financeOverride
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'closed-beta-p0-b1-'));
  const provider = createMockStreamingProvider({ chunks: ['同意后可用'] });
  const financeRuntime = financeOverride || createFinanceRuntime({
    databasePath: path.join(directory, 'finance.sqlite'),
    applyMigrations: true
  });
  const conversationRuntime = createConversationRuntime({
    databasePath: path.join(directory, 'conversations.sqlite'),
    aiService: createMockStreamingAiService(provider),
    applyMigrations: true,
    financeIntegration: financeRuntime.service
  });
  const tasksRuntime = createTasksRuntime({
    databasePath: path.join(directory, 'tasks.sqlite'),
    applyMigrations: true,
    clock: () => new Date('2026-07-29T10:00:00.000Z')
  });
  const instance = await createBetaServer({
    config: {
      publicDir: path.join(directory, 'public'),
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access-control.sqlite'),
      conversationDb: path.join(directory, 'unused-conversation.sqlite'),
      financeDb: path.join(directory, 'unused-finance.sqlite'),
      privacyDb: privacyDb || path.join(directory, 'privacy.sqlite'),
      privacyExportDir: path.join(directory, 'privacy-exports'),
      privacyExportTtlMs: exportTtlMs,
      privacyRequired: true,
      privacyNotice: {
        privacyNoticeVersion: privacyVersion,
        termsVersion,
        locale: 'zh-CN',
        retentionDays: 30,
        contact: 'privacy@example.test'
      },
      cookieSecret: COOKIE_SECRET,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0
    },
    aiService: {
      getStatus: () => ({ available: true }),
      getAdminSettings: () => ({ providers: [] })
    },
    memoryRuntime: {
      initialize: async () => ({ status: 'disabled', pathSummary: 'test' }),
      close: async () => {},
      service: {}
    },
    protectedMemoryRuntime: memory,
    conversationRuntime,
    financeRuntime,
    tasksRuntime
  });
  const accountA = await instance.auth.createAccount({
    username: 'privacy_a',
    displayName: 'Privacy A',
    password: 'PrivacyPasswordA1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const accountB = await instance.auth.createAccount({
    username: 'privacy_b',
    displayName: 'Privacy B',
    password: 'PrivacyPasswordB1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  memory.seed(accountA.id, 'A');
  memory.seed(accountB.id, 'B');
  const loginA = await instance.auth.login({ username: 'privacy_a', password: 'PrivacyPasswordA1!' });
  const loginB = await instance.auth.login({ username: 'privacy_b', password: 'PrivacyPasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    directory,
    provider,
    memory,
    financeRuntime,
    instance,
    accountA,
    accountB,
    loginA,
    loginB,
    baseUrl: `http://127.0.0.1:${instance.server.address().port}`,
    async accept(cookie, overrides = {}) {
      return request(this.baseUrl, '/api/privacy/consent', {
        method: 'POST',
        cookie,
        body: {
          accepted: true,
          privacyNoticeVersion: privacyVersion,
          termsVersion,
          locale: 'zh-CN',
          source: 'first_login',
          ...overrides
        }
      });
    },
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      financeRuntime.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test('RED: versioned explicit consent gates Finance writes and Provider calls with owner isolation', async () => {
  const h = await createHarness();
  try {
    const notice = await request(h.baseUrl, '/api/privacy/notice');
    assert.equal(notice.status, 200);
    assert.equal(notice.body.closedBeta, true);
    assert.match(notice.body.storage, /VPS/i);
    assert.match(notice.body.prohibitedSensitiveData, /API Key|银行卡/);

    const rejected = await request(h.baseUrl, '/api/ai/chat/stream', {
      method: 'POST',
      cookie: h.loginA.setCookie,
      body: { message: '早餐14元', clientRequestId: 'privacy-before-consent' }
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.code, 'PRIVACY_CONSENT_REQUIRED');
    assert.equal(h.provider.calls, 0);
    assert.equal(h.financeRuntime.repository.list({ ownerId: h.accountA.id }).length, 0);

    const accepted = await h.accept(h.loginA.setCookie, { userId: h.accountB.id });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.consent.userId, h.accountA.id);
    assert.equal(accepted.body.consent.status, 'accepted');
    assert.equal(accepted.body.consent.acceptedAt.endsWith('Z'), true);

    const own = await request(h.baseUrl, `/api/privacy/consent?userId=${encodeURIComponent(h.accountB.id)}`, {
      cookie: h.loginA.setCookie
    });
    assert.equal(own.body.consent.userId, h.accountA.id);
    const other = await request(h.baseUrl, '/api/privacy/consent', { cookie: h.loginB.setCookie });
    assert.equal(other.body.consent.status, 'pending');

    const allowed = await request(h.baseUrl, '/api/ai/chat/stream', {
      method: 'POST',
      cookie: h.loginA.setCookie,
      body: { message: '同意后可以发送', clientRequestId: 'privacy-after-consent' }
    });
    assert.equal(allowed.status, 200);
    assert.equal(h.provider.calls, 1);

    const withdrawn = await request(h.baseUrl, '/api/privacy/consent/withdraw', {
      method: 'POST',
      cookie: h.loginA.setCookie,
      body: { source: 'settings' }
    });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.consent.status, 'pending');
    const afterWithdrawal = await request(h.baseUrl, '/api/ai/chat/stream', {
      method: 'POST',
      cookie: h.loginA.setCookie,
      body: { message: '撤回后不能发送', clientRequestId: 'privacy-after-withdrawal' }
    });
    assert.equal(afterWithdrawal.status, 403);
    assert.equal(h.provider.calls, 1);
  } finally {
    await h.close();
  }
});

test('RED: policy version upgrade requires a fresh explicit acceptance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'privacy-version-upgrade-'));
  const privacyDb = path.join(directory, 'privacy.sqlite');
  const v1 = normalizePrivacyPolicy({
    privacyNoticeVersion: 'privacy-v1',
    termsVersion: 'terms-v1',
    locale: 'zh-CN',
    retentionDays: 30,
    contact: 'privacy@example.test'
  });
  const first = new PrivacyStore({ dbPath: privacyDb, policy: v1 }).initialize();
  try {
    first.acceptConsent({
      ownerId: 'owner-versioned',
      privacyNoticeVersion: 'privacy-v1',
      termsVersion: 'terms-v1',
      locale: 'zh-CN',
      source: 'first_login'
    });
    assert.equal(first.getConsent('owner-versioned').status, 'accepted');
  } finally {
    first.close();
  }
  const second = new PrivacyStore({
    dbPath: privacyDb,
    policy: normalizePrivacyPolicy({
      privacyNoticeVersion: 'privacy-v2',
      termsVersion: 'terms-v2',
      locale: 'zh-CN',
      retentionDays: 30,
      contact: 'privacy@example.test'
    })
  }).initialize();
  try {
    const status = second.getConsent('owner-versioned');
    assert.equal(status.status, 'pending');
    assert.equal(status.current, false);
    assert.equal(status.privacyNoticeVersion, 'privacy-v2');
    assert.equal(second.listConsents('owner-versioned')[0].privacyNoticeVersion, 'privacy-v1');
  } finally {
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('RED: authenticated export is allowlisted, owner-scoped, mode 0600, one-time and expiring', async () => {
  const h = await createHarness({ exportTtlMs: 1_000 });
  let privacyNowMs = Date.parse('2026-07-29T10:00:00.000Z');
  const privacyClock = () => new Date(privacyNowMs).toISOString();
  h.instance.privacyLifecycle.now = privacyClock;
  h.instance.privacyLifecycle.store.now = privacyClock;
  try {
    await h.accept(h.loginA.setCookie);
    await h.accept(h.loginB.setCookie);
    const conversationA = h.instance.conversationRuntime.conversations.createForOwner(h.accountA.id, { title: 'A私有对话' });
    h.instance.conversationRuntime.messages.createUserMessage({
      ownerId: h.accountA.id,
      conversationId: conversationA.id,
      content: 'A完整Prompt',
      clientRequestId: 'export-a'
    });
    const conversationB = h.instance.conversationRuntime.conversations.createForOwner(h.accountB.id, { title: 'B绝密对话' });
    h.instance.conversationRuntime.messages.createUserMessage({
      ownerId: h.accountB.id,
      conversationId: conversationB.id,
      content: 'B绝密内容',
      clientRequestId: 'export-b'
    });
    h.instance.financeRuntime.repository.create({
      ownerId: h.accountA.id,
      type: 'expense',
      amountMinor: 2900,
      occurredAt: '2026-07-29T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      category: '餐饮',
      sourceMessageId: 'source-finance-a',
      clientRequestId: 'finance-a'
    });
    h.instance.tasksRuntime.service.create(h.accountA.id, {
      title: 'A导出事项',
      scheduledAt: '2026-07-30T03:00:00.000Z',
      timezone: 'Asia/Shanghai'
    });
    h.instance.tasksRuntime.service.create(h.accountB.id, {
      title: 'B私有事项',
      scheduledAt: '2026-07-30T04:00:00.000Z',
      timezone: 'Asia/Shanghai'
    });
    h.instance.privacyLifecycle.recordGeneratedReport({
      ownerId: h.accountA.id,
      reportType: 'monthly_finance',
      format: 'pdf',
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z'
    });

    const created = await request(h.baseUrl, '/api/privacy/exports', {
      method: 'POST',
      cookie: h.loginA.setCookie,
      body: { userId: h.accountB.id, ownerId: h.accountB.id }
    });
    assert.equal(created.status, 201);
    assert.match(created.body.downloadUrl, /^\/api\/privacy\/exports\/download\//);
    const files = await readdir(path.join(h.directory, 'privacy-exports'));
    assert.equal(files.length, 1);
    assert.equal((await stat(path.join(h.directory, 'privacy-exports', files[0]))).mode & 0o777, 0o600);

    const denied = await request(h.baseUrl, created.body.downloadUrl, { cookie: h.loginB.setCookie });
    assert.equal(denied.status, 404);
    const downloaded = await request(h.baseUrl, created.body.downloadUrl, { cookie: h.loginA.setCookie });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.body.account.id, h.accountA.id);
    assert.equal(downloaded.body.conversations[0].messages[0].content, 'A完整Prompt');
    assert.equal(downloaded.body.finance.entries[0].amountMinor, 2900);
    assert.equal(downloaded.body.tasks.length, 1);
    assert.equal(downloaded.body.tasks[0].title, 'A导出事项');
    assert.equal(JSON.stringify(downloaded.body.tasks).includes('B私有事项'), false);
    assert.equal(downloaded.body.memory.current[0].predicate, 'birthday');
    assert.equal(downloaded.body.calendar.birthdayEvidence[0].predicate, 'birthday');
    assert.equal(downloaded.body.generatedReports[0].format, 'pdf');
    assert.equal(downloaded.body.quotaUsage.account.accountId, h.accountA.id);
    assert.equal(downloaded.body.conversations.some((item) => JSON.stringify(item).includes('B绝密内容')), false);
    assert.doesNotMatch(JSON.stringify(downloaded.body), /passwordHash|apiKey|cookie|sessionToken|providerCredential|KEK/i);
    assert.equal((await request(h.baseUrl, created.body.downloadUrl, { cookie: h.loginA.setCookie })).status, 410);

    const expiring = await request(h.baseUrl, '/api/privacy/exports', {
      method: 'POST',
      cookie: h.loginA.setCookie
    });
    privacyNowMs += 1_001;
    assert.equal((await request(h.baseUrl, expiring.body.downloadUrl, { cookie: h.loginA.setCookie })).status, 410);
  } finally {
    await h.close();
  }
});

test('RED: two-phase deletion revokes sessions, deletes every online domain, preserves B and writes a signed tombstone', async () => {
  const h = await createHarness();
  try {
    await h.accept(h.loginA.setCookie);
    await h.accept(h.loginB.setCookie);
    const conversationA = h.instance.conversationRuntime.conversations.createForOwner(h.accountA.id);
    h.instance.conversationRuntime.messages.createUserMessage({
      ownerId: h.accountA.id,
      conversationId: conversationA.id,
      content: '删除我的A内容',
      clientRequestId: 'delete-a'
    });
    const conversationB = h.instance.conversationRuntime.conversations.createForOwner(h.accountB.id);
    h.instance.conversationRuntime.messages.createUserMessage({
      ownerId: h.accountB.id,
      conversationId: conversationB.id,
      content: '保留B内容',
      clientRequestId: 'keep-b'
    });
    h.instance.financeRuntime.repository.create({
      ownerId: h.accountA.id,
      type: 'expense',
      amountMinor: 100,
      occurredAt: '2026-07-29T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      category: '餐饮',
      sourceMessageId: 'delete-finance-a',
      clientRequestId: 'delete-finance-a'
    });
    h.instance.financeRuntime.repository.create({
      ownerId: h.accountB.id,
      type: 'income',
      amountMinor: 200,
      occurredAt: '2026-07-29T11:00:00.000Z',
      timezone: 'Asia/Shanghai',
      category: '其他收入',
      sourceMessageId: 'keep-finance-b',
      clientRequestId: 'keep-finance-b'
    });
    h.instance.tasksRuntime.service.create(h.accountA.id, {
      title: '删除A事项',
      scheduledAt: '2026-07-30T03:00:00.000Z',
      timezone: 'Asia/Shanghai'
    });
    h.instance.tasksRuntime.service.create(h.accountB.id, {
      title: '保留B事项',
      scheduledAt: '2026-07-30T04:00:00.000Z',
      timezone: 'Asia/Shanghai'
    });
    const oldExport = await request(h.baseUrl, '/api/privacy/exports', {
      method: 'POST',
      cookie: h.loginA.setCookie
    });
    assert.equal(oldExport.status, 201);

    const initiated = await request(h.baseUrl, '/api/privacy/deletion-requests', {
      method: 'POST',
      cookie: h.loginA.setCookie
    });
    assert.equal(initiated.status, 201);
    assert.equal(initiated.body.impact.conversations, true);
    assert.equal(initiated.body.impact.tasks, true);
    assert.equal(initiated.body.impact.backups, 'tombstone_pending_physical_cleanup');

    const completed = await request(h.baseUrl, '/api/privacy/deletion-requests/confirm', {
      method: 'POST',
      cookie: h.loginA.setCookie,
      body: {
        confirmationToken: initiated.body.confirmationToken,
        confirmation: 'DELETE_MY_ACCOUNT',
        userId: h.accountB.id
      }
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, 'completed');
    assert.match(completed.body.receiptId, /^del_/);

    assert.equal((await request(h.baseUrl, '/api/auth/me', { cookie: h.loginA.setCookie })).status, 401);
    assert.equal((await request(h.baseUrl, oldExport.body.downloadUrl, { cookie: h.loginA.setCookie })).status, 401);
    assert.equal((await request(h.baseUrl, '/api/auth/me', { cookie: h.loginB.setCookie })).status, 200);
    assert.equal((await request(h.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'privacy_a', password: 'PrivacyPasswordA1!' }
    })).status, 401);
    assert.equal(h.instance.conversationRuntime.conversations.listForOwner(h.accountA.id).length, 0);
    assert.equal(h.instance.conversationRuntime.conversations.listForOwner(h.accountB.id).length, 1);
    assert.equal(h.instance.financeRuntime.repository.list({ ownerId: h.accountA.id, includeDeleted: true }).length, 0);
    assert.equal(h.instance.financeRuntime.repository.list({ ownerId: h.accountB.id, includeDeleted: true }).length, 1);
    assert.equal(h.instance.tasksRuntime.repository.exportForOwner(h.accountA.id).length, 0);
    assert.equal(h.instance.tasksRuntime.repository.exportForOwner(h.accountB.id).length, 1);
    assert.equal(h.memory.verifyOwnerDeleted(h.accountA.id), true);
    assert.equal(h.memory.verifyOwnerDeleted(h.accountB.id), false);
    assert.equal(h.instance.accessControlStore.getAccountAccess(h.accountA.id), null);

    const tombstones = h.instance.privacyLifecycle.listDeletionReceipts();
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].status, 'completed');
    assert.ok(tombstones[0].subjectRef);
    assert.ok(tombstones[0].signature);
    assert.equal(JSON.stringify(tombstones[0]).includes(h.accountA.id), false);

    const replay = await h.instance.privacyLifecycle.executeDeletion({
      ownerId: h.accountA.id,
      confirmationToken: initiated.body.confirmationToken
    });
    assert.equal(replay.receiptId, completed.body.receiptId);
  } finally {
    await h.close();
  }
});

test('RED: a deletion step failure never returns completed and leaves a durable retryable failure state', async () => {
  const h = await createHarness();
  try {
    await h.accept(h.loginA.setCookie);
    const initiated = await request(h.baseUrl, '/api/privacy/deletion-requests', {
      method: 'POST',
      cookie: h.loginA.setCookie
    });
    h.instance.financeRuntime.repository.deleteAllForOwner = () => {
      throw Object.assign(new Error('injected finance deletion failure'), { code: 'FINANCE_DELETE_FAILED' });
    };
    const failed = await request(h.baseUrl, '/api/privacy/deletion-requests/confirm', {
      method: 'POST',
      cookie: h.loginA.setCookie,
      body: {
        confirmationToken: initiated.body.confirmationToken,
        confirmation: 'DELETE_MY_ACCOUNT'
      }
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, 'DELETION_NOT_COMPLETED');
    assert.equal(JSON.stringify(failed.body).includes('completed'), false);
    assert.equal((await request(h.baseUrl, '/api/auth/me', { cookie: h.loginA.setCookie })).status, 401);
    assert.equal((await request(h.baseUrl, '/api/auth/me', { cookie: h.loginB.setCookie })).status, 200);
    const row = h.instance.privacyLifecycle.store.database.prepare(
      'SELECT status, failure_code FROM deletion_requests WHERE id = ?'
    ).get(initiated.body.ok ? h.instance.privacyLifecycle.store.database.prepare(
      'SELECT id FROM deletion_requests ORDER BY created_at DESC LIMIT 1'
    ).get().id : '');
    assert.deepEqual({ ...row }, { status: 'failed', failure_code: 'FINANCE_DELETE_FAILED' });
    assert.equal(h.instance.privacyLifecycle.listDeletionReceipts().length, 0);
  } finally {
    await h.close();
  }
});

test('owner deletion removes only that owner invalid legacy export metadata without touching unsafe files', async () => {
  const h = await createHarness();
  const unsafeA = path.join(h.directory, 'unsafe-a.json');
  const unsafeB = path.join(h.directory, 'unsafe-b.json');
  try {
    await writeFile(unsafeA, 'unsafe-a-must-remain', { mode: 0o600 });
    await writeFile(unsafeB, 'unsafe-b-must-remain', { mode: 0o600 });
    seedInvalidatedExport(h.instance.privacyLifecycle, {
      id: 'invalid-a', ownerId: h.accountA.id, filePath: unsafeA, tokenHash: 'invalid-token-a'
    });
    seedInvalidatedExport(h.instance.privacyLifecycle, {
      id: 'invalid-b', ownerId: h.accountB.id, filePath: unsafeB, tokenHash: 'invalid-token-b'
    });
    await h.accept(h.loginA.setCookie);
    const initiated = await request(h.baseUrl, '/api/privacy/deletion-requests', {
      method: 'POST', cookie: h.loginA.setCookie
    });
    const completed = await request(h.baseUrl, '/api/privacy/deletion-requests/confirm', {
      method: 'POST', cookie: h.loginA.setCookie,
      body: { confirmationToken: initiated.body.confirmationToken, confirmation: 'DELETE_MY_ACCOUNT' }
    });
    assert.equal(completed.status, 200);
    const database = h.instance.privacyLifecycle.store.database;
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM privacy_export_grants WHERE owner_id = ?'
    ).get(h.accountA.id).count, 0);
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM privacy_export_invalidations WHERE owner_id = ?'
    ).get(h.accountA.id).count, 0);
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM privacy_export_grants WHERE owner_id = ?'
    ).get(h.accountB.id).count, 1);
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM privacy_export_invalidations WHERE owner_id = ?'
    ).get(h.accountB.id).count, 1);
    assert.equal(await readFile(unsafeA, 'utf8'), 'unsafe-a-must-remain');
    assert.equal(await readFile(unsafeB, 'utf8'), 'unsafe-b-must-remain');
  } finally {
    await h.close();
  }
});

test('account deletion cannot report completed while invalid legacy export metadata remains', async () => {
  const h = await createHarness();
  const unsafeA = path.join(h.directory, 'unsafe-a-residual.json');
  try {
    await writeFile(unsafeA, 'unsafe-a-residual-must-remain', { mode: 0o600 });
    seedInvalidatedExport(h.instance.privacyLifecycle, {
      id: 'invalid-a-residual', ownerId: h.accountA.id, filePath: unsafeA, tokenHash: 'invalid-token-a-residual'
    });
    await h.accept(h.loginA.setCookie);
    const initiated = await request(h.baseUrl, '/api/privacy/deletion-requests', {
      method: 'POST', cookie: h.loginA.setCookie
    });
    const originalDelete = h.instance.privacyLifecycle.store.deleteOwnerPrivacyData.bind(
      h.instance.privacyLifecycle.store
    );
    h.instance.privacyLifecycle.store.deleteOwnerPrivacyData = (ownerId) => {
      originalDelete(ownerId);
      if (ownerId !== h.accountA.id) return;
      seedInvalidatedExport(h.instance.privacyLifecycle, {
        id: 'invalid-a-residual', ownerId: h.accountA.id,
        filePath: unsafeA, tokenHash: 'invalid-token-a-residual'
      });
    };
    const failed = await request(h.baseUrl, '/api/privacy/deletion-requests/confirm', {
      method: 'POST', cookie: h.loginA.setCookie,
      body: { confirmationToken: initiated.body.confirmationToken, confirmation: 'DELETE_MY_ACCOUNT' }
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, 'DELETION_NOT_COMPLETED');
    assert.equal(h.instance.privacyLifecycle.listDeletionReceipts().length, 0);
    assert.equal(await readFile(unsafeA, 'utf8'), 'unsafe-a-residual-must-remain');
  } finally {
    await h.close();
  }
});

test('account deletion cannot report completed while only an orphan export binding remains', async () => {
  const h = await createHarness();
  try {
    await h.accept(h.loginA.setCookie);
    const initiated = await request(h.baseUrl, '/api/privacy/deletion-requests', {
      method: 'POST', cookie: h.loginA.setCookie
    });
    const originalDelete = h.instance.privacyLifecycle.store.deleteOwnerPrivacyData.bind(
      h.instance.privacyLifecycle.store
    );
    h.instance.privacyLifecycle.store.deleteOwnerPrivacyData = (ownerId) => {
      originalDelete(ownerId);
      if (ownerId !== h.accountA.id) return;
      h.instance.privacyLifecycle.store.database.prepare(`
        INSERT INTO privacy_export_file_bindings (
          export_id, owner_id, file_path, file_dev, file_ino,
          file_nlink, file_realpath, created_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        'orphan-binding-a', h.accountA.id, path.join(h.directory, 'orphan-a.json'),
        '1', '2', path.join(h.directory, 'orphan-a.json'), '2026-07-29T09:00:00.000Z'
      );
    };

    const failed = await request(h.baseUrl, '/api/privacy/deletion-requests/confirm', {
      method: 'POST', cookie: h.loginA.setCookie,
      body: { confirmationToken: initiated.body.confirmationToken, confirmation: 'DELETE_MY_ACCOUNT' }
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, 'DELETION_NOT_COMPLETED');
    assert.equal(h.instance.privacyLifecycle.listDeletionReceipts().length, 0);
    assert.equal(h.instance.privacyLifecycle.store.database.prepare(
      'SELECT COUNT(*) AS count FROM privacy_export_file_bindings WHERE owner_id = ?'
    ).get(h.accountA.id).count, 1);
  } finally {
    await h.close();
  }
});
