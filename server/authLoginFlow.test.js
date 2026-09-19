import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveBetaAuthDbPath } from '../core/auth/betaAuthConfig.js';
import { createBetaServer } from './betaServer.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'scripts/beta-auth-cli.js');
const cookieSecret = 'test-cookie-secret-longer-than-24';

function fixturePassword(label) {
  return `${label}Aa1!${crypto.randomBytes(12).toString('hex')}`;
}

function runCli(args, dbPath, accessDbPath, input = '') {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AI_SECRETARY_AUTH_DB: dbPath,
      AI_SECRETARY_ACCESS_CONTROL_DB: accessDbPath,
      AI_SECRETARY_COOKIE_SECRET: cookieSecret
    },
    encoding: 'utf8',
    input
  });
}

async function login(baseUrl, username, password, extra = {}) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, ...extra })
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get('set-cookie') || ''
  };
}

async function me(baseUrl, cookie = '') {
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: cookie ? { cookie } : {}
  });
  return { status: response.status, body: await response.json() };
}

function assertSameAuthDatabase(cliDb, serverDb) {
  assert.equal(
    path.resolve(serverDb),
    path.resolve(cliDb),
    'CLI and login server must use the same authentication database'
  );
}

test('CLI accounts authenticate through HTTP with one database and secure sessions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-auth-flow-'));
  const dbPath = path.join(dir, 'auth.sqlite');
  const accessDbPath = path.join(dir, 'access-control.sqlite');
  const userPassword = fixturePassword('user');
  const resetPassword = fixturePassword('reset');
  const adminPassword = fixturePassword('admin');
  const inactivePassword = fixturePassword('inactive');
  const huagePassword = fixturePassword('huage');
  const userCreate = runCli([
    'create', '--username', 'beta_user', '--display-name', 'Beta User',
    '--role', 'user', '--quota-profile', 'closed_beta_user_v1'
  ], dbPath, accessDbPath, `${userPassword}\n`);
  const adminCreate = runCli([
    'create', '--username', 'beta_admin', '--display-name', 'Beta Admin',
    '--role', 'admin', '--quota-profile', 'closed_beta_admin_v1'
  ], dbPath, accessDbPath, `${adminPassword}\n`);
  assert.equal(userCreate.status, 0, userCreate.stderr);
  assert.equal(adminCreate.status, 0, adminCreate.stderr);
  assert.doesNotMatch(userCreate.stdout + userCreate.stderr + adminCreate.stdout + adminCreate.stderr, /UserPassword|AdminPassword/);

  const config = {
    publicDir: path.join(dir, 'public'),
    authDb: dbPath,
    accessControlDb: accessDbPath,
    trustedProxyIps: ['127.0.0.1'],
    cookieSecret,
    secureCookie: false,
    financeF201Enabled: true,
    host: '127.0.0.1',
    port: 0
  };
  assertSameAuthDatabase(resolveBetaAuthDbPath({ env: { AI_SECRETARY_AUTH_DB: dbPath }, projectRoot }), config.authDb);
  const { server, auth } = await createBetaServer({ config });

  try {
    await auth.createAccount({
      username: 'inactive_user', displayName: 'Inactive',
      password: inactivePassword, role: 'user', status: 'disabled',
      quotaProfileId: 'closed_beta_user_v1'
    });
    await auth.createAccount({
      username: 'huage', displayName: 'Huage', password: huagePassword,
      role: 'admin', quotaProfileId: 'closed_beta_admin_v1'
    });
    const huageBefore = auth.db.prepare('SELECT * FROM accounts WHERE username = ?').get('huage');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    assert.deepEqual(await me(baseUrl), { status: 401, body: { ok: false, user: null } });
    assert.deepEqual(await login(baseUrl, 'beta_user', 'wrong-password'), {
      status: 401,
      body: { ok: false, message: '用户名或密码错误。' },
      cookie: ''
    });
    assert.deepEqual(await login(baseUrl, 'missing_user', userPassword), {
      status: 401,
      body: { ok: false, message: '用户名或密码错误。' },
      cookie: ''
    });
    assert.equal((await login(baseUrl, 'inactive_user', inactivePassword)).status, 401);

    const userLogin = await login(baseUrl, ' beta_user ', userPassword, { role: 'admin' });
    assert.equal(userLogin.status, 200);
    assert.equal(userLogin.body.user.role, 'user');
    assert.deepEqual(userLogin.body.featureFlags, { financeF201Enabled: true });
    assert.match(userLogin.cookie, /^ai_secretary_session=/);
    assert.match(userLogin.cookie, /HttpOnly/);
    assert.match(userLogin.cookie, /SameSite=Lax/);
    assert.match(userLogin.cookie, /Path=\//);
    assert.doesNotMatch(userLogin.cookie, /; Secure/);
    const currentUser = await me(baseUrl, userLogin.cookie);
    assert.equal(currentUser.status, 200);
    assert.equal(currentUser.body.ok, true);
    assert.equal(currentUser.body.user.id, userLogin.body.user.id);
    assert.equal(currentUser.body.user.username, 'beta_user');
    assert.equal(currentUser.body.user.role, 'user');
    assert.equal(currentUser.body.user.status, 'active');
    assert.equal(currentUser.body.user.updatedAt, currentUser.body.user.lastLoginAt);
    assert.deepEqual(currentUser.body.featureFlags, { financeF201Enabled: true });

    const adminLogin = await login(baseUrl, 'beta_admin', adminPassword);
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.body.user.role, 'admin');

    const reset = runCli(
      ['reset-password', '--username', 'beta_user'],
      dbPath,
      accessDbPath,
      `${resetPassword}\n`
    );
    assert.equal(reset.status, 0, reset.stderr);
    assert.doesNotMatch(reset.stdout + reset.stderr, /UserPassword/);
    assert.equal((await login(baseUrl, 'beta_user', userPassword)).status, 401);
    const resetLogin = await login(baseUrl, 'beta_user', resetPassword);
    assert.equal(resetLogin.status, 200);
    const huageAfter = auth.db.prepare('SELECT * FROM accounts WHERE username = ?').get('huage');
    assert.deepEqual(huageAfter, huageBefore, 'resetting beta_user must not modify huage');

    auth.db.prepare('UPDATE sessions SET expiresAt = ? WHERE accountId = ?').run('2000-01-01T00:00:00.000Z', resetLogin.body.user.id);
    assert.deepEqual(await me(baseUrl, resetLogin.cookie), { status: 401, body: { ok: false, user: null } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    auth.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('forged X-Forwarded-For cannot split the IP failure window for an untrusted peer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-xff-flow-'));
  const config = {
    publicDir: path.join(dir, 'public'),
    authDb: path.join(dir, 'auth.sqlite'),
    accessControlDb: path.join(dir, 'access-control.sqlite'),
    trustedProxyIps: ['10.0.0.1'],
    cookieSecret,
    secureCookie: false,
    host: '127.0.0.1',
    port: 0
  };
  const { server, auth } = await createBetaServer({ config });
  try {
    await auth.createAccount({
      username: 'xff_user',
      displayName: 'XFF User',
      password: 'CorrectPassword1!',
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let last;
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.${index + 1}`
        },
        body: JSON.stringify({
          username: `missing_${index}`,
          password: 'wrong-password'
        })
      });
      last = { status: response.status, body: await response.json() };
    }
    assert.equal(last.status, 429);
    assert.deepEqual(last.body, { ok: false, message: '登录失败，请稍后再试。' });

    const blocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.200'
      },
      body: JSON.stringify({
        username: 'xff_user',
        password: 'CorrectPassword1!'
      })
    });
    assert.equal(blocked.status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    auth.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('database path mismatch fails with an explicit diagnostic', () => {
  assert.throws(
    () => assertSameAuthDatabase('/tmp/cli-auth.sqlite', '/tmp/server-auth.sqlite'),
    /CLI and login server must use the same authentication database/
  );
});
