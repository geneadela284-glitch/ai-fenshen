import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_STATE_FILE,
  PROJECT_STATE_ERROR,
  checkpointProjectState,
  collectWorkingTreeSnapshot,
  parseProjectStateDocument,
  renderProjectStateDocument,
  validateProjectState
} from './projectState.js';
import { consumeVerificationReceipt, runProjectVerification } from './verificationReceipt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESUME_SCRIPT = path.join(HERE, 'resume.js');
const CHECKPOINT_SCRIPT = path.join(HERE, 'checkpoint.js');
const PROJECT_ROOT = path.resolve(HERE, '../..');
const STATE_TOKEN_PREFIX = 'aiwc-project-state-document-v1-sha256:';
const EVIDENCE_DEFINITIONS = Object.freeze([
  { id: 'entity-grounding-root-cause', path: 'docs/memory/M9_ENTITY_GROUNDING_ROOT_CAUSE_AUDIT.md', role: 'root_cause' },
  { id: 'entity-model-decision-gate', path: 'docs/memory/ENTITY_MODEL_DECISION_GATE.md', role: 'decision_gate' },
  { id: 'entity-model-v2-proposal', path: 'docs/memory/ENTITY_MEMORY_MODEL_V2_PROPOSAL.md', role: 'proposal' },
  { id: 'entity-resolution-model', path: 'docs/memory/ENTITY_RESOLUTION_AND_RELATION_MODEL.md', role: 'architecture' },
  { id: 'entity-grounded-recall-invariants', path: 'docs/memory/ENTITY_GROUNDED_RECALL_INVARIANTS.md', role: 'invariants' },
  { id: 'entity-model-migration-plan', path: 'docs/memory/ENTITY_MODEL_MIGRATION_PLAN.md', role: 'migration_plan' }
]);
const EVIDENCE_PATHS = Object.freeze(EVIDENCE_DEFINITIONS.map((item) => item.path));
const EVIDENCE_FIXTURES = Object.freeze({
  'docs/memory/M9_ENTITY_GROUNDING_ROOT_CAUSE_AUDIT.md': '# Audit\n状态：`BLOCKED`\n需要 Entity Memory Model V2\n',
  'docs/memory/ENTITY_MODEL_DECISION_GATE.md': '# Gate\nM9 保持 BLOCKED\nG1 G2 G3 G4 G5 G6 G7 G8 G9\n',
  'PROJECT_STATUS.md': '# Status\nAI_WORK_SECRETARY_PROJECT_STATE.md is the only canonical project state.\n',
  'docs/NEXT_SESSION_HANDOFF.md': '# Handoff\nAI_WORK_SECRETARY_PROJECT_STATE.md is the only canonical project state.\n'
});

function git(repoRoot, ...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function write(repoRoot, relativePath, content = '# fixture\n') {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function createRepository() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-test-'));
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@example.invalid');
  git(repoRoot, 'config', 'user.name', 'Project State Fixture');
  write(repoRoot, 'README.md');
  write(repoRoot, 'package.json', `${JSON.stringify({
    name: 'project-state-fixture', private: true, type: 'module', scripts: { build: 'node build.mjs' }
  }, null, 2)}\n`);
  write(repoRoot, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
  write(repoRoot, 'build.mjs', "console.log('vite v9.9.9 building for production...');\nconsole.log('✓ 3 modules transformed.');\n");
  const smokeTest = "import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture',()=>assert.equal(1,1));\n";
  write(repoRoot, 'scripts/project-state/smoke.test.js', smokeTest);
  for (const testPath of [
    'memory/recall/entityGrounding.test.js',
    'memory/integration/service.test.js',
    'memory/integration/runtime.test.js'
  ]) write(repoRoot, testPath, smokeTest);
  for (const evidencePath of EVIDENCE_PATHS) {
    write(repoRoot, evidencePath, EVIDENCE_FIXTURES[evidencePath] || '# fixture\n');
  }
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'fixture baseline');
  return repoRoot;
}

function verifiedCheckpointInput(repoRoot, statePath, now = new Date('2030-02-03T04:00:00.000Z'), stateUpdates = {}) {
  const verification = runProjectVerification({
    repoRoot,
    statePath,
    now,
    tempParent: fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-verification-'))
  });
  assert.equal(verification.ok, true, verification.failures?.join('\n'));
  const restored = validateProjectState({ repoRoot, statePath });
  const snapshot = collectWorkingTreeSnapshot(repoRoot);
  return {
    verificationReceipt: verification.receipt,
    expectedStateToken: restored.stateToken,
    expectedWorkingTreeFingerprint: `${snapshot.fingerprint.algorithm}:${snapshot.fingerprint.value}`,
    stateUpdates
  };
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function stateToken(content) {
  return `${STATE_TOKEN_PREFIX}${sha256(content)}`;
}

function evidenceFor(repoRoot, definitions = EVIDENCE_DEFINITIONS) {
  return definitions.map((item) => ({
    ...item,
    required: item.required ?? true,
    digest: {
      algorithm: 'sha256',
      value: sha256(fs.readFileSync(path.join(repoRoot, item.path)))
    }
  }));
}

function decisionGates() {
  return Array.from({ length: 9 }, (_, index) => ({
    id: `G${index + 1}`,
    title: `Entity Model decision ${index + 1}`,
    status: 'UNAPPROVED',
    blocks_following_actions: true,
    evidence_ids: ['entity-model-decision-gate']
  }));
}

function stateFor(repoRoot, overrides = {}) {
  const snapshot = collectWorkingTreeSnapshot(repoRoot);
  const base = {
    schema_version: 3,
    checkpoint_generation: 0,
    project_id: 'ai-work-secretary-audit-memory-os',
    canonical_project_name: 'Ai工作秘书 / Audit Memory OS',
    current_milestone: {
      id: 'M9',
      name: 'Entity Grounding',
      label: 'M9 — Entity Grounding'
    },
    status: 'BLOCKED',
    verified_at: '2030-01-02T03:04:05.000Z',
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
        id: 'entity-grounding-regression',
        title: 'Entity grounding regression',
        test_paths: [
          'memory/recall/entityGrounding.test.js',
          'memory/integration/service.test.js',
          'memory/integration/runtime.test.js'
        ]
      }
    },
    real_data_modified: false,
    tests: [
      {
        name: 'M9 entity grounding related tests',
        command: 'node --test memory/recall/entityGrounding.test.js memory/integration/service.test.js memory/integration/runtime.test.js',
        result: '140/140 PASS',
        verification_scope: 'current_run'
      }
    ],
    build: {
      command: 'pnpm build',
      result: 'PASS',
      verification_scope: 'current_run'
    },
    blocker: 'Stable entity identity is absent across the Memory OS contract.',
    root_cause_summary: [
      'Relationship buckets are not stable Entity IDs.',
      'The Entity Contract does not span Capture through downstream derived systems.'
    ],
    approved_decisions: [
      'Keep the exact subject + predicate containment until Entity Model V2 is approved and implemented.'
    ],
    current_engineering_action: {
      id: 'S0-R1',
      title: 'Canonical Project State and Evidence Contract Unification',
      status: 'IN_PROGRESS',
      authorized: true,
      gate_ids: []
    },
    next_product_action_after_stabilization: {
      id: 'ENTITY_MODEL_GATE_REVIEW',
      title: '审查并批准 Entity Model Decision Gate G1–G9',
      status: 'PENDING',
      after_engineering_action_id: 'S0-R1',
      gate_ids: Array.from({ length: 9 }, (_, index) => `G${index + 1}`)
    },
    decision_gates: decisionGates(),
    forbidden_actions: [
      {
        id: 'pause-memory-center',
        action_id: 'CONTINUE_MEMORY_CENTER',
        description: 'Do not continue Memory Center.',
        condition: { type: 'always' },
        severity: 'BLOCKING',
        enforcement: 'FAIL_CLOSED'
      },
      {
        id: 'keep-current-milestone-open',
        action_id: 'CLOSE_CURRENT_MILESTONE',
        description: 'Do not close M9.',
        condition: { type: 'until_gates_approved', gate_ids: Array.from({ length: 9 }, (_, index) => `G${index + 1}`) },
        severity: 'BLOCKING',
        enforcement: 'FAIL_CLOSED'
      },
      {
        id: 'block-next-milestone',
        action_id: 'START_NEXT_MILESTONE',
        description: 'Do not start M10.',
        condition: { type: 'until_gates_approved', gate_ids: Array.from({ length: 9 }, (_, index) => `G${index + 1}`) },
        severity: 'BLOCKING',
        enforcement: 'FAIL_CLOSED'
      },
      {
        id: 'block-entity-v2-implementation',
        action_id: 'IMPLEMENT_ENTITY_MODEL_V2',
        description: 'Do not implement Entity Model V2 before G1-G9 approval.',
        condition: { type: 'until_gates_approved', gate_ids: Array.from({ length: 9 }, (_, index) => `G${index + 1}`) },
        severity: 'BLOCKING',
        enforcement: 'FAIL_CLOSED'
      }
    ],
    evidence: evidenceFor(repoRoot),
    updated_by: 'fixture-agent'
  };
  return { ...base, ...overrides };
}

function scopedRealDataAuthorization() {
  return {
    scope: 'local-m9-2-acceptance',
    environment: 'local-m9-2-acceptance',
    database_kind: 'isolated_acceptance_memory',
    database_path: '/Users/tristazhang/Desktop/AI-Fenshen-Dev/runtime/m9-2-acceptance/memory.sqlite',
    owner_source: 'authenticated_session',
    allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
    original_memory_database: {
      path: '/Users/tristazhang/Desktop/Ai work center/data/memory/memory.sqlite',
      access: 'read_only'
    },
    cross_owner_access: 'denied',
    migration_allowed: false,
    bulk_import_allowed: false,
    active_action_ids: ['S0-R1', 'ENTITY_MODEL_GATE_REVIEW']
  };
}

function scopedRealDataAuthorizations() {
  return {
    'local-m9-2-acceptance': scopedRealDataAuthorization(),
    'vps-staging': {
      ...scopedRealDataAuthorization(),
      scope: 'vps-staging',
      environment: 'vps-staging',
      database_path: '/opt/ai-fenshen-staging/shared/data/memory/memory.sqlite'
    }
  };
}

function writeState(repoRoot, state) {
  write(repoRoot, CANONICAL_STATE_FILE, renderProjectStateDocument(state));
}

function validate(repoRoot) {
  return validateProjectState({ repoRoot, statePath: path.join(repoRoot, CANONICAL_STATE_FILE) });
}

function mutableCanonicalFacts(current) {
  return [
    current.current_milestone?.id,
    current.current_milestone?.name,
    current.current_milestone?.label,
    current.current_engineering_action?.id,
    current.current_engineering_action?.title,
    current.next_engineering_action?.id,
    current.next_engineering_action?.title,
    current.next_product_action_after_stabilization?.id,
    current.next_product_action_after_stabilization?.title,
    current.blocker,
    current.updated_by,
    ...current.root_cause_summary,
    ...current.approved_decisions,
    ...current.decision_gates.flatMap((gate) => [gate.id, gate.title]),
    ...current.forbidden_actions.flatMap((action) => [action.id, action.action_id, action.description]),
    ...current.tests.map((entry) => entry.result === 'PASS' ? '' : entry.result)
  ].filter((value) => typeof value === 'string' && value.length > 1);
}

function currentMutableCanonicalFacts() {
  return mutableCanonicalFacts(parseProjectStateDocument(
    fs.readFileSync(path.join(PROJECT_ROOT, CANONICAL_STATE_FILE), 'utf8')
  ));
}

function copiedMutableFacts(runtimeSource, state) {
  return mutableCanonicalFacts(state).filter((fact) => runtimeSource.includes(fact));
}

test('runtime mutable-state audit excludes structural verification labels', () => {
  assert.equal(currentMutableCanonicalFacts().includes('Project-state tests'), false);
});

test('runtime mutable-state audit detects a copied current milestone fact', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot, {
    current_milestone: {
      id: 'SYNTHETIC-MILESTONE',
      name: 'Synthetic milestone name',
      label: 'SYNTHETIC-MILESTONE — Synthetic milestone name'
    }
  });
  assert.deepEqual(
    copiedMutableFacts('const milestone = "SYNTHETIC-MILESTONE — Synthetic milestone name";', state),
    ['SYNTHETIC-MILESTONE', 'Synthetic milestone name', 'SYNTHETIC-MILESTONE — Synthetic milestone name']
  );
});

test('runtime mutable-state audit detects a copied current action fact', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot, {
    current_engineering_action: {
      id: 'SYNTHETIC-CURRENT-ACTION',
      title: 'Synthetic current action title',
      status: 'IN_PROGRESS',
      authorized: true,
      gate_ids: []
    }
  });
  assert.deepEqual(
    copiedMutableFacts('const action = "SYNTHETIC-CURRENT-ACTION: Synthetic current action title";', state),
    ['SYNTHETIC-CURRENT-ACTION', 'Synthetic current action title']
  );
});

test('canonical state with runtime structural rules contains no copied mutable facts', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  const runtimeRules = [
    'state.current_milestone.label',
    'state.current_engineering_action.title',
    'state.decision_gates.map((gate) => gate.status)',
    'state.tests.map((entry) => entry.result)'
  ].join('\n');
  assert.deepEqual(copiedMutableFacts(runtimeRules, state), []);
});

test('valid canonical state restores successfully', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const result = validate(repoRoot);
  assert.equal(result.ok, true);
  assert.equal(result.state.project_id, 'ai-work-secretary-audit-memory-os');
  assert.equal(result.state.status, 'BLOCKED');
});

test('canonical state rejects malformed scoped real-data authorization', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, {
    real_data_authorization: {
      ...scopedRealDataAuthorization(),
      owner_source: 'request_body'
    }
  }));
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /real_data_authorization|owner.*session/i);
});

test('legacy single-scope canonical state still restores', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, {
    real_data_authorization: scopedRealDataAuthorization()
  }));
  const execution = spawnSync(process.execPath, [RESUME_SCRIPT], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /PROJECT_STATE_RESTORED/);
});

test('new multi-scope canonical state validates and resumes', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, {
    real_data_authorizations: scopedRealDataAuthorizations()
  }));
  assert.equal(validate(repoRoot).ok, true);
  const execution = spawnSync(process.execPath, [RESUME_SCRIPT], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /PROJECT_STATE_RESTORED/);
});

test('canonical state rejects a malformed entry in the multi-scope registry', () => {
  const repoRoot = createRepository();
  const authorizations = scopedRealDataAuthorizations();
  authorizations['vps-staging'].owner_source = 'request_body';
  writeState(repoRoot, stateFor(repoRoot, { real_data_authorizations: authorizations }));
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /vps-staging|owner.*session|real_data_authorizations/i);
});

test('canonical state rejects legacy and multi-scope authorization fields together', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, {
    real_data_authorization: scopedRealDataAuthorization(),
    real_data_authorizations: scopedRealDataAuthorizations()
  }));
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /cannot coexist|legacy|multi.scope/i);
});

test('project state token covers every authorization scope', () => {
  const repoRoot = createRepository();
  const base = stateFor(repoRoot, { real_data_authorizations: scopedRealDataAuthorizations() });
  const localChanged = structuredClone(base);
  localChanged.real_data_authorizations['local-m9-2-acceptance'].allowed_operations = ['query'];
  const vpsChanged = structuredClone(base);
  vpsChanged.real_data_authorizations['vps-staging'].allowed_operations = ['query'];
  const baseToken = stateToken(renderProjectStateDocument(base));
  assert.notEqual(stateToken(renderProjectStateDocument(localChanged)), baseToken);
  assert.notEqual(stateToken(renderProjectStateDocument(vpsChanged)), baseToken);
});

test('missing canonical state fails closed', () => {
  const repoRoot = createRepository();
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /state file is missing/i);
});

test('tampered project ID fails closed', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, { project_id: 'wrong-project' }));
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /project_id/);
});

test('unsupported schema version fails closed', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, { schema_version: 99 }));
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /schema_version/);
});

test('missing required field fails closed', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  delete state.blocker;
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /blocker/);
});

test('M9 milestone cannot authorize M10 or bypass G1-G9', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  state.current_engineering_action = {
    id: 'START_NEXT_MILESTONE',
    title: 'Start M10 reliability validation',
    status: 'IN_PROGRESS',
    authorized: true,
    gate_ids: ['G1']
  };
  state.next_product_action_after_stabilization.after_engineering_action_id = 'START_NEXT_MILESTONE';
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /gate|forbidden/i);
});

test('missing evidence file fails closed', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  fs.unlinkSync(path.join(repoRoot, EVIDENCE_PATHS[0]));
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /evidence/i);
});

test('contradictory critical evidence fails closed', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  write(repoRoot, EVIDENCE_PATHS[0], '# Audit\n状态：`COMPLETED`\n');
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /evidence.*digest.*mismatch/i);
});

test('unknown or non-ancestor base commit fails closed', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, { verified_base_commit: 'f'.repeat(40) }));
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /verified_base_commit/);
});

test('damaged state document fails closed', () => {
  const repoRoot = createRepository();
  write(repoRoot, CANONICAL_STATE_FILE, '# broken\n```json\n{"schema_version":\n```\n');
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /parse|metadata|JSON/i);
});

test('unexplained working-tree drift fails closed', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  write(repoRoot, 'unexpected.txt', 'drift\n');
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /working_tree/);
});

test('working-tree snapshot records a tracked path as canonical base64', () => {
  const repoRoot = createRepository();
  write(repoRoot, 'README.md', '# changed\n');
  const snapshot = collectWorkingTreeSnapshot(repoRoot);
  assert.deepEqual(snapshot.entries, [{
    kind: 'tracked',
    path_encoding: 'base64',
    path: Buffer.from('README.md').toString('base64')
  }]);
});

test('working-tree fingerprint detects content drift when porcelain paths stay unchanged', () => {
  const repoRoot = createRepository();
  write(repoRoot, 'README.md', '# first dirty value\n');
  writeState(repoRoot, stateFor(repoRoot));
  write(repoRoot, 'README.md', '# second dirty value\n');
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /working_tree.*fingerprint/i);
});

test('working-tree validator rejects a digest primitive that is not the complete algorithm ID', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  state.working_tree.fingerprint.algorithm = 'sha256';
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /fingerprint\.algorithm/);
});

test('successful resume prints the complete fingerprint algorithm ID', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const execution = spawnSync(process.execPath, [RESUME_SCRIPT], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /PROJECT_STATE_RESTORED/);
  assert.match(execution.stdout, /aiwc-working-tree-fingerprint-v2-sha256:/);
  assert.match(execution.stdout, /Checkpoint generation: 0/);
  assert.match(execution.stdout, new RegExp(`State token: ${STATE_TOKEN_PREFIX}[0-9a-f]{64}`));
});

test('explicit checkpoint recovery CLI is idempotent when no transaction is pending', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const execution = spawnSync(process.execPath, [CHECKPOINT_SCRIPT, '--recover'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /PROJECT_STATE_CHECKPOINT_RECOVERED/);
  assert.match(execution.stdout, /NO_RECOVERY_NEEDED/);
  assert.match(execution.stdout, /Checkpoint generation: 0/);
  assert.match(execution.stdout, new RegExp(`State token: ${STATE_TOKEN_PREFIX}[0-9a-f]{64}`));
});

test('checkpoint generation is required canonical metadata', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  delete state.checkpoint_generation;
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /checkpoint_generation/);
});

test('checkpoint atomically updates state and revalidates it', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const beforeToken = stateToken(fs.readFileSync(statePath));
  const input = verifiedCheckpointInput(repoRoot, statePath);
  const result = checkpointProjectState({
    repoRoot,
    statePath,
    now: new Date('2030-02-03T04:05:06.000Z'),
    input
  });
  assert.equal(result.ok, true);
  const parsed = parseProjectStateDocument(fs.readFileSync(statePath, 'utf8'));
  assert.equal(parsed.verified_at, '2030-02-03T04:05:06.000Z');
  assert.match(parsed.updated_by, /project:verify receipt/);
  assert.equal(parsed.checkpoint_generation, 1);
  assert.equal(result.stateToken, stateToken(fs.readFileSync(statePath)));
  assert.notEqual(result.stateToken, beforeToken);
  assert.deepEqual(
    fs.readdirSync(repoRoot).filter((name) => name.includes('.project-state.tmp')),
    []
  );
});

test('checkpoint rejects a stale state token without changing canonical bytes', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const input = verifiedCheckpointInput(repoRoot, statePath);
  assert.throws(() => checkpointProjectState({
    repoRoot,
    statePath,
    input: {
      ...input,
      expectedStateToken: `${STATE_TOKEN_PREFIX}${'0'.repeat(64)}`
    }
  }), /state token|CAS|stale/i);
  assert.deepEqual(fs.readFileSync(statePath), before);
});

test('checkpoint rejects caller-supplied generation without changing canonical bytes', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  assert.throws(() => checkpointProjectState({
    repoRoot,
    statePath,
    input: {
      tests: [{ name: 'Synthetic', command: 'node --test synthetic.test.js', result: '1/1 PASS', verification_scope: 'current_run' }],
      build: { command: 'pnpm build', result: 'PASS', verification_scope: 'current_run' },
      realDataModified: false,
      updatedBy: 'stale-generation-agent',
      expectedGeneration: 99,
      expectedStateToken: stateToken(before),
      stateUpdates: {}
    }
  }), /generation|caller-supplied|forbidden/i);
  assert.deepEqual(fs.readFileSync(statePath), before);
});

test('fault after canonical rename rolls back to the original exact bytes', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const input = verifiedCheckpointInput(repoRoot, statePath);
  assert.throws(() => checkpointProjectState({
    repoRoot,
    statePath,
    input,
    transactionOptions: {
      faultInjector(point) {
        if (point === 'after-canonical-rename') throw new Error('injected-after-rename');
      }
    }
  }), /injected-after-rename/);
  assert.deepEqual(fs.readFileSync(statePath), before);
});

test('checkpoint refuses an existing exclusive lock', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const input = verifiedCheckpointInput(repoRoot, statePath);
  const lockPath = path.join(repoRoot, '.git', 'aiwc-project-state', 'lock');
  fs.mkdirSync(lockPath, { recursive: true });
  assert.throws(() => checkpointProjectState({
    repoRoot,
    statePath,
    input
  }), /lock|concurrent/i);
  assert.deepEqual(fs.readFileSync(statePath), before);
});

test('resume fails closed while a checkpoint transaction journal exists', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const transactionRoot = path.join(repoRoot, '.git', 'aiwc-project-state');
  fs.mkdirSync(transactionRoot, { recursive: true });
  fs.writeFileSync(path.join(transactionRoot, 'transaction.json'), '{"version":1}\n');
  const execution = spawnSync(process.execPath, [RESUME_SCRIPT], { cwd: repoRoot, encoding: 'utf8' });
  const output = `${execution.stdout}\n${execution.stderr}`;
  assert.notEqual(execution.status, 0);
  assert.match(output, /PROJECT_STATE_NOT_RESTORED/);
  assert.match(output, /PROJECT_STATE_RECOVERY_REQUIRED/);
  assert.doesNotMatch(output, /Project:\s|Milestone:\s|Status:\s/);
});

test('checkpoint refuses to invent missing test or build evidence', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath, 'utf8');
  assert.throws(() => checkpointProjectState({
    repoRoot,
    statePath,
    input: {
      tests: [],
      realDataModified: false,
      updatedBy: 'checkpoint-test-agent',
      stateUpdates: {}
    }
  }), /tests|build/i);
  assert.equal(fs.readFileSync(statePath, 'utf8'), before);
});

test('checkpoint rejects complete caller-supplied PASS evidence without a verification receipt', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  assert.throws(() => checkpointProjectState({
    repoRoot,
    statePath,
    input: {
      tests: [{ name: 'Caller claim', command: 'false', result: 'PASS', verification_scope: 'caller' }],
      build: { command: 'false', result: 'PASS', verification_scope: 'caller' },
      realDataModified: false,
      updatedBy: 'caller',
      expectedGeneration: 0,
      expectedStateToken: stateToken(before),
      stateUpdates: {}
    }
  }), /receipt|caller|tests|build/i);
  assert.deepEqual(fs.readFileSync(statePath), before);
  assert.equal(parseProjectStateDocument(before.toString('utf8')).checkpoint_generation, 0);
});

test('checkpoint CLI rejects legacy caller-supplied PASS flags without printing success', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const execution = spawnSync(process.execPath, [CHECKPOINT_SCRIPT, '--tests-json', '[]'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /disabled|project:verify|forged|replayed/i);
  assert.doesNotMatch(`${execution.stdout}\n${execution.stderr}`, /PROJECT_STATE_CHECKPOINT_UPDATED/);
});

test('failed resume prints the fail-closed marker and no normal summary', () => {
  const repoRoot = createRepository();
  const execution = spawnSync(process.execPath, [RESUME_SCRIPT], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const output = `${execution.stdout}\n${execution.stderr}`;
  assert.notEqual(execution.status, 0);
  assert.match(output, new RegExp(PROJECT_STATE_ERROR));
  assert.doesNotMatch(output, /Project:\s|Milestone:\s|Status:\s/);
  assert.equal(
    fs.readdirSync(repoRoot, { recursive: true }).some((name) => String(name).endsWith('.sqlite')),
    false
  );
});

test('a future milestone restores by changing only canonical metadata', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot, {
    current_milestone: { id: 'TEST-MILESTONE', name: 'Synthetic Future', label: 'TEST-MILESTONE — Synthetic Future' },
    status: 'IN_PROGRESS',
    blocker: '',
    current_engineering_action: {
      id: 'SYNTHETIC-R1',
      title: 'Synthetic engineering action',
      status: 'IN_PROGRESS',
      authorized: true,
      gate_ids: []
    }
  });
  state.next_product_action_after_stabilization.after_engineering_action_id = 'SYNTHETIC-R1';
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.state.current_milestone.id, 'TEST-MILESTONE');
});

test('resume summary milestone status and current action come from canonical metadata', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot, {
    current_milestone: {
      id: 'OUTPUT-MILESTONE',
      name: 'Canonical output milestone',
      label: 'OUTPUT-MILESTONE — Canonical output milestone'
    },
    status: 'IN_PROGRESS',
    blocker: '',
    current_engineering_action: {
      id: 'OUTPUT-CURRENT-ACTION',
      title: 'Canonical output current action',
      status: 'IN_PROGRESS',
      authorized: true,
      gate_ids: []
    }
  });
  state.next_product_action_after_stabilization.after_engineering_action_id = 'OUTPUT-CURRENT-ACTION';
  writeState(repoRoot, state);
  const execution = spawnSync(process.execPath, [RESUME_SCRIPT], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /Milestone: OUTPUT-MILESTONE — Canonical output milestone/);
  assert.match(execution.stdout, /Status: IN_PROGRESS/);
  assert.match(
    execution.stdout,
    /Current engineering action: \[OUTPUT-CURRENT-ACTION\] Canonical output current action \(IN_PROGRESS\)/
  );
});

test('non-canonical status documents cannot override restored canonical state', () => {
  const repoRoot = createRepository();
  write(repoRoot, 'PROJECT_STATUS.md', [
    '# NON-CANONICAL',
    'Current milestone: EXTERNAL-MILESTONE',
    'Current status: COMPLETE',
    'Current action: EXTERNAL-ACTION'
  ].join('\n'));
  write(repoRoot, 'docs/NEXT_SESSION_HANDOFF.md', [
    '# NON-CANONICAL',
    'Blocker: none',
    'Next action: EXTERNAL-NEXT-ACTION'
  ].join('\n'));
  writeState(repoRoot, stateFor(repoRoot));
  const result = validate(repoRoot);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.state.current_milestone.id, 'M9');
  assert.equal(result.state.status, 'BLOCKED');
  assert.equal(result.state.current_engineering_action.id, 'S0-R1');
});

test('status and current engineering action are metadata-defined', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot, {
    status: 'IN_PROGRESS',
    blocker: '',
    current_engineering_action: {
      id: 'S0-R9',
      title: 'A different stabilization action',
      status: 'AUTHORIZED',
      authorized: true,
      gate_ids: []
    }
  });
  state.next_product_action_after_stabilization.after_engineering_action_id = 'S0-R9';
  writeState(repoRoot, state);
  assert.equal(validate(repoRoot).ok, true);
});

test('decision gate IDs and titles are metadata-defined', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  state.decision_gates = [{
    id: 'QUALITY-1',
    title: 'Synthetic quality approval',
    status: 'UNAPPROVED',
    blocks_following_actions: true,
    evidence_ids: ['entity-model-decision-gate']
  }];
  state.next_product_action_after_stabilization.gate_ids = ['QUALITY-1'];
  state.forbidden_actions = [];
  writeState(repoRoot, state);
  assert.equal(validate(repoRoot).ok, true);
});

test('action reference to an unknown gate fails closed', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  state.current_engineering_action.gate_ids = ['UNKNOWN-GATE'];
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unknown gate|gate.*exist/i);
});

test('a forbidden action cannot also be the current authorized action', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  state.forbidden_actions.push({
    id: 'contradiction',
    action_id: state.current_engineering_action.id,
    description: 'Contradicts the current action.',
    condition: { type: 'always' },
    severity: 'BLOCKING',
    enforcement: 'FAIL_CLOSED'
  });
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /forbidden.*current|current.*forbidden/i);
});

test('BLOCKED state requires a non-empty blocker', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, { blocker: '' }));
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /BLOCKED.*blocker|blocker.*BLOCKED/i);
});

test('evidence path and digest come entirely from metadata', () => {
  const repoRoot = createRepository();
  write(repoRoot, 'docs/custom-evidence.md', '# Custom evidence\n');
  const definitions = [{ id: 'custom-evidence', path: 'docs/custom-evidence.md', role: 'custom' }];
  const state = stateFor(repoRoot, { evidence: evidenceFor(repoRoot, definitions) });
  state.decision_gates = [{
    id: 'CUSTOM-GATE',
    title: 'Custom gate',
    status: 'UNAPPROVED',
    blocks_following_actions: true,
    evidence_ids: ['custom-evidence']
  }];
  state.next_product_action_after_stabilization.gate_ids = ['CUSTOM-GATE'];
  state.forbidden_actions = [];
  writeState(repoRoot, state);
  assert.equal(validate(repoRoot).ok, true);
});

test('evidence digest mismatch fails closed without printing content', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  state.evidence[0].digest.value = '0'.repeat(64);
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /digest/i);
  assert.doesNotMatch(result.errors.join('\n'), /状态：|需要 Entity/);
});

test('modifying an evidence file after checkpoint fails closed', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  fs.appendFileSync(path.join(repoRoot, EVIDENCE_PATHS[0]), 'changed after checkpoint\n');
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /digest/i);
});

test('evidence path traversal fails closed', () => {
  const repoRoot = createRepository();
  const state = stateFor(repoRoot);
  state.evidence[0].path = '../outside.md';
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsafe|outside|escape/i);
});

test('evidence symlink escaping the repository fails closed', () => {
  const repoRoot = createRepository();
  const outside = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-outside.md`);
  fs.writeFileSync(outside, '# outside\n');
  fs.symlinkSync(outside, path.join(repoRoot, 'docs/escape.md'));
  const definitions = [{ id: 'escape', path: 'docs/escape.md', role: 'escape' }];
  const state = stateFor(repoRoot, { evidence: evidenceFor(repoRoot, definitions) });
  state.decision_gates = [{
    id: 'ESCAPE-GATE',
    title: 'Escape gate',
    status: 'UNAPPROVED',
    blocks_following_actions: true,
    evidence_ids: ['escape']
  }];
  state.next_product_action_after_stabilization.gate_ids = ['ESCAPE-GATE'];
  state.forbidden_actions = [];
  writeState(repoRoot, state);
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /symlink|outside|escape/i);
  fs.rmSync(outside, { force: true });
});

test('human-readable Markdown cannot drift from metadata', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  fs.appendFileSync(statePath, '\nindependent human edit\n');
  const result = validate(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /body|formatting|metadata/i);
});

test('historical status documents are pointer-only and archived', () => {
  for (const relativePath of ['PROJECT_STATUS.md', 'docs/NEXT_SESSION_HANDOFF.md']) {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
    assert.match(content, /NON-CANONICAL/);
    assert.match(content, /AI_WORK_SECRETARY_PROJECT_STATE\.md/);
    assert.doesNotMatch(content, /M9|BLOCKED|\d+\s*\/\s*\d+|Build\s*[:：].*PASS|G1.?G9/);
  }
  for (const relativePath of [
    'docs/archive/project-state/PROJECT_STATUS_PRE_CANONICAL.md',
    'docs/archive/project-state/NEXT_SESSION_HANDOFF_PRE_CANONICAL.md'
  ]) {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
    assert.match(content, /Historical/i);
    assert.match(content, /Non-canonical/i);
    assert.match(content, /Not valid for project recovery/i);
  }
});

test('runtime implementation contains no current milestone or gate facts', () => {
  const runtime = fs.readdirSync(HERE)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map((name) => fs.readFileSync(path.join(HERE, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(runtime, /\bM9\b|G1.?G9|Entity Model Decision Gate|EXPECTED_NEXT_ACTION|EXPECTED_GATES/);

  assert.deepEqual(
    copiedMutableFacts(runtime, parseProjectStateDocument(
      fs.readFileSync(path.join(PROJECT_ROOT, CANONICAL_STATE_FILE), 'utf8')
    )),
    []
  );
});

test('AGENTS bootstrap delegates all current state to canonical metadata', () => {
  const content = fs.readFileSync(path.join(PROJECT_ROOT, 'AGENTS.md'), 'utf8');
  const bootstrap = content.split('## Ai工作秘书 Project State Bootstrap')[1] || '';
  assert.match(bootstrap, /pnpm project:resume/);
  assert.match(bootstrap, /canonical/i);
  assert.doesNotMatch(bootstrap, /\bM9\b|\bBLOCKED\b|G1.?G9|Memory Center|\bM10\b|Entity Model V2/);
  for (const fact of currentMutableCanonicalFacts()) {
    assert.equal(content.includes(fact), false, `AGENTS.md copied mutable canonical fact: ${fact}`);
  }
});

test('checkpoint accepts a schema-valid non-G1 engineering action', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const input = verifiedCheckpointInput(repoRoot, statePath, new Date('2030-03-04T05:00:00.000Z'), {
    current_engineering_action: {
      id: 'SYNTHETIC-R2',
      title: 'Synthetic schema-valid action',
      status: 'IN_PROGRESS',
      authorized: true,
      gate_ids: []
    },
    next_product_action_after_stabilization: {
      ...stateFor(repoRoot).next_product_action_after_stabilization,
      after_engineering_action_id: 'SYNTHETIC-R2'
    }
  });
  const result = checkpointProjectState({
    repoRoot,
    statePath,
    now: new Date('2030-03-04T05:06:07.000Z'),
    input
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.current_engineering_action.id, 'SYNTHETIC-R2');
});

test('checkpoint can atomically register a valid scoped real-data authorization', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const input = verifiedCheckpointInput(repoRoot, statePath, new Date('2030-03-04T05:00:00.000Z'), {
    real_data_authorization: scopedRealDataAuthorization()
  });
  const result = checkpointProjectState({
    repoRoot,
    statePath,
    now: new Date('2030-03-04T05:06:07.000Z'),
    input
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.real_data_authorization.scope, 'local-m9-2-acceptance');
  assert.equal(result.state.real_data_authorization.owner_source, 'authenticated_session');
});

test('checkpoint atomically migrates legacy authorization to multi-scope registry', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, {
    real_data_authorization: scopedRealDataAuthorization()
  }));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const input = verifiedCheckpointInput(repoRoot, statePath, new Date('2030-03-04T05:00:00.000Z'), {
    real_data_authorizations: scopedRealDataAuthorizations()
  });
  const result = checkpointProjectState({
    repoRoot,
    statePath,
    now: new Date('2030-03-04T05:06:07.000Z'),
    input
  });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.state, 'real_data_authorization'), false);
  assert.deepEqual(Object.keys(result.state.real_data_authorizations).sort(), [
    'local-m9-2-acceptance',
    'vps-staging'
  ]);
});

test('changing one authorization scope invalidates an old verification receipt and CAS token', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, {
    real_data_authorizations: scopedRealDataAuthorizations()
  }));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const input = verifiedCheckpointInput(repoRoot, statePath);
  const changed = parseProjectStateDocument(fs.readFileSync(statePath, 'utf8'));
  changed.real_data_authorizations['vps-staging'].allowed_operations = ['query'];
  writeState(repoRoot, changed);
  const changedBytes = fs.readFileSync(statePath);
  assert.throws(() => checkpointProjectState({ repoRoot, statePath, input }), /state token|stale|CAS/i);
  const receipt = input.verificationReceipt;
  const receiptBindings = {
    projectId: changed.project_id,
    branch: receipt.branch,
    head: receipt.head,
    stateToken: stateToken(changedBytes),
    checkpointGeneration: changed.checkpoint_generation,
    workingTreeFingerprint: input.expectedWorkingTreeFingerprint,
    lockfileSha256: receipt.lockfile.sha256,
    verificationPlan: changed.verification_plan
  };
  assert.throws(() => consumeVerificationReceipt({
    repoRoot,
    receipt,
    now: new Date(receipt.finished_at),
    bindings: receiptBindings
  }), /state token mismatch/i);
  assert.doesNotThrow(() => consumeVerificationReceipt({
    repoRoot,
    receipt,
    now: new Date(receipt.finished_at),
    bindings: { ...receiptBindings, stateToken: input.expectedStateToken }
  }));
  assert.deepEqual(fs.readFileSync(statePath), changedBytes);
});

test('checkpoint rejects caller updates containing both authorization formats', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const input = verifiedCheckpointInput(repoRoot, statePath, new Date('2030-03-04T05:00:00.000Z'), {
    real_data_authorization: scopedRealDataAuthorization(),
    real_data_authorizations: scopedRealDataAuthorizations()
  });
  assert.throws(() => checkpointProjectState({ repoRoot, statePath, input }), /cannot coexist|both|legacy|multi.scope/i);
  assert.deepEqual(fs.readFileSync(statePath), before);
});

test('checkpoint rejects downgrade from multi-scope registry to legacy authorization', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, {
    real_data_authorizations: scopedRealDataAuthorizations()
  }));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const input = verifiedCheckpointInput(repoRoot, statePath, new Date('2030-03-04T05:00:00.000Z'), {
    real_data_authorization: scopedRealDataAuthorization()
  });
  assert.throws(() => checkpointProjectState({ repoRoot, statePath, input }), /cannot coexist|downgrade|legacy|multi.scope/i);
  assert.deepEqual(fs.readFileSync(statePath), before);
});

test('failed multi-scope migration restores exact legacy canonical bytes', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot, {
    real_data_authorization: scopedRealDataAuthorization()
  }));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const input = verifiedCheckpointInput(repoRoot, statePath, new Date('2030-03-04T05:00:00.000Z'), {
    real_data_authorizations: scopedRealDataAuthorizations()
  });
  assert.throws(() => checkpointProjectState({
    repoRoot,
    statePath,
    input,
    transactionOptions: {
      faultInjector(point) {
        if (point === 'after-canonical-rename') throw new Error('injected-multi-scope-migration-failure');
      }
    }
  }), /injected-multi-scope-migration-failure/);
  assert.deepEqual(fs.readFileSync(statePath), before);
  const restored = parseProjectStateDocument(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.hasOwn(restored, 'real_data_authorization'), true);
  assert.equal(Object.hasOwn(restored, 'real_data_authorizations'), false);
});

test('checkpoint rejects an action that references an unknown gate', () => {
  const repoRoot = createRepository();
  writeState(repoRoot, stateFor(repoRoot));
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const before = fs.readFileSync(statePath);
  const input = verifiedCheckpointInput(repoRoot, statePath, new Date('2030-03-04T05:00:00.000Z'), {
    current_engineering_action: {
      id: 'BROKEN-ACTION',
      title: 'Broken action',
      status: 'IN_PROGRESS',
      authorized: true,
      gate_ids: ['DOES-NOT-EXIST']
    },
    next_product_action_after_stabilization: {
      ...stateFor(repoRoot).next_product_action_after_stabilization,
      after_engineering_action_id: 'BROKEN-ACTION'
    }
  });
  assert.throws(() => checkpointProjectState({
    repoRoot,
    statePath,
    input
  }), /gate/i);
  assert.deepEqual(fs.readFileSync(statePath), before);
});
