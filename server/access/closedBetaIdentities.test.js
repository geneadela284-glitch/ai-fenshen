import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const COOKIE_SECRET = crypto.randomBytes(32).toString('base64url');
const NOW = new Date('2026-08-02T06:00:00.000Z');

function fixturePassword(label) {
  return `${label}Aa1!${crypto.randomBytes(16).toString('hex')}`;
}

async function requestJson(baseUrl, pathname, { method = 'GET', cookie = '', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function requestText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, text: await response.text() };
}

async function login(baseUrl, username, password, forged = {}) {
  const response = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username, password, ...forged }
  });
  return {
    ...response,
    cookie: response.headers.get('set-cookie') || ''
  };
}

async function sendFinanceMessage(baseUrl, cookie, { conversationId, message, clientRequestId, ownerId }) {
  const response = await fetch(`${baseUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, message, clientRequestId, ownerId })
  });
  return { status: response.status, text: await response.text() };
}

function isolatedPaths(root) {
  return {
    auth: path.join(root, 'auth', 'auth.sqlite'),
    access: path.join(root, 'access', 'access-control.sqlite'),
    finance: path.join(root, 'finance', 'finance.sqlite'),
    conversation: path.join(root, 'conversation', 'conversation.sqlite'),
    privacy: path.join(root, 'privacy', 'privacy.sqlite'),
    privacyExports: path.join(root, 'privacy', 'exports')
  };
}

function storageArguments(root, paths = isolatedPaths(root)) {
  return {
    isolationRoot: root,
    authDb: paths.auth,
    accessControlDb: paths.access,
    financeDb: paths.finance,
    conversationDb: paths.conversation,
    privacyDb: paths.privacy,
    privacyExportDir: paths.privacyExports
  };
}

function environmentOptions(storageConfig, overrides = {}) {
  return {
    storageConfig,
    cookieSecret: COOKIE_SECRET,
    testOnlyClock: () => new Date(NOW),
    testOnlyAllowRoot: true,
    ...overrides
  };
}

function assertCode(code) {
  return (error) => error?.code === code;
}

function directorySnapshot(root) {
  return readdirSync(root, { recursive: true }).map(String).sort();
}

test('CT-2 rejects missing, relative, broad, production, outside, and symlinked storage before opening SQLite', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  assert.equal(
    typeof identityModule.createClosedBetaIsolationConfig,
    'function',
    'CT-2 requires a fail-closed pre-open isolation factory'
  );
  const createConfig = identityModule.createClosedBetaIsolationConfig;
  const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-config-'));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-outside-'));
  const paths = isolatedPaths(isolatedRoot);
  try {
    assert.throws(() => createConfig({}), assertCode('CLOSED_BETA_ISOLATION_ROOT_REQUIRED'));
    assert.throws(() => createConfig({
      isolationRoot: 'relative/closed-beta',
      authDb: 'relative/auth.sqlite',
      accessControlDb: 'relative/access.sqlite',
      financeDb: 'relative/finance.sqlite',
      conversationDb: 'relative/conversation.sqlite',
      privacyDb: 'relative/privacy.sqlite',
      privacyExportDir: 'relative/privacy-exports'
    }), assertCode('CLOSED_BETA_PATH_MUST_BE_ABSOLUTE'));
    assert.throws(() => createConfig({
      isolationRoot: path.parse(isolatedRoot).root,
      ...{
        authDb: paths.auth,
        accessControlDb: paths.access,
        financeDb: paths.finance,
        conversationDb: paths.conversation,
        privacyDb: paths.privacy,
        privacyExportDir: paths.privacyExports
      }
    }), assertCode('CLOSED_BETA_ISOLATION_ROOT_UNSAFE'));
    assert.throws(() => createConfig({
      isolationRoot: '/data',
      authDb: '/data/auth/auth.sqlite',
      accessControlDb: '/data/access/access.sqlite',
      financeDb: '/data/finance/finance.sqlite',
      conversationDb: '/data/conversation/conversation.sqlite',
      privacyDb: '/data/privacy/privacy.sqlite',
      privacyExportDir: '/data/privacy/exports'
    }), assertCode('CLOSED_BETA_PRODUCTION_PATH_FORBIDDEN'));
    assert.throws(() => createConfig({
      isolationRoot: isolatedRoot,
      authDb: path.join(outsideRoot, 'auth.sqlite'),
      accessControlDb: paths.access,
      financeDb: paths.finance,
      conversationDb: paths.conversation,
      privacyDb: paths.privacy,
      privacyExportDir: paths.privacyExports
    }), assertCode('CLOSED_BETA_STORAGE_OUTSIDE_ISOLATION_ROOT'));
    assert.throws(() => createConfig({
      isolationRoot: isolatedRoot,
      authDb: 'relative-auth.sqlite',
      accessControlDb: paths.access,
      financeDb: paths.finance,
      conversationDb: paths.conversation,
      privacyDb: paths.privacy,
      privacyExportDir: paths.privacyExports
    }), assertCode('CLOSED_BETA_PATH_MUST_BE_ABSOLUTE'));

    symlinkSync(outsideRoot, path.join(isolatedRoot, 'escaped'));
    assert.throws(() => createConfig({
      isolationRoot: isolatedRoot,
      authDb: path.join(isolatedRoot, 'escaped', 'auth.sqlite'),
      accessControlDb: paths.access,
      financeDb: paths.finance,
      conversationDb: paths.conversation,
      privacyDb: paths.privacy,
      privacyExportDir: paths.privacyExports
    }), assertCode('CLOSED_BETA_SYMLINK_FORBIDDEN'));

    const existingAuth = path.join(isolatedRoot, 'existing-auth.sqlite');
    writeFileSync(existingAuth, 'pre-existing');
    assert.throws(() => createConfig({
      isolationRoot: isolatedRoot,
      authDb: existingAuth,
      accessControlDb: paths.access,
      financeDb: paths.finance,
      conversationDb: paths.conversation,
      privacyDb: paths.privacy,
      privacyExportDir: paths.privacyExports
    }), assertCode('CLOSED_BETA_STORAGE_ALREADY_EXISTS'));

    const hardlinkSource = path.join(isolatedRoot, 'hardlink-source.sqlite');
    const hardlinkedAuth = path.join(isolatedRoot, 'hardlinked-auth.sqlite');
    writeFileSync(hardlinkSource, 'pre-existing-hardlink');
    linkSync(hardlinkSource, hardlinkedAuth);
    assert.throws(() => createConfig({
      isolationRoot: isolatedRoot,
      authDb: hardlinkedAuth,
      accessControlDb: paths.access,
      financeDb: paths.finance,
      conversationDb: paths.conversation,
      privacyDb: paths.privacy,
      privacyExportDir: paths.privacyExports
    }), assertCode('CLOSED_BETA_STORAGE_ALREADY_EXISTS'));

    const escapedPrivacyRoot = path.join(isolatedRoot, 'privacy-escaped');
    symlinkSync(outsideRoot, escapedPrivacyRoot);
    assert.throws(() => createConfig({
      ...storageArguments(isolatedRoot, paths),
      privacyDb: path.join(escapedPrivacyRoot, 'privacy.sqlite'),
      privacyExportDir: path.join(escapedPrivacyRoot, 'exports')
    }), assertCode('CLOSED_BETA_SYMLINK_FORBIDDEN'));

    const existingPrivacy = path.join(isolatedRoot, 'existing-privacy.sqlite');
    writeFileSync(existingPrivacy, 'pre-existing-privacy');
    assert.throws(() => createConfig({
      ...storageArguments(isolatedRoot, paths),
      privacyDb: existingPrivacy
    }), assertCode('CLOSED_BETA_STORAGE_ALREADY_EXISTS'));

    const privacyHardlinkSource = path.join(isolatedRoot, 'privacy-hardlink-source.sqlite');
    const hardlinkedPrivacy = path.join(isolatedRoot, 'hardlinked-privacy.sqlite');
    writeFileSync(privacyHardlinkSource, 'pre-existing-privacy-hardlink');
    linkSync(privacyHardlinkSource, hardlinkedPrivacy);
    assert.throws(() => createConfig({
      ...storageArguments(isolatedRoot, paths),
      privacyDb: hardlinkedPrivacy
    }), assertCode('CLOSED_BETA_STORAGE_ALREADY_EXISTS'));

    const valid = createConfig(storageArguments(isolatedRoot, paths));
    assert.deepEqual(valid.paths, paths);
    assert.equal(Object.values(paths).some(existsSync), false, 'pre-open validation must not create databases');
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

async function createIsolatedAuthHarness(identityModule) {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-provision-'));
  const paths = isolatedPaths(root);
  const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(root, paths));
  let environment;
  try {
    const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
    environment = await identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
      privacyPreparation
    }));
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    environment,
    storageConfig,
    async close() {
      await environment.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('CT-2 requires a separate explicit Privacy preparation handle and rejects missing or forged handles', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  assert.equal(typeof identityModule.prepareCt2PrivacyCompatibility, 'function');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-explicit-privacy-prepare-'));
  let environment;
  try {
    const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(root));
    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig)),
      assertCode('CLOSED_BETA_PRIVACY_PREPARATION_REQUIRED')
    );
    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
        privacyPreparation: Object.freeze({ prepared: true })
      })),
      assertCode('CLOSED_BETA_PRIVACY_PREPARATION_REQUIRED')
    );
    const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
    assert.equal('storageConfig' in privacyPreparation, false);
    environment = await identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
      privacyPreparation
    }));
    assert.equal(environment.testOnly.inspect().databasePaths.privacy, realpathSync(storageConfig.paths.privacy));
  } finally {
    try { await environment?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('CT-2 validates an invalid clock before consuming the one-time Privacy preparation handle', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const container = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-invalid-clock-'));
  const root = path.join(container, 'isolated');
  mkdirSync(root, { mode: 0o700 });
  let environment;
  try {
    const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(root));
    const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
    const beforeFailure = directorySnapshot(container);

    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
        privacyPreparation,
        testOnlyClock: () => new Date('invalid')
      })),
      assertCode('CLOSED_BETA_CLOCK_INVALID')
    );
    assert.deepEqual(directorySnapshot(container), beforeFailure, 'clock rejection must not create candidate resources');

    environment = await identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
      privacyPreparation,
      testOnlyClock: () => new Date(NOW)
    }));
    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
        privacyPreparation,
        testOnlyClock: () => new Date(NOW)
      })),
      assertCode('CLOSED_BETA_PRIVACY_PREPARATION_REQUIRED')
    );
  } finally {
    try { await environment?.close(); } catch {}
    rmSync(container, { recursive: true, force: true });
  }
});

test('CT-2 keeps the Privacy preparation handle retryable when the clock throws', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const container = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-throwing-clock-'));
  const root = path.join(container, 'isolated');
  mkdirSync(root, { mode: 0o700 });
  let environment;
  try {
    const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(root));
    const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
    const beforeFailure = directorySnapshot(container);

    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
        privacyPreparation,
        testOnlyClock: () => { throw new Error('CLOCK_EXPLODED'); }
      })),
      /CLOCK_EXPLODED/
    );
    assert.deepEqual(directorySnapshot(container), beforeFailure, 'throwing clock must not create candidate resources');

    environment = await identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
      privacyPreparation,
      testOnlyClock: () => new Date(NOW)
    }));
    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
        privacyPreparation,
        testOnlyClock: () => new Date(NOW)
      })),
      assertCode('CLOSED_BETA_PRIVACY_PREPARATION_REQUIRED')
    );
  } finally {
    try { await environment?.close(); } catch {}
    rmSync(container, { recursive: true, force: true });
  }
});

test('CT-2 compensation removes the first identity and exposes rollback cleanup failure', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const credentials = {
    closed_beta_admin_v1: { password: fixturePassword('admin') },
    closed_beta_user_v1: { password: fixturePassword('user') }
  };

  const cleaned = await createIsolatedAuthHarness(identityModule);
  try {
    cleaned.environment.testOnly.configureProvisionFailure({ failSecondCreate: true });
    await assert.rejects(
      identityModule.provisionClosedBetaIdentities({
        environment: cleaned.environment,
        credentials
      }),
      assertCode('SECOND_IDENTITY_FAILED')
    );
    assert.deepEqual(cleaned.environment.testOnly.inspect().accounts, []);
    assert.deepEqual(cleaned.environment.testOnly.inspect().accessBindings, []);
  } finally {
    await cleaned.close();
  }

  const incomplete = await createIsolatedAuthHarness(identityModule);
  try {
    incomplete.environment.testOnly.configureProvisionFailure({
      failSecondCreate: true,
      failAuthCleanup: true,
      failAccessCleanup: true
    });
    await assert.rejects(
      identityModule.provisionClosedBetaIdentities({
        environment: incomplete.environment,
        credentials
      }),
      (error) => (
        error?.code === 'CLOSED_BETA_ROLLBACK_INCOMPLETE' &&
        error?.requiresIsolationRootDestruction === true &&
        error?.originalCode === 'SECOND_IDENTITY_FAILED' &&
        Array.isArray(error?.cleanupCodes) &&
        error.cleanupCodes.includes('AUTH_CLEANUP_FAILED') &&
        error.cleanupCodes.includes('ACCESS_CLEANUP_FAILED')
      )
    );
    assert.equal(incomplete.environment.testOnly.cleanupStatus().state, 'poisoned');
    await assert.rejects(incomplete.environment.listen(), assertCode('CLOSED_BETA_ENVIRONMENT_POISONED'));
    await assert.rejects(
      identityModule.provisionClosedBetaIdentities({ environment: incomplete.environment, credentials }),
      assertCode('CLOSED_BETA_ENVIRONMENT_POISONED')
    );
  } finally {
    await incomplete.close();
  }
});

test('CT-2 rejects weak closed-beta credentials before creating either identity', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const harness = await createIsolatedAuthHarness(identityModule);
  try {
    await assert.rejects(
      identityModule.provisionClosedBetaIdentities({
        environment: harness.environment,
        credentials: {
          closed_beta_admin_v1: { password: '12345678' },
          closed_beta_user_v1: { password: 'password12345678' }
        }
      }),
      assertCode('CLOSED_BETA_CREDENTIAL_WEAK')
    );
    assert.deepEqual(harness.environment.testOnly.inspect().accounts, []);
  } finally {
    await harness.close();
  }
});

test('CT-2 validated config provenance cannot be copied or symbol-forged', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-provenance-'));
  const paths = isolatedPaths(root);
  try {
    const valid = identityModule.createClosedBetaIsolationConfig(storageArguments(root, paths));
    const copied = { ...valid, paths: { ...valid.paths } };
    for (const symbol of Object.getOwnPropertySymbols(valid)) {
      Object.defineProperty(copied, symbol, Object.getOwnPropertyDescriptor(valid, symbol));
    }
    assert.throws(
      () => identityModule.assertClosedBetaIsolationConfig(copied),
      assertCode('CLOSED_BETA_ISOLATION_CONFIG_REQUIRED')
    );
    assert.equal(identityModule.assertClosedBetaIsolationConfig(valid), valid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CT-2 safe environment rejects storage/public overrides, root execution, and weak Cookie secrets before SQLite', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-environment-'));
  const paths = isolatedPaths(root);
  try {
    const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(root, paths));
    await assert.rejects(
      identityModule.createClosedBetaEnvironment({
        ...environmentOptions(storageConfig),
        financeDb: '/data/finance/finance.sqlite'
      }),
      assertCode('CLOSED_BETA_ENVIRONMENT_OVERRIDE_FORBIDDEN')
    );
    await assert.rejects(
      identityModule.createClosedBetaEnvironment({
        ...environmentOptions(storageConfig),
        conversationDb: '/data/conversations/conversations.sqlite'
      }),
      assertCode('CLOSED_BETA_ENVIRONMENT_OVERRIDE_FORBIDDEN')
    );
    assert.equal(Object.values(paths).some(existsSync), false, 'rejected overrides must open no database');

    await assert.rejects(
      identityModule.createClosedBetaEnvironment({
        ...environmentOptions(storageConfig),
        publicDir: root
      }),
      assertCode('CLOSED_BETA_ENVIRONMENT_OVERRIDE_FORBIDDEN')
    );
    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
        testOnlyEffectiveUid: 0,
        testOnlyAllowRoot: false
      })),
      assertCode('CLOSED_BETA_ROOT_EXECUTION_FORBIDDEN')
    );
    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
        cookieSecret: 'secret-secret-secret-secret-secret-secret'
      })),
      assertCode('CLOSED_BETA_COOKIE_SECRET_WEAK')
    );
    assert.equal(Object.values(paths).some(existsSync), false, 'all preflight refusals must open no database');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CT-2 public environment exposes no mutable instance and rejects copied or fake-prepare handles', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const first = await createIsolatedAuthHarness(identityModule);
  const second = await createIsolatedAuthHarness(identityModule);
  const credentials = {
    closed_beta_admin_v1: { password: fixturePassword('admin') },
    closed_beta_user_v1: { password: fixturePassword('user') }
  };
  try {
    assert.equal('instance' in first.environment, false);
    assert.equal('storageConfig' in first.environment, false);
    assert.throws(() => Object.defineProperty(first.environment, 'instance', {
      value: { auth: { db: { prepare: () => ({ all: () => [] }) } } }
    }));
    await assert.rejects(
      identityModule.provisionClosedBetaIdentities({
        environment: {
          ...first.environment,
          instance: {
            auth: { db: { prepare: () => ({ all: () => [{ name: 'main', file: second.storageConfig.paths.auth }] }) } },
            accessControlStore: { database: { prepare: () => ({ all: () => [] }) } }
          }
        },
        credentials
      }),
      assertCode('CLOSED_BETA_ENVIRONMENT_HANDLE_REQUIRED')
    );
    assert.deepEqual(first.environment.testOnly.inspect().accounts, []);
    assert.deepEqual(second.environment.testOnly.inspect().accounts, []);
  } finally {
    await first.close();
    await second.close();
  }
});

test('CT-2 initialization failures fail closed and complete cleanup at every acquisition stage', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  for (const stage of ['reservation', 'migration', 'runtime', 'server']) {
    const root = mkdtempSync(path.join(tmpdir(), `ai-fenshen-ct2-failure-${stage}-`));
    try {
      const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(root));
      const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
      await assert.rejects(
        identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
          privacyPreparation,
          testOnlyFailureAt: stage
        })),
        (error) => (
          error?.code === 'CLOSED_BETA_INITIALIZATION_FAILED' &&
          error?.failedStage === stage &&
          error?.cleanupCompleted === true &&
          error?.requiresIsolationRootDestruction === true &&
          Array.isArray(error?.cleanupCodes) &&
          error.cleanupCodes.length === 0
        )
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('CT-2 startup late-symlink attack is rejected before mkdir or chmod can touch the external target', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-startup-symlink-'));
  const external = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-startup-external-'));
  const marker = path.join(external, 'do-not-touch.txt');
  chmodSync(external, 0o750);
  writeFileSync(marker, 'external-content-must-not-change', { mode: 0o640 });
  try {
    const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(root));
    const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
    await assert.rejects(
      identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
        privacyPreparation,
        testOnlyReplacePrivacyExportBeforeServer: external
      })),
      (error) => error?.code === 'CLOSED_BETA_INITIALIZATION_FAILED' &&
        error?.originalCode === 'PRIVACY_STORAGE_UNSAFE' &&
        error?.requiresIsolationRootDestruction === true
    );
    assert.equal(statSync(external).mode & 0o777, 0o750);
    assert.equal(readFileSync(marker, 'utf8'), 'external-content-must-not-change');
    assert.deepEqual(readdirSync(external), ['do-not-touch.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('CT-2 reservation drift before and after listen or provision always poisons the environment', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const credentials = {
    closed_beta_admin_v1: { password: fixturePassword('admin') },
    closed_beta_user_v1: { password: fixturePassword('user') }
  };
  for (const phase of ['before_listen', 'after_listen', 'before_provision', 'after_provision']) {
    const harness = await createIsolatedAuthHarness(identityModule);
    try {
      if (phase === 'before_listen') harness.environment.testOnly.installPrivacyExportSymlinkAttack();
      if (phase === 'after_listen') harness.environment.testOnly.driftReservationAfterNextListen();
      if (phase === 'before_provision') harness.environment.testOnly.installPrivacyExportSymlinkAttack();
      if (phase === 'after_provision') harness.environment.testOnly.driftReservationAfterProvision();
      const operation = phase.endsWith('listen')
        ? harness.environment.listen()
        : identityModule.provisionClosedBetaIdentities({ environment: harness.environment, credentials });
      await assert.rejects(operation, (error) => (
        error?.code === 'CLOSED_BETA_STORAGE_RESERVATION_CHANGED' ||
        error?.code === 'CLOSED_BETA_ISOLATION_ROOT_CHANGED'
      ));
      assert.equal(harness.environment.testOnly.cleanupStatus().state, 'poisoned', phase);
      await assert.rejects(harness.environment.listen(), assertCode('CLOSED_BETA_ENVIRONMENT_POISONED'));
      await assert.rejects(
        identityModule.provisionClosedBetaIdentities({ environment: harness.environment, credentials }),
        assertCode('CLOSED_BETA_ENVIRONMENT_POISONED')
      );
    } finally {
      try { await harness.environment.close(); } catch {}
      rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test('CT-2 poisons the environment when any reserved database file disappears', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const harness = await createIsolatedAuthHarness(identityModule);
  try {
    rmSync(harness.storageConfig.paths.auth);
    await assert.rejects(harness.environment.listen(), (error) => error?.code === 'ENOENT');
    assert.equal(harness.environment.testOnly.cleanupStatus().state, 'poisoned');
    await assert.rejects(harness.environment.listen(), assertCode('CLOSED_BETA_ENVIRONMENT_POISONED'));
  } finally {
    try { await harness.environment.close(); } catch {}
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('CT-2 server-stop cleanup failure blocks database teardown and every operation until close retry succeeds', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const harness = await createIsolatedAuthHarness(identityModule);
  try {
    const baseUrl = await harness.environment.listen();
    harness.environment.testOnly.failCleanupOnce('server');
    harness.environment.testOnly.failCleanupOnce('auth');
    await assert.rejects(
      harness.environment.close(),
      (error) => error?.code === 'CLOSED_BETA_CLEANUP_INCOMPLETE' &&
        error?.cleanupCodes?.some((code) => code.startsWith('server:'))
    );
    const failed = harness.environment.testOnly.cleanupStatus();
    assert.equal(failed.state, 'cleanup_failed');
    assert.equal(failed.pending.includes('server'), true);
    assert.equal(failed.pending.includes('auth'), true, 'DB cleanup must not continue while HTTP is still listening');
    assert.equal((await requestJson(baseUrl, '/api/auth/me')).status, 503);
    await assert.rejects(harness.environment.listen(), assertCode('CLOSED_BETA_ENVIRONMENT_NOT_ACTIVE'));
    await assert.rejects(
      identityModule.provisionClosedBetaIdentities({
        environment: harness.environment,
        credentials: {
          closed_beta_admin_v1: { password: fixturePassword('admin') },
          closed_beta_user_v1: { password: fixturePassword('user') }
        }
      }),
      assertCode('CLOSED_BETA_ENVIRONMENT_NOT_ACTIVE')
    );
    await assert.rejects(
      harness.environment.close(),
      (error) => error?.code === 'CLOSED_BETA_CLEANUP_INCOMPLETE' &&
        error?.cleanupCodes?.some((code) => code.startsWith('auth:'))
    );
    assert.deepEqual(
      harness.environment.testOnly.cleanupStatus(),
      { state: 'cleanup_failed', pending: ['auth'] },
      'a cleanup retry must run only the resource that did not close successfully'
    );
    await harness.environment.close();
    assert.equal(harness.environment.testOnly.cleanupStatus().state, 'closed');
  } finally {
    try { await harness.environment.close(); } catch {}
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('createBetaServer registers every supplied runtime before use and closes all partial resources on constructor failure', async () => {
  const { createBetaServer } = await import('../betaServer.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-beta-server-failure-'));
  const badExportPath = path.join(root, 'privacy-export-file');
  const closed = {
    finance: 0,
    conversation: 0,
    protectedMemory: 0,
    memory: 0,
    tasks: 0,
    attachments: 0
  };
  writeFileSync(badExportPath, 'not-a-directory');
  try {
    await assert.rejects(
      createBetaServer({
        config: {
          publicDir: root,
          authDb: path.join(root, 'auth.sqlite'),
          accessControlDb: path.join(root, 'access.sqlite'),
          conversationDb: path.join(root, 'conversation.sqlite'),
          privacyDb: path.join(root, 'privacy.sqlite'),
          privacyExportDir: badExportPath,
          cookieSecret: COOKIE_SECRET,
          secureCookie: true,
          privacyRequired: true,
          host: '127.0.0.1',
          port: 0
        },
        aiService: {
          getStatus: () => ({ available: false }),
          stream: async () => ({ ok: false, code: 'CLOSED_BETA_PROVIDER_DISABLED' })
        },
        financeRuntime: {
          service: null,
          timezone: 'Asia/Shanghai',
          clock: () => NOW,
          close: async () => { closed.finance += 1; }
        },
        conversationRuntime: {
          service: { setAttachmentProcessor() {} },
          close: async () => { closed.conversation += 1; }
        },
        protectedMemoryRuntime: {
          close: async () => { closed.protectedMemory += 1; }
        },
        memoryRuntime: {
          service: {},
          initialize: async () => ({ status: 'disabled' }),
          close: async () => { closed.memory += 1; }
        },
        tasksRuntime: {
          service: null,
          close: async () => { closed.tasks += 1; }
        },
        attachmentRuntime: {
          processingService: null,
          close: async () => { closed.attachments += 1; }
        }
      }),
      (error) => error?.cleanupCompleted === true &&
        Array.isArray(error?.cleanupCodes) && error.cleanupCodes.length === 0
    );
    assert.equal(existsSync(path.join(root, 'privacy.sqlite')), false, 'Privacy SQLite must not open after export preflight fails');
    assert.deepEqual(closed, {
      finance: 1,
      conversation: 1,
      protectedMemory: 1,
      memory: 1,
      tasks: 1,
      attachments: 1
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createBetaServer never reports cleanup success when an internal factory throws after opening an unreturned resource', async () => {
  const { createBetaServer } = await import('../betaServer.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-unreturned-runtime-'));
  let leakedDatabase = null;
  try {
    await assert.rejects(
      createBetaServer({
        config: {
          publicDir: root,
          authDb: path.join(root, 'auth.sqlite'),
          accessControlDb: path.join(root, 'access.sqlite'),
          financeDb: path.join(root, 'finance.sqlite'),
          conversationDb: path.join(root, 'conversation.sqlite'),
          privacyDb: path.join(root, 'privacy.sqlite'),
          privacyExportDir: path.join(root, 'privacy-exports'),
          cookieSecret: COOKIE_SECRET,
          secureCookie: true,
          financeF201Enabled: true,
          host: '127.0.0.1',
          port: 0
        },
        aiService: {
          getStatus: () => ({ available: false }),
          stream: async () => ({ ok: false, code: 'CLOSED_BETA_PROVIDER_DISABLED' })
        },
        runtimeFactories: {
          finance() {
            leakedDatabase = new DatabaseSync(path.join(root, 'unreturned-finance.sqlite'));
            throw Object.assign(new Error('factory threw after open'), { code: 'INJECTED_FACTORY_HALF_INITIALIZED' });
          }
        }
      }),
      (error) => error?.code === 'INJECTED_FACTORY_HALF_INITIALIZED' &&
        error?.cleanupCompleted === false &&
        error?.requiresProcessExit === true &&
        error?.requiresIsolationRootDestruction === true &&
        error?.cleanupCodes?.includes('finance:UNPROVEN_PARTIAL_INITIALIZATION')
    );
  } finally {
    try { leakedDatabase?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('PrivacyLifecycle guards every export file action and never follows an external replacement', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  for (const action of ['create', 'read', 'delete', 'status', 'invalidate', 'retention', 'close']) {
    const root = mkdtempSync(path.join(tmpdir(), `ai-fenshen-ct2-privacy-${action}-`));
    const external = mkdtempSync(path.join(tmpdir(), `ai-fenshen-ct2-external-${action}-`));
    const exportDir = path.join(root, 'exports');
    const marker = path.join(external, 'external-marker.txt');
    writeFileSync(marker, `untouched-${action}`, { mode: 0o640 });
    chmodSync(external, 0o750);
    let lifecycle;
    try {
      mkdirSync(exportDir, { mode: 0o700 });
      const reserved = lstatSync(exportDir);
      const reservedRealpath = realpathSync(exportDir);
      const exportStorageGuard = () => {
        const current = lstatSync(exportDir);
        if (current.isSymbolicLink() || !current.isDirectory() ||
            current.dev !== reserved.dev || current.ino !== reserved.ino || current.nlink < reserved.nlink ||
            realpathSync(exportDir) !== reservedRealpath) {
          throw Object.assign(new Error('Privacy storage changed.'), { code: 'PRIVACY_STORAGE_UNSAFE' });
        }
      };
      lifecycle = new PrivacyLifecycle({
        dbPath: path.join(root, 'privacy.sqlite'),
        exportDir,
        secret: COOKIE_SECRET,
        exportStorageGuard,
        auth: { getAccountById: () => ({ id: 'owner-a', username: 'owner-a', role: 'beta_user' }) },
        accessControl: { getAccountUsageSummary: () => null },
        now: () => NOW.toISOString()
      });
      const notice = lifecycle.notice();
      lifecycle.acceptConsent({
        ownerId: 'owner-a',
        accepted: true,
        privacyNoticeVersion: notice.privacyNoticeVersion,
        termsVersion: notice.termsVersion,
        locale: notice.locale,
        source: 'ct2_guard_test'
      });
      let token = '';
      if (action !== 'create') {
        const created = lifecycle.createExport('owner-a');
        token = decodeURIComponent(created.downloadUrl.split('/').at(-1));
      }
      rmSync(exportDir, { recursive: true, force: true });
      symlinkSync(external, exportDir);

      await assert.rejects(async () => {
        if (action === 'create') lifecycle.createExport('owner-a');
        if (action === 'read' || action === 'delete') lifecycle.consumeExport('owner-a', token);
        if (action === 'status') lifecycle.hasOwnerExports('owner-a');
        if (action === 'invalidate') lifecycle.invalidateOwnerExports('owner-a');
        if (action === 'retention') lifecycle.cleanupExports();
        if (action === 'close') lifecycle.close();
      }, action === 'close'
        ? (error) => error?.code === 'PRIVACY_CLOSE_INCOMPLETE' &&
          error?.cleanupCodes?.includes('PRIVACY_STORAGE_UNSAFE')
        : assertCode('PRIVACY_STORAGE_UNSAFE'), action);

      assert.equal(statSync(external).mode & 0o777, 0o750, action);
      assert.equal(readFileSync(marker, 'utf8'), `untouched-${action}`, action);
      assert.deepEqual(readdirSync(external), ['external-marker.txt'], action);
    } finally {
      if (lifecycle && action !== 'close') {
        try {
          rmSync(exportDir, { force: true });
          mkdirSync(exportDir, { mode: 0o700 });
          lifecycle.close();
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  }
});

test('PrivacyLifecycle binds every export file inode and rejects symlink or hardlink replacement before every file action', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  for (const attack of ['symlink', 'hardlink']) {
    for (const action of ['read', 'delete', 'status', 'invalidate', 'retention', 'close']) {
      const root = mkdtempSync(path.join(tmpdir(), `ai-fenshen-ct2-file-${attack}-${action}-`));
      const external = path.join(root, 'external-secret.txt');
      const exportDir = path.join(root, 'exports');
      let nowMs = NOW.getTime();
      let lifecycle;
      writeFileSync(external, `external-${attack}-${action}`, { mode: 0o600 });
      try {
        lifecycle = new PrivacyLifecycle({
          dbPath: path.join(root, 'privacy.sqlite'),
          exportDir,
          secret: COOKIE_SECRET,
          exportTtlMs: 10,
          auth: { getAccountById: () => ({ id: 'owner-a', username: 'owner-a', role: 'beta_user' }) },
          accessControl: { getAccountUsageSummary: () => null },
          now: () => new Date(nowMs).toISOString()
        });
        const notice = lifecycle.notice();
        lifecycle.acceptConsent({
          ownerId: 'owner-a',
          accepted: true,
          privacyNoticeVersion: notice.privacyNoticeVersion,
          termsVersion: notice.termsVersion,
          locale: notice.locale,
          source: 'ct2_file_binding_test'
        });
        const created = lifecycle.createExport('owner-a');
        const token = decodeURIComponent(created.downloadUrl.split('/').at(-1));
        const exportFile = path.join(exportDir, readdirSync(exportDir)[0]);
        rmSync(exportFile, { force: true });
        if (attack === 'symlink') symlinkSync(external, exportFile);
        else linkSync(external, exportFile);
        if (action === 'retention' || action === 'close') nowMs += 20;

        await assert.rejects(async () => {
          if (action === 'read' || action === 'delete') lifecycle.consumeExport('owner-a', token);
          if (action === 'status') lifecycle.hasOwnerExports('owner-a');
          if (action === 'invalidate') lifecycle.invalidateOwnerExports('owner-a');
          if (action === 'retention') lifecycle.cleanupExports();
          if (action === 'close') lifecycle.close();
        }, action === 'close'
          ? (error) => error?.code === 'PRIVACY_CLOSE_INCOMPLETE' &&
            error?.cleanupCodes?.includes('PRIVACY_EXPORT_FILE_UNSAFE')
          : assertCode('PRIVACY_EXPORT_FILE_UNSAFE'), `${attack}:${action}`);
        assert.equal(readFileSync(external, 'utf8'), `external-${attack}-${action}`);
        assert.equal(existsSync(external), true);
      } finally {
        if (lifecycle && action !== 'close') {
          try { lifecycle.close(); } catch {}
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test('PrivacyLifecycle rebuilds persisted export bindings across restart before status, download, and expiry cleanup', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-restart-'));
  const dbPath = path.join(root, 'privacy.sqlite');
  const exportDir = path.join(root, 'exports');
  let nowMs = NOW.getTime();
  let lifecycle;
  const createLifecycle = () => new PrivacyLifecycle({
    dbPath,
    exportDir,
    secret: COOKIE_SECRET,
    exportTtlMs: 1_000,
    auth: {
      getAccountById: (ownerId) => ({ id: ownerId, username: ownerId, role: 'beta_user' })
    },
    accessControl: { getAccountUsageSummary: () => null },
    now: () => new Date(nowMs).toISOString()
  });
  try {
    lifecycle = createLifecycle();
    const notice = lifecycle.notice();
    for (const ownerId of ['owner-download', 'owner-expire']) {
      lifecycle.acceptConsent({
        ownerId,
        accepted: true,
        privacyNoticeVersion: notice.privacyNoticeVersion,
        termsVersion: notice.termsVersion,
        locale: notice.locale,
        source: 'ct2_restart_binding_test'
      });
    }
    const downloadable = lifecycle.createExport('owner-download');
    lifecycle.createExport('owner-expire');
    const authorizations = lifecycle.store.listExportAuthorizations();
    assert.equal(authorizations.length, 2);
    for (const authorization of authorizations) {
      assert.equal(typeof authorization.binding?.dev, 'string');
      assert.equal(typeof authorization.binding?.ino, 'string');
      assert.equal(authorization.binding?.nlink, 1);
      assert.equal(path.isAbsolute(authorization.binding?.realpath), true);
    }
    lifecycle.close();

    lifecycle = createLifecycle();
    assert.equal(lifecycle.hasOwnerExports('owner-download'), true);
    assert.equal(lifecycle.hasOwnerExports('owner-expire'), true);
    const token = decodeURIComponent(downloadable.downloadUrl.split('/').at(-1));
    const downloaded = lifecycle.consumeExport('owner-download', token);
    assert.equal(JSON.parse(downloaded.buffer.toString('utf8')).account.id, 'owner-download');
    lifecycle.close();

    nowMs += 1_001;
    lifecycle = createLifecycle();
    assert.equal(lifecycle.hasOwnerExports('owner-expire'), false);
    assert.deepEqual(readdirSync(exportDir), []);
  } finally {
    try { lifecycle?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('PrivacyLifecycle never consumes a grant before its persisted file binding is proven', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-preconsume-'));
  let lifecycle;
  try {
    lifecycle = new PrivacyLifecycle({
      dbPath: path.join(root, 'privacy.sqlite'),
      exportDir: path.join(root, 'exports'),
      secret: COOKIE_SECRET,
      auth: { getAccountById: () => ({ id: 'owner-a', username: 'owner-a', role: 'beta_user' }) },
      accessControl: { getAccountUsageSummary: () => null }
    });
    const notice = lifecycle.notice();
    lifecycle.acceptConsent({
      ownerId: 'owner-a',
      accepted: true,
      privacyNoticeVersion: notice.privacyNoticeVersion,
      termsVersion: notice.termsVersion,
      locale: notice.locale,
      source: 'ct2_preconsume_test'
    });
    const created = lifecycle.createExport('owner-a');
    const token = decodeURIComponent(created.downloadUrl.split('/').at(-1));
    lifecycle.exportFileBindings.clear();
    assert.throws(() => lifecycle.consumeExport('owner-a', token), assertCode('PRIVACY_EXPORT_FILE_UNSAFE'));
    const row = lifecycle.store.database.prepare(
      'SELECT consumed_at FROM privacy_export_grants WHERE owner_id = ?'
    ).get('owner-a');
    assert.equal(row.consumed_at, null);
  } finally {
    try { lifecycle?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('PrivacyLifecycle preserves a verified export when marking it consumed fails and allows a safe retry', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-consume-retry-'));
  const exportDir = path.join(root, 'exports');
  let lifecycle;
  try {
    lifecycle = new PrivacyLifecycle({
      dbPath: path.join(root, 'privacy.sqlite'),
      exportDir,
      secret: COOKIE_SECRET,
      auth: { getAccountById: () => ({ id: 'owner-a', username: 'owner-a', role: 'beta_user' }) },
      accessControl: { getAccountUsageSummary: () => null }
    });
    const notice = lifecycle.notice();
    lifecycle.acceptConsent({
      ownerId: 'owner-a',
      accepted: true,
      privacyNoticeVersion: notice.privacyNoticeVersion,
      termsVersion: notice.termsVersion,
      locale: notice.locale,
      source: 'ct2_consume_retry_test'
    });
    const created = lifecycle.createExport('owner-a');
    const token = decodeURIComponent(created.downloadUrl.split('/').at(-1));
    const exportFile = path.join(exportDir, readdirSync(exportDir)[0]);
    const originalConsume = lifecycle.store.consumeExport.bind(lifecycle.store);
    let failOnce = true;
    lifecycle.store.consumeExport = (input) => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' });
      }
      return originalConsume(input);
    };

    assert.throws(() => lifecycle.consumeExport('owner-a', token), assertCode('SQLITE_BUSY'));
    assert.equal(existsSync(exportFile), true, 'verified export must remain after a DB-only consume failure');
    assert.equal(lifecycle.exportFileBindings.has(path.resolve(exportFile)), true);
    assert.equal(lifecycle.store.database.prepare(
      'SELECT consumed_at FROM privacy_export_grants WHERE owner_id = ?'
    ).get('owner-a').consumed_at, null);

    const retry = lifecycle.consumeExport('owner-a', token);
    assert.equal(JSON.parse(retry.buffer.toString('utf8')).account.id, 'owner-a');
    assert.equal(existsSync(exportFile), false);
    assert.notEqual(lifecycle.store.database.prepare(
      'SELECT consumed_at FROM privacy_export_grants WHERE owner_id = ?'
    ).get('owner-a').consumed_at, null);
  } finally {
    try { lifecycle?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('PrivacyLifecycle reads only from a no-follow descriptor whose inode still matches after path validation', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-read-fd-'));
  const exportDir = path.join(root, 'exports');
  const external = path.join(root, 'external-valid.json');
  let lifecycle;
  writeFileSync(external, JSON.stringify({ marker: 'external-must-never-be-read' }), { mode: 0o600 });
  try {
    lifecycle = new PrivacyLifecycle({
      dbPath: path.join(root, 'privacy.sqlite'),
      exportDir,
      secret: COOKIE_SECRET,
      auth: { getAccountById: () => ({ id: 'owner-a', username: 'owner-a', role: 'beta_user' }) },
      accessControl: { getAccountUsageSummary: () => null }
    });
    const notice = lifecycle.notice();
    lifecycle.acceptConsent({
      ownerId: 'owner-a',
      accepted: true,
      privacyNoticeVersion: notice.privacyNoticeVersion,
      termsVersion: notice.termsVersion,
      locale: notice.locale,
      source: 'ct2_descriptor_read_test'
    });
    const created = lifecycle.createExport('owner-a');
    const token = decodeURIComponent(created.downloadUrl.split('/').at(-1));
    const exportFile = path.join(exportDir, readdirSync(exportDir)[0]);
    assert.equal(typeof lifecycle.readExportDescriptor, 'function');
    const originalValidate = lifecycle.validateBoundExportFile.bind(lifecycle);
    let swapped = false;
    lifecycle.validateBoundExportFile = (filePath, action) => {
      const binding = originalValidate(filePath, action);
      if (action === 'export_read' && !swapped) {
        swapped = true;
        rmSync(filePath);
        linkSync(external, filePath);
      }
      return binding;
    };
    const originalRead = lifecycle.readExportDescriptor.bind(lifecycle);
    let descriptorRead = false;
    let externalRead = false;
    lifecycle.readExportDescriptor = (descriptor) => {
      descriptorRead = true;
      const buffer = originalRead(descriptor);
      externalRead = buffer.includes('external-must-never-be-read');
      return buffer;
    };
    assert.throws(() => lifecycle.consumeExport('owner-a', token), assertCode('PRIVACY_EXPORT_FILE_UNSAFE'));
    assert.equal(swapped, true);
    assert.equal(descriptorRead, false, 'inode mismatch must be rejected before reading from the descriptor');
    assert.equal(externalRead, false);
    const row = lifecycle.store.database.prepare(
      'SELECT consumed_at FROM privacy_export_grants WHERE owner_id = ?'
    ).get('owner-a');
    assert.equal(row.consumed_at, null);
    assert.equal(readFileSync(external, 'utf8'), JSON.stringify({ marker: 'external-must-never-be-read' }));
  } finally {
    try { lifecycle?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('PrivacyLifecycle close retries a failed store close and reports closed only after the database is unusable', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-close-retry-'));
  const lifecycle = new PrivacyLifecycle({
    dbPath: path.join(root, 'privacy.sqlite'),
    exportDir: path.join(root, 'exports'),
    secret: COOKIE_SECRET
  });
  const database = lifecycle.store.database;
  const originalClose = lifecycle.store.close.bind(lifecycle.store);
  let failOnce = true;
  lifecycle.store.close = () => {
    if (failOnce) {
      failOnce = false;
      throw Object.assign(new Error('injected store close failure'), { code: 'INJECTED_STORE_CLOSE_FAILURE' });
    }
    return originalClose();
  };
  try {
    await assert.rejects(async () => lifecycle.close(), assertCode('PRIVACY_CLOSE_INCOMPLETE'));
    assert.equal(lifecycle.closeStatus().state, 'cleanup_failed');
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1, 'database must still be usable after failed close');
    lifecycle.close();
    assert.equal(lifecycle.closeStatus().state, 'closed');
    assert.throws(() => database.prepare('SELECT 1'), 'database must be unusable after successful retry');
  } finally {
    try { lifecycle.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('PrivacyLifecycle keeps failed export cleanup pending and closes the store only after a real retry succeeds', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-export-cleanup-retry-'));
  const lifecycle = new PrivacyLifecycle({
    dbPath: path.join(root, 'privacy.sqlite'),
    exportDir: path.join(root, 'exports'),
    secret: COOKIE_SECRET
  });
  const database = lifecycle.store.database;
  const originalCleanup = lifecycle.cleanupExports.bind(lifecycle);
  const originalClose = lifecycle.store.close.bind(lifecycle.store);
  let cleanupAttempts = 0;
  let storeCloseAttempts = 0;
  lifecycle.cleanupExports = () => {
    cleanupAttempts += 1;
    if (cleanupAttempts === 1) {
      throw Object.assign(new Error('injected export cleanup failure'), {
        code: 'INJECTED_EXPORT_CLEANUP_FAILURE'
      });
    }
    return originalCleanup();
  };
  lifecycle.store.close = () => {
    storeCloseAttempts += 1;
    return originalClose();
  };
  try {
    assert.throws(() => lifecycle.close(), (error) => error?.code === 'PRIVACY_CLOSE_INCOMPLETE' &&
      error?.cleanupCompleted === false &&
      error?.cleanupCodes?.includes('INJECTED_EXPORT_CLEANUP_FAILURE'));
    assert.equal(lifecycle.closeStatus().state, 'cleanup_failed');
    assert.equal(cleanupAttempts, 1);
    assert.equal(storeCloseAttempts, 0, 'store must remain open until export cleanup succeeds');
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);

    lifecycle.close();
    assert.equal(cleanupAttempts, 2);
    assert.equal(storeCloseAttempts, 1);
    assert.equal(lifecycle.closeStatus().state, 'closed');
    assert.throws(() => database.prepare('SELECT 1'));
  } finally {
    try { lifecycle.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('PrivacyLifecycle marks an uncloseable half-initialized PrivacyStore as unproven cleanup', async () => {
  const { PrivacyLifecycle } = await import('../privacy/privacyLifecycle.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-init-uncertain-'));
  let leakedDatabase;
  try {
    assert.throws(() => new PrivacyLifecycle({
      dbPath: path.join(root, 'privacy.sqlite'),
      exportDir: path.join(root, 'exports'),
      secret: COOKIE_SECRET,
      privacyStoreFactory: ({ dbPath }) => ({
        initialize() {
          leakedDatabase = new DatabaseSync(dbPath);
          throw Object.assign(new Error('half initialized PrivacyStore'), { code: 'INJECTED_PRIVACY_STORE_INIT_FAILURE' });
        },
        close() {
          throw Object.assign(new Error('cannot prove PrivacyStore close'), { code: 'INJECTED_PRIVACY_STORE_CLOSE_FAILURE' });
        }
      })
    }), (error) => error?.code === 'INJECTED_PRIVACY_STORE_INIT_FAILURE' &&
      error?.cleanupCompleted === false &&
      error?.unprovenPartialInitialization === 'privacy' &&
      error?.cleanupCodes?.includes('privacy:INJECTED_PRIVACY_STORE_CLOSE_FAILURE'));
  } finally {
    try { leakedDatabase?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('CT-2 HTTP Privacy export rejects an independent runtime symlink attack with zero external writes', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const harness = await createIsolatedAuthHarness(identityModule);
  const credentials = {
    closed_beta_admin_v1: { password: fixturePassword('admin') },
    closed_beta_user_v1: { password: fixturePassword('user') }
  };
  try {
    await identityModule.provisionClosedBetaIdentities({ environment: harness.environment, credentials });
    const baseUrl = await harness.environment.listen();
    const admin = await login(baseUrl, 'closed_beta_admin_v1', credentials.closed_beta_admin_v1.password);
    const notice = await requestJson(baseUrl, '/api/privacy/notice');
    assert.equal((await requestJson(baseUrl, '/api/privacy/consent', {
      method: 'POST',
      cookie: admin.cookie,
      body: {
        accepted: true,
        privacyNoticeVersion: notice.body.privacyNoticeVersion,
        termsVersion: notice.body.termsVersion,
        locale: notice.body.locale,
        source: 'ct2_runtime_symlink_test'
      }
    })).status, 200);
    harness.environment.testOnly.installPrivacyExportSymlinkAttack();
    const response = await requestJson(baseUrl, '/api/privacy/exports', {
      method: 'POST',
      cookie: admin.cookie
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'PRIVACY_STORAGE_UNSAFE');
    assert.equal(harness.environment.testOnly.privacyEscapeFileCount(), 0);
  } finally {
    try { await harness.environment.close(); } catch {}
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('CT-2 clock is dynamic by default and explicit temporary test clock advances Privacy TTL and Session expiry', async () => {
  const identityModule = await import('./closedBetaIdentities.js');
  const dynamicRoot = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-dynamic-clock-'));
  let dynamicEnvironment;
  try {
    const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(dynamicRoot));
    const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
    dynamicEnvironment = await identityModule.createClosedBetaEnvironment({
      storageConfig,
      privacyPreparation,
      cookieSecret: COOKIE_SECRET,
      testOnlyAllowRoot: true
    });
    const first = dynamicEnvironment.testOnly.clockNow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(dynamicEnvironment.testOnly.clockNow() > first, 'default wall clock must not capture one Date');
  } finally {
    try { await dynamicEnvironment?.close(); } catch {}
    rmSync(dynamicRoot, { recursive: true, force: true });
  }

  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-fixed-clock-'));
  let nowMs = NOW.getTime();
  let environment;
  const credentials = {
    closed_beta_admin_v1: { password: fixturePassword('admin') },
    closed_beta_user_v1: { password: fixturePassword('user') }
  };
  try {
    const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(root));
    const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
    environment = await identityModule.createClosedBetaEnvironment({
      storageConfig,
      privacyPreparation,
      cookieSecret: COOKIE_SECRET,
      testOnlyAllowRoot: true,
      testOnlyClock: () => new Date(nowMs)
    });
    await identityModule.provisionClosedBetaIdentities({ environment, credentials });
    const baseUrl = await environment.listen();
    const admin = await login(baseUrl, 'closed_beta_admin_v1', credentials.closed_beta_admin_v1.password);
    const notice = await requestJson(baseUrl, '/api/privacy/notice');
    await requestJson(baseUrl, '/api/privacy/consent', {
      method: 'POST',
      cookie: admin.cookie,
      body: {
        accepted: true,
        privacyNoticeVersion: notice.body.privacyNoticeVersion,
        termsVersion: notice.body.termsVersion,
        locale: notice.body.locale,
        source: 'ct2_time_test'
      }
    });
    const created = await requestJson(baseUrl, '/api/privacy/exports', {
      method: 'POST',
      cookie: admin.cookie
    });
    assert.equal(created.status, 201);
    nowMs += 11 * 60 * 1000;
    assert.equal((await requestJson(baseUrl, created.body.downloadUrl, { cookie: admin.cookie })).status, 410);
    nowMs += 8 * 24 * 60 * 60 * 1000;
    assert.equal((await requestJson(baseUrl, '/api/auth/me', { cookie: admin.cookie })).status, 401);
  } finally {
    try { await environment?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('CT-2 provisions isolated closed-beta identities and enforces auth, owner isolation, and stable HTTP errors', async () => {
  let identityModule = null;
  try {
    identityModule = await import('./closedBetaIdentities.js');
  } catch {
    // The first RED run intentionally reaches the assertion below.
  }
  assert.equal(
    typeof identityModule?.provisionClosedBetaIdentities,
    'function',
    'CT-2 requires an explicit isolated closed-beta identity provisioner'
  );

  const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-identities-'));
  const paths = isolatedPaths(isolatedRoot);

  let environment = null;
  try {
    const storageConfig = identityModule.createClosedBetaIsolationConfig(storageArguments(isolatedRoot, paths));
    const privacyPreparation = identityModule.prepareCt2PrivacyCompatibility({ storageConfig });
    environment = await identityModule.createClosedBetaEnvironment(environmentOptions(storageConfig, {
      privacyPreparation
    }));
    assert.equal('instance' in environment, false);
    const initialEvidence = environment.testOnly.inspect();
    assert.deepEqual(initialEvidence.databasePaths, {
      auth: realpathSync(storageConfig.paths.auth),
      access: realpathSync(storageConfig.paths.access),
      finance: realpathSync(storageConfig.paths.finance),
      conversation: realpathSync(storageConfig.paths.conversation),
      privacy: realpathSync(storageConfig.paths.privacy)
    });
    assert.equal(initialEvidence.privacyExportDir, realpathSync(storageConfig.paths.privacyExports));
    assert.deepEqual(initialEvidence.persistentRuntimeOrigins, {
      access: 'ct2_factory_supplied',
      auth: 'ct2_factory_supplied',
      finance: 'ct2_factory_supplied',
      conversation: 'ct2_factory_supplied',
      privacy: 'ct2_factory_supplied'
    });
    assert.equal(statSync(storageConfig.paths.privacy).nlink, 1);
    assert.equal(statSync(storageConfig.paths.privacy).mode & 0o077, 0);
    assert.equal(statSync(storageConfig.paths.privacyExports).mode & 0o077, 0);

    const credentials = {
      closed_beta_admin_v1: { password: fixturePassword('admin') },
      closed_beta_user_v1: { password: fixturePassword('user') }
    };
    const identities = await identityModule.provisionClosedBetaIdentities({
      environment,
      credentials
    });

    assert.deepEqual(Object.keys(identities), ['closed_beta_admin_v1', 'closed_beta_user_v1']);
    assert.equal(identities.closed_beta_admin_v1.username, 'closed_beta_admin_v1');
    assert.equal(identities.closed_beta_admin_v1.role, 'admin');
    assert.equal(identities.closed_beta_user_v1.username, 'closed_beta_user_v1');
    assert.equal(identities.closed_beta_user_v1.role, 'beta_user');
    assert.notEqual(identities.closed_beta_admin_v1.id, identities.closed_beta_user_v1.id);
    const provisionEvidence = environment.testOnly.inspect();
    assert.equal(provisionEvidence.accessProfiles[identities.closed_beta_admin_v1.id], 'closed_beta_admin_v1');
    assert.equal(provisionEvidence.accessProfiles[identities.closed_beta_user_v1.id], 'closed_beta_user_v1');

    const baseUrl = await environment.listen();

    const anonymousFinance = await requestJson(baseUrl, '/api/finance/entries?period=all_time');
    const anonymousConversation = await requestJson(baseUrl, '/api/ai/conversations');
    assert.equal(anonymousFinance.status, 401);
    assert.equal(anonymousConversation.status, 401);

    for (const attack of ['hardlink', 'late_symlink', 'starts_with_boundary']) {
      const requestPath = environment.testOnly.installStaticAttack(attack);
      const response = await requestText(baseUrl, requestPath);
      assert.equal(response.status, 404);
      assert.doesNotMatch(response.text, /ct2-private-static-hardlink-secret|ct2-private-static-boundary-secret/);
    }

    const adminLogin = await login(
      baseUrl,
      'closed_beta_admin_v1',
      credentials.closed_beta_admin_v1.password
    );
    const userLogin = await login(
      baseUrl,
      'closed_beta_user_v1',
      credentials.closed_beta_user_v1.password,
      { role: 'admin', ownerId: identities.closed_beta_admin_v1.id }
    );
    assert.equal(adminLogin.status, 200);
    assert.equal(userLogin.status, 200);
    assert.equal(adminLogin.body.user.role, 'admin');
    assert.equal(userLogin.body.user.role, 'beta_user');
    assert.match(adminLogin.cookie, /^ai_secretary_session=/);
    assert.match(adminLogin.cookie, /HttpOnly/);
    assert.match(adminLogin.cookie, /Secure/);
    assert.match(userLogin.cookie, /^ai_secretary_session=/);
    assert.match(userLogin.cookie, /Secure/);
    assert.notEqual(adminLogin.cookie, userLogin.cookie);

    const adminMe = await requestJson(baseUrl, '/api/auth/me', { cookie: adminLogin.cookie });
    const userMe = await requestJson(baseUrl, '/api/auth/me', { cookie: userLogin.cookie });
    assert.equal(adminMe.status, 200);
    assert.equal(userMe.status, 200);
    assert.equal(adminMe.body.user.id, identities.closed_beta_admin_v1.id);
    assert.equal(userMe.body.user.id, identities.closed_beta_user_v1.id);
    assert.equal(userMe.body.user.role, 'beta_user', 'login body cannot forge the authenticated role');
    assert.deepEqual(
      environment.testOnly.inspect().sessionAccountIds,
      [identities.closed_beta_admin_v1.id, identities.closed_beta_user_v1.id].sort()
    );

    assert.equal((await requestJson(baseUrl, '/api/admin/system-status', { cookie: adminLogin.cookie })).status, 200);
    assert.equal((await requestJson(baseUrl, '/api/admin/system-status', { cookie: userLogin.cookie })).status, 403);
    const aiStatus = await requestJson(baseUrl, '/api/ai/status', { cookie: adminLogin.cookie });
    assert.equal(aiStatus.status, 200);
    assert.equal(aiStatus.body.available, false);

    const noConsentFinance = await requestJson(baseUrl, '/api/finance/entries?period=all_time', {
      cookie: adminLogin.cookie
    });
    const noConsentConversation = await requestJson(baseUrl, '/api/ai/conversations', {
      cookie: adminLogin.cookie
    });
    assert.equal(noConsentFinance.status, 403);
    assert.equal(noConsentFinance.body.code, 'PRIVACY_CONSENT_REQUIRED');
    assert.equal(noConsentConversation.status, 403);
    assert.equal(noConsentConversation.body.code, 'PRIVACY_CONSENT_REQUIRED');

    const notice = await requestJson(baseUrl, '/api/privacy/notice');
    assert.equal(notice.status, 200);
    for (const cookie of [adminLogin.cookie, userLogin.cookie]) {
      const consent = await requestJson(baseUrl, '/api/privacy/consent', {
        method: 'POST',
        cookie,
        body: {
          accepted: true,
          privacyNoticeVersion: notice.body.privacyNoticeVersion,
          termsVersion: notice.body.termsVersion,
          locale: notice.body.locale,
          source: 'ct2_explicit_acceptance'
        }
      });
      assert.equal(consent.status, 200);
      assert.equal(consent.body.consent.current, true);
    }

    const adminConversation = await requestJson(baseUrl, '/api/ai/conversations', {
      method: 'POST',
      cookie: adminLogin.cookie,
      body: { title: '管理员账本会话', ownerId: identities.closed_beta_user_v1.id }
    });
    const userConversation = await requestJson(baseUrl, '/api/ai/conversations', {
      method: 'POST',
      cookie: userLogin.cookie,
      body: { title: '普通用户账本会话', ownerId: identities.closed_beta_admin_v1.id }
    });
    assert.equal(adminConversation.status, 201);
    assert.equal(userConversation.status, 201);
    assert.equal('ownerId' in adminConversation.body.conversation, false);
    assert.equal('ownerId' in userConversation.body.conversation, false);

    const ordinaryChat = await sendFinanceMessage(baseUrl, adminLogin.cookie, {
      conversationId: adminConversation.body.conversation.id,
      message: '请介绍一下你自己',
      clientRequestId: 'ct2-admin-disabled-provider',
      ownerId: identities.closed_beta_user_v1.id
    });
    assert.equal(ordinaryChat.status, 200);
    assert.match(ordinaryChat.text, /event: error/);
    assert.match(ordinaryChat.text, /CLOSED_BETA_PROVIDER_DISABLED/);
    assert.doesNotMatch(ordinaryChat.text, /event: completed/);

    const adminWrite = await sendFinanceMessage(baseUrl, adminLogin.cookie, {
      conversationId: adminConversation.body.conversation.id,
      message: '早餐18元',
      clientRequestId: 'ct2-admin-finance-create',
      ownerId: identities.closed_beta_user_v1.id
    });
    const userWrite = await sendFinanceMessage(baseUrl, userLogin.cookie, {
      conversationId: userConversation.body.conversation.id,
      message: '午饭28元',
      clientRequestId: 'ct2-user-finance-create',
      ownerId: identities.closed_beta_admin_v1.id
    });
    assert.equal(adminWrite.status, 200);
    assert.equal(userWrite.status, 200);
    assert.match(adminWrite.text, /event: completed/);
    assert.match(userWrite.text, /event: completed/);

    const adminFinance = await requestJson(
      baseUrl,
      `/api/finance/entries?period=all_time&ownerId=${encodeURIComponent(identities.closed_beta_user_v1.id)}`,
      { cookie: adminLogin.cookie }
    );
    const userFinance = await requestJson(
      baseUrl,
      `/api/finance/entries?period=all_time&ownerId=${encodeURIComponent(identities.closed_beta_admin_v1.id)}`,
      { cookie: userLogin.cookie }
    );
    assert.equal(adminFinance.status, 200);
    assert.equal(userFinance.status, 200);
    assert.deepEqual(adminFinance.body.entries.map((entry) => entry.amountMinor), [1800]);
    assert.deepEqual(userFinance.body.entries.map((entry) => entry.amountMinor), [2800]);
    assert.equal(adminFinance.body.entries.some((entry) => Object.hasOwn(entry, 'ownerId')), false);
    assert.equal(userFinance.body.entries.some((entry) => Object.hasOwn(entry, 'ownerId')), false);

    const adminEntryId = adminFinance.body.entries[0].id;
    const userEntryId = userFinance.body.entries[0].id;
    assert.equal((await requestJson(baseUrl, `/api/finance/entries/${adminEntryId}`, { cookie: userLogin.cookie })).status, 404);
    assert.equal((await requestJson(baseUrl, `/api/finance/entries/${userEntryId}`, { cookie: adminLogin.cookie })).status, 404);

    const adminConversations = await requestJson(baseUrl, '/api/ai/conversations', { cookie: adminLogin.cookie });
    const userConversations = await requestJson(baseUrl, '/api/ai/conversations', { cookie: userLogin.cookie });
    assert.deepEqual(adminConversations.body.conversations.map((item) => item.id), [adminConversation.body.conversation.id]);
    assert.deepEqual(userConversations.body.conversations.map((item) => item.id), [userConversation.body.conversation.id]);
    assert.equal((await requestJson(
      baseUrl,
      `/api/ai/conversations/${adminConversation.body.conversation.id}/messages`,
      { cookie: userLogin.cookie }
    )).status, 404);
    assert.equal((await requestJson(
      baseUrl,
      `/api/ai/conversations/${userConversation.body.conversation.id}/messages`,
      { cookie: adminLogin.cookie }
    )).status, 404);

    const adminMessages = await requestJson(
      baseUrl,
      `/api/ai/conversations/${adminConversation.body.conversation.id}/messages`,
      { cookie: adminLogin.cookie }
    );
    const userMessages = await requestJson(
      baseUrl,
      `/api/ai/conversations/${userConversation.body.conversation.id}/messages`,
      { cookie: userLogin.cookie }
    );
    assert.equal(adminMessages.status, 200);
    assert.equal(userMessages.status, 200);
    assert.match(JSON.stringify(adminMessages.body), /早餐18元/);
    assert.doesNotMatch(JSON.stringify(adminMessages.body), /午饭28元/);
    assert.match(JSON.stringify(userMessages.body), /午饭28元/);
    assert.doesNotMatch(JSON.stringify(userMessages.body), /早餐18元/);

    const firstUpdate = await requestJson(baseUrl, `/api/finance/entries/${adminEntryId}`, {
      method: 'PATCH',
      cookie: adminLogin.cookie,
      headers: { 'Idempotency-Key': 'ct2-admin-update-1' },
      body: { expectedVersion: 1, amountMinor: 1900, ownerId: identities.closed_beta_user_v1.id }
    });
    assert.equal(firstUpdate.status, 200);
    const staleUpdate = await requestJson(baseUrl, `/api/finance/entries/${adminEntryId}`, {
      method: 'PATCH',
      cookie: adminLogin.cookie,
      headers: { 'Idempotency-Key': 'ct2-admin-stale-update' },
      body: { expectedVersion: 1, amountMinor: 2000 }
    });
    assert.equal(staleUpdate.status, 409);

    environment.testOnly.failFinanceQueryOnce();
    const unavailable = await requestJson(baseUrl, '/api/finance/entries?period=all_time', { cookie: adminLogin.cookie });
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(JSON.stringify(unavailable.body), /private|sqlite|storage detail/i);

    assert.deepEqual(
      Object.values(paths).every((databasePath) => path.relative(isolatedRoot, databasePath).startsWith('..') === false),
      true
    );
  } finally {
    if (environment) await environment.close();
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
  assert.equal(existsSync(isolatedRoot), false, 'isolated account, Session, Finance, and Conversation data must be destroyed');
});
