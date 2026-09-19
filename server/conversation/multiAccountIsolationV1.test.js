import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createConversationRuntime } from './runtime.js';
import {
  createMockStreamingAiService,
  createMockStreamingProvider
} from './testing/mockStreamingProvider.js';

const COOKIE_SECRET = 'multi-account-isolation-secret-32';
const SENTINEL_A = 'SYNTHETIC_ACCOUNT_A_ONLY_93817';
const SENTINEL_B = 'SYNTHETIC_ACCOUNT_B_ONLY_24650';

const disabledMemoryRuntime = () => ({
  initialize: async () => ({ status: 'disabled', pathSummary: 'temporary-memory.sqlite' }),
  close: async () => {},
  service: {}
});

async function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-multi-account-v1-'));
  const provider = createMockStreamingProvider({
    chunks: ['synthetic-', 'isolated-', 'reply'],
    delayMs: 25
  });
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
    aiService: {
      getStatus: () => ({ available: true }),
      run: async () => ({ ok: true, content: 'unused' })
    },
    memoryRuntime: disabledMemoryRuntime(),
    conversationRuntime: runtime
  });
  await instance.auth.createAccount({
    username: 'isolation_owner_a',
    displayName: 'Isolation A',
    password: 'PasswordA1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  await instance.auth.createAccount({
    username: 'isolation_owner_b',
    displayName: 'Isolation B',
    password: 'PasswordB1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const ownerA = await instance.auth.login({ username: 'isolation_owner_a', password: 'PasswordA1!' });
  const ownerB = await instance.auth.login({ username: 'isolation_owner_b', password: 'PasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    directory,
    instance,
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

async function jsonRequest(h, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${h.baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json()
  };
}

function streamRequest(h, cookie, message, clientRequestId) {
  return fetch(`${h.baseUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ message, clientRequestId })
  });
}

function startedData(text) {
  const match = String(text).match(/event: started\ndata: (.+)\n\n/);
  assert.ok(match, 'stream must contain a started event');
  return JSON.parse(match[1]);
}

async function readThroughFirstEvent(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: !done });
    if (done) break;
  }
  return {
    firstText: text,
    async finish() {
      while (true) {
        const { value, done } = await reader.read();
        if (value) text += decoder.decode(value, { stream: !done });
        if (done) break;
      }
      text += decoder.decode();
      reader.releaseLock();
      return text;
    }
  };
}

test('two temporary accounts can chat concurrently without listing or restoring each other data', async () => {
  const h = await harness();
  try {
    const [responseA, responseB] = await Promise.all([
      streamRequest(h, h.ownerA.setCookie, SENTINEL_A, 'client-account-a'),
      streamRequest(h, h.ownerB.setCookie, SENTINEL_B, 'client-account-b')
    ]);
    assert.equal(responseA.status, 200);
    assert.equal(responseB.status, 200);
    assert.equal(responseA.headers.get('x-ai-account-context'), h.ownerA.user.id);
    assert.equal(responseB.headers.get('x-ai-account-context'), h.ownerB.user.id);

    const [textA, textB] = await Promise.all([responseA.text(), responseB.text()]);
    const startedA = startedData(textA);
    const startedB = startedData(textB);
    assert.notEqual(startedA.conversationId, startedB.conversationId);

    const [listA, listB, historyA, historyB] = await Promise.all([
      jsonRequest(h, '/api/ai/conversations', { cookie: h.ownerA.setCookie }),
      jsonRequest(h, '/api/ai/conversations', { cookie: h.ownerB.setCookie }),
      jsonRequest(h, `/api/ai/conversations/${startedA.conversationId}/messages`, { cookie: h.ownerA.setCookie }),
      jsonRequest(h, `/api/ai/conversations/${startedB.conversationId}/messages`, { cookie: h.ownerB.setCookie })
    ]);
    assert.equal(listA.body.accountContext, h.ownerA.user.id);
    assert.equal(listB.body.accountContext, h.ownerB.user.id);
    assert.deepEqual(listA.body.conversations.map(({ id }) => id), [startedA.conversationId]);
    assert.deepEqual(listB.body.conversations.map(({ id }) => id), [startedB.conversationId]);

    const serializedA = JSON.stringify(historyA.body);
    const serializedB = JSON.stringify(historyB.body);
    assert.match(serializedA, new RegExp(SENTINEL_A));
    assert.doesNotMatch(serializedA, new RegExp(SENTINEL_B));
    assert.match(serializedB, new RegExp(SENTINEL_B));
    assert.doesNotMatch(serializedB, new RegExp(SENTINEL_A));

    const [crossA, crossB] = await Promise.all([
      jsonRequest(h, `/api/ai/conversations/${startedB.conversationId}/messages`, { cookie: h.ownerA.setCookie }),
      jsonRequest(h, `/api/ai/conversations/${startedA.conversationId}/messages`, { cookie: h.ownerB.setCookie })
    ]);
    assert.equal(crossA.status, 404);
    assert.equal(crossB.status, 404);
    assert.doesNotMatch(JSON.stringify(crossA.body), new RegExp(SENTINEL_B));
    assert.doesNotMatch(JSON.stringify(crossB.body), new RegExp(SENTINEL_A));
  } finally {
    await h.close();
  }
});

test('one account cannot cancel another account active stream', async () => {
  const h = await harness();
  try {
    const responseB = await streamRequest(h, h.ownerB.setCookie, 'SYNTHETIC_CANCEL_B', 'client-cancel-b');
    assert.equal(responseB.status, 200);
    const streamB = await readThroughFirstEvent(responseB);
    const { requestId } = startedData(streamB.firstText);

    const wrongOwner = await jsonRequest(h, `/api/ai/chat/requests/${requestId}/cancel`, {
      method: 'POST',
      cookie: h.ownerA.setCookie
    });
    assert.equal(wrongOwner.status, 404);

    const correctOwner = await jsonRequest(h, `/api/ai/chat/requests/${requestId}/cancel`, {
      method: 'POST',
      cookie: h.ownerB.setCookie
    });
    assert.equal(correctOwner.status, 200);
    assert.equal(correctOwner.body.accountContext, h.ownerB.user.id);
    assert.equal(correctOwner.headers.get('x-ai-account-context'), h.ownerB.user.id);
    assert.match(await streamB.finish(), /event: stopped/);
  } finally {
    await h.close();
  }
});
