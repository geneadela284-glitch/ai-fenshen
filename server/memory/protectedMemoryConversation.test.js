import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createConversationRuntime } from '../conversation/runtime.js';
import { createProtectedMemoryRuntime } from './protectedMemoryRuntime.js';

const ACTION_ID = 'M9_2_REAL_CONVERSATION_MEMORY_OS_WIRING';
const COOKIE_SECRET = 'm9-2-protected-memory-cookie-secret';
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => ({
    type: block.match(/^event:\s*(.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}')
  }));
}

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-2-http-'));
  const memoryPath = path.join(root, 'acceptance', 'memory.sqlite');
  const originalPath = path.join(root, 'original', 'memory.sqlite');
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.writeFileSync(originalPath, 'original-memory-read-only');
  const originalHash = digest(originalPath);
  let tick = 0;
  const authorization = {
    scope: 'local-m9-2-acceptance', environment: 'local-m9-2-acceptance',
    database_kind: 'isolated_acceptance_memory', database_path: memoryPath,
    owner_source: 'authenticated_session',
    allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
    original_memory_database: { path: originalPath, access: 'read_only' },
    cross_owner_access: 'denied', migration_allowed: false, bulk_import_allowed: false,
    active_action_ids: [ACTION_ID]
  };
  const protectedMemory = createProtectedMemoryRuntime({
    databasePath: memoryPath, repositoryRoot: process.cwd(), authorization,
    scope: authorization.scope, actionId: ACTION_ID,
    now: () => new Date(Date.UTC(2026, 6, 19, 9, 0, tick++)).toISOString()
  });
  const providerCalls = [];
  const aiService = {
    async stream(request, { onDelta }) {
      providerCalls.push(structuredClone(request));
      const grounded = /"displayDate":"5月6日"/.test(request.messages[0].content) &&
        /"yearKnown":false/.test(request.messages[0].content) &&
        !/2000/.test(request.messages[0].content);
      const answer = grounded ? '5月6号。' : '我会自然地继续这次对话。';
      await onDelta(answer);
      return { ok: true, content: answer };
    }
  };
  const conversationRuntime = createConversationRuntime({
    databasePath: path.join(root, 'conversation.sqlite'), aiService, applyMigrations: true,
    memoryPolicy: 'protected_acceptance', memoryIntegration: protectedMemory
  });
  const legacyMemory = { service: {}, initialize: async () => ({ status: 'disabled' }), close: async () => {} };
  const instance = await createBetaServer({
    config: { publicDir: path.join(root, 'public'), authDb: path.join(root, 'auth.sqlite'), cookieSecret: COOKIE_SECRET, secureCookie: false },
    aiService, memoryRuntime: legacyMemory, conversationRuntime, protectedMemoryRuntime: protectedMemory
  });
  await instance.auth.createAccount({ username: 'owner_a', displayName: 'Owner A', password: 'PasswordA1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  await instance.auth.createAccount({ username: 'owner_b', displayName: 'Owner B', password: 'PasswordB1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  const ownerA = await instance.auth.login({ username: 'owner_a', password: 'PasswordA1!' });
  const ownerB = await instance.auth.login({ username: 'owner_b', password: 'PasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    root, memoryPath, originalPath, originalHash, protectedMemory, conversationRuntime,
    providerCalls, ownerA, ownerB, instance,
    baseUrl: `http://127.0.0.1:${instance.server.address().port}`,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      assert.equal(digest(originalPath), originalHash);
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function stream(h, cookie, body) {
  const response = await fetch(`${h.baseUrl}/api/ai/chat/stream`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { response, events: parseSse(await response.text()) };
}

test('authenticated SSE stores a fact in the isolated database and recalls it in a new conversation', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const saved = await stream(h, h.ownerA.setCookie, {
    message: '我妈妈5月6号生日。', clientRequestId: 'save-1', ownerId: h.ownerB.user.id
  });
  assert.equal(saved.response.status, 200);
  assert.equal(h.protectedMemory.inspectOwner(h.ownerA.user.id).currentMemories.length, 1);
  assert.equal(h.protectedMemory.inspectOwner(h.ownerB.user.id).currentMemories.length, 0);

  const providerCallsBeforeRecall = h.providerCalls.length;
  const recalled = await stream(h, h.ownerA.setCookie, {
    message: '我妈什么时候生日？', clientRequestId: 'query-new-conversation'
  });
  assert.deepEqual(recalled.events.filter((event) => event.type === 'delta').map((event) => event.data.text), ['5月6号。']);
  assert.equal(recalled.events.at(-1).type, 'completed');
  assert.equal(h.providerCalls.length, providerCallsBeforeRecall);
  assert.equal(digest(h.originalPath), h.originalHash);
});

test('an owner without evidence receives a sealed unknown answer without a Provider guess', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const beforeCalls = h.providerCalls.length;
  const result = await stream(h, h.ownerB.setCookie, {
    message: '我妈什么时候生日？', clientRequestId: 'owner-b-query', ownerId: h.ownerA.user.id
  });
  assert.deepEqual(result.events.filter((event) => event.type === 'delta').map((event) => event.data.text), ['我目前还不知道。']);
  assert.equal(h.providerCalls.length, beforeCalls);
  assert.equal(h.protectedMemory.inspectOwner(h.ownerA.user.id).currentMemories.length, 0);
});

test('incident birthday survives a new conversation and logout/login with the authenticated owner', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const saved = await stream(h, h.ownerA.setCookie, {
    message: '我女儿出生于2012年6月8日', clientRequestId: 'incident-birthday-save'
  });
  assert.equal(saved.response.status, 200);
  assert.equal(h.protectedMemory.inspectOwner(h.ownerA.user.id).currentMemories
    .filter((item) => item.predicate === 'birthday').length, 1);

  const sameConversationId = saved.events.find((event) => event.type === 'started').data.conversationId;
  const sameConversation = await stream(h, h.ownerA.setCookie, {
    conversationId: sameConversationId,
    message: '我女儿是什么时候出生的？', clientRequestId: 'incident-birthday-same-conversation'
  });
  assert.deepEqual(sameConversation.events.filter((event) => event.type === 'delta').map((event) => event.data.text),
    ['2012年6月8日。']);

  const logout = await fetch(`${h.baseUrl}/api/auth/logout`, {
    method: 'POST', headers: { cookie: h.ownerA.setCookie }
  });
  assert.equal(logout.status, 200);
  const login = await fetch(`${h.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner_a', password: 'PasswordA1!' })
  });
  assert.equal(login.status, 200);
  const reloggedCookie = login.headers.get('set-cookie');
  const afterRelogin = await stream(h, reloggedCookie, {
    message: '我女儿什么时候生日？', clientRequestId: 'incident-birthday-after-relogin'
  });
  assert.deepEqual(afterRelogin.events.filter((event) => event.type === 'delta').map((event) => event.data.text),
    ['2012年6月8日。']);
  assert.equal(h.protectedMemory.inspectOwner(h.ownerB.user.id).currentMemories.length, 0);
});
