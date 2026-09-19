import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createExactWorktreeClone } from './exactWorktree.js';
import {
  CANONICAL_STATE_FILE,
  collectWorkingTreeSnapshot,
  validateProjectState
} from './projectState.js';

export const VERIFICATION_RECEIPT_VERSION = 2;
export const VERIFICATION_RECEIPT_TTL_MS = 30 * 60 * 1000;

const REQUIRED_COMMAND_IDS = Object.freeze([
  'node_version',
  'pnpm_version',
  'frozen_install',
  'project_state_tests',
  'domain_regression_tests',
  'build'
]);
const RECEIPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const issuedReceipts = new WeakMap();
const consumedReceiptIds = new Set();

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function issueVerificationReceipt(payload) {
  const receipt = deepFreeze(structuredClone(payload));
  issuedReceipts.set(receipt, {
    digest: sha256(Buffer.from(JSON.stringify(receipt))),
    receiptId: receipt.receipt_id
  });
  return receipt;
}

function requireIssuedReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || !issuedReceipts.has(receipt)) {
    throw new Error('Verification receipt was not issued by the current project:verify execution.');
  }
  const record = issuedReceipts.get(receipt);
  if (consumedReceiptIds.has(record.receiptId)) throw new Error('Verification receipt has already been used.');
  if (record.digest !== sha256(Buffer.from(JSON.stringify(receipt)))) {
    throw new Error('Verification receipt was modified after issuance.');
  }
  return record;
}

function validateCommand(command, errors) {
  if (!command || typeof command !== 'object') {
    errors.push('receipt command must be an object.');
    return;
  }
  if (typeof command.id !== 'string' || typeof command.command !== 'string') errors.push('receipt command identity is invalid.');
  if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string')) errors.push(`receipt command ${command.id} args are invalid.`);
  if (typeof command.cwd !== 'string' || !path.isAbsolute(command.cwd)) errors.push(`receipt command ${command.id} cwd is invalid.`);
  if (!Number.isInteger(command.exit_code) || command.exit_code !== 0) errors.push(`receipt command ${command.id} exit code is not zero.`);
  if (!DIGEST_PATTERN.test(command.stdout_sha256 || '') || !DIGEST_PATTERN.test(command.stderr_sha256 || '')) {
    errors.push(`receipt command ${command.id} output digest is invalid.`);
  }
}

function expectedCommandContracts(repoRoot, payload) {
  const cloneRoot = payload.workspace?.clone_root;
  const storeRoot = payload.workspace?.store_root;
  return new Map([
    ['node_version', { command: process.execPath, args: ['--version'] }],
    ['pnpm_version', { command: 'pnpm', args: ['--version'] }],
    ['frozen_install', { command: 'pnpm', args: ['install', '--frozen-lockfile', '--store-dir', storeRoot] }],
    ['project_state_tests', { command: process.execPath, args: ['--test', '--test-concurrency=1', ...discoverProjectStateTests(repoRoot)] }],
    ['domain_regression_tests', {
      command: process.execPath,
      args: ['--test', '--test-concurrency=1', ...payload.verification_plan.domain_regression.test_paths]
    }],
    ['build', { command: 'pnpm', args: ['build'] }]
  ].map(([id, contract]) => [id, { ...contract, cwd: cloneRoot }]));
}

function validateReceiptPayload(payload, { repoRoot, receiptId, now, bindings }) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['receipt payload must be an object.'];
  if (payload.schema_version !== VERIFICATION_RECEIPT_VERSION) errors.push('receipt schema version is invalid.');
  if (payload.receipt_id !== receiptId) errors.push('receipt ID mismatch.');
  if (payload.project_id !== bindings.projectId) errors.push('receipt project ID mismatch.');
  if (payload.branch !== bindings.branch) errors.push('receipt branch mismatch.');
  if (payload.head !== bindings.head) errors.push('receipt HEAD mismatch.');
  if (payload.state_token !== bindings.stateToken) errors.push('receipt state token mismatch.');
  if (payload.checkpoint_generation !== bindings.checkpointGeneration) errors.push('receipt checkpoint generation mismatch.');
  if (payload.working_tree_fingerprint !== bindings.workingTreeFingerprint) errors.push('receipt working-tree fingerprint mismatch.');
  if (JSON.stringify(payload.verification_plan) !== JSON.stringify(bindings.verificationPlan)) {
    errors.push('receipt verification plan mismatch.');
  }
  if (payload.lockfile?.sha256 !== bindings.lockfileSha256 || payload.lockfile?.before_sha256 !== payload.lockfile?.after_sha256 || payload.lockfile?.unchanged !== true) {
    errors.push('receipt lockfile verification failed.');
  }
  const started = Date.parse(payload.started_at);
  const finished = Date.parse(payload.finished_at);
  const expires = Date.parse(payload.expires_at);
  if (![started, finished, expires].every(Number.isFinite) || started > finished || finished > expires) errors.push('receipt timestamps are invalid.');
  if (expires - finished !== VERIFICATION_RECEIPT_TTL_MS) errors.push('receipt expiration interval is invalid.');
  if (now.getTime() > expires) errors.push('verification receipt is expired.');
  if (!Array.isArray(payload.commands)) errors.push('receipt commands are missing.');
  else {
    const ids = payload.commands.map((command) => command?.id);
    if (ids.length !== REQUIRED_COMMAND_IDS.length || REQUIRED_COMMAND_IDS.some((id) => !ids.includes(id)) || new Set(ids).size !== ids.length) {
      errors.push('receipt is missing a required command.');
    }
    for (const command of payload.commands) validateCommand(command, errors);
    if (payload.workspace?.clone_root && payload.workspace?.store_root) {
      const contracts = expectedCommandContracts(repoRoot, payload);
      for (const command of payload.commands) {
        const expected = contracts.get(command.id);
        if (!expected || command.command !== expected.command || command.cwd !== expected.cwd ||
            JSON.stringify(command.args) !== JSON.stringify(expected.args)) {
          errors.push(`receipt command ${command.id} does not match the required command contract.`);
        }
      }
    }
  }
  for (const [name, counts] of Object.entries({
    project_state: payload.tests?.project_state,
    domain_regression: payload.tests?.domain_regression
  })) {
    if (!counts || !Number.isInteger(counts.tests) || !Number.isInteger(counts.pass) || !Number.isInteger(counts.fail) || !Number.isInteger(counts.skipped) || counts.tests < 1 || counts.fail !== 0 || counts.pass + counts.skipped !== counts.tests) {
      errors.push(`receipt ${name} test counts are invalid.`);
    }
  }
  if (payload.build?.result !== 'PASS' || payload.build?.exit_code !== 0 || !Number.isInteger(payload.build?.transformed_modules) || payload.build.transformed_modules < 0) {
    errors.push('receipt build result is invalid.');
  }
  if (typeof payload.toolchain?.node !== 'string' || typeof payload.toolchain?.pnpm !== 'string' || typeof payload.toolchain?.vite !== 'string') {
    errors.push('receipt toolchain versions are invalid.');
  }
  const repository = fs.realpathSync(repoRoot);
  const temporaryRoot = path.resolve(payload.workspace?.temporary_root || '');
  const cloneRoot = path.resolve(payload.workspace?.clone_root || '');
  const storeRoot = path.resolve(payload.workspace?.store_root || '');
  const databaseRoot = path.resolve(payload.database?.root || '');
  const outsideRepository = (candidate) => candidate !== repository && !candidate.startsWith(`${repository}${path.sep}`);
  const insideTemporaryRoot = (candidate) => candidate.startsWith(`${temporaryRoot}${path.sep}`);
  if (
    payload.database?.temporary_only !== true ||
    payload.database?.real_data_modified !== false ||
    payload.real_data_modified !== false ||
    typeof payload.database?.root !== 'string' ||
    !path.isAbsolute(payload.database.root) ||
    !outsideRepository(databaseRoot) ||
    !insideTemporaryRoot(databaseRoot)
  ) errors.push('receipt database policy permits real data access.');
  if (
    payload.workspace?.source_repository !== repository ||
    !path.isAbsolute(payload.workspace?.temporary_root || '') ||
    !path.isAbsolute(payload.workspace?.clone_root || '') ||
    !path.isAbsolute(payload.workspace?.store_root || '') ||
    !outsideRepository(temporaryRoot) ||
    !insideTemporaryRoot(cloneRoot) ||
    !insideTemporaryRoot(storeRoot) ||
    payload.workspace?.manifest_match !== true ||
    !DIGEST_PATTERN.test(payload.workspace?.manifest_sha256 || '') ||
    !Number.isInteger(payload.workspace?.manifest_entries)
  ) {
    errors.push('receipt exact-worktree manifest is invalid.');
  }
  return errors;
}

export function inspectVerificationReceipt({ repoRoot, receipt, now = new Date(), bindings }) {
  const record = requireIssuedReceipt(receipt);
  const errors = validateReceiptPayload(receipt, {
    repoRoot,
    receiptId: record.receiptId,
    now,
    bindings
  });
  if (errors.length) throw new Error(errors.join(' '));
  return structuredClone(receipt);
}

export function consumeVerificationReceipt(options) {
  const payload = inspectVerificationReceipt(options);
  issuedReceipts.delete(options.receipt);
  consumedReceiptIds.add(payload.receipt_id);
  return payload;
}

function safeEnvironment(temporaryDatabaseRoot) {
  const allowed = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PNPM_HOME', 'SystemRoot', 'ComSpec', 'PATHEXT'];
  const environment = {};
  for (const key of allowed) if (process.env[key] !== undefined) environment[key] = process.env[key];
  environment.TMPDIR = temporaryDatabaseRoot;
  environment.TMP = temporaryDatabaseRoot;
  environment.TEMP = temporaryDatabaseRoot;
  environment.HOME = temporaryDatabaseRoot;
  environment.XDG_CACHE_HOME = path.join(temporaryDatabaseRoot, 'xdg-cache');
  environment.XDG_CONFIG_HOME = path.join(temporaryDatabaseRoot, 'xdg-config');
  environment.XDG_DATA_HOME = path.join(temporaryDatabaseRoot, 'xdg-data');
  environment.CI = '1';
  environment.pnpm_config_verify_deps_before_run = 'false';
  return environment;
}

function commandRecord(id, command, args, cwd, environment) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000
  });
  const stdout = result.stdout || Buffer.alloc(0);
  const stderr = result.stderr || Buffer.alloc(0);
  return {
    id,
    command,
    args,
    cwd,
    exit_code: result.status ?? (result.error ? 1 : 0),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    _stdout: stdout,
    _stderr: stderr
  };
}

function publicCommand(record) {
  const { _stdout, _stderr, ...publicRecord } = record;
  return publicRecord;
}

function parseTap(record) {
  const output = record._stdout.toString('utf8');
  const value = (name) => {
    const match = output.match(new RegExp(`^(?:#|ℹ) ${name} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { tests: value('tests'), pass: value('pass'), fail: value('fail'), skipped: value('skipped') };
}

function fingerprintString(snapshot) {
  return `${snapshot.fingerprint.algorithm}:${snapshot.fingerprint.value}`;
}

function discoverProjectStateTests(cloneRoot) {
  const directory = path.join(cloneRoot, 'scripts/project-state');
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.test.js'))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((name) => `scripts/project-state/${name}`);
}

function parseVersion(record) {
  return record._stdout.toString('utf8').trim();
}

export function runProjectVerification({
  repoRoot,
  statePath = path.join(repoRoot, CANONICAL_STATE_FILE),
  now = new Date(),
  tempParent = os.tmpdir()
}) {
  const startedAt = new Date(now);
  const monotonicStartedAt = Date.now();
  // Verification exists to attest an authorized dirty worktree before checkpointing it.
  // Canonical structure, evidence, branch and ancestor checks remain fail-closed; only the
  // old checkpoint's working-tree snapshot may drift, and the receipt binds the new snapshot.
  const state = validateProjectState({ repoRoot, statePath, allowWorkingTreeDrift: true });
  if (!state.ok) return { ok: false, receiptId: null, failures: state.errors };
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim();
  const snapshot = collectWorkingTreeSnapshot(repoRoot);
  const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml');
  const lockfileBefore = sha256(fs.readFileSync(lockfilePath));
  fs.mkdirSync(tempParent, { recursive: true });
  const tempParentStat = fs.lstatSync(tempParent);
  if (!tempParentStat.isDirectory() || tempParentStat.isSymbolicLink()) {
    throw new Error('Verification temporary parent is unsafe.');
  }
  const temporaryRoot = fs.mkdtempSync(path.join(tempParent, 'aiwc-project-verify-'));
  const cloneRoot = path.join(temporaryRoot, 'worktree');
  const databaseRoot = path.join(temporaryRoot, 'test-databases');
  const storeRoot = path.join(temporaryRoot, 'pnpm-store');
  fs.mkdirSync(databaseRoot, { recursive: true });
  const failures = [];
  let payload = null;
  try {
    const manifests = createExactWorktreeClone({ repoRoot, destination: cloneRoot });
    const environment = safeEnvironment(databaseRoot);
    const commands = [];
    commands.push(commandRecord('node_version', process.execPath, ['--version'], cloneRoot, environment));
    commands.push(commandRecord('pnpm_version', 'pnpm', ['--version'], cloneRoot, environment));
    commands.push(commandRecord('frozen_install', 'pnpm', ['install', '--frozen-lockfile', '--store-dir', storeRoot], cloneRoot, environment));
    const projectTests = discoverProjectStateTests(cloneRoot);
    commands.push(commandRecord('project_state_tests', process.execPath, ['--test', '--test-concurrency=1', ...projectTests], cloneRoot, environment));
    commands.push(commandRecord(
      'domain_regression_tests',
      process.execPath,
      ['--test', '--test-concurrency=1', ...state.state.verification_plan.domain_regression.test_paths],
      cloneRoot,
      environment
    ));
    commands.push(commandRecord('build', 'pnpm', ['build'], cloneRoot, environment));
    const lockfileAfter = sha256(fs.readFileSync(path.join(cloneRoot, 'pnpm-lock.yaml')));
    for (const command of commands) if (command.exit_code !== 0) failures.push(`${command.id} failed with exit code ${command.exit_code}.`);
    if (lockfileAfter !== lockfileBefore) failures.push('Lockfile changed during isolated verification.');
    const projectCounts = parseTap(commands.find((command) => command.id === 'project_state_tests'));
    const domainCounts = parseTap(commands.find((command) => command.id === 'domain_regression_tests'));
    if (projectCounts.fail !== 0 || projectCounts.tests === null) failures.push('Project-state test result could not be verified.');
    if (domainCounts.fail !== 0 || domainCounts.tests === null) failures.push('Domain regression test result could not be verified.');
    const buildCommand = commands.find((command) => command.id === 'build');
    const buildOutput = `${buildCommand._stdout.toString('utf8')}\n${buildCommand._stderr.toString('utf8')}`;
    const transformed = buildOutput.match(/(\d+) modules transformed/);
    const viteVersion = buildOutput.match(/vite\s+v([0-9][^\s]*)/i)?.[1] || '';
    if (!transformed || !viteVersion) failures.push('Build toolchain evidence could not be parsed.');
    const finishedAt = new Date(startedAt.getTime() + Math.max(1, Date.now() - monotonicStartedAt));
    const receiptId = crypto.randomUUID();
    payload = {
      schema_version: VERIFICATION_RECEIPT_VERSION,
      receipt_id: receiptId,
      project_id: state.state.project_id,
      branch,
      head,
      state_token: state.stateToken,
      checkpoint_generation: state.state.checkpoint_generation,
      working_tree_fingerprint: fingerprintString(snapshot),
      verification_plan: structuredClone(state.state.verification_plan),
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      expires_at: new Date(finishedAt.getTime() + VERIFICATION_RECEIPT_TTL_MS).toISOString(),
      commands: commands.map(publicCommand),
      workspace: {
        source_repository: fs.realpathSync(repoRoot),
        temporary_root: temporaryRoot,
        clone_root: cloneRoot,
        store_root: storeRoot,
        manifest_entries: manifests.sourceManifest.entries,
        manifest_sha256: manifests.sourceManifest.digest,
        manifest_match: manifests.sourceManifest.digest === manifests.cloneManifest.digest,
        ignored_files_excluded: true
      },
      tests: { project_state: projectCounts, domain_regression: domainCounts },
      build: {
        result: buildCommand.exit_code === 0 ? 'PASS' : 'FAIL',
        exit_code: buildCommand.exit_code,
        vite_version: viteVersion,
        transformed_modules: transformed ? Number(transformed[1]) : -1,
        warnings: (buildOutput.match(/\(!\)/g) || []).length
      },
      toolchain: {
        node: parseVersion(commands.find((command) => command.id === 'node_version')),
        pnpm: parseVersion(commands.find((command) => command.id === 'pnpm_version')),
        vite: viteVersion
      },
      lockfile: {
        path: 'pnpm-lock.yaml',
        sha256: lockfileBefore,
        before_sha256: lockfileBefore,
        after_sha256: lockfileAfter,
        unchanged: lockfileBefore === lockfileAfter
      },
      database: {
        temporary_only: true,
        root: databaseRoot,
        sanitized_environment: true,
        real_data_modified: false
      },
      real_data_modified: false
    };
  } catch (error) {
    failures.push(error.message);
  } finally {
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch {
      failures.push('Temporary verification workspace cleanup failed.');
    }
  }
  if (failures.length || !payload) return { ok: false, receiptId: null, failures };
  const receipt = issueVerificationReceipt(payload);
  return { ok: true, receiptId: receipt.receipt_id, failures: [], receipt };
}
