import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import ExcelJS from 'exceljs';

import { createBetaServer } from '../betaServer.js';
import { createFinanceRuntime } from './runtime.js';

const COOKIE_SECRET = 'finance-api-test-cookie-secret-32';
const memoryRuntime = () => ({ initialize: async () => ({ status: 'disabled', pathSummary: 'test-memory.sqlite' }), close: async () => {}, service: {} });
const unavailableAiService = {
  getStatus: () => ({ available: false }),
  run: async () => ({ ok: false }),
  stream: async () => ({ ok: false })
};

function startupConfig(directory, financeF201Enabled) {
  return {
    publicDir: path.join(directory, 'public'),
    authDb: path.join(directory, 'auth.sqlite'),
    financeDb: path.join(directory, 'finance.sqlite'),
    financeTimezone: 'Asia/Shanghai',
    financeF201Enabled,
    conversationDb: null,
    tasksDb: null,
    attachmentsDb: null,
    attachmentStorageRoot: null,
    privacyRequired: false,
    cookieSecret: COOKIE_SECRET,
    secureCookie: false,
    host: '127.0.0.1',
    port: 0
  };
}

function closeUnstartedServer(instance) {
  if (!instance) return;
  instance.auth.close();
  instance.server.emit('close');
}

async function captureStartup(config) {
  try {
    const instance = await createBetaServer({
      config,
      aiService: unavailableAiService,
      memoryRuntime: memoryRuntime(),
      conversationRuntime: null,
      tasksRuntime: null,
      attachmentRuntime: null
    });
    return { instance, error: null };
  } catch (error) {
    return { instance: null, error };
  }
}

test('Finance flag disabled preserves the Generation 154 automatic v1 startup path', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-finance-flag-off-'));
  let instance = null;
  try {
    const result = await captureStartup(startupConfig(directory, false));
    instance = result.instance;
    assert.equal(result.error, null);
    assert.ok(instance?.financeRuntime);
    assert.equal(
      instance.financeRuntime.database.prepare('SELECT MAX(version) AS version FROM finance_schema_versions').get().version,
      1
    );
  } finally {
    closeUnstartedServer(instance);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Finance flag enabled fails closed before creating a missing database', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-finance-flag-on-missing-'));
  const config = startupConfig(directory, true);
  let instance = null;
  try {
    const result = await captureStartup(config);
    instance = result.instance;
    assert.equal(result.error?.code, 'FINANCE_F2_0_1_SCHEMA_NOT_READY');
    assert.equal(instance, null);
    assert.equal(existsSync(config.financeDb), false);
  } finally {
    closeUnstartedServer(instance);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Finance flag enabled rejects Generation 154 schema without automatic upgrade', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-finance-flag-on-v1-'));
  const config = startupConfig(directory, true);
  const legacy = createFinanceRuntime({
    databasePath: config.financeDb,
    applyMigrations: true,
    timezone: config.financeTimezone
  });
  legacy.close();
  let instance = null;
  try {
    const result = await captureStartup(config);
    instance = result.instance;
    assert.equal(result.error?.code, 'FINANCE_F2_0_1_SCHEMA_NOT_READY');
    assert.equal(instance, null);
    const database = new DatabaseSync(config.financeDb, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT MAX(version) AS version FROM finance_schema_versions').get().version, 1);
      assert.deepEqual(
        database.prepare('PRAGMA table_info(finance_entries)').all().map((column) => column.name),
        [
          'id', 'owner_id', 'type', 'amount_minor', 'currency', 'occurred_at', 'timezone',
          'category', 'merchant', 'counterparty', 'note', 'source_message_id',
          'client_request_id', 'status', 'created_at', 'updated_at', 'deleted_at'
        ]
      );
    } finally {
      database.close();
    }
  } finally {
    closeUnstartedServer(instance);
    rmSync(directory, { recursive: true, force: true });
  }
});

async function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-finance-api-'));
  const publicDir = path.join(directory, 'public');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<main>test</main>');
  const financeRuntime = createFinanceRuntime({ databasePath: path.join(directory, 'finance.sqlite'), applyMigrations: true, timezone: 'Asia/Shanghai' });
  const instance = await createBetaServer({
    config: { publicDir, authDb: path.join(directory, 'auth.sqlite'), cookieSecret: COOKIE_SECRET, secureCookie: false, host: '127.0.0.1', port: 0 },
    aiService: { getStatus: () => ({ available: false }), run: async () => ({ ok: false }), stream: async () => ({ ok: false }) },
    memoryRuntime: memoryRuntime(), conversationRuntime: null, financeRuntime
  });
  await instance.auth.createAccount({ username: 'owner_a', displayName: 'Owner A', password: 'PasswordA1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  await instance.auth.createAccount({ username: 'owner_b', displayName: 'Owner B', password: 'PasswordB1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  const ownerA = await instance.auth.login({ username: 'owner_a', password: 'PasswordA1!' });
  const ownerB = await instance.auth.login({ username: 'owner_b', password: 'PasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    directory, instance, financeRuntime, ownerA, ownerB,
    url: `http://127.0.0.1:${instance.server.address().port}`,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function request(h, pathname, cookie, options = {}) {
  return fetch(`${h.url}${pathname}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...options.headers } });
}

test('Finance API requires authentication and ignores submitted owner_id', async () => {
  const h = await harness();
  try {
    const anonymous = await request(h, '/api/finance/entries', '');
    assert.equal(anonymous.status, 401);
    const created = h.financeRuntime.repository.create({
      ownerId: h.ownerA.user.id, type: 'expense', amountMinor: 1800, currency: 'CNY', occurredAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai', category: '餐饮', sourceMessageId: 'source-a', clientRequestId: 'request-a', note: '早餐'
    });
    const crossRead = await request(h, `/api/finance/entries/${created.id}`, h.ownerB.setCookie);
    const crossPatch = await request(h, `/api/finance/entries/${created.id}`, h.ownerB.setCookie, { method: 'PATCH', body: JSON.stringify({ owner_id: h.ownerA.user.id, amountMinor: 2000 }) });
    const crossDelete = await request(h, `/api/finance/entries/${created.id}`, h.ownerB.setCookie, { method: 'DELETE' });
    assert.equal(crossRead.status, 404);
    assert.equal(crossPatch.status, 404);
    assert.equal(crossDelete.status, 404);
    assert.equal(h.financeRuntime.repository.get({ ownerId: h.ownerA.user.id, id: created.id }).amountMinor, 1800);
  } finally { await h.close(); }
});

test('Finance API supplies repository-backed page data and owner-scoped edit/delete', async () => {
  const h = await harness();
  try {
    const created = h.financeRuntime.repository.create({
      ownerId: h.ownerA.user.id, type: 'expense', amountMinor: 1800, currency: 'CNY', occurredAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai', category: '餐饮', sourceMessageId: 'source-a', clientRequestId: 'request-a', note: '早餐'
    });
    const page = await request(h, '/api/finance/overview', h.ownerA.setCookie);
    assert.equal(page.status, 200);
    const payload = await page.json();
    assert.equal(payload.entries[0].amountMinor, 1800);
    assert.equal(payload.summary.expenseMinor, 1800);

    const patch = await request(h, `/api/finance/entries/${created.id}`, h.ownerA.setCookie, { method: 'PATCH', body: JSON.stringify({ amountMinor: 2000, category: '购物', owner_id: 'owner-b' }) });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).entry.amountMinor, 2000);
    const removed = await request(h, `/api/finance/entries/${created.id}`, h.ownerA.setCookie, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(h.financeRuntime.repository.list({ ownerId: h.ownerA.user.id }).length, 0);
  } finally { await h.close(); }
});

test('Finance API rejects invalid amount and category without leaking internals', async () => {
  const h = await harness();
  try {
    const created = h.financeRuntime.repository.create({
      ownerId: h.ownerA.user.id, type: 'expense', amountMinor: 1800, currency: 'CNY', occurredAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai', category: '餐饮', sourceMessageId: 'source-a', clientRequestId: 'request-a', note: '早餐'
    });
    const amount = await request(h, `/api/finance/entries/${created.id}`, h.ownerA.setCookie, { method: 'PATCH', body: JSON.stringify({ amountMinor: 18.5 }) });
    const category = await request(h, `/api/finance/entries/${created.id}`, h.ownerA.setCookie, { method: 'PATCH', body: JSON.stringify({ category: '工资' }) });
    assert.equal(amount.status, 400);
    assert.equal(category.status, 400);
    assert.doesNotMatch(JSON.stringify(await amount.json()), /sqlite|owner_id|SELECT|\/opt\//i);
    assert.doesNotMatch(JSON.stringify(await category.json()), /sqlite|owner_id|SELECT|\/opt\//i);
  } finally { await h.close(); }
});

test('Finance overview exposes deterministic export capabilities and disabled future placeholders', async () => {
  const h = await harness();
  try {
    const response = await request(h, '/api/finance/overview', h.ownerA.setCookie);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.capabilities.monthly_report_export, {
      availability: 'enabled', execution: 'deterministic', formats: ['pdf', 'xlsx']
    });
    assert.deepEqual(payload.capabilities.financial_position, {
      availability: 'placeholder',
      execution: 'none',
      message: '当前仅基于收支账本，完整资产负债分析尚未启用。'
    });
    assert.deepEqual(payload.capabilities.ai_finance_analysis, {
      availability: 'disabled', execution: 'none', reasonCode: 'MODEL_ROUTING_REQUIRED'
    });
  } finally { await h.close(); }
});

test('Finance report API requires authentication and emits complete PDF/XLSX attachments for the Session owner', async () => {
  const h = await harness();
  try {
    const now = new Date();
    h.financeRuntime.repository.create({
      ownerId: h.ownerA.user.id, type: 'expense', amountMinor: 1800, currency: 'CNY', occurredAt: now.toISOString(),
      timezone: 'Asia/Shanghai', category: '餐饮', sourceMessageId: 'report-source-a', clientRequestId: 'report-request-a', note: '本人早餐'
    });
    h.financeRuntime.repository.create({
      ownerId: h.ownerB.user.id, type: 'income', amountMinor: 999999, currency: 'CNY', occurredAt: now.toISOString(),
      timezone: 'Asia/Shanghai', category: '工资', sourceMessageId: 'report-source-b', clientRequestId: 'report-request-b', note: '其他用户'
    });

    const anonymous = await request(h, '/api/finance/reports/current-month?format=pdf', '');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('content-disposition'), null);

    const pdf = await request(h, '/api/finance/reports/current-month?format=pdf&owner_id=forged', h.ownerA.setCookie);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /filename\*=UTF-8''AI%E5%88%86%E8%BA%AB-/);
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
    const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBuffer.subarray(0, 5).toString(), '%PDF-');
    assert.equal(Number(pdf.headers.get('content-length')), pdfBuffer.length);

    const xlsx = await request(h, '/api/finance/reports/current-month?format=xlsx', h.ownerA.setCookie);
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
    const details = workbook.getWorksheet('账目明细');
    assert.equal(details.rowCount, 2);
    assert.equal(details.getRow(2).getCell(7).value, '本人早餐');
    assert.equal(details.getRow(2).getCell(8).value, -18);
  } finally { await h.close(); }
});

test('Finance report API rejects unknown formats before rendering', async () => {
  const h = await harness();
  try {
    let calls = 0;
    const original = h.financeRuntime.reportService.exportCurrentMonth.bind(h.financeRuntime.reportService);
    h.financeRuntime.reportService.exportCurrentMonth = async (...args) => {
      calls += 1;
      return original(...args);
    };
    const response = await request(h, '/api/finance/reports/current-month?format=csv', h.ownerA.setCookie);
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
    assert.equal(response.headers.get('content-disposition'), null);
  } finally { await h.close(); }
});

test('Finance report API fails before attachment headers when generation fails', async () => {
  const h = await harness();
  try {
    h.financeRuntime.reportService.exportCurrentMonth = async () => {
      throw Object.assign(new Error('sensitive sqlite /opt/private'), { code: 'RENDER_FAILED' });
    };
    const response = await request(h, '/api/finance/reports/current-month?format=pdf', h.ownerA.setCookie);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const payload = await response.json();
    assert.deepEqual(payload, { ok: false, message: '报表暂时无法生成，请稍后再试。' });
    assert.doesNotMatch(JSON.stringify(payload), /sqlite|\/opt\/|RENDER_FAILED/i);
  } finally { await h.close(); }
});
