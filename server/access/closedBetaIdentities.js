import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
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

import { BetaAuthService } from '../../core/auth/betaAuthService.js';
import { createBetaServer } from '../betaServer.js';
import { createConversationRuntime } from '../conversation/runtime.js';
import { applyFinanceF201Migration } from '../finance/financeF201Migration.js';
import { applyFinanceMigrations } from '../finance/migrations.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { PrivacyLifecycle } from '../privacy/privacyLifecycle.js';
import { applyPrivacyExportCompatibilityMigration } from '../privacy/privacyExportCompatibilityMigration.js';
import { AccessControlService } from './accessControlService.js';
import { AccessControlStore } from './accessControlStore.js';

const VALIDATED_CONFIGS = new WeakSet();
const PRIVACY_PREPARATION_HANDLES = new WeakMap();
const ENVIRONMENT_HANDLES = new WeakMap();
const KNOWN_PRODUCTION_ROOTS = Object.freeze([
  '/data',
  '/opt/ai-fenshen',
  '/opt/ai-fenshen/current'
]);
const DATABASE_STORAGE_KEYS = Object.freeze([
  ['auth', 'authDb'],
  ['access', 'accessControlDb'],
  ['finance', 'financeDb'],
  ['conversation', 'conversationDb'],
  ['privacy', 'privacyDb']
]);
const DIRECTORY_STORAGE_KEYS = Object.freeze([
  ['privacyExports', 'privacyExportDir']
]);
const STORAGE_KEYS = Object.freeze([...DATABASE_STORAGE_KEYS, ...DIRECTORY_STORAGE_KEYS]);
const TEST_FAILURE_STAGES = new Set(['reservation', 'migration', 'runtime', 'server']);

// Threat model: the isolation root is a pre-created, current-UID-owned 0700 directory.
// Every path is checked before acquisition and every reserved inode is checked after
// each initialization stage. Any drift fails closed and requires destroying the root.
export const CLOSED_BETA_ISOLATION_THREAT_MODEL = Object.freeze({
  rootOwnership: 'current_uid_owner_only_0700',
  toctouPolicy: 'verify_each_reserved_inode_before_and_after_each_initialization_stage',
  driftPolicy: 'fail_closed_destroy_isolation_root'
});

export const CLOSED_BETA_IDENTITIES = Object.freeze({
  closed_beta_admin_v1: Object.freeze({
    username: 'closed_beta_admin_v1',
    displayName: 'Closed Beta Admin V1',
    role: 'admin',
    quotaProfileId: 'closed_beta_admin_v1'
  }),
  closed_beta_user_v1: Object.freeze({
    username: 'closed_beta_user_v1',
    displayName: 'Closed Beta User V1',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  })
});

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requiredIsolationRoot(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('Closed-beta isolation root must be an absolute path.'), {
      code: 'CLOSED_BETA_ISOLATION_ROOT_REQUIRED'
    });
  }
  if (!path.isAbsolute(value)) {
    throw codedError('CLOSED_BETA_PATH_MUST_BE_ABSOLUTE', 'Closed-beta isolation root must be absolute.');
  }
  if (path.normalize(value) !== value) {
    throw codedError('CLOSED_BETA_PATH_NOT_NORMALIZED', 'Closed-beta isolation root must be normalized.');
  }
  return value;
}

function pathWithin(root, candidate, { allowEqual = false } = {}) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowEqual;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function matchesProductionRoot(candidate) {
  return KNOWN_PRODUCTION_ROOTS.some((root) => pathWithin(root, candidate, { allowEqual: true }));
}

function assertRestrictedDirectory(directory) {
  const stats = statSync(directory);
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) {
    throw codedError('CLOSED_BETA_ISOLATION_ROOT_PERMISSIONS_UNSAFE', 'Closed-beta isolation directories must be owner-only.');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw codedError('CLOSED_BETA_ISOLATION_ROOT_OWNER_MISMATCH', 'Closed-beta isolation root must belong to the current process owner.');
  }
}

function requiredDatabasePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw codedError('CLOSED_BETA_STORAGE_PATH_REQUIRED', `${label} is required.`);
  }
  if (!path.isAbsolute(value)) {
    throw codedError('CLOSED_BETA_PATH_MUST_BE_ABSOLUTE', `${label} must be absolute.`);
  }
  if (path.normalize(value) !== value) {
    throw codedError('CLOSED_BETA_PATH_NOT_NORMALIZED', `${label} must be normalized.`);
  }
  return value;
}

function assertNoSymlinkBelow(root, candidate) {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw codedError('CLOSED_BETA_SYMLINK_FORBIDDEN', 'Closed-beta storage cannot traverse a symbolic link.');
    }
  }
}

function canonicalFuturePath(candidate) {
  let existing = candidate;
  const suffix = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw codedError('CLOSED_BETA_STORAGE_PARENT_UNAVAILABLE', 'Closed-beta storage has no existing parent.');
    }
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...suffix);
}

export function createClosedBetaIsolationConfig({
  isolationRoot,
  authDb,
  accessControlDb,
  financeDb,
  conversationDb,
  privacyDb,
  privacyExportDir
} = {}) {
  const lexicalRoot = requiredIsolationRoot(isolationRoot);
  if (matchesProductionRoot(lexicalRoot)) {
    throw codedError('CLOSED_BETA_PRODUCTION_PATH_FORBIDDEN', 'Production storage cannot be used for closed-beta identities.');
  }
  const filesystemRoot = path.parse(lexicalRoot).root;
  if (lexicalRoot === filesystemRoot || path.dirname(lexicalRoot) === filesystemRoot) {
    throw codedError('CLOSED_BETA_ISOLATION_ROOT_UNSAFE', 'Closed-beta isolation root is too broad.');
  }
  if (!existsSync(lexicalRoot) || !statSync(lexicalRoot).isDirectory()) {
    throw codedError('CLOSED_BETA_ISOLATION_ROOT_UNAVAILABLE', 'Closed-beta isolation root must already exist.');
  }
  if (lstatSync(lexicalRoot).isSymbolicLink()) {
    throw codedError('CLOSED_BETA_SYMLINK_FORBIDDEN', 'Closed-beta isolation root cannot be a symbolic link.');
  }
  assertRestrictedDirectory(lexicalRoot);
  const canonicalRoot = realpathSync(lexicalRoot);
  if (matchesProductionRoot(canonicalRoot)) {
    throw codedError('CLOSED_BETA_PRODUCTION_PATH_FORBIDDEN', 'Production storage cannot be used for closed-beta identities.');
  }

  const rootStats = statSync(canonicalRoot);
  const input = { authDb, accessControlDb, financeDb, conversationDb, privacyDb, privacyExportDir };
  const paths = {};
  for (const [key, inputName] of STORAGE_KEYS) {
    const candidate = requiredDatabasePath(input[inputName], inputName);
    if (matchesProductionRoot(candidate)) {
      throw codedError('CLOSED_BETA_PRODUCTION_PATH_FORBIDDEN', `${inputName} cannot use production storage.`);
    }
    if (!pathWithin(lexicalRoot, candidate)) {
      throw codedError('CLOSED_BETA_STORAGE_OUTSIDE_ISOLATION_ROOT', `${inputName} must stay inside the isolation root.`);
    }
    assertNoSymlinkBelow(lexicalRoot, candidate);
    if (existsSync(candidate)) {
      throw codedError('CLOSED_BETA_STORAGE_ALREADY_EXISTS', `${inputName} must not already exist; existing files, directories, and hardlinks are forbidden.`);
    }
    const canonicalCandidate = canonicalFuturePath(candidate);
    if (!pathWithin(canonicalRoot, canonicalCandidate)) {
      throw codedError('CLOSED_BETA_STORAGE_OUTSIDE_ISOLATION_ROOT', `${inputName} escapes the isolation root.`);
    }
    paths[key] = candidate;
  }
  if (new Set(Object.values(paths)).size !== STORAGE_KEYS.length) {
    throw codedError('CLOSED_BETA_STORAGE_PATH_COLLISION', 'Closed-beta storage paths must be distinct.');
  }

  const config = {
    isolationRoot: lexicalRoot,
    canonicalRoot,
    rootIdentity: Object.freeze({ dev: rootStats.dev, ino: rootStats.ino }),
    paths: Object.freeze(paths)
  };
  const frozen = Object.freeze(config);
  VALIDATED_CONFIGS.add(frozen);
  return frozen;
}

export function assertClosedBetaIsolationConfig(storageConfig) {
  if (!storageConfig || typeof storageConfig !== 'object' || !VALIDATED_CONFIGS.has(storageConfig)) {
    throw codedError('CLOSED_BETA_ISOLATION_CONFIG_REQUIRED', 'Validated closed-beta isolation config is required.');
  }
  return storageConfig;
}

function revalidateBeforeOpen(storageConfig) {
  const config = assertClosedBetaIsolationConfig(storageConfig);
  if (!existsSync(config.isolationRoot) || lstatSync(config.isolationRoot).isSymbolicLink()) {
    throw codedError('CLOSED_BETA_SYMLINK_FORBIDDEN', 'Closed-beta isolation root changed after validation.');
  }
  assertRestrictedDirectory(config.isolationRoot);
  if (realpathSync(config.isolationRoot) !== config.canonicalRoot) {
    throw codedError('CLOSED_BETA_ISOLATION_ROOT_CHANGED', 'Closed-beta isolation root changed after validation.');
  }
  const rootStats = statSync(config.canonicalRoot);
  if (rootStats.dev !== config.rootIdentity.dev || rootStats.ino !== config.rootIdentity.ino) {
    throw codedError('CLOSED_BETA_ISOLATION_ROOT_CHANGED', 'Closed-beta isolation root inode changed after validation; destroy the isolation root.');
  }
  for (const candidate of Object.values(config.paths)) {
    assertNoSymlinkBelow(config.isolationRoot, candidate);
    if (existsSync(candidate)) {
      throw codedError('CLOSED_BETA_STORAGE_ALREADY_EXISTS', 'Closed-beta databases are one-time and must start absent.');
    }
    if (!pathWithin(config.canonicalRoot, canonicalFuturePath(candidate))) {
      throw codedError('CLOSED_BETA_STORAGE_OUTSIDE_ISOLATION_ROOT', 'Closed-beta storage escaped after validation.');
    }
  }
  return config;
}

function injectedFailure(stage) {
  return Object.assign(new Error(`Injected closed-beta ${stage} initialization failure.`), {
    code: 'CLOSED_BETA_TEST_FAILURE',
    failedStage: stage
  });
}

function reserveStorage(config, failureAt = '', preparedReservations = null) {
  const reservations = new Map(preparedReservations || []);
  let createdCount = 0;
  try {
    for (const [key] of DATABASE_STORAGE_KEYS) {
      const candidate = config.paths[key];
      if (reservations.has(candidate)) continue;
      const parent = path.dirname(candidate);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      assertNoSymlinkBelow(config.isolationRoot, parent);
      assertRestrictedDirectory(parent);
      const descriptor = openSync(candidate, 'wx', 0o600);
      try {
        const stats = fstatSync(descriptor);
        if (!stats.isFile() || stats.nlink !== 1) {
          throw codedError('CLOSED_BETA_STORAGE_HARDLINK_FORBIDDEN', 'Closed-beta database reservation must have one link.');
        }
        reservations.set(candidate, { kind: 'file', dev: stats.dev, ino: stats.ino });
        createdCount += 1;
      } finally {
        closeSync(descriptor);
      }
      if (failureAt === 'reservation' && createdCount === 1) throw injectedFailure('reservation');
    }
    for (const [key] of DIRECTORY_STORAGE_KEYS) {
      const candidate = config.paths[key];
      if (reservations.has(candidate)) continue;
      const parent = path.dirname(candidate);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      assertNoSymlinkBelow(config.isolationRoot, parent);
      assertRestrictedDirectory(parent);
      mkdirSync(candidate, { mode: 0o700 });
      const stats = lstatSync(candidate);
      if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
        throw codedError('CLOSED_BETA_EXPORT_DIRECTORY_UNSAFE', 'Closed-beta Privacy export directory must be a private real directory.');
      }
      reservations.set(candidate, { kind: 'directory', dev: stats.dev, ino: stats.ino, nlink: stats.nlink });
      createdCount += 1;
    }
  } catch (error) {
    throw Object.assign(
      codedError('CLOSED_BETA_STORAGE_RESERVATION_FAILED', 'Closed-beta storage reservation failed or changed; fail closed and destroy the isolation root.'),
      {
        requiresIsolationRootDestruction: true,
        originalCode: String(error?.code || 'CLOSED_BETA_STORAGE_RESERVATION_FAILED'),
        failedStage: 'reservation'
      }
    );
  }
  return reservations;
}

export function prepareCt2PrivacyCompatibility({ storageConfig } = {}) {
  const config = revalidateBeforeOpen(storageConfig);
  const reservations = new Map();
  const createdPaths = [];
  let database = null;
  try {
    const privacyPath = config.paths.privacy;
    const privacyParent = path.dirname(privacyPath);
    mkdirSync(privacyParent, { recursive: true, mode: 0o700 });
    assertNoSymlinkBelow(config.isolationRoot, privacyParent);
    assertRestrictedDirectory(privacyParent);
    const descriptor = openSync(privacyPath, 'wx', 0o600);
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.nlink !== 1) {
        throw codedError('CLOSED_BETA_STORAGE_HARDLINK_FORBIDDEN', 'Closed-beta Privacy database must have one link.');
      }
      reservations.set(privacyPath, { kind: 'file', dev: stats.dev, ino: stats.ino });
      createdPaths.push(privacyPath);
    } finally {
      closeSync(descriptor);
    }

    const exportDir = config.paths.privacyExports;
    mkdirSync(exportDir, { mode: 0o700 });
    const exportStats = lstatSync(exportDir);
    if (!exportStats.isDirectory() || exportStats.isSymbolicLink() || (exportStats.mode & 0o077) !== 0) {
      throw codedError('CLOSED_BETA_EXPORT_DIRECTORY_UNSAFE', 'Closed-beta Privacy export directory must be private.');
    }
    reservations.set(exportDir, {
      kind: 'directory',
      dev: exportStats.dev,
      ino: exportStats.ino,
      nlink: exportStats.nlink
    });
    createdPaths.push(exportDir);
    assertReservations(config, reservations);

    database = new DatabaseSync(privacyPath);
    applyPrivacyExportCompatibilityMigration({ database, exportDir });
    database.close();
    database = null;
    assertReservations(config, reservations);

    const handle = Object.freeze({ kind: 'ct2_privacy_compatibility_preparation_v1' });
    PRIVACY_PREPARATION_HANDLES.set(handle, {
      config,
      reservations,
      state: 'ready'
    });
    return handle;
  } catch (error) {
    try { database?.close(); } catch {}
    for (const candidate of createdPaths.reverse()) {
      try { rmSync(candidate, { recursive: true, force: true }); } catch {}
    }
    throw Object.assign(new Error('Explicit CT-2 Privacy compatibility preparation failed.'), {
      code: 'CLOSED_BETA_PRIVACY_PREPARATION_FAILED',
      originalCode: String(error?.code || 'CLOSED_BETA_PRIVACY_PREPARATION_FAILED'),
      cause: error
    });
  }
}

function consumePrivacyPreparation(config, handle) {
  const preparation = PRIVACY_PREPARATION_HANDLES.get(handle);
  if (!preparation || preparation.config !== config || preparation.state !== 'ready') {
    throw codedError(
      'CLOSED_BETA_PRIVACY_PREPARATION_REQUIRED',
      'A live explicit CT-2 Privacy compatibility preparation handle is required.'
    );
  }
  assertReservations(config, preparation.reservations);
  preparation.state = 'consumed';
  return preparation.reservations;
}

function assertReservations(config, reservations) {
  revalidateBeforeOpenReservations(config);
  for (const [candidate, reserved] of reservations) {
    const stats = lstatSync(candidate);
    const typeMatches = reserved.kind === 'file'
      ? stats.isFile() && stats.nlink === 1 && (stats.mode & 0o077) === 0
      : stats.isDirectory() && !stats.isSymbolicLink() && stats.nlink >= reserved.nlink && (stats.mode & 0o077) === 0;
    if (!typeMatches || stats.dev !== reserved.dev || stats.ino !== reserved.ino) {
      throw Object.assign(
        codedError('CLOSED_BETA_STORAGE_RESERVATION_CHANGED', 'Closed-beta reserved inode changed during initialization; fail closed and destroy the isolation root.'),
        { requiresIsolationRootDestruction: true }
      );
    }
    if (!pathWithin(config.canonicalRoot, realpathSync(candidate))) {
      throw Object.assign(
        codedError('CLOSED_BETA_STORAGE_RESERVATION_CHANGED', 'Closed-beta storage escaped its owner-only root; fail closed and destroy the isolation root.'),
        { requiresIsolationRootDestruction: true }
      );
    }
  }
}

function revalidateBeforeOpenReservations(config) {
  if (!existsSync(config.isolationRoot) || lstatSync(config.isolationRoot).isSymbolicLink()) {
    throw codedError('CLOSED_BETA_ISOLATION_ROOT_CHANGED', 'Closed-beta owner-only root changed; destroy the isolation root.');
  }
  assertRestrictedDirectory(config.isolationRoot);
  const rootStats = statSync(config.isolationRoot);
  if (realpathSync(config.isolationRoot) !== config.canonicalRoot ||
      rootStats.dev !== config.rootIdentity.dev || rootStats.ino !== config.rootIdentity.ino) {
    throw codedError('CLOSED_BETA_ISOLATION_ROOT_CHANGED', 'Closed-beta owner-only root inode changed; destroy the isolation root.');
  }
}

function disabledClosedBetaAiService() {
  return {
    getStatus: () => ({ available: false, code: 'CLOSED_BETA_PROVIDER_DISABLED' }),
    stream: async () => ({ ok: false, code: 'CLOSED_BETA_PROVIDER_DISABLED' })
  };
}

function disabledClosedBetaMemoryRuntime() {
  return {
    initialize: async () => ({ status: 'disabled', pathSummary: 'closed-beta-isolated-memory' }),
    close: async () => {},
    service: {}
  };
}

function createOwnedStaticDirectory(config) {
  const parent = path.dirname(config.canonicalRoot);
  const directory = mkdtempSync(path.join(parent, '.ai-fenshen-ct2-static-'));
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 ||
      pathWithin(config.canonicalRoot, realpathSync(directory), { allowEqual: true }) ||
      pathWithin(realpathSync(directory), config.canonicalRoot, { allowEqual: true })) {
    throw codedError('CLOSED_BETA_STATIC_ROOT_UNSAFE', 'Factory-owned static root must remain private and separate from data storage.');
  }
  const index = path.join(directory, 'index.html');
  const descriptor = openSync(index, 'wx', 0o600);
  try {
    writeFileSync(descriptor, '<!doctype html><meta charset="utf-8"><title>Closed beta API</title>');
  } finally {
    closeSync(descriptor);
  }
  return Object.freeze({ path: directory, dev: stats.dev, ino: stats.ino });
}

function assertOwnedStaticDirectory(owned) {
  const stats = lstatSync(owned.path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== owned.dev ||
      stats.ino !== owned.ino || (stats.mode & 0o077) !== 0) {
    throw codedError('CLOSED_BETA_STATIC_ROOT_CHANGED', 'Factory-owned static root changed; fail closed.');
  }
}

function sqliteMainPath(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw codedError('CLOSED_BETA_SQLITE_HANDLE_REQUIRED', 'A live SQLite handle is required for closed-beta provenance verification.');
  }
  const file = database.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
  if (!file) throw codedError('CLOSED_BETA_SQLITE_HANDLE_REQUIRED', 'SQLite main database path is unavailable.');
  return realpathSync(file);
}

function assertDatabaseHandle(database, candidate, reservations, mismatchCode = 'CLOSED_BETA_STORAGE_HANDLE_MISMATCH') {
  const expected = reservations.get(candidate);
  const stats = statSync(candidate);
  if (!expected || expected.kind !== 'file' || sqliteMainPath(database) !== realpathSync(candidate) ||
      stats.dev !== expected.dev || stats.ino !== expected.ino || stats.nlink !== 1) {
    throw Object.assign(
      codedError(mismatchCode, 'Live SQLite handle or inode does not match the validated closed-beta reservation.'),
      { requiresIsolationRootDestruction: true }
    );
  }
}

async function runCleanupStack(stack) {
  const cleanupCodes = [];
  for (const cleanup of [...stack].reverse()) {
    try { await cleanup(); } catch (error) { cleanupCodes.push(String(error?.code || error?.message || 'CLEANUP_FAILED')); }
  }
  return cleanupCodes;
}

function isTemporaryConfig(config) {
  const temporaryRoot = realpathSync(tmpdir());
  return pathWithin(temporaryRoot, config.canonicalRoot);
}

function assertTestOnlyOptions(config, options) {
  const requested = options.testOnlyFailureAt || options.testOnlyInsecureCookie === true ||
    options.testOnlyAllowRoot === true || options.testOnlyEffectiveUid !== undefined ||
    options.testOnlyReplacePrivacyExportBeforeServer !== undefined || options.testOnlyClock !== undefined;
  if (requested && !isTemporaryConfig(config)) {
    throw codedError('CLOSED_BETA_TEST_ONLY_OPTION_FORBIDDEN', 'Test-only options require a validated isolated root under the operating-system temporary directory.');
  }
  if (options.testOnlyFailureAt && !TEST_FAILURE_STAGES.has(options.testOnlyFailureAt)) {
    throw codedError('CLOSED_BETA_TEST_ONLY_OPTION_FORBIDDEN', 'Unknown test-only failure stage.');
  }
  if (options.testOnlyReplacePrivacyExportBeforeServer !== undefined) {
    const target = String(options.testOnlyReplacePrivacyExportBeforeServer || '');
    if (!path.isAbsolute(target) || !existsSync(target) || lstatSync(target).isSymbolicLink() ||
        !lstatSync(target).isDirectory() || !pathWithin(realpathSync(tmpdir()), realpathSync(target))) {
      throw codedError('CLOSED_BETA_TEST_ONLY_OPTION_FORBIDDEN', 'Late-symlink target must be a real temporary directory.');
    }
  }
  if (options.testOnlyClock !== undefined && typeof options.testOnlyClock !== 'function') {
    throw codedError('CLOSED_BETA_TEST_ONLY_OPTION_FORBIDDEN', 'Fixed closed-beta clock must be an explicit test-only function.');
  }
  const effectiveUid = options.testOnlyEffectiveUid === undefined
    ? (typeof process.geteuid === 'function' ? process.geteuid() : null)
    : Number(options.testOnlyEffectiveUid);
  if (effectiveUid === 0 && !(options.testOnlyAllowRoot === true && isTemporaryConfig(config))) {
    throw codedError('CLOSED_BETA_ROOT_EXECUTION_FORBIDDEN', 'Closed-beta identity services refuse root execution; use a dedicated unprivileged service account.');
  }
}

function validateCookieSecret(value) {
  const secret = typeof value === 'string' ? value : '';
  const unique = new Set(secret).size;
  if (secret.length < 32 || unique < 12 || /(password|secret|123456|qwerty)/i.test(secret)) {
    throw codedError('CLOSED_BETA_COOKIE_SECRET_WEAK', 'Closed-beta Cookie secret must contain at least 32 high-entropy characters.');
  }
  return secret;
}

function sealStaticSurface(server, isActive) {
  const requestListeners = server.listeners('request');
  if (requestListeners.length !== 1) {
    throw codedError('CLOSED_BETA_SERVER_LISTENER_UNSAFE', 'Closed-beta server must have exactly one request listener before sealing.');
  }
  const applicationHandler = requestListeners[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (!isActive()) {
      res.writeHead(503, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: false,
        code: 'CLOSED_BETA_ENVIRONMENT_NOT_ACTIVE',
        message: '封闭测试环境不可用。'
      }));
      return;
    }
    let pathname = '';
    try { pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname; } catch {}
    if (pathname === '/healthz' || pathname === '/api' || pathname.startsWith('/api/')) {
      return applicationHandler(req, res);
    }
    res.writeHead(404, {
      'Content-Type': 'text/plain;charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end('Not found');
  });
}

function createCleanupTasks(instance, ownedPaths) {
  instance.server.removeAllListeners('close');
  const tasks = [
    ['server', async () => {
      if (!instance.server.listening) return;
      await new Promise((resolve, reject) => instance.server.close((error) => error ? reject(error) : resolve()));
    }],
    ['attachments', () => instance.attachmentRuntime?.close?.()],
    ['tasks', () => instance.tasksRuntime?.close?.()],
    ['privacy', () => instance.privacyLifecycle?.close?.()],
    ['conversation', () => instance.conversationRuntime?.close?.()],
    ['finance', () => instance.financeRuntime?.close?.()],
    ['protected_memory', () => instance.protectedMemoryRuntime?.close?.()],
    ['memory', () => instance.memoryRuntime?.close?.()],
    ['auth', () => instance.auth?.close?.()],
    ['access', () => instance.accessControlStore?.close?.()],
    ['static', () => {
      for (const candidate of ownedPaths.splice(0).reverse()) rmSync(candidate, { recursive: true, force: true });
    }]
  ];
  return tasks.map(([label, run]) => ({ label, run, done: false }));
}

async function runCleanupTasks(tasks) {
  const cleanupCodes = [];
  const serverTask = tasks.find((task) => task.label === 'server');
  if (serverTask && !serverTask.done) {
    try {
      await serverTask.run();
      serverTask.done = true;
    } catch (error) {
      return [`server:${String(error?.code || error?.message || 'FAILED')}`];
    }
  }
  for (const task of tasks) {
    if (task === serverTask) continue;
    if (task.done) continue;
    try {
      await task.run();
      task.done = true;
    } catch (error) {
      cleanupCodes.push(`${task.label}:${String(error?.code || error?.message || 'FAILED')}`);
    }
  }
  return cleanupCodes;
}

function inspectPrivateEnvironment(metadata) {
  const { instance, config, reservations } = metadata;
  assertDatabaseHandle(instance.auth.db, config.paths.auth, reservations, 'CLOSED_BETA_AUTH_STORAGE_MISMATCH');
  assertDatabaseHandle(instance.accessControlStore.database, config.paths.access, reservations, 'CLOSED_BETA_AUTH_STORAGE_MISMATCH');
  const accounts = instance.auth.db.prepare(`
    SELECT id, username, displayName, status, role, createdAt, updatedAt, lastLoginAt
    FROM accounts ORDER BY username
  `).all();
  const accessProfiles = {};
  const accessBindings = [];
  for (const account of accounts) {
    const binding = instance.accessControl.getAccountAccess(account.id);
    if (binding) {
      accessProfiles[account.id] = binding.profileId;
      accessBindings.push({ accountId: account.id, profileId: binding.profileId });
    }
  }
  return Object.freeze({
    accounts: Object.freeze(accounts.map((account) => Object.freeze({ ...account }))),
    accessProfiles: Object.freeze(accessProfiles),
    accessBindings: Object.freeze(accessBindings.map((binding) => Object.freeze(binding))),
    sessionAccountIds: Object.freeze(instance.auth.db.prepare(
      'SELECT DISTINCT accountId FROM sessions ORDER BY accountId'
    ).all().map((row) => row.accountId)),
    databasePaths: Object.freeze({
      auth: sqliteMainPath(instance.auth.db),
      access: sqliteMainPath(instance.accessControlStore.database),
      finance: sqliteMainPath(instance.financeRuntime.database),
      conversation: sqliteMainPath(instance.conversationRuntime.database),
      privacy: sqliteMainPath(instance.privacyLifecycle.store.database)
    }),
    privacyExportDir: realpathSync(instance.privacyLifecycle.exportDir),
    persistentRuntimeOrigins: Object.freeze({ ...metadata.persistentRuntimeOrigins })
  });
}

function createTestOnlyHooks(metadata) {
  const assertActive = () => assertEnvironmentActive(metadata);
  return Object.freeze({
    inspect: () => {
      assertActive();
      return inspectPrivateEnvironment(metadata);
    },
    configureProvisionFailure({ failSecondCreate = false, failAuthCleanup = false, failAccessCleanup = false } = {}) {
      assertActive();
      const auth = metadata.instance.auth;
      if (failSecondCreate) {
        const original = auth.createAccount.bind(auth);
        auth.createAccount = async (input) => {
          if (input.username === 'closed_beta_user_v1') {
            throw Object.assign(new Error('simulated second identity failure'), { code: 'SECOND_IDENTITY_FAILED' });
          }
          return original(input);
        };
      }
      if (failAuthCleanup) {
        auth.deleteAccountById = () => {
          throw Object.assign(new Error('simulated auth cleanup failure'), { code: 'AUTH_CLEANUP_FAILED' });
        };
      }
      if (failAccessCleanup) {
        auth.accessControl.deleteAccountData = () => {
          throw Object.assign(new Error('simulated access cleanup failure'), { code: 'ACCESS_CLEANUP_FAILED' });
        };
      }
    },
    failFinanceQueryOnce() {
      assertActive();
      const repository = metadata.instance.financeRuntime.repository;
      const original = repository.queryHistory.bind(repository);
      let pending = true;
      repository.queryHistory = (...args) => {
        if (pending) {
          pending = false;
          repository.queryHistory = original;
          throw new Error('private isolated storage detail');
        }
        return original(...args);
      };
    },
    installStaticAttack(kind) {
      assertActive();
      assertOwnedStaticDirectory(metadata.ownedStatic);
      if (kind === 'hardlink') {
        const source = path.join(metadata.config.canonicalRoot, 'private-static-hardlink-source.txt');
        writeFileSync(source, 'ct2-private-static-hardlink-secret', { mode: 0o600 });
        metadata.ownedPaths.push(source);
        const target = path.join(metadata.ownedStatic.path, 'private-static-hardlink.txt');
        linkSync(source, target);
        return '/private-static-hardlink.txt';
      }
      if (kind === 'late_symlink') {
        const target = path.join(metadata.ownedStatic.path, 'late-private-link');
        symlinkSync(metadata.config.canonicalRoot, target);
        return '/late-private-link/privacy/privacy.sqlite';
      }
      if (kind === 'starts_with_boundary') {
        const sibling = `${metadata.ownedStatic.path}-evil`;
        mkdirSync(sibling, { mode: 0o700 });
        writeFileSync(path.join(sibling, 'secret.txt'), 'ct2-private-static-boundary-secret', { mode: 0o600 });
        metadata.ownedPaths.push(sibling);
        return `/%2e%2e/${path.basename(sibling)}/secret.txt`;
      }
      throw codedError('CLOSED_BETA_TEST_ATTACK_UNKNOWN', 'Unknown static attack fixture.');
    },
    installPrivacyExportSymlinkAttack() {
      assertActive();
      const escapeRoot = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-escape-'));
      metadata.ownedPaths.push(escapeRoot);
      replacePrivacyExportReservation(metadata.config, escapeRoot);
      metadata.privacyEscapeRoot = escapeRoot;
    },
    driftReservationAfterNextListen() {
      assertActive();
      metadata.testDriftAfterListen = true;
    },
    driftReservationAfterProvision() {
      assertActive();
      metadata.testDriftAfterProvision = true;
    },
    privacyEscapeFileCount() {
      if (!metadata.privacyEscapeRoot) return 0;
      return readdirSync(metadata.privacyEscapeRoot).length;
    },
    failCleanupOnce(label) {
      assertActive();
      const task = metadata.cleanupTasks.find((candidate) => candidate.label === label);
      if (!task || task.done) throw codedError('CLOSED_BETA_TEST_CLEANUP_TARGET_INVALID', 'Cleanup target is unavailable.');
      const original = task.run;
      let pending = true;
      task.run = async () => {
        if (pending) {
          pending = false;
          throw Object.assign(new Error('simulated cleanup failure'), { code: 'TEST_CLEANUP_FAILED' });
        }
        return original();
      };
    },
    cleanupStatus: () => Object.freeze({
      state: metadata.lifecycle.state,
      pending: Object.freeze(metadata.cleanupTasks.filter((task) => !task.done).map((task) => task.label))
    }),
    clockNow: () => new Date(metadata.clock()).getTime()
  });
}

function assertEnvironmentActive(metadata) {
  if (metadata.lifecycle.state === 'poisoned') {
    throw codedError('CLOSED_BETA_ENVIRONMENT_POISONED', 'Closed-beta environment is poisoned and must be closed and destroyed.');
  }
  if (metadata.lifecycle.state !== 'active') {
    throw codedError('CLOSED_BETA_ENVIRONMENT_NOT_ACTIVE', 'Closed-beta environment is not active; only cleanup retry is allowed.');
  }
}

function assertReservationsOrPoison(metadata) {
  return assertIsolationProvenanceOrPoison(metadata, () => {
    assertReservations(metadata.config, metadata.reservations);
  });
}

function assertIsolationProvenanceOrPoison(metadata, assertion) {
  try {
    return assertion();
  } catch (error) {
    metadata.lifecycle.state = 'poisoned';
    throw error;
  }
}

function replacePrivacyExportReservation(config, escapeRoot) {
  rmSync(config.paths.privacyExports, { recursive: true, force: true });
  symlinkSync(escapeRoot, config.paths.privacyExports);
}

function createPublicEnvironmentHandle(metadata) {
  let environment;
  const handle = {
    get baseUrl() { return metadata.baseUrl; },
    async listen() {
      if (!ENVIRONMENT_HANDLES.has(environment) || metadata.lifecycle.state === 'closed') {
        throw codedError('CLOSED_BETA_ENVIRONMENT_CLOSED', 'Closed-beta environment is closed.');
      }
      assertEnvironmentActive(metadata);
      if (metadata.baseUrl) return metadata.baseUrl;
      assertReservationsOrPoison(metadata);
      assertOwnedStaticDirectory(metadata.ownedStatic);
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        metadata.instance.server.once('error', onError);
        metadata.instance.server.listen(0, '127.0.0.1', () => {
          metadata.instance.server.off('error', onError);
          resolve();
        });
      });
      metadata.baseUrl = `http://127.0.0.1:${metadata.instance.server.address().port}`;
      if (metadata.testDriftAfterListen) {
        metadata.testDriftAfterListen = false;
        const escapeRoot = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-listen-drift-'));
        metadata.ownedPaths.push(escapeRoot);
        replacePrivacyExportReservation(metadata.config, escapeRoot);
      }
      assertReservationsOrPoison(metadata);
      return metadata.baseUrl;
    },
    async close() {
      if (metadata.lifecycle.state === 'closed') return;
      if (!ENVIRONMENT_HANDLES.has(environment)) {
        throw codedError('CLOSED_BETA_ENVIRONMENT_HANDLE_REQUIRED', 'Live closed-beta provenance is required for cleanup.');
      }
      if (metadata.lifecycle.state === 'closing') {
        throw codedError('CLOSED_BETA_ENVIRONMENT_NOT_ACTIVE', 'Closed-beta cleanup is already in progress.');
      }
      metadata.lifecycle.state = 'closing';
      const cleanupCodes = await runCleanupTasks(metadata.cleanupTasks);
      if (cleanupCodes.length) {
        metadata.lifecycle.state = 'cleanup_failed';
        throw Object.assign(new Error('Closed-beta cleanup is incomplete and may be retried.'), {
          code: 'CLOSED_BETA_CLEANUP_INCOMPLETE',
          cleanupCodes,
          cleanupCompleted: false,
          requiresIsolationRootDestruction: true
        });
      }
      metadata.lifecycle.state = 'closed';
      ENVIRONMENT_HANDLES.delete(environment);
    }
  };
  if (metadata.testMode) handle.testOnly = createTestOnlyHooks(metadata);
  environment = Object.freeze(handle);
  return environment;
}

const ENVIRONMENT_OPTION_KEYS = new Set([
  'storageConfig',
  'privacyPreparation',
  'cookieSecret',
  'testOnlyFailureAt',
  'testOnlyInsecureCookie',
  'testOnlyAllowRoot',
  'testOnlyEffectiveUid',
  'testOnlyReplacePrivacyExportBeforeServer',
  'testOnlyClock'
]);

export async function createClosedBetaEnvironment(options = {}) {
  for (const key of Object.keys(options)) {
    if (!ENVIRONMENT_OPTION_KEYS.has(key)) {
      throw codedError('CLOSED_BETA_ENVIRONMENT_OVERRIDE_FORBIDDEN', `Closed-beta environment option is forbidden: ${key}.`);
    }
  }
  const config = assertClosedBetaIsolationConfig(options.storageConfig);
  revalidateBeforeOpenReservations(config);
  assertTestOnlyOptions(config, options);
  const cookieSecret = validateCookieSecret(options.cookieSecret);
  const clock = options.testOnlyClock || (() => new Date());
  const initialClockValue = new Date(clock());
  if (!Number.isFinite(initialClockValue.getTime())) {
    throw codedError('CLOSED_BETA_CLOCK_INVALID', 'Closed-beta clock must be valid.');
  }
  const preparedPrivacyReservations = consumePrivacyPreparation(config, options.privacyPreparation);

  const cleanupStack = [];
  const ownedPaths = [];
  const lifecycle = { state: 'active' };
  let failedStage = 'reservation';
  let reservations;
  try {
    const ownedStatic = createOwnedStaticDirectory(config);
    ownedPaths.push(ownedStatic.path);
    cleanupStack.push(() => rmSync(ownedStatic.path, { recursive: true, force: true }));

    reservations = reserveStorage(config, options.testOnlyFailureAt, preparedPrivacyReservations);
    assertReservations(config, reservations);
    assertOwnedStaticDirectory(ownedStatic);

    failedStage = 'migration';
    const financeSchema = new DatabaseSync(config.paths.finance);
    let financeSchemaClosed = false;
    cleanupStack.push(() => {
      if (!financeSchemaClosed) financeSchema.close();
      financeSchemaClosed = true;
    });
    if (options.testOnlyFailureAt === 'migration') throw injectedFailure('migration');
    applyFinanceMigrations(financeSchema);
    applyFinanceF201Migration(financeSchema, { clock });
    financeSchema.close();
    financeSchemaClosed = true;
    cleanupStack.pop();
    assertReservations(config, reservations);
    assertOwnedStaticDirectory(ownedStatic);

    failedStage = 'runtime';
    const financeDatabase = new DatabaseSync(config.paths.finance);
    let financeDatabaseClosed = false;
    cleanupStack.push(() => {
      if (!financeDatabaseClosed) financeDatabase.close();
      financeDatabaseClosed = true;
    });
    const financeRuntimeInner = createFinanceRuntime({
      database: financeDatabase,
      f201Enabled: true,
      timezone: 'Asia/Shanghai',
      clock
    });
    const financeRuntime = {
      ...financeRuntimeInner,
      close() {
        financeRuntimeInner.close();
        if (!financeDatabaseClosed) financeDatabase.close();
        financeDatabaseClosed = true;
      }
    };
    if (options.testOnlyFailureAt === 'runtime') throw injectedFailure('runtime');
    assertDatabaseHandle(financeRuntime.database, config.paths.finance, reservations);
    assertReservations(config, reservations);
    assertOwnedStaticDirectory(ownedStatic);

    failedStage = 'server';
    const accessControlStore = new AccessControlStore({
      dbPath: config.paths.access,
      clock
    });
    cleanupStack.push(() => accessControlStore.close());
    accessControlStore.initialize();
    const accessControl = new AccessControlService({
      store: accessControlStore,
      hmacSecret: cookieSecret
    });
    const auth = new BetaAuthService({
      dbPath: config.paths.auth,
      cookieSecret,
      secureCookie: options.testOnlyInsecureCookie === true ? false : true,
      accessControl,
      clock
    });
    cleanupStack.push(() => auth.close());
    await auth.initialize();
    const aiService = disabledClosedBetaAiService();
    const conversationDatabase = new DatabaseSync(config.paths.conversation);
    let conversationDatabaseClosed = false;
    cleanupStack.push(() => {
      if (!conversationDatabaseClosed) conversationDatabase.close();
      conversationDatabaseClosed = true;
    });
    const conversationRuntimeInner = createConversationRuntime({
      database: conversationDatabase,
      aiService,
      applyMigrations: true,
      memoryPolicy: 'disabled',
      financeIntegration: financeRuntime.service
    });
    const conversationRuntime = {
      ...conversationRuntimeInner,
      close() {
        conversationRuntimeInner.close();
        if (!conversationDatabaseClosed) conversationDatabase.close();
        conversationDatabaseClosed = true;
      }
    };
    cleanupStack.push(() => conversationRuntime.close());
    const privacyStorageGuard = () => {
      try {
        assertReservations(config, reservations);
      } catch (error) {
        lifecycle.state = 'poisoned';
        throw Object.assign(codedError('PRIVACY_STORAGE_UNSAFE', 'Closed-beta Privacy export storage is unsafe.'), {
          cause: error
        });
      }
    };
    const privacyLifecycle = new PrivacyLifecycle({
      dbPath: config.paths.privacy,
      exportDir: config.paths.privacyExports,
      secret: cookieSecret,
      auth,
      accessControl,
      conversationRuntime,
      financeRuntime,
      exportStorageGuard: privacyStorageGuard,
      now: () => new Date(clock()).toISOString()
    });
    cleanupStack.push(() => privacyLifecycle.close());

    if (options.testOnlyReplacePrivacyExportBeforeServer) {
      replacePrivacyExportReservation(config, options.testOnlyReplacePrivacyExportBeforeServer);
    }
    const instance = await createBetaServer({
      config: {
        publicDir: ownedStatic.path,
        authDb: config.paths.auth,
        accessControlDb: config.paths.access,
        financeDb: config.paths.finance,
        conversationDb: config.paths.conversation,
        privacyDb: config.paths.privacy,
        privacyExportDir: config.paths.privacyExports,
        cookieSecret,
        secureCookie: options.testOnlyInsecureCookie === true ? false : true,
        host: '127.0.0.1',
        port: 0,
        privacyRequired: true,
        privacyStorageGuard,
        financeF201Enabled: true,
        financeTimezone: 'Asia/Shanghai'
      },
      aiService,
      memoryRuntime: disabledClosedBetaMemoryRuntime(),
      financeRuntime,
      conversationRuntime,
      accessControlStore,
      accessControl,
      auth,
      privacyLifecycle
    });
    const cleanupTasks = createCleanupTasks(instance, ownedPaths);
    cleanupStack.length = 0;
    cleanupStack.push(async () => {
      const codes = await runCleanupTasks(cleanupTasks);
      if (codes.length) throw Object.assign(new Error('Closed-beta instance cleanup failed.'), { code: codes.join(',') });
    });
    sealStaticSurface(instance.server, () => lifecycle.state === 'active');
    if (options.testOnlyFailureAt === 'server') throw injectedFailure('server');

    assertDatabaseHandle(instance.auth.db, config.paths.auth, reservations, 'CLOSED_BETA_AUTH_STORAGE_MISMATCH');
    assertDatabaseHandle(instance.accessControlStore.database, config.paths.access, reservations, 'CLOSED_BETA_AUTH_STORAGE_MISMATCH');
    assertDatabaseHandle(instance.financeRuntime.database, config.paths.finance, reservations);
    assertDatabaseHandle(instance.conversationRuntime.database, config.paths.conversation, reservations);
    assertDatabaseHandle(instance.privacyLifecycle.store.database, config.paths.privacy, reservations);
    assertReservations(config, reservations);
    assertOwnedStaticDirectory(ownedStatic);

    const metadata = {
      config,
      instance,
      reservations,
      cleanupTasks,
      ownedPaths,
      ownedStatic,
      baseUrl: '',
      lifecycle,
      clock,
      persistentRuntimeOrigins: Object.freeze({
        access: 'ct2_factory_supplied',
        auth: 'ct2_factory_supplied',
        finance: 'ct2_factory_supplied',
        conversation: 'ct2_factory_supplied',
        privacy: 'ct2_factory_supplied'
      }),
      testMode: isTemporaryConfig(config) && options.testOnlyAllowRoot === true
    };
    const environment = createPublicEnvironmentHandle(metadata);
    ENVIRONMENT_HANDLES.set(environment, metadata);
    return environment;
  } catch (error) {
    const cleanupCodes = [
      ...(Array.isArray(error?.cleanupCodes) ? error.cleanupCodes : []),
      ...await runCleanupStack(cleanupStack)
    ];
    throw Object.assign(new Error('Closed-beta initialization failed; fail closed and destroy the isolation root.'), {
      code: 'CLOSED_BETA_INITIALIZATION_FAILED',
      originalCode: String(error?.originalCode || error?.code || 'CLOSED_BETA_INITIALIZATION_FAILED'),
      failedStage: String(error?.failedStage || failedStage),
      cleanupCompleted: cleanupCodes.length === 0,
      cleanupCodes,
      requiresIsolationRootDestruction: true
    });
  }
}

function requiredPassword(credentials, identityId) {
  const password = credentials?.[identityId]?.password;
  if (typeof password !== 'string' || password.length < 16 ||
      /(password|12345678|qwerty|letmein)/i.test(password) || new Set(password).size < 8) {
    throw Object.assign(new Error(`Strong password is required for ${identityId}.`), {
      code: 'CLOSED_BETA_CREDENTIAL_WEAK'
    });
  }
  return password;
}

async function rollbackCreated(auth, created) {
  const cleanupCodes = [];
  for (const account of [...created].reverse()) {
    try {
      if (!auth.deleteAccountById(account.id)) cleanupCodes.push('AUTH_ACCOUNT_CLEANUP_INCOMPLETE');
    } catch (error) {
      cleanupCodes.push(String(error?.code || 'AUTH_ACCOUNT_CLEANUP_FAILED'));
    }
    try {
      auth.accessControl.deleteAccountData({ accountId: account.id, username: account.username });
    } catch (error) {
      cleanupCodes.push(String(error?.code || 'ACCESS_BINDING_CLEANUP_FAILED'));
    }
    try {
      if (await auth.findAccountByUsername(account.username)) cleanupCodes.push('AUTH_ACCOUNT_REMAINS');
    } catch (error) {
      cleanupCodes.push(String(error?.code || 'AUTH_ACCOUNT_CLEANUP_UNVERIFIED'));
    }
    try {
      if (auth.accessControl.getAccountAccess(account.id)) cleanupCodes.push('ACCESS_BINDING_REMAINS');
    } catch (error) {
      cleanupCodes.push(String(error?.code || 'ACCESS_BINDING_CLEANUP_UNVERIFIED'));
    }
  }
  return [...new Set(cleanupCodes)];
}

export async function provisionClosedBetaIdentities({
  environment,
  credentials
} = {}) {
  const metadata = environment && ENVIRONMENT_HANDLES.get(environment);
  if (!metadata) {
    throw codedError('CLOSED_BETA_ENVIRONMENT_HANDLE_REQUIRED', 'A live module-issued closed-beta environment handle is required.');
  }
  assertEnvironmentActive(metadata);
  const { config, instance, reservations } = metadata;
  const auth = instance.auth;
  if (!auth?.db || auth.accessControl?.store !== instance.accessControlStore ||
      typeof auth.createAccount !== 'function') {
    metadata.lifecycle.state = 'poisoned';
    throw Object.assign(
      codedError('CLOSED_BETA_AUTH_STORAGE_MISMATCH', 'Authentication services do not match the module-issued closed-beta environment.'),
      { requiresIsolationRootDestruction: true }
    );
  }
  assertIsolationProvenanceOrPoison(metadata, () => {
    assertReservations(config, reservations);
    assertDatabaseHandle(auth.db, config.paths.auth, reservations, 'CLOSED_BETA_AUTH_STORAGE_MISMATCH');
    assertDatabaseHandle(instance.accessControlStore.database, config.paths.access, reservations, 'CLOSED_BETA_AUTH_STORAGE_MISMATCH');
    if (path.normalize(auth.dbPath) !== config.paths.auth ||
        path.normalize(instance.accessControlStore.dbPath) !== config.paths.access ||
        path.normalize(auth.accessControl.store.dbPath) !== config.paths.access) {
      throw Object.assign(
        codedError('CLOSED_BETA_AUTH_STORAGE_MISMATCH', 'Authentication storage does not match the validated isolation config.'),
        { requiresIsolationRootDestruction: true }
      );
    }
  });

  const definitions = Object.entries(CLOSED_BETA_IDENTITIES);
  for (const [identityId, definition] of definitions) {
    requiredPassword(credentials, identityId);
    if (await auth.findAccountByUsername(definition.username)) {
      throw Object.assign(new Error(`Closed-beta identity already exists: ${identityId}.`), {
        code: 'CLOSED_BETA_IDENTITY_ALREADY_EXISTS'
      });
    }
  }

  const created = [];
  try {
    for (const [identityId, definition] of definitions) {
      created.push(await auth.createAccount({
        ...definition,
        password: requiredPassword(credentials, identityId)
      }));
    }
    if (metadata.testDriftAfterProvision) {
      metadata.testDriftAfterProvision = false;
      const escapeRoot = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-provision-drift-'));
      metadata.ownedPaths.push(escapeRoot);
      replacePrivacyExportReservation(config, escapeRoot);
    }
    assertIsolationProvenanceOrPoison(metadata, () => {
      assertDatabaseHandle(auth.db, config.paths.auth, reservations, 'CLOSED_BETA_AUTH_STORAGE_MISMATCH');
      assertDatabaseHandle(instance.accessControlStore.database, config.paths.access, reservations, 'CLOSED_BETA_AUTH_STORAGE_MISMATCH');
      assertReservations(config, reservations);
    });
  } catch (error) {
    if (error?.requiresIsolationRootDestruction === true) metadata.lifecycle.state = 'poisoned';
    const cleanupCodes = await rollbackCreated(auth, created);
    if (cleanupCodes.length) {
      metadata.lifecycle.state = 'poisoned';
      throw Object.assign(
        new Error('Closed-beta identity rollback was incomplete; destroy the entire isolation root.'),
        {
          code: 'CLOSED_BETA_ROLLBACK_INCOMPLETE',
          requiresIsolationRootDestruction: true,
          originalCode: String(error?.code || 'CLOSED_BETA_IDENTITY_PROVISION_FAILED'),
          cleanupCodes
        }
      );
    }
    throw error;
  }

  return Object.freeze(Object.fromEntries(definitions.map(([identityId], index) => [
    identityId,
    Object.freeze(created[index])
  ])));
}
