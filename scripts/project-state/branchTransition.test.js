import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CANONICAL_STATE_FILE,
  collectWorkingTreeSnapshot,
  computeEvidenceDigest,
  parseProjectStateDocument,
  renderProjectStateDocument,
  validateProjectState
} from './projectState.js';

const TARGET = 'codex/target';

function git(repoRoot, ...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(repoRoot, relativePath, content) {
  const target = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixtureState(repoRoot, verifiedBaseCommit) {
  const snapshot = collectWorkingTreeSnapshot(repoRoot, [CANONICAL_STATE_FILE]);
  return {
    schema_version: 3,
    checkpoint_generation: 7,
    project_id: 'ai-work-secretary-audit-memory-os',
    canonical_project_name: 'Ai工作秘书 / Audit Memory OS',
    current_milestone: { id: 'M9', name: 'Entity Grounding', label: 'M9 — Entity Grounding' },
    status: 'BLOCKED',
    verified_at: '2030-01-02T03:04:05.000Z',
    verified_branch: 'main',
    verified_base_commit: verifiedBaseCommit,
    working_tree: {
      state: snapshot.state,
      entries: snapshot.entries,
      fingerprint: snapshot.fingerprint,
      excluded_paths: [CANONICAL_STATE_FILE],
      protected_preexisting_paths: []
    },
    verification_plan: {
      domain_regression: {
        id: 'fixture-regression',
        title: 'Fixture regression',
        test_paths: [
          'memory/recall/entityGrounding.test.js',
          'memory/integration/service.test.js',
          'memory/integration/runtime.test.js'
        ]
      }
    },
    real_data_modified: false,
    tests: [{ name: 'Fixture', command: 'node --test fixture', result: '1/1 PASS', verification_scope: 'fixture' }],
    build: { command: 'pnpm build', result: 'PASS', verification_scope: 'fixture' },
    blocker: 'Fixture blocker.',
    root_cause_summary: ['Fixture root cause.'],
    approved_decisions: ['Fixture decision.'],
    current_engineering_action: {
      id: 'CURRENT_ACTION', title: 'Current action remains unchanged', status: 'COMPLETED', authorized: true, gate_ids: []
    },
    next_product_action_after_stabilization: {
      id: 'NEXT_ACTION', title: 'Next action remains unchanged', status: 'AUTHORIZED', after_engineering_action_id: 'CURRENT_ACTION', gate_ids: []
    },
    decision_gates: [],
    forbidden_actions: [{
      id: 'fixture-protection', action_id: 'DO_NOT_TOUCH', description: 'Fixture protection.',
      condition: { type: 'always' }, severity: 'BLOCKING', enforcement: 'FAIL_CLOSED'
    }],
    evidence: [{
      id: 'fixture-evidence', path: 'evidence.md', role: 'fixture', required: true,
      digest: { algorithm: 'sha256', value: computeEvidenceDigest(fs.readFileSync(path.join(repoRoot, 'evidence.md'))) }
    }],
    updated_by: 'fixture'
  };
}

function createRepository() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-branch-transition-'));
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.name', 'Fixture');
  git(repoRoot, 'config', 'user.email', 'fixture@example.com');
  write(repoRoot, 'evidence.md', '# evidence\n');
  write(repoRoot, 'product.txt', 'approved product bytes\n');
  write(repoRoot, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  for (const testPath of [
    'memory/recall/entityGrounding.test.js',
    'memory/integration/service.test.js',
    'memory/integration/runtime.test.js'
  ]) write(repoRoot, testPath, "import test from 'node:test'; test('fixture', () => {});\n");
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'fixture product');
  const verifiedBaseCommit = git(repoRoot, 'rev-parse', 'HEAD');
  write(repoRoot, CANONICAL_STATE_FILE, renderProjectStateDocument(fixtureState(repoRoot, verifiedBaseCommit)));
  git(repoRoot, 'add', CANONICAL_STATE_FILE);
  git(repoRoot, 'commit', '-m', 'fixture canonical');
  git(repoRoot, 'branch', TARGET);
  assert.equal(validateProjectState({ repoRoot }).ok, true);
  return repoRoot;
}

async function api() {
  return import('./branchTransition.js');
}

async function transition(repoRoot, options = {}) {
  const { transitionVerifiedBranch } = await api();
  return transitionVerifiedBranch({
    repoRoot,
    targetBranch: TARGET,
    now: new Date('2030-02-03T04:05:06.000Z'),
    ...options
  });
}

function readState(repoRoot) {
  return parseProjectStateDocument(fs.readFileSync(path.join(repoRoot, CANONICAL_STATE_FILE), 'utf8'));
}

test('same-HEAD verified branch transition succeeds', async () => {
  const repoRoot = createRepository();
  const result = await transition(repoRoot);
  assert.equal(result.ok, true);
  assert.equal(result.targetBranch, TARGET);
});

test('generation increments exactly once', async () => {
  const repoRoot = createRepository();
  await transition(repoRoot);
  assert.equal(readState(repoRoot).checkpoint_generation, 8);
});

test('current action remains byte-equivalent', async () => {
  const repoRoot = createRepository();
  const before = JSON.stringify(readState(repoRoot).current_engineering_action);
  await transition(repoRoot);
  assert.equal(JSON.stringify(readState(repoRoot).current_engineering_action), before);
});

test('next action remains byte-equivalent', async () => {
  const repoRoot = createRepository();
  const before = JSON.stringify(readState(repoRoot).next_product_action_after_stabilization);
  await transition(repoRoot);
  assert.equal(JSON.stringify(readState(repoRoot).next_product_action_after_stabilization), before);
});

test('non-transition project state remains unchanged', async () => {
  const repoRoot = createRepository();
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const state = readState(repoRoot);
  state.real_data_modified = true;
  fs.writeFileSync(statePath, renderProjectStateDocument(state));
  git(repoRoot, 'add', CANONICAL_STATE_FILE);
  git(repoRoot, 'commit', '-m', 'record real-data audit state');
  git(repoRoot, 'branch', '-f', TARGET, 'HEAD');
  assert.equal(validateProjectState({ repoRoot }).ok, true);

  await transition(repoRoot);
  assert.equal(readState(repoRoot).real_data_modified, true);
});

test('verified branch becomes target branch', async () => {
  const repoRoot = createRepository();
  await transition(repoRoot);
  assert.equal(readState(repoRoot).verified_branch, TARGET);
});

test('fingerprint is rebuilt with the canonical exclusion', async () => {
  const repoRoot = createRepository();
  await transition(repoRoot);
  const expected = collectWorkingTreeSnapshot(repoRoot, [CANONICAL_STATE_FILE]).fingerprint;
  assert.deepEqual(readState(repoRoot).working_tree.fingerprint, expected);
});

test('dry-run returns candidate without modifying canonical', async () => {
  const repoRoot = createRepository();
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const result = await transition(repoRoot, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(fs.readFileSync(statePath), before);
  assert.equal(result.state.verified_branch, TARGET);
});

test('wrong current branch is rejected', async () => {
  const repoRoot = createRepository();
  git(repoRoot, 'branch', 'wrong');
  git(repoRoot, 'switch', 'wrong');
  await assert.rejects(() => transition(repoRoot), /verified branch|mismatch/i);
});

test('unstaged dirty worktree is rejected', async () => {
  const repoRoot = createRepository();
  write(repoRoot, 'product.txt', 'changed\n');
  await assert.rejects(() => transition(repoRoot), /clean|dirty/i);
});

test('staged dirty worktree is rejected', async () => {
  const repoRoot = createRepository();
  write(repoRoot, 'product.txt', 'changed\n');
  git(repoRoot, 'add', 'product.txt');
  await assert.rejects(() => transition(repoRoot), /clean|dirty/i);
});

test('untracked files are rejected', async () => {
  const repoRoot = createRepository();
  write(repoRoot, 'untracked.txt', 'no\n');
  await assert.rejects(() => transition(repoRoot), /clean|untracked|dirty/i);
});

test('missing target branch is rejected', async () => {
  const repoRoot = createRepository();
  const { transitionVerifiedBranch } = await api();
  assert.throws(() => transitionVerifiedBranch({ repoRoot, targetBranch: 'missing' }), /target branch.*exist/i);
});

test('different target HEAD is rejected', async () => {
  const repoRoot = createRepository();
  git(repoRoot, 'switch', TARGET);
  write(repoRoot, 'target-only.txt', 'different\n');
  git(repoRoot, 'add', 'target-only.txt');
  git(repoRoot, 'commit', '-m', 'target advanced');
  git(repoRoot, 'switch', 'main');
  await assert.rejects(() => transition(repoRoot), /same HEAD|HEAD.*equal/i);
});

test('detached HEAD is rejected', async () => {
  const repoRoot = createRepository();
  git(repoRoot, 'checkout', '--detach');
  await assert.rejects(() => transition(repoRoot), /detached|branch/i);
});

test('tampered canonical is rejected', async () => {
  const repoRoot = createRepository();
  fs.appendFileSync(path.join(repoRoot, CANONICAL_STATE_FILE), '\n');
  await assert.rejects(() => transition(repoRoot), /canonical|inconsistent|restored/i);
});

test('write fault restores canonical byte-for-byte', async () => {
  const repoRoot = createRepository();
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  await assert.rejects(() => transition(repoRoot, { faultInjector: (phase) => { if (phase === 'after-install') throw new Error('injected write fault'); } }), /injected write fault/);
  assert.deepEqual(fs.readFileSync(statePath), before);
});

test('successful transition preserves the canonical regular-file mode', async () => {
  const repoRoot = createRepository();
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  fs.chmodSync(statePath, 0o640);
  await transition(repoRoot);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o640);
});

test('transition to current branch is rejected', async () => {
  const repoRoot = createRepository();
  const { transitionVerifiedBranch } = await api();
  assert.throws(() => transitionVerifiedBranch({ repoRoot, targetBranch: 'main' }), /current branch|different/i);
});

test('only canonical file changes and product bytes remain unchanged', async () => {
  const repoRoot = createRepository();
  const before = sha256(fs.readFileSync(path.join(repoRoot, 'product.txt')));
  await transition(repoRoot);
  assert.equal(sha256(fs.readFileSync(path.join(repoRoot, 'product.txt'))), before);
  assert.deepEqual(git(repoRoot, 'diff', '--name-only').split('\n').filter(Boolean), [CANONICAL_STATE_FILE]);
});

test('resume validation succeeds after carrying state to target branch', async () => {
  const repoRoot = createRepository();
  await transition(repoRoot);
  git(repoRoot, 'switch', TARGET);
  assert.equal(validateProjectState({ repoRoot }).ok, true);
});

test('old branch fails closed after transition is carried to target', async () => {
  const repoRoot = createRepository();
  await transition(repoRoot);
  git(repoRoot, 'switch', TARGET);
  git(repoRoot, 'add', CANONICAL_STATE_FILE);
  git(repoRoot, 'commit', '-m', 'transition state');
  const newState = fs.readFileSync(path.join(repoRoot, CANONICAL_STATE_FILE));
  git(repoRoot, 'switch', 'main');
  fs.writeFileSync(path.join(repoRoot, CANONICAL_STATE_FILE), newState);
  const result = validateProjectState({ repoRoot });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /verified_branch mismatch/);
});

test('package exposes the permanent transition command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(packageJson.scripts['project:transition-branch'], 'node scripts/project-state/transitionBranch.js');
});

test('CLI dry-run does not alter fixture canonical', () => {
  const repoRoot = createRepository();
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const result = spawnSync(process.execPath, [path.resolve('scripts/project-state/transitionBranch.js'), '--to', TARGET, '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY_RUN/);
  assert.deepEqual(fs.readFileSync(statePath), before);
});
