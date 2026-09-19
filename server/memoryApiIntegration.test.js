import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from './betaServer.js';

const fakeUser = { id: 'fake-user-a', username: 'fake-user-a', displayName: 'Fake User', status: 'active', role: 'user' };

function fakeRuntime() {
  const calls = [];
  const service = {
    getStatus(user) { calls.push(['status', user]); return { enabled: true, flags: { MEMORY_REAL_USER_ENABLED: true } }; },
    processConversation(user, body) { calls.push(['conversation', user, body]); return { enabled: true, handled: false, status: 'empty', memoryContext: { items: [] } }; },
    confirmCapture(user, body) { calls.push(['confirm', user, body]); return { status: 'stored', memoryId: 'fake-memory' }; },
    listMemories(user, query) { calls.push(['list', user, query]); return { status: 'completed', data: { items: [] } }; },
    getMemoryDetails(user, id) { calls.push(['details', user, id]); return { status: 'completed', data: { memoryId: id } }; },
    getMemoryHistory(user, id) { calls.push(['history', user, id]); return { status: 'completed', data: { items: [{ memoryId: id }] } }; },
    correctMemory(user, id, body) { calls.push(['correct', user, id, body]); return { status: 'completed', memoryId: 'fake-corrected' }; },
    deleteMemory(user, id, body) { calls.push(['delete', user, id, body]); return { status: 'completed', memoryId: id }; },
    restoreMemory(user, id, body) { calls.push(['restore', user, id, body]); return { status: 'completed', memoryId: id }; },
    purgeMemory(user, id, body) { calls.push(['purge', user, id, body]); return { status: 'confirmation_required', memoryId: id }; },
    getTimeline(user, query) { calls.push(['timeline', user, query]); return { ok: true, events: [] }; },
    getIntelligence(user, query) { calls.push(['intelligence', user, query]); return { ok: true, insights: [] }; }
  };
  return { calls, service, initialize: async () => ({ status: 'ready', pathSummary: 'data/memory/memory.sqlite' }), close: async () => {} };
}

async function request(baseUrl, route, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') || '' };
}

test('memory API binds every operation to the authenticated session and never accepts anonymous access', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-memory-api-'));
  const runtime = fakeRuntime();
  const { server, auth } = await createBetaServer({
    config: {
      host: '127.0.0.1', port: 0, publicDir: path.resolve('apps/desktop/dist'),
      authDb: path.join(directory, 'auth.sqlite'), cookieSecret: 'fake-memory-api-cookie-secret', secureCookie: false,
      aiConfig: path.join(directory, 'ai-settings.json')
    },
    aiService: { getStatus: () => ({ available: false }) },
    memoryRuntime: runtime
  });
  try {
    await auth.createAccount({ username: fakeUser.username, displayName: fakeUser.displayName, password: 'FakePassword123!', role: 'user', quotaProfileId: 'closed_beta_user_v1' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    assert.equal((await request(baseUrl, '/api/memory/status')).status, 401);
    const login = await request(baseUrl, '/api/auth/login', {
      method: 'POST', body: { username: fakeUser.username, password: 'FakePassword123!' }
    });
    assert.equal(login.status, 200);
    const cookie = login.cookie;

    const cases = [
      ['/api/memory/status', 'GET', undefined, 'status'],
      ['/api/memory/conversation', 'POST', { input: '你好' }, 'conversation'],
      ['/api/memory/confirm', 'POST', { confirmationId: 'fake-confirm', action: 'confirm' }, 'confirm'],
      ['/api/memory/memories', 'GET', undefined, 'list'],
      ['/api/memory/memories/fake-memory', 'GET', undefined, 'details'],
      ['/api/memory/memories/fake-memory/history', 'GET', undefined, 'history'],
      ['/api/memory/memories/fake-memory/correct', 'POST', { expectedVersion: 1, value: 'fake correction' }, 'correct'],
      ['/api/memory/memories/fake-memory/delete', 'POST', { expectedVersion: 1 }, 'delete'],
      ['/api/memory/memories/fake-memory/restore', 'POST', { expectedVersion: 2 }, 'restore'],
      ['/api/memory/memories/fake-memory/purge', 'POST', { expectedVersion: 1 }, 'purge'],
      ['/api/memory/timeline', 'GET', undefined, 'timeline'],
      ['/api/memory/intelligence', 'GET', undefined, 'intelligence']
    ];
    for (const [route, method, body, expectedCall] of cases) {
      const response = await request(baseUrl, route, { method, body, cookie });
      assert.equal(response.status, 200, route);
      assert.equal(response.body.ok, true, route);
      assert.equal(runtime.calls.at(-1)[0], expectedCall, route);
      assert.equal(runtime.calls.at(-1)[1].username, fakeUser.username, route);
      assert.equal('passwordHash' in runtime.calls.at(-1)[1], false, route);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('forged userId on a memory request fails closed before the service sees it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-memory-forged-'));
  const runtime = fakeRuntime();
  const { server, auth } = await createBetaServer({
    config: {
      host: '127.0.0.1', port: 0, publicDir: path.resolve('apps/desktop/dist'),
      authDb: path.join(directory, 'auth.sqlite'), cookieSecret: 'fake-memory-forged-cookie-secret', secureCookie: false,
      aiConfig: path.join(directory, 'ai-settings.json')
    },
    aiService: { getStatus: () => ({ available: false }) },
    memoryRuntime: runtime
  });
  try {
    await auth.createAccount({ username: fakeUser.username, displayName: fakeUser.displayName, password: 'FakePassword123!', role: 'user', quotaProfileId: 'closed_beta_user_v1' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: fakeUser.username, password: 'FakePassword123!' } });
    const response = await request(baseUrl, '/api/memory/conversation', {
      method: 'POST', cookie: login.cookie, body: { input: '你好', userId: 'fake-user-b' }
    });
    assert.equal(response.status, 403);
    assert.equal(runtime.calls.some(([name]) => name === 'conversation'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    auth.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
