import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRealUserMemoryRuntime } from '../memory/integration/index.js';
import { createBetaServer } from './betaServer.js';

const COOKIE_SECRET = 'fake-relogin-cookie-secret-long-enough';
const USERNAME = 'fake-user-a';

function fakePassword() {
  return `FakeOnly-${crypto.randomBytes(12).toString('hex')}!`;
}

async function request(baseUrl, route, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie') || ''
  };
}

async function start(directory) {
  const env = {
    MEMORY_REAL_USER_ENABLED: 'true',
    MEMORY_USER_WHITELIST: USERNAME
  };
  const runtime = createRealUserMemoryRuntime({ projectRoot: directory, env });
  const created = await createBetaServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      publicDir: path.resolve('apps/desktop/dist'),
      authDb: path.join(directory, 'auth.sqlite'),
      aiConfig: path.join(directory, 'ai-settings.json'),
      cookieSecret: COOKIE_SECRET,
      secureCookie: false
    },
    aiService: { getStatus: () => ({ available: false }) },
    memoryRuntime: runtime
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  return {
    ...created,
    baseUrl: `http://127.0.0.1:${created.server.address().port}`,
    async close() {
      await new Promise((resolve) => created.server.close(resolve));
      await runtime.close();
      created.auth.close();
    }
  };
}

async function login(instance, password) {
  return request(instance.baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: USERNAME, password }
  });
}

async function conversation(instance, cookie, input, suffix, idempotencyKey = `fake-${suffix}`) {
  return request(instance.baseUrl, '/api/memory/conversation', {
    method: 'POST',
    cookie,
    body: {
      input,
      sourceId: `fake-source-${suffix}`,
      requestId: `fake-request-${suffix}`,
      correlationId: `fake-correlation-${suffix}`,
      conversationId: `fake-conversation-${suffix}`,
      idempotencyKey
    }
  });
}

test('persistent recall survives logout, a new session, backend restart and a fresh client', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-relogin-recall-'));
  const password = fakePassword();
  let instance = await start(directory);
  try {
    const account = await instance.auth.createAccount({
      username: USERNAME,
      displayName: 'Fake User A',
      password,
      role: 'user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    const memoryPath = instance.memoryRuntime.paths.databasePath;
    const firstLogin = await login(instance, password);
    assert.equal(firstLogin.status, 200);
    assert.equal(firstLogin.body.user.id, account.id);

    const firstSave = await conversation(instance, firstLogin.cookie, '记住我喜欢吃虚构辣味食物', 'save-food', 'fake-idempotency-food');
    assert.equal(firstSave.body.result.status, 'stored');
    const secondSave = await conversation(instance, firstLogin.cookie, '记住我喜欢喝虚构温热饮品', 'save-drink', 'fake-idempotency-drink');
    assert.equal(secondSave.body.result.status, 'stored');
    const replay = await conversation(instance, firstLogin.cookie, '记住我喜欢吃虚构辣味食物', 'save-food', 'fake-idempotency-food');
    assert.equal(replay.body.result.memoryId, firstSave.body.result.memoryId);

    const sameSession = await conversation(instance, firstLogin.cookie, '我最喜欢吃什么？', 'same-session');
    assert.equal(sameSession.body.result.status, 'recalled');

    const logout = await request(instance.baseUrl, '/api/auth/logout', { method: 'POST', cookie: firstLogin.cookie });
    assert.equal(logout.status, 200);
    assert.equal((await conversation(instance, firstLogin.cookie, '我最喜欢吃什么？', 'revoked-session')).status, 401);

    const secondLogin = await login(instance, password);
    assert.equal(secondLogin.body.user.id, account.id);
    const newSession = await conversation(instance, secondLogin.cookie, '我最喜欢吃什么？', 'new-session');
    assert.equal(newSession.body.result.status, 'recalled');
    assert.equal(newSession.body.result.memoryContext.items.length, 2);
    assert.equal(instance.memoryRuntime.paths.databasePath, memoryPath);

    const listed = await request(instance.baseUrl, '/api/memory/memories', { cookie: secondLogin.cookie });
    assert.equal(listed.body.result.data.items.length, 2);

    await instance.close();
    instance = await start(directory);
    assert.equal(instance.memoryRuntime.paths.databasePath, memoryPath);
    const afterRestartLogin = await login(instance, password);
    assert.equal(afterRestartLogin.body.user.id, account.id);
    const afterBackendRestart = await conversation(instance, afterRestartLogin.cookie, '我最喜欢吃什么？', 'backend-restart');
    assert.equal(afterBackendRestart.body.result.status, 'recalled');

    const freshClientLogin = await login(instance, password);
    const afterFrontendRestart = await conversation(instance, freshClientLogin.cookie, '我最喜欢吃什么？', 'frontend-restart');
    assert.equal(afterFrontendRestart.body.result.status, 'recalled');
    const finalList = await request(instance.baseUrl, '/api/memory/memories', { cookie: freshClientLogin.cookie });
    assert.equal(finalList.body.result.data.items.length, 2);
  } finally {
    await instance.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
