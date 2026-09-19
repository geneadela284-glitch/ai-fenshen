import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import { createCoreAiService } from '../coreAiService.js';
import { AccessControlService } from '../access/accessControlService.js';
import { AccessControlStore } from '../access/accessControlStore.js';
import { createMemoryStorage } from '../../core/storage/memoryStorage.js';

function fixture(t, { healthy = true, errorCode = 'TIMEOUT', respond } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'meeting-recovery-test-'));
  const store = new AccessControlStore({ dbPath: path.join(directory, 'access.sqlite') }).initialize();
  const access = new AccessControlService({ store, hmacSecret: 'synthetic-meeting-test-secret-long-enough' });
  access.bindAccountProfile({ accountId: 'synthetic-a', profileId: 'closed_beta_user_v1', enabled: true });
  const subject = access.createAuthenticatedSubject({ accountId: 'synthetic-a', role: 'beta_user' });
  const service = createCoreAiService({ configPath: path.join(directory, 'unused.json'), storage: createMemoryStorage(), healthStorage: createMemoryStorage(), accessControl: access });
  service.saveProvider('qwen', { enabled: true, apiKey: 'synthetic-key', baseUrl: 'https://meeting-provider.invalid/v1', defaultModel: 'qwen-max' });
  service.saveRouter({ routes: { MEETING_SUMMARY: { providerId: 'qwen', model: 'qwen-max' } } });
  service.settings.recordProviderHealth('qwen', { success: healthy, errorCode: healthy ? '' : errorCode });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(['https://meeting-provider.invalid/v1/chat/completions', 'https://meeting-fallback.invalid/v1/chat/completions'].includes(url));
    const request = JSON.parse(options.body);
    const call = { request, signal: options.signal };
    calls.push(call);
    const content = await respond(call, calls.length);
    return new Response(JSON.stringify({ model: 'qwen-max', choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }), { status: 200 });
  });
  let sequence = 0;
  async function run({ trusted = true, capability = 'MEETING_SUMMARY', metadata = {} } = {}) {
    const requestLease = access.beginRequest({ subject, requestId: `synthetic-request-${++sequence}` });
    try {
      return await service.run({ input: 'synthetic meeting', messages: [{ role: 'user', content: 'synthetic meeting' }], capability, metadata, options: { timeoutMs: 90000 } }, { subject, requestLease, ...(trusted ? { meetingAnalysis: true } : {}) });
    } finally { access.releaseRequest(requestLease); }
  }
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, access, store, calls, run };
}

function delayed(call, delayMs, content = '{"summary":"synthetic result"}') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(content), delayMs);
    call.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
}

test('meeting-only server accepts a valid result after the former 30-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(t, { respond: call => delayed(call, 54000) });
  const pending = f.run();
  await flush();
  t.mock.timers.tick(54000);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.content, '{"summary":"synthetic result"}');
  assert.equal(f.calls.length, 1);
});

test('public task metadata cannot opt other calls into the extended meeting deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(t, { respond: call => delayed(call, 54000) });
  const pending = f.run({ trusted: false, metadata: { meetingAnalysis: true, purpose: 'meeting_stage4_analysis' } });
  await flush();
  t.mock.timers.tick(30000);
  assert.equal((await pending).code, 'TIMEOUT');
});

test('a meeting hard timeout cancels provider work and never becomes a success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(t, { respond: call => delayed(call, 120000) });
  const pending = f.run();
  await flush();
  t.mock.timers.tick(89999);
  const abortedEarly = f.calls[0].signal.aborted;
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(abortedEarly, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(f.calls[0].signal.aborted, true);
});

test('a timed-out meeting provider is verified before reuse through the real guarded router', async t => {
  const f = fixture(t, { healthy: false, respond: async (call, number) => number === 1 ? '连接成功' : '{"summary":"recovered"}' });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.content, '{"summary":"recovered"}');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].request.messages, [{ role: 'user', content: '请回复：连接成功' }]);
  assert.equal(f.service.settings.getProviderConfig('qwen').healthy, true);
});

test('failed recovery does not falsify health or repeatedly call the provider', async t => {
  const f = fixture(t, { healthy: false, respond: async () => { throw new TypeError('synthetic network failure'); } });
  assert.equal((await f.run()).ok, false);
  assert.equal((await f.run()).ok, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.settings.getProviderConfig('qwen').healthy, false);
});

test('credential failures and non-meeting requests do not trigger meeting recovery', async t => {
  const f = fixture(t, { healthy: false, errorCode: 'AUTH_FAILED', respond: async () => { throw new Error('must not call'); } });
  assert.equal((await f.run()).ok, false);
  f.service.settings.recordProviderHealth('qwen', { success: false, errorCode: 'TIMEOUT' });
  assert.equal((await f.run({ trusted: false })).ok, false);
  assert.equal(f.calls.length, 0);
});

test('recovery and analysis each consume their own authorized provider reservation', async t => {
  const f = fixture(t, { healthy: false, respond: async () => '连接成功' });
  f.access.putCustomQuotaProfile({ id: 'single_call', enabled: true, requestsPerMinute: 10, maxConcurrentRequests: 2, providerCallsPerDay: 1, inputTokensPerDay: 300000, outputTokensPerDay: 120000, dailyCostMicros: 10000000, monthlyCostMicros: 150000000, lifetimeCostMicros: 500000000 });
  f.access.bindAccountProfile({ accountId: 'synthetic-a', profileId: 'single_call', enabled: true });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACCOUNT_USAGE_LIMIT_REACHED');
  assert.equal(f.calls.length, 1);
});

test('meeting deadline expiry does not call or poison an untried fallback provider', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(t, { respond: call => delayed(call, 120000) });
  f.service.saveProvider('deepseek', { enabled: true, apiKey: 'synthetic-fallback', baseUrl: 'https://meeting-fallback.invalid/v1', defaultModel: 'deepseek-v4-flash' });
  f.service.settings.recordProviderHealth('deepseek', { success: true });
  assert.equal(f.service.registry.listCandidates(f.service.settings.load(), 'MEETING_SUMMARY').length, 2);
  const pending = f.run();
  await flush();
  t.mock.timers.tick(90000);
  assert.equal((await pending).code, 'TIMEOUT');
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.settings.getProviderConfig('deepseek').healthy, true);
});

test('meeting fallback gets only the remaining deadline rather than a fresh 90 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(t, { respond: (call, number) => number === 1
    ? delayed(call, 60000).then(() => { throw new TypeError('temporary network failure'); })
    : delayed(call, 60000) });
  f.service.saveProvider('deepseek', { enabled: true, apiKey: 'synthetic-fallback', baseUrl: 'https://meeting-fallback.invalid/v1', defaultModel: 'deepseek-v4-flash' });
  f.service.settings.recordProviderHealth('deepseek', { success: true });
  const pending = f.run();
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(f.calls.length, 2);
  t.mock.timers.tick(30000);
  assert.equal((await pending).code, 'TIMEOUT');
  assert.equal(f.calls[1].signal.aborted, true);
});

test('a timeout recovery cycle survives one network failure and verifies again after cooldown', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const f = fixture(t, { healthy: false, respond: async (_call, number) => {
    if (number === 1) throw new TypeError('synthetic temporary network failure');
    return number === 2 ? '连接成功' : '{"summary":"recovered after network failure"}';
  } });
  assert.equal((await f.run()).ok, false);
  assert.equal((await f.run()).ok, false);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(60001);
  assert.equal((await f.run()).ok, true);
  assert.equal(f.calls.length, 3);
  assert.equal(f.service.settings.getProviderConfig('qwen').healthy, true);
});

test('meeting health recovery reserves actual output limit and settles actual provider usage', async t => {
  const f = fixture(t, { healthy: false, respond: async () => '连接成功' });
  assert.equal((await f.run()).ok, true);
  const row = f.store.database.prepare("SELECT reserved_output_tokens, settled_input_tokens, settled_output_tokens, status FROM provider_attempts WHERE attempt_type = 'meeting_health_recovery'").get();
  assert.equal(row.reserved_output_tokens, f.calls[0].request.max_tokens);
  assert.equal(row.settled_input_tokens, 12);
  assert.equal(row.settled_output_tokens, 8);
  assert.equal(row.status, 'settled');
});

test('failed meeting health recovery is recorded as failed rather than successful', async t => {
  const f = fixture(t, { healthy: false, respond: async () => { throw new TypeError('synthetic failure'); } });
  assert.equal((await f.run()).ok, false);
  const row = f.store.database.prepare("SELECT status FROM provider_attempts WHERE attempt_type = 'meeting_health_recovery'").get();
  assert.equal(row.status, 'failed');
});

test('meeting recovery honors the smaller output limit granted by the real quota store', async t => {
  const f = fixture(t, { healthy: false, respond: async () => '连接成功' });
  f.access.putCustomQuotaProfile({ id: 'small_output', enabled: true, requestsPerMinute: 10, maxConcurrentRequests: 2, providerCallsPerDay: 10, inputTokensPerDay: 300000, outputTokensPerDay: 32, dailyCostMicros: 10000000, monthlyCostMicros: 150000000, lifetimeCostMicros: 500000000 });
  f.access.bindAccountProfile({ accountId: 'synthetic-a', profileId: 'small_output', enabled: true });
  assert.equal((await f.run()).ok, true);
  assert.equal(f.calls[0].request.max_tokens, 32);
  assert.equal(f.calls[1].request.max_tokens, 24);
});

test('meeting recovery verifies the enabled fallback when the default preferred provider is disabled', async t => {
  const f = fixture(t, { healthy: false, respond: async () => '连接成功' });
  f.service.saveRouter({ routes: { MEETING_SUMMARY: { providerId: 'deepseek', model: 'deepseek-v4-flash' } } });
  assert.equal(f.service.registry.resolveRoute(f.service.settings.load(), 'MEETING_SUMMARY').enabled, false);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 2);
});
