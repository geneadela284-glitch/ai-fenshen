import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBetaServer } from '../betaServer.js';
import { createConversationRuntime } from './runtime.js';
import { createMockStreamingAiService, createMockStreamingProvider } from './testing/mockStreamingProvider.js';

const COOKIE_SECRET = 'conversation-test-cookie-secret-32';
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const memoryRuntime = () => ({ initialize: async () => ({ status: 'disabled', pathSummary: 'test-memory.sqlite' }), close: async () => {}, service: {} });

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = block.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
    return { event, data: JSON.parse(data) };
  });
}

async function createHarness(providerOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-conversation-stream-'));
  const provider = createMockStreamingProvider(providerOptions);
  const legacyAi = {
    calls: 0,
    getStatus: () => ({ available: true }),
    async run() {
      legacyAi.calls += 1;
      return { ok: true, content: 'legacy-json', latency: 1, usage: null };
    }
  };
  const runtime = createConversationRuntime({
    databasePath: path.join(directory, 'conversation.sqlite'),
    aiService: createMockStreamingAiService(provider),
    applyMigrations: true
  });
  const instance = await createBetaServer({
    config: {
      publicDir: path.join(directory, 'public'), authDb: path.join(directory, 'auth.sqlite'),
      cookieSecret: COOKIE_SECRET, secureCookie: false, host: '127.0.0.1', port: 0
    },
    aiService: legacyAi,
    memoryRuntime: memoryRuntime(), conversationRuntime: runtime
  });
  await instance.auth.createAccount({ username: 'owner_a', displayName: 'Owner A', password: 'PasswordA1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  await instance.auth.createAccount({ username: 'owner_b', displayName: 'Owner B', password: 'PasswordB1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  const ownerA = await instance.auth.login({ username: 'owner_a', password: 'PasswordA1!' });
  const ownerB = await instance.auth.login({ username: 'owner_b', password: 'PasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  return {
    directory, provider, legacyAi, runtime, instance, ownerA, ownerB, baseUrl,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function postStream(h, body, cookie = '') {
  return fetch(`${h.baseUrl}/api/ai/chat/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body)
  });
}

test('SSE rejects unauthenticated and invalid input before opening a stream', async () => {
  const h = await createHarness();
  try {
    const anonymous = await postStream(h, { message: '你好', clientRequestId: 'request-1' });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { ok: false, message: '请先登录。' });
    const empty = await postStream(h, { message: '  ', clientRequestId: 'request-2' }, h.ownerA.setCookie);
    assert.equal(empty.status, 400);
  } finally { await h.close(); }
});

test('SSE emits started, ordered deltas and completed while persisting one owner-scoped exchange', async () => {
  const h = await createHarness();
  try {
    const response = await postStream(h, { message: '你好', clientRequestId: 'request-1', ownerId: h.ownerB.user.id }, h.ownerA.setCookie);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('vary') || '', /(?:^|,\s*)Cookie(?:,|$)/i);
    const responseText = await response.text();
    assert.doesNotMatch(
      responseText,
      /selectedProvider|selectedModel|routeTrace|routeReason|fallbackFrom|fallbackTo|api.?key|baseUrl/i
    );
    const events = parseSse(responseText);
    assert.deepEqual(events.map((item) => item.event), ['started', 'delta', 'delta', 'delta', 'completed']);
    assert.deepEqual(events.filter((item) => item.event === 'delta').map((item) => item.data.text), ['你好，', '我是你的', 'AI分身。']);
    const started = events[0].data;
    const conversation = h.runtime.conversations.getByIdForOwner(started.conversationId, h.ownerA.user.id);
    assert.ok(conversation);
    assert.equal(h.runtime.conversations.getByIdForOwner(started.conversationId, h.ownerB.user.id), null);
    const messages = h.runtime.messages.listForConversationOwner(started.conversationId, h.ownerA.user.id);
    assert.deepEqual(messages.map(({ role, content, status }) => ({ role, content, status })), [
      { role: 'user', content: '你好', status: 'completed' },
      { role: 'assistant', content: '你好，我是你的AI分身。', status: 'completed' }
    ]);
  } finally { await h.close(); }
});

test('clientRequestId is database-backed idempotency and never invokes Provider twice', async () => {
  const h = await createHarness();
  try {
    const first = parseSse(await (await postStream(h, { message: '你好', clientRequestId: 'same' }, h.ownerA.setCookie)).text());
    const conversationId = first[0].data.conversationId;
    const second = parseSse(await (await postStream(h, { conversationId, message: '重复', clientRequestId: 'same' }, h.ownerA.setCookie)).text());
    assert.equal(h.provider.calls, 1);
    assert.deepEqual(second.map((item) => item.event), ['started', 'completed']);
    assert.equal(second[0].data.deduplicated, true);
    assert.equal(h.runtime.messages.listForConversationOwner(conversationId, h.ownerA.user.id).length, 2);
  } finally { await h.close(); }
});

test('cross-owner conversation write is hidden and does not invoke Provider', async () => {
  const h = await createHarness();
  try {
    const first = parseSse(await (await postStream(h, { message: 'A', clientRequestId: 'a-1' }, h.ownerA.setCookie)).text());
    const response = await postStream(h, { conversationId: first[0].data.conversationId, message: 'B越权', clientRequestId: 'b-1' }, h.ownerB.setCookie);
    assert.equal(response.status, 404);
    assert.equal(h.provider.calls, 1);
  } finally { await h.close(); }
});

test('Provider failure emits sanitized error and persists partial content as error', async () => {
  const h = await createHarness({ failAt: 1 });
  try {
    const events = parseSse(await (await postStream(h, { message: '失败', clientRequestId: 'error-1' }, h.ownerA.setCookie)).text());
    assert.deepEqual(events.map((item) => item.event), ['started', 'delta', 'error']);
    const error = events.at(-1).data;
    assert.equal(error.message, 'AI服务暂时不可用，请稍后重试');
    assert.doesNotMatch(JSON.stringify(error), /internal provider detail|stack|secret/i);
    const messages = h.runtime.messages.listForConversationOwner(events[0].data.conversationId, h.ownerA.user.id);
    assert.equal(messages.at(-1).content, '你好，');
    assert.equal(messages.at(-1).status, 'error');
  } finally { await h.close(); }
});

test('owner cancel aborts Provider, persists stopped content, forbids other owner and is idempotent', async () => {
  const h = await createHarness({ chunks: ['一', '二', '三', '四'], delayMs: 40 });
  try {
    const response = await postStream(h, { message: '停止', clientRequestId: 'stop-1' }, h.ownerA.setCookie);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let requestId = '';
    while (!requestId) {
      const next = await reader.read();
      text += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
      const match = text.match(/event: started\ndata: (.+)\n\n/);
      if (match) requestId = JSON.parse(match[1]).requestId;
    }
    const forbidden = await fetch(`${h.baseUrl}/api/ai/chat/requests/${requestId}/cancel`, { method: 'POST', headers: { cookie: h.ownerB.setCookie } });
    assert.equal(forbidden.status, 404);
    const cancel = await fetch(`${h.baseUrl}/api/ai/chat/requests/${requestId}/cancel`, { method: 'POST', headers: { cookie: h.ownerA.setCookie } });
    assert.equal(cancel.status, 200);
    const duplicateCancel = await fetch(`${h.baseUrl}/api/ai/chat/requests/${requestId}/cancel`, { method: 'POST', headers: { cookie: h.ownerA.setCookie } });
    assert.equal(duplicateCancel.status, 200);
    while (true) {
      const next = await reader.read();
      text += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
      if (next.done) break;
    }
    const events = parseSse(text);
    assert.equal(events.at(-1).event, 'stopped');
    const messages = h.runtime.messages.listForConversationOwner(events[0].data.conversationId, h.ownerA.user.id);
    assert.equal(messages.at(-1).status, 'stopped');
    assert.equal(h.provider.aborts, 1);
    assert.equal(h.provider.deltasAfterAbort, 0);
    assert.equal(h.runtime.registry.activeCount, 0);
  } finally { await h.close(); }
});

test('completed, stopped and error streams never modify a separate Memory database', async () => {
  const h = await createHarness();
  const memoryPath = path.join(h.directory, 'memory.sqlite');
  writeFileSync(memoryPath, 'immutable-memory-sentinel');
  const before = hash(memoryPath);
  try {
    await (await postStream(h, { message: '完成', clientRequestId: 'memory-1' }, h.ownerA.setCookie)).text();
    assert.equal(hash(memoryPath), before);
  } finally { await h.close(); }
});

test('client disconnect propagates Abort and leaves no active request', async () => {
  const h = await createHarness({ chunks: ['一', '二', '三', '四'], delayMs: 60 });
  const controller = new AbortController();
  try {
    const response = await fetch(`${h.baseUrl}/api/ai/chat/stream`, {
      method: 'POST', signal: controller.signal,
      headers: { cookie: h.ownerA.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '断开连接', clientRequestId: 'disconnect-1' })
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    controller.abort();
    await assert.rejects(reader.read(), /abort/i);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(h.provider.aborts, 1);
    assert.equal(h.runtime.registry.activeCount, 0);
  } finally { await h.close(); }
});

test('runtime refuses any browser-selectable unsupported Memory policy', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-conversation-policy-'));
  const provider = createMockStreamingProvider();
  try {
    assert.throws(() => createConversationRuntime({
      databasePath: path.join(directory, 'conversation.sqlite'),
      aiService: createMockStreamingAiService(provider), applyMigrations: true, memoryPolicy: 'enabled'
    }), /MEMORY_POLICY_INVALID/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy JSON chat endpoint is retired without Router or Provider invocation', async () => {
  const h = await createHarness();
  try {
    const response = await fetch(`${h.baseUrl}/api/ai/chat`, {
      method: 'POST', headers: { cookie: h.ownerA.setCookie, 'content-type': 'application/json' }, body: JSON.stringify({ input: '旧接口' })
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: 'LEGACY_CHAT_ENDPOINT_RETIRED',
      message: '该接口已停用，请使用正式聊天入口。'
    });
    assert.equal(h.legacyAi.calls, 0);
    assert.equal(h.provider.calls, 0);
  } finally { await h.close(); }
});
