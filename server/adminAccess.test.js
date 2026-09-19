import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBetaServer } from './betaServer.js';

const COOKIE_SECRET = 'test-cookie-secret-longer-than-24';

async function request(baseUrl, pathname, cookie = '', headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { ...(cookie ? { cookie } : {}), ...headers }
  });
  return { status: response.status, body: await response.json() };
}

test('admin APIs trust only the signed server session and return consistent 401/403', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-access-'));
  const aiCalls = [];
  const aiService = {
    getStatus() {
      return { available: true };
    },
    async run(task) {
      aiCalls.push(task);
      return { ok: true, content: 'AI秘书：你好', latency: 12, usage: null };
    },
    getAdminSettings() {
      return {
        provider: 'deepseek',
        providers: [{ id: 'deepseek', apiKeyConfigured: true, maskedApiKey: '****abcd', healthy: true }],
        router: { routes: {} }
      };
    },
    listTraces() {
      return [];
    }
  };
  const { server, auth } = await createBetaServer({
    config: {
      publicDir: path.join(dir, 'public'),
      authDb: path.join(dir, 'auth.sqlite'),
      cookieSecret: COOKIE_SECRET,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0
    },
    aiService
  });

  try {
    await auth.createAccount({ username: 'beta_user', displayName: 'Beta User', password: 'UserPassword1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
    await auth.createAccount({ username: 'beta_admin', displayName: 'Beta Admin', password: 'AdminPassword1!', role: 'admin', quotaProfileId: 'closed_beta_admin_v1' });
    const userLogin = await auth.login({ username: 'beta_user', password: 'UserPassword1!' });
    const adminLogin = await auth.login({ username: 'beta_admin', password: 'AdminPassword1!' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    assert.deepEqual(await request(baseUrl, '/api/auth/me'), {
      status: 401,
      body: { ok: false, user: null }
    });
    assert.deepEqual(await request(baseUrl, '/api/admin/users'), {
      status: 401,
      body: { ok: false, message: '请先登录。' }
    });
    assert.deepEqual(await request(baseUrl, '/api/admin/users', userLogin.setCookie), {
      status: 403,
      body: { ok: false, message: '无权限。' }
    });
    assert.deepEqual(await request(baseUrl, '/api/user/export-scope', userLogin.setCookie), {
      status: 200,
      body: { ok: true, userId: userLogin.user.id }
    });
    assert.deepEqual(await request(baseUrl, '/api/user/export-scope?userId=beta_admin', userLogin.setCookie), {
      status: 200,
      body: { ok: true, userId: userLogin.user.id }
    });
    assert.equal((await request(baseUrl, '/api/admin/providers', userLogin.setCookie, { 'x-user-role': 'admin' })).status, 403);

    assert.deepEqual(await request(baseUrl, '/api/ai/status', userLogin.setCookie), {
      status: 200,
      body: { ok: true, available: true }
    });
    const userChat = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { cookie: userLogin.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ input: '你好', capability: 'CHAT' })
    });
    assert.equal(userChat.status, 410);
    const userChatBody = await userChat.json();
    assert.deepEqual(userChatBody, {
      ok: false,
      code: 'LEGACY_CHAT_ENDPOINT_RETIRED',
      message: '该接口已停用，请使用正式聊天入口。'
    });
    assert.doesNotMatch(JSON.stringify(userChatBody), /provider|model|router|trace|api.?key|capability/i);
    assert.equal(aiCalls.length, 0);

    assert.equal((await request(baseUrl, '/api/admin/ai/settings', userLogin.setCookie)).status, 403);
    assert.equal((await request(baseUrl, '/api/admin/access/profiles', userLogin.setCookie)).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/admin/access/accounts/${userLogin.user.id}`, {
      method: 'PUT',
      headers: { cookie: userLogin.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'closed_beta_admin_v1', enabled: true })
    })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/admin/ai/providers/deepseek`, {
      method: 'PUT',
      headers: { cookie: userLogin.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'must-not-be-used' })
    })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/admin/ai/providers/deepseek/test`, {
      method: 'POST',
      headers: { cookie: userLogin.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'must-not-be-used' })
    })).status, 403);

    const adminUsers = await request(baseUrl, '/api/admin/users', adminLogin.setCookie);
    assert.equal(adminUsers.status, 200);
    assert.deepEqual(adminUsers.body.users.map(({ username, role }) => ({ username, role })), [
      { username: 'beta_user', role: 'beta_user' },
      { username: 'beta_admin', role: 'admin' }
    ]);
    assert.ok(adminUsers.body.users.every((user) => !('passwordHash' in user)));
    const adminAi = await request(baseUrl, '/api/admin/ai/settings', adminLogin.setCookie);
    assert.equal(adminAi.status, 200);
    assert.equal(adminAi.body.settings.providers[0].apiKeyConfigured, true);
    assert.equal('apiKey' in adminAi.body.settings.providers[0], false);

    const profiles = await request(baseUrl, '/api/admin/access/profiles', adminLogin.setCookie);
    assert.equal(profiles.status, 200);
    assert.deepEqual(profiles.body.profiles.map((profile) => profile.id), [
      'closed_beta_admin_v1',
      'closed_beta_user_v1'
    ]);

    const customProfile = await fetch(`${baseUrl}/api/admin/access/profiles/acceptance_small_v1`, {
      method: 'PUT',
      headers: { cookie: adminLogin.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        requestsPerMinute: 4,
        maxConcurrentRequests: 1,
        providerCallsPerDay: 10,
        inputTokensPerDay: 20000,
        outputTokensPerDay: 10000,
        dailyCostMicros: 1000000,
        monthlyCostMicros: 5000000,
        lifetimeCostMicros: 10000000,
        enabled: true
      })
    });
    assert.equal(customProfile.status, 200);
    assert.equal((await customProfile.json()).profile.id, 'acceptance_small_v1');

    const bind = await fetch(`${baseUrl}/api/admin/access/accounts/${userLogin.user.id}`, {
      method: 'PUT',
      headers: { cookie: adminLogin.setCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'acceptance_small_v1', enabled: true })
    });
    assert.equal(bind.status, 200);
    assert.equal((await bind.json()).accountAccess.profileId, 'acceptance_small_v1');

    const revoke = await fetch(`${baseUrl}/api/admin/access/accounts/${userLogin.user.id}/sessions/revoke`, {
      method: 'POST',
      headers: { cookie: adminLogin.setCookie }
    });
    assert.equal(revoke.status, 200);
    assert.deepEqual(await request(baseUrl, '/api/auth/me', userLogin.setCookie), {
      status: 401,
      body: { ok: false, user: null }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    auth.close();
    await rm(dir, { recursive: true, force: true });
  }
});
