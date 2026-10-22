import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BetaAuthService } from '../core/auth/betaAuthService.js';
import { AccessControlService } from '../server/access/accessControlService.js';
import { AccessControlStore } from '../server/access/accessControlStore.js';
import { resolveBetaAuthDbPath } from './beta-auth-config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'scripts/beta-auth-cli.js');

function runCli(args, { dbPath, accessDbPath = path.join(path.dirname(dbPath), 'access-control.sqlite'),
  input = '' } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AI_SECRETARY_AUTH_DB: dbPath,
      AI_SECRETARY_ACCESS_CONTROL_DB: accessDbPath,
      AI_SECRETARY_COOKIE_SECRET: 'test-cookie-secret-minimum-32-bytes'
    },
    encoding: 'utf8',
    input
  });
}

test('resolves auth database paths for local, production, and explicit environments', () => {
  assert.equal(
    resolveBetaAuthDbPath({ env: {}, projectRoot }),
    path.join(projectRoot, 'data/auth/auth.sqlite')
  );
  assert.equal(
    resolveBetaAuthDbPath({ env: { NODE_ENV: 'production' }, projectRoot }),
    '/data/auth/auth.sqlite'
  );
  assert.equal(
    resolveBetaAuthDbPath({ env: { AI_SECRETARY_DATA_DIR: '/srv/ai-secretary' }, projectRoot }),
    '/srv/ai-secretary/auth/auth.sqlite'
  );
  assert.equal(
    resolveBetaAuthDbPath({ env: { AI_SECRETARY_AUTH_DB: '/custom/auth.sqlite' }, projectRoot }),
    '/custom/auth.sqlite'
  );
});

test('local CLI supports create, list, reset-password, and disable without exposing passwords', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-auth-cli-'));
  const dbPath = path.join(dir, 'auth.sqlite');
  const accessDbPath = path.join(dir, 'access-control.sqlite');
  try {
    const create = runCli([
      'create',
      '--username', 'cli-admin',
      '--display-name', 'CLI Admin',
      '--role', 'admin',
      '--quota-profile', 'closed_beta_admin_v1'
    ], {
      dbPath,
      accessDbPath,
      input: 'InitialPassword1!\n'
    });
    assert.equal(create.status, 0, create.stderr);
    assert.match(create.stdout, /created cli-admin \(admin\)/);
    assert.doesNotMatch(create.stdout + create.stderr, /InitialPassword1!/);

    const list = runCli(['list'], { dbPath, accessDbPath });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /cli-admin/);
    assert.match(list.stdout, /active/);

    const reset = runCli(['reset-password', '--username', 'cli-admin'], {
      dbPath,
      accessDbPath,
      input: 'UpdatedPassword2!\n'
    });
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /password reset for cli-admin/);
    assert.doesNotMatch(reset.stdout + reset.stderr, /UpdatedPassword2!/);

    const accessStore = new AccessControlStore({ dbPath: accessDbPath }).initialize();
    const accessControl = new AccessControlService({
      store: accessStore,
      hmacSecret: 'test-cookie-secret-minimum-32-bytes'
    });
    const service = new BetaAuthService({
      dbPath,
      cookieSecret: 'test-cookie-secret-minimum-32-bytes',
      secureCookie: false,
      accessControl
    });
    await service.initialize();
    const login = await service.login({ username: 'cli-admin', password: 'UpdatedPassword2!' });
    service.close();
    accessStore.close();
    assert.equal(login.ok, true);

    const disable = runCli(['disable', '--username', 'cli-admin'], { dbPath, accessDbPath });
    assert.equal(disable.status, 0, disable.stderr);
    assert.match(disable.stdout, /disabled cli-admin/);

    const afterDisable = runCli(['list'], { dbPath, accessDbPath });
    assert.equal(afterDisable.status, 0, afterDisable.stderr);
    assert.match(afterDisable.stdout, /disabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
