import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBetaServer } from '../betaServer.js';
import { handleConversationApi } from './httpApi.js';
import { createConversationRuntime } from './runtime.js';
import { createMockStreamingAiService, createMockStreamingProvider } from './testing/mockStreamingProvider.js';

const COOKIE_SECRET = 'conversation-lifecycle-secret-32';
const disabledMemoryRuntime = () => ({
  initialize: async () => ({ status: 'disabled', pathSummary: 'test-memory.sqlite' }),
  close: async () => {},
  service: {}
});

async function harness(providerOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-conversation-lifecycle-'));
  const provider = createMockStreamingProvider(providerOptions);
  const runtime = createConversationRuntime({
    databasePath: path.join(directory, 'conversation.sqlite'),
    aiService: createMockStreamingAiService(provider),
    applyMigrations: true
  });
  const instance = await createBetaServer({
    config: {
      publicDir: path.join(directory, 'public'),
      authDb: path.join(directory, 'auth.sqlite'),
      cookieSecret: COOKIE_SECRET,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0
    },
    aiService: { getStatus: () => ({ available: true }), run: async () => ({ ok: true, content: 'legacy' }) },
    memoryRuntime: disabledMemoryRuntime(),
    conversationRuntime: runtime
  });
  await instance.auth.createAccount({ username: 'owner_a', displayName: 'Owner A', password: 'PasswordA1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  await instance.auth.createAccount({ username: 'owner_b', displayName: 'Owner B', password: 'PasswordB1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  const ownerA = await instance.auth.login({ username: 'owner_a', password: 'PasswordA1!' });
  const ownerB = await instance.auth.login({ username: 'owner_b', password: 'PasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    provider,
    runtime,
    ownerA,
    ownerB,
    baseUrl: `http://127.0.0.1:${instance.server.address().port}`,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function request(h, pathname, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${h.baseUrl}${pathname}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('authenticated owner can create, list and restore only their conversations and messages', async () => {
  const h = await harness();
  try {
    assert.equal((await request(h, '/api/ai/conversations', { method: 'POST' })).status, 401);
    const created = await request(h, '/api/ai/conversations', {
      method: 'POST', cookie: h.ownerA.setCookie, body: { title: '新的对话', ownerId: h.ownerB.user.id }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.accountContext, h.ownerA.user.id);
    assert.equal(created.headers.get('x-ai-account-context'), h.ownerA.user.id);
    assert.equal(created.headers.get('cache-control'), 'private, no-store');
    assert.match(created.headers.get('vary') || '', /Cookie/i);
    assert.equal(created.body.conversation.ownerId, undefined);

    h.runtime.messages.createUserMessage({
      ownerId: h.ownerA.user.id,
      conversationId: created.body.conversation.id,
      content: '只属于用户A',
      clientRequestId: 'restore-1'
    });

    const listA = await request(h, '/api/ai/conversations', { cookie: h.ownerA.setCookie });
    assert.equal(listA.status, 200);
    assert.equal(listA.body.accountContext, h.ownerA.user.id);
    assert.equal(listA.headers.get('x-ai-account-context'), h.ownerA.user.id);
    assert.equal(listA.headers.get('cache-control'), 'private, no-store');
    assert.match(listA.headers.get('vary') || '', /Cookie/i);
    assert.equal(listA.body.conversations.length, 1);
    assert.equal(listA.body.conversations[0].id, created.body.conversation.id);
    assert.equal('ownerId' in listA.body.conversations[0], false);

    const messagesA = await request(h, `/api/ai/conversations/${created.body.conversation.id}/messages`, { cookie: h.ownerA.setCookie });
    assert.equal(messagesA.status, 200);
    assert.equal(messagesA.body.accountContext, h.ownerA.user.id);
    assert.equal(messagesA.headers.get('x-ai-account-context'), h.ownerA.user.id);
    assert.deepEqual(messagesA.body.messages.map(({ role, content, status }) => ({ role, content, status })), [
      { role: 'user', content: '只属于用户A', status: 'completed' }
    ]);

    assert.equal((await request(h, `/api/ai/conversations/${created.body.conversation.id}/messages`, { cookie: h.ownerB.setCookie })).status, 404);
    assert.deepEqual((await request(h, '/api/ai/conversations', { cookie: h.ownerB.setCookie })).body.conversations, []);
  } finally {
    await h.close();
  }
});

test('explicit retry reuses the original user message and assistant row without duplicate inserts', async () => {
  const h = await harness({ failAt: 0 });
  try {
    const first = await fetch(`${h.baseUrl}/api/ai/chat/stream`, {
      method: 'POST',
      headers: { cookie: h.ownerA.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '请重试', clientRequestId: 'retry-1' })
    });
    assert.equal(first.headers.get('x-ai-account-context'), h.ownerA.user.id);
    assert.equal(first.headers.get('cache-control'), 'private, no-store');
    assert.match(first.headers.get('vary') || '', /Cookie/i);
    const firstText = await first.text();
    const conversationId = JSON.parse(firstText.match(/event: started\ndata: (.+)\n\n/)[1]).conversationId;
    h.provider.failAt = -1;

    const retried = await fetch(`${h.baseUrl}/api/ai/chat/stream`, {
      method: 'POST',
      headers: { cookie: h.ownerA.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, message: '请重试', clientRequestId: 'retry-1', retry: true })
    });
    const retryText = await retried.text();
    assert.match(retryText, /event: completed/);
    assert.equal(h.provider.calls, 2);
    assert.equal(h.runtime.messages.listForConversationOwner(conversationId, h.ownerA.user.id).length, 2);
    assert.equal(h.runtime.messages.listForConversationOwner(conversationId, h.ownerA.user.id).at(-1).status, 'completed');
  } finally {
    await h.close();
  }
});

test('mismatched authenticated subject is rejected before owner repositories are touched', async () => {
  let repositoryCalls = 0;
  const res = { status: null, body: null, headers: null };
  const handled = await handleConversationApi({
    req: { method: 'GET' },
    res,
    url: new URL('http://local/api/ai/conversations'),
    user: { id: 'account-a' },
    subject: { marker: 'trusted-b' },
    accessControl: {
      assertAuthenticatedSubject(subject) {
        assert.deepEqual(subject, { marker: 'trusted-b' });
        return { accountId: 'account-b' };
      }
    },
    runtime: {
      service: {},
      conversations: {
        listForOwner() {
          repositoryCalls += 1;
          return [];
        }
      }
    },
    readJson: async () => ({}),
    sendJson(response, status, body, headers = {}) {
      response.status = status;
      response.body = body;
      response.headers = headers;
    }
  });

  assert.equal(handled, true);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ACCOUNT_CONTEXT_MISMATCH');
  assert.equal(repositoryCalls, 0);
});

test('a stale page account header is rejected before owner repositories are touched', async () => {
  let repositoryCalls = 0;
  const res = { status: null, body: null, headers: null };
  const handled = await handleConversationApi({
    req: { method: 'GET', headers: { 'x-ai-expected-account-context': 'account-a' } },
    res,
    url: new URL('http://local/api/ai/conversations'),
    user: { id: 'account-b' },
    subject: { marker: 'trusted-b' },
    accessControl: {
      assertAuthenticatedSubject(subject) {
        assert.deepEqual(subject, { marker: 'trusted-b' });
        return { accountId: 'account-b' };
      }
    },
    runtime: {
      service: {},
      conversations: {
        listForOwner() {
          repositoryCalls += 1;
          return [];
        }
      }
    },
    readJson: async () => ({}),
    sendJson(response, status, body, headers = {}) {
      response.status = status;
      response.body = body;
      response.headers = headers;
    }
  });

  assert.equal(handled, true);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ACCOUNT_CONTEXT_MISMATCH');
  assert.equal(res.body.accountContext, 'account-b');
  assert.equal(res.headers['X-AI-Account-Context'], 'account-b');
  assert.equal(repositoryCalls, 0);
});
