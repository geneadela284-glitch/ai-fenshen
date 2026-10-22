import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CANONICAL_STATE_FILE,
  checkpointProjectState,
  collectWorkingTreeSnapshot,
  renderProjectStateDocument,
  validateProjectState
} from './projectState.js';
import {
  inspectVerificationReceipt,
  runProjectVerification
} from './verificationReceipt.js';

const VERIFY_SCRIPT = path.resolve('scripts/project-state/verify.js');

function git(repoRoot, ...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function write(repoRoot, relativePath, content) {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function fingerprint(snapshot) {
  return `${snapshot.fingerprint.algorithm}:${snapshot.fingerprint.value}`;
}

function createFixture({ failingTests = false, failingBuild = false, mutateLockDuringBuild = false, secretOutput = '' } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-receipt-test-'));
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@example.invalid');
  git(repoRoot, 'config', 'user.name', 'Verification Fixture');
  write(repoRoot, 'package.json', `${JSON.stringify({
    name: 'verification-fixture',
    private: true,
    type: 'module',
    scripts: { build: 'node build.mjs' }
  }, null, 2)}\n`);
  write(repoRoot, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
  const passingTest = "import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture',()=>assert.equal(1,1));\n";
  const failingTest = "import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture failure',()=>assert.equal(1,2));\n";
  for (const relativePath of [
    'scripts/project-state/checkpointTransaction.test.js',
    'scripts/project-state/projectState.test.js',
    'scripts/project-state/workingTreeFingerprint.test.js'
  ]) write(repoRoot, relativePath, failingTests ? failingTest : passingTest);
  for (const relativePath of [
    'memory/recall/entityGrounding.test.js',
    'memory/integration/service.test.js',
    'memory/integration/runtime.test.js'
  ]) write(repoRoot, relativePath, passingTest);
  const buildLines = [
    secretOutput ? `console.log(${JSON.stringify(secretOutput)});` : '',
    "console.log('vite v9.9.9 building for production...');",
    "console.log('✓ 7 modules transformed.');",
    mutateLockDuringBuild ? "import fs from 'node:fs'; fs.appendFileSync('pnpm-lock.yaml', '# drift\\n');" : '',
    failingBuild ? 'process.exitCode = 9;' : ''
  ].filter(Boolean);
  write(repoRoot, 'build.mjs', `${buildLines.join('\n')}\n`);
  write(repoRoot, 'docs/evidence.md', '# fixture evidence\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'fixture baseline');
  const snapshot = collectWorkingTreeSnapshot(repoRoot);
  const state = {
    schema_version: 3,
    checkpoint_generation: 0,
    project_id: 'ai-work-secretary-audit-memory-os',
    canonical_project_name: 'Verification Fixture',
    current_milestone: { id: 'TEST', name: 'Test', label: 'TEST — Verification' },
    status: 'IN_PROGRESS',
    verified_at: '2030-01-01T00:00:00.000Z',
    verified_branch: 'main',
    verified_base_commit: git(repoRoot, 'rev-parse', 'HEAD'),
    working_tree: {
      state: snapshot.state,
      entries: snapshot.entries,
      fingerprint: snapshot.fingerprint,
      excluded_paths: [CANONICAL_STATE_FILE],
      protected_preexisting_paths: []
    },
    verification_plan: {
      domain_regression: {
        id: 'fixture-domain-regression',
        title: 'Fixture domain regression',
        test_paths: [
          'memory/recall/entityGrounding.test.js',
          'memory/integration/service.test.js',
          'memory/integration/runtime.test.js'
        ]
      }
    },
    real_data_modified: false,
    tests: [{ name: 'Prior', command: 'node --test prior.test.js', result: 'PASS', verification_scope: 'historical' }],
    build: { command: 'pnpm build', result: 'PASS', verification_scope: 'historical' },
    blocker: '',
    root_cause_summary: [],
    approved_decisions: [],
    current_engineering_action: { id: 'S0-R3B', title: 'Receipt verification', status: 'IN_PROGRESS', authorized: true, gate_ids: [] },
    next_engineering_action: { id: 'S0-R4', title: 'Independent isolated re-audit', status: 'PENDING', authorized: false, after_engineering_action_id: 'S0-R3B', gate_ids: [] },
    next_product_action_after_stabilization: { id: 'PRODUCT-GATE', title: 'Product gate', status: 'PENDING', after_engineering_action_id: 'S0-R3B', gate_ids: [] },
    decision_gates: [],
    forbidden_actions: [],
    evidence: [{
      id: 'fixture-evidence',
      path: 'docs/evidence.md',
      required: true,
      role: 'fixture',
      digest: { algorithm: 'sha256', value: sha256(fs.readFileSync(path.join(repoRoot, 'docs/evidence.md'))) }
    }],
    updated_by: 'fixture'
  };
  write(repoRoot, CANONICAL_STATE_FILE, renderProjectStateDocument(state));
  return { repoRoot, statePath: path.join(repoRoot, CANONICAL_STATE_FILE) };
}

function currentBindings(fixture) {
  const state = validateProjectState({ repoRoot: fixture.repoRoot, statePath: fixture.statePath });
  assert.equal(state.ok, true, state.errors.join('\n'));
  const snapshot = collectWorkingTreeSnapshot(fixture.repoRoot);
  return {
    projectId: state.state.project_id,
    branch: git(fixture.repoRoot, 'branch', '--show-current'),
    head: git(fixture.repoRoot, 'rev-parse', 'HEAD'),
    stateToken: state.stateToken,
    checkpointGeneration: state.state.checkpoint_generation,
    workingTreeFingerprint: fingerprint(snapshot),
    lockfileSha256: sha256(fs.readFileSync(path.join(fixture.repoRoot, 'pnpm-lock.yaml'))),
    verificationPlan: state.state.verification_plan
  };
}

function verifyFixture(fixture, now = new Date('2030-01-01T01:00:00.000Z')) {
  return runProjectVerification({
    repoRoot: fixture.repoRoot,
    statePath: fixture.statePath,
    now,
    tempParent: fs.mkdtempSync(path.join(os.tmpdir(), 'verification-workspaces-'))
  });
}

let sharedReadOnlyVerification;
function readOnlyVerificationFixture() {
  if (!sharedReadOnlyVerification) {
    const fixture = createFixture();
    const verification = verifyFixture(fixture);
    assert.equal(verification.ok, true, verification.failures?.join('\n'));
    sharedReadOnlyVerification = { fixture, verification };
  }
  return sharedReadOnlyVerification;
}

function checkpointInput(fixture, receiptId, overrides = {}) {
  const bindings = currentBindings(fixture);
  return {
    verificationReceipt: receiptId,
    expectedStateToken: bindings.stateToken,
    expectedWorkingTreeFingerprint: bindings.workingTreeFingerprint,
    stateUpdates: {},
    ...overrides
  };
}

function forgedReceipt(receipt, mutate = () => {}) {
  const clone = structuredClone(receipt);
  mutate(clone);
  return clone;
}

test('real commands produce a valid receipt and checkpoint derives PASS evidence', () => {
  const fixture = createFixture();
  assert.equal(validateProjectState({ repoRoot: fixture.repoRoot, statePath: fixture.statePath }).state.checkpoint_generation, 0);
  const verification = verifyFixture(fixture);
  assert.equal(verification.ok, true, verification.failures?.join('\n'));
  const result = checkpointProjectState({
    repoRoot: fixture.repoRoot,
    statePath: fixture.statePath,
    input: checkpointInput(fixture, verification.receipt),
    now: new Date('2030-01-01T01:10:00.000Z')
  });
  assert.equal(result.state.checkpoint_generation, 1);
  assert.match(result.state.tests[0].verification_scope, new RegExp(verification.receiptId));
  assert.match(result.state.build.result, /PASS/);
});

test('project:verify checkpoint mode keeps verification and consumption in one trusted process', () => {
  const fixture = createFixture();
  const bindings = currentBindings(fixture);
  const execution = execFileSync(process.execPath, [
    VERIFY_SCRIPT,
    '--checkpoint',
    '--expected-state-token', bindings.stateToken,
    '--expected-working-tree-fingerprint', bindings.workingTreeFingerprint
  ], { cwd: fixture.repoRoot, encoding: 'utf8' });
  assert.match(execution, /PROJECT_VERIFICATION_RECEIPT_ISSUED/);
  assert.match(execution, /PROJECT_STATE_CHECKPOINT_UPDATED/);
  const restored = validateProjectState({ repoRoot: fixture.repoRoot, statePath: fixture.statePath });
  assert.equal(restored.ok, true, restored.errors.join('\n'));
  assert.equal(restored.state.checkpoint_generation, 1);
});

test('hand-written receipt cannot cross the in-process project:verify trust boundary', () => {
  const { fixture, verification } = readOnlyVerificationFixture();
  const before = fs.readFileSync(fixture.statePath);
  assert.throws(() => checkpointProjectState({
    repoRoot: fixture.repoRoot,
    statePath: fixture.statePath,
    input: checkpointInput(fixture, forgedReceipt(verification.receipt))
  }), /not issued|project:verify|receipt/i);
  assert.deepEqual(fs.readFileSync(fixture.statePath), before);
  const gitMetadataNames = fs.readdirSync(path.join(fixture.repoRoot, '.git'), { recursive: true })
    .map(String)
    .join('\n');
  assert.doesNotMatch(gitMetadataNames, /verification.*(key|secret)|receipt.*(key|secret)/i);
});

test('test failure cannot create a usable receipt', () => {
  const fixture = createFixture({ failingTests: true });
  const before = fs.readFileSync(fixture.statePath);
  const result = verifyFixture(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.receiptId, null);
  assert.deepEqual(fs.readFileSync(fixture.statePath), before);
  assert.equal(validateProjectState({ repoRoot: fixture.repoRoot, statePath: fixture.statePath }).state.checkpoint_generation, 0);
});

test('build failure cannot create a usable receipt', () => {
  const fixture = createFixture({ failingBuild: true });
  const before = fs.readFileSync(fixture.statePath);
  const result = verifyFixture(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.receiptId, null);
  assert.deepEqual(fs.readFileSync(fixture.statePath), before);
});

test('caller-supplied PASS evidence is rejected', () => {
  const fixture = createFixture();
  const before = fs.readFileSync(fixture.statePath);
  assert.throws(() => checkpointProjectState({
    repoRoot: fixture.repoRoot,
    statePath: fixture.statePath,
    input: {
      ...checkpointInput(fixture, {}),
      tests: [{ name: 'fake', command: 'false', result: 'PASS', verification_scope: 'caller' }],
      build: { command: 'false', result: 'PASS', verification_scope: 'caller' }
    }
  }), /caller|receipt|tests|build/i);
  assert.deepEqual(fs.readFileSync(fixture.statePath), before);
});

test('modified receipt is rejected byte-for-byte', () => {
  const { fixture, verification } = readOnlyVerificationFixture();
  const tampered = forgedReceipt(verification.receipt, (receipt) => { receipt.build.result = 'FAIL'; });
  assert.throws(() => checkpointProjectState({
    repoRoot: fixture.repoRoot,
    statePath: fixture.statePath,
    input: checkpointInput(fixture, tampered)
  }), /not issued|project:verify|receipt/i);
});

test('checkpoint cannot replace the canonical verification plan after commands ran', () => {
  const { fixture, verification } = readOnlyVerificationFixture();
  const before = fs.readFileSync(fixture.statePath);
  assert.throws(() => checkpointProjectState({
    repoRoot: fixture.repoRoot,
    statePath: fixture.statePath,
    input: checkpointInput(fixture, verification.receipt, {
      stateUpdates: {
        verification_plan: {
          domain_regression: {
            id: 'substituted-plan',
            title: 'Substituted plan',
            test_paths: ['substituted.test.js']
          }
        }
      }
    })
  }), /not allowed|verification_plan/i);
  assert.deepEqual(fs.readFileSync(fixture.statePath), before);
});

test('receipt is one-time and cannot be reused', () => {
  const fixture = createFixture();
  const verification = verifyFixture(fixture);
  checkpointProjectState({ repoRoot: fixture.repoRoot, statePath: fixture.statePath, input: checkpointInput(fixture, verification.receipt) });
  const after = fs.readFileSync(fixture.statePath);
  assert.throws(() => checkpointProjectState({ repoRoot: fixture.repoRoot, statePath: fixture.statePath, input: checkpointInput(fixture, verification.receipt) }), /used|receipt|not issued/i);
  assert.deepEqual(fs.readFileSync(fixture.statePath), after);
});

for (const [name, mutate, pattern] of [
  ['old state token', (bindings) => { bindings.stateToken = `aiwc-project-state-document-v1-sha256:${'0'.repeat(64)}`; }, /token/i],
  ['old generation', (bindings) => { bindings.checkpointGeneration = 99; }, /generation/i],
  ['old fingerprint', (bindings) => { bindings.workingTreeFingerprint = `aiwc-working-tree-fingerprint-v2-sha256:${'0'.repeat(64)}`; }, /fingerprint/i],
  ['different HEAD', (bindings) => { bindings.head = '0'.repeat(40); }, /HEAD/i],
  ['different branch', (bindings) => { bindings.branch = 'different'; }, /branch/i],
  ['different lockfile digest', (bindings) => { bindings.lockfileSha256 = '0'.repeat(64); }, /lockfile/i],
  ['different verification plan', (bindings) => { bindings.verificationPlan = { domain_regression: { id: 'other', title: 'Other', test_paths: ['other.test.js'] } }; }, /plan/i]
]) {
  test(`issued receipt with ${name} binding is rejected`, () => {
    const { fixture, verification } = readOnlyVerificationFixture();
    const bindings = currentBindings(fixture);
    mutate(bindings);
    assert.throws(() => inspectVerificationReceipt({
      repoRoot: fixture.repoRoot,
      receipt: verification.receipt,
      now: new Date('2030-01-01T01:01:00.000Z'),
      bindings
    }), pattern);
  });
}

for (const [name, mutate] of [
  ['missing required command', (payload) => { payload.commands = payload.commands.filter((command) => command.id !== 'build'); }],
  ['substituted required command', (payload) => { payload.commands.find((command) => command.id === 'build').args = ['fake-build']; }],
  ['nonzero exit code', (payload) => { payload.commands.find((command) => command.id === 'build').exit_code = 7; }],
  ['real database path', (payload) => { payload.database.temporary_only = false; payload.database.root = '/real/users.sqlite'; }]
]) {
  test(`forged receipt with ${name} is rejected before canonical write`, () => {
    const { fixture, verification } = readOnlyVerificationFixture();
    const before = fs.readFileSync(fixture.statePath);
    assert.throws(() => checkpointProjectState({
      repoRoot: fixture.repoRoot,
      statePath: fixture.statePath,
      input: checkpointInput(fixture, forgedReceipt(verification.receipt, mutate))
    }), /not issued|project:verify|receipt/i);
    assert.deepEqual(fs.readFileSync(fixture.statePath), before);
  });
}

test('current working-tree drift rejects an otherwise valid old receipt', () => {
  const fixture = createFixture();
  const verification = verifyFixture(fixture);
  const originalBindings = currentBindings(fixture);
  write(fixture.repoRoot, 'drift.txt', 'drift\n');
  const before = fs.readFileSync(fixture.statePath);
  assert.throws(() => checkpointProjectState({ repoRoot: fixture.repoRoot, statePath: fixture.statePath, input: {
    verificationReceipt: verification.receipt,
    expectedStateToken: originalBindings.stateToken,
    expectedWorkingTreeFingerprint: `aiwc-working-tree-fingerprint-v2-sha256:${'0'.repeat(64)}`,
    stateUpdates: {}
  } }), /fingerprint|working.tree/i);
  assert.deepEqual(fs.readFileSync(fixture.statePath), before);
});

test('lockfile mutation during verification prevents receipt issuance', () => {
  const result = verifyFixture(createFixture({ mutateLockDuringBuild: true }));
  assert.equal(result.ok, false);
  assert.equal(result.receiptId, null);
  assert.match(result.failures.join('\n'), /lockfile/i);
});

test('expired receipt is rejected', () => {
  const { fixture, verification } = readOnlyVerificationFixture();
  const before = fs.readFileSync(fixture.statePath);
  assert.throws(() => checkpointProjectState({
    repoRoot: fixture.repoRoot,
    statePath: fixture.statePath,
    input: checkpointInput(fixture, verification.receipt),
    now: new Date('2030-01-01T02:00:00.000Z')
  }), /expired/i);
  assert.deepEqual(fs.readFileSync(fixture.statePath), before);
});

test('receipt stores only output hashes and does not leak command output or sensitive environment values', () => {
  const secret = 'S0_R3B_DO_NOT_LEAK_9347';
  const previous = process.env.S0_R3B_TEST_SECRET;
  process.env.S0_R3B_TEST_SECRET = secret;
  try {
    const fixture = createFixture({ secretOutput: secret });
    const verification = verifyFixture(fixture);
    const bytes = JSON.stringify(verification.receipt);
    assert.doesNotMatch(bytes, new RegExp(secret));
    const receipt = inspectVerificationReceipt({
      repoRoot: fixture.repoRoot,
      receipt: verification.receipt,
      now: new Date('2030-01-01T01:01:00.000Z'),
      bindings: currentBindings(fixture)
    });
    for (const command of receipt.commands) {
      assert.match(command.stdout_sha256, /^[0-9a-f]{64}$/);
      assert.match(command.stderr_sha256, /^[0-9a-f]{64}$/);
      assert.equal('stdout' in command, false);
      assert.equal('stderr' in command, false);
    }
  } finally {
    if (previous === undefined) delete process.env.S0_R3B_TEST_SECRET;
    else process.env.S0_R3B_TEST_SECRET = previous;
  }
});
