import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  WORKING_TREE_FINGERPRINT_ALGORITHM,
  WORKING_TREE_FINGERPRINT_VERSION,
  collectWorkingTreeSnapshot as collectFingerprintSnapshot
} from './workingTreeFingerprint.js';
import {
  CHECKPOINT_RECOVERY_REQUIRED,
  inspectCheckpointTransaction,
  recoverCheckpointTransaction,
  runCheckpointTransaction
} from './checkpointTransaction.js';
import { consumeVerificationReceipt } from './verificationReceipt.js';
import {
  validateScopedRealDataAuthorization,
  validateScopedRealDataAuthorizations
} from '../../core/safety/scopedRealDataAuthorization.js';

export const CANONICAL_STATE_FILE = 'AI_WORK_SECRETARY_PROJECT_STATE.md';
export const PROJECT_STATE_ERROR = 'PROJECT_STATE_NOT_RESTORED';
export const PROJECT_STATE_OK = 'PROJECT_STATE_RESTORED';
export const EXPECTED_PROJECT_ID = 'ai-work-secretary-audit-memory-os';
export const SUPPORTED_SCHEMA_VERSION = 3;
export const PROJECT_STATE_TOKEN_ALGORITHM = 'aiwc-project-state-document-v1-sha256';

const METADATA_START = '<!-- AI_WORK_SECRETARY_PROJECT_STATE_METADATA_START -->';
const METADATA_END = '<!-- AI_WORK_SECRETARY_PROJECT_STATE_METADATA_END -->';
const PROJECT_STATUSES = Object.freeze(['PLANNED', 'IN_PROGRESS', 'AWAITING_ACCEPTANCE', 'BLOCKED', 'READY', 'COMPLETED', 'CANCELLED']);
const ACTION_STATUSES = Object.freeze(['PENDING', 'AUTHORIZED', 'IN_PROGRESS', 'AWAITING_ACCEPTANCE', 'BLOCKED', 'COMPLETED', 'CANCELLED']);
const GATE_STATUSES = Object.freeze(['UNAPPROVED', 'PENDING', 'APPROVED', 'REJECTED', 'DEFERRED']);
const FORBIDDEN_SEVERITIES = Object.freeze(['INFO', 'WARNING', 'BLOCKING', 'CRITICAL']);
const FORBIDDEN_ENFORCEMENTS = Object.freeze(['ADVISORY', 'REQUIRE_CONFIRMATION', 'FAIL_CLOSED']);
const CONDITION_TYPES = Object.freeze([
  'always',
  'until_gate_approved',
  'until_gates_approved',
  'while_status',
  'until_engineering_action_completed'
]);
const CHECKPOINT_UPDATE_FIELDS = Object.freeze([
  'current_milestone',
  'status',
  'blocker',
  'root_cause_summary',
  'approved_decisions',
  'current_engineering_action',
  'next_product_action_after_stabilization',
  'decision_gates',
  'forbidden_actions',
  'evidence',
  'real_data_authorization',
  'real_data_authorizations'
]);
const REQUIRED_FIELDS = Object.freeze([
  'schema_version',
  'checkpoint_generation',
  'project_id',
  'canonical_project_name',
  'current_milestone',
  'status',
  'verified_at',
  'verified_branch',
  'verified_base_commit',
  'working_tree',
  'verification_plan',
  'real_data_modified',
  'tests',
  'build',
  'blocker',
  'root_cause_summary',
  'approved_decisions',
  'current_engineering_action',
  'next_product_action_after_stabilization',
  'decision_gates',
  'forbidden_actions',
  'evidence',
  'updated_by'
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function inline(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function tableCell(value) {
  return inline(value).replace(/\|/g, '\\|');
}

function bulletList(values) {
  return values.map((value) => `- ${inline(value)}`).join('\n');
}

function uniqueStrings(values) {
  return Array.isArray(values) && values.every(nonEmptyString) && new Set(values).size === values.length;
}

function git(repoRoot, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe']
  });
}

function tryGit(repoRoot, args) {
  try {
    return { ok: true, output: git(repoRoot, args).replace(/\r?\n$/, '') };
  } catch (error) {
    return {
      ok: false,
      output: '',
      message: inline(error?.stderr?.toString() || error?.message || 'git command failed')
    };
  }
}

export function findRepositoryRoot(startDirectory = process.cwd()) {
  const result = tryGit(startDirectory, ['rev-parse', '--show-toplevel']);
  if (!result.ok || !result.output) throw new Error('Git repository root could not be determined.');
  return result.output;
}

export function collectWorkingTreeSnapshot(repoRoot, excludedPaths = [CANONICAL_STATE_FILE]) {
  return collectFingerprintSnapshot(repoRoot, excludedPaths);
}

export function parseProjectStateDocument(document) {
  if (!nonEmptyString(document)) throw new Error('Project-state document is empty.');
  const pattern = new RegExp(
    METADATA_START + '\\n```json\\n([\\s\\S]*?)\\n```\\n' + METADATA_END
  );
  const match = document.match(pattern);
  if (!match) throw new Error('Project-state metadata block is missing or damaged.');
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Project-state metadata JSON cannot be parsed: ${inline(error.message)}`);
  }
}

function renderAction(action) {
  return `[${inline(action?.id)}] ${inline(action?.title)} (${inline(action?.status)})`;
}

export function renderProjectStateDocument(state) {
  const tests = Array.isArray(state.tests) ? state.tests : [];
  const build = isObject(state.build) ? state.build : {};
  const workingTree = isObject(state.working_tree) ? state.working_tree : {};
  const milestone = isObject(state.current_milestone) ? state.current_milestone : {};
  const gates = Array.isArray(state.decision_gates) ? state.decision_gates : [];
  const forbidden = Array.isArray(state.forbidden_actions) ? state.forbidden_actions : [];
  const evidence = Array.isArray(state.evidence) ? state.evidence : [];
  const domainRegression = state.verification_plan?.domain_regression || {};
  const metadata = JSON.stringify(state, null, 2);
  const gateRows = gates.map((gate) =>
    `| ${tableCell(gate.id)} | ${tableCell(gate.title)} | ${tableCell(gate.status)} | ${gate.blocks_following_actions ? 'Yes' : 'No'} | ${tableCell((gate.evidence_ids || []).join(', '))} |`
  ).join('\n');
  const forbiddenRows = forbidden.map((item) =>
    `| ${tableCell(item.id)} | ${tableCell(item.action_id)} | ${tableCell(item.description)} | ${tableCell(item.severity)} | ${tableCell(item.enforcement)} |`
  ).join('\n');
  const evidenceRows = evidence.map((item) =>
    `| ${tableCell(item.id)} | \`${tableCell(item.path)}\` | ${tableCell(item.role)} | ${item.required ? 'Yes' : 'No'} | ${tableCell(item.digest?.algorithm)}:${tableCell(item.digest?.value)} |`
  ).join('\n');
  return `# Ai工作秘书 Project State\n\n` +
    `> This file is the only canonical project state. Its JSON metadata is authoritative; the readable body is deterministically rendered from that metadata and must not be edited independently.\n\n` +
    `${METADATA_START}\n\`\`\`json\n${metadata}\n\`\`\`\n${METADATA_END}\n\n` +
    `## Current checkpoint\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Project | ${tableCell(state.canonical_project_name)} |\n` +
    `| Project ID | ${tableCell(state.project_id)} |\n` +
    `| Checkpoint generation | ${tableCell(state.checkpoint_generation)} |\n` +
    `| Milestone | ${tableCell(milestone.label)} |\n` +
    `| Status | ${tableCell(state.status)} |\n` +
    `| Verified timestamp | ${tableCell(state.verified_at)} |\n` +
    `| Verified branch | ${tableCell(state.verified_branch)} |\n` +
    `| Verified base commit | ${tableCell(state.verified_base_commit)} |\n` +
    `| Working tree | ${tableCell(workingTree.state)} (${Array.isArray(workingTree.entries) ? workingTree.entries.length : 0} entries; fingerprint v${tableCell(workingTree.fingerprint?.version)} ${tableCell(workingTree.fingerprint?.algorithm)}:${tableCell(workingTree.fingerprint?.value)}; canonical state file excluded to avoid self-reference) |\n` +
    `| Real user data modified | ${state.real_data_modified === false ? 'No' : state.real_data_modified === true ? 'Yes' : 'Invalid'} |\n` +
    `| Updated by | ${tableCell(state.updated_by)} |\n\n` +
    `## Authorized actions\n\n` +
    `- Current engineering action: ${renderAction(state.current_engineering_action)}\n` +
    `- Next product action after stabilization: ${renderAction(state.next_product_action_after_stabilization)}\n\n` +
    `## Decision gates\n\n` +
    `| Gate ID | Title | Status | Blocks following actions | Evidence IDs |\n|---|---|---|---|---|\n${gateRows}\n\n` +
    `## Verification evidence\n\n` +
    `- Required domain regression: [${inline(domainRegression.id)}] ${inline(domainRegression.title)}; paths: ${(domainRegression.test_paths || []).map((item) => `\`${inline(item)}\``).join(', ')}\n` +
    `${tests.map((item) => `- Tests — ${inline(item.name)}: ${inline(item.result)}; command: \`${inline(item.command)}\`; scope: ${inline(item.verification_scope)}`).join('\n')}\n` +
    `- Build: ${inline(build.result)}; command: \`${inline(build.command)}\`; scope: ${inline(build.verification_scope)}\n\n` +
    `## Current blocker\n\n${inline(state.blocker)}\n\n` +
    `Root cause summary:\n\n${bulletList(Array.isArray(state.root_cause_summary) ? state.root_cause_summary : [])}\n\n` +
    `Approved decisions:\n\n${bulletList(Array.isArray(state.approved_decisions) ? state.approved_decisions : [])}\n\n` +
    `## Forbidden actions\n\n` +
    `| Rule ID | Action ID | Description | Severity | Enforcement |\n|---|---|---|---|---|\n${forbiddenRows}\n\n` +
    `## Evidence contract\n\n` +
    `Evidence digests use SHA-256 over the exact raw file bytes. Paths are repository-relative, normalized, and must not escape the repository through traversal or symbolic links.\n\n` +
    `| Evidence ID | Path | Role | Required | Digest |\n|---|---|---|---|---|\n${evidenceRows}\n\n` +
    `## Verification model\n\n` +
    `\`verified_base_commit\` is an ancestor checkpoint rather than the commit containing this file. Resume separately verifies branch, ancestor relationship, working-tree snapshot, evidence digests, and deterministic rendering.\n`;
}

function validateTestEvidence(tests, errors) {
  if (!Array.isArray(tests) || tests.length === 0) {
    errors.push('tests must contain at least one explicit test result.');
    return;
  }
  for (const [index, item] of tests.entries()) {
    if (!isObject(item)) {
      errors.push(`tests[${index}] must be an object.`);
      continue;
    }
    for (const field of ['name', 'command', 'result', 'verification_scope']) {
      if (!nonEmptyString(item[field])) errors.push(`tests[${index}].${field} is required.`);
    }
  }
}

function validateBuildEvidence(build, errors) {
  if (!isObject(build)) {
    errors.push('build must be an object.');
    return;
  }
  for (const field of ['command', 'result', 'verification_scope']) {
    if (!nonEmptyString(build[field])) errors.push(`build.${field} is required.`);
  }
}

function validateVerificationPlan(plan, errors) {
  if (!isObject(plan) || !isObject(plan.domain_regression)) {
    errors.push('verification_plan.domain_regression must be an object.');
    return;
  }
  const domain = plan.domain_regression;
  for (const field of ['id', 'title']) {
    if (!nonEmptyString(domain[field])) errors.push(`verification_plan.domain_regression.${field} is required.`);
  }
  if (!uniqueStrings(domain.test_paths) || domain.test_paths.length === 0) {
    errors.push('verification_plan.domain_regression.test_paths must contain unique repository-relative test paths.');
    return;
  }
  for (const testPath of domain.test_paths) {
    if (
      testPath.includes('\\') ||
      path.posix.normalize(testPath) !== testPath ||
      testPath.startsWith('../') ||
      path.isAbsolute(testPath) ||
      !testPath.endsWith('.test.js')
    ) {
      errors.push(`verification_plan domain test path is invalid: ${inline(testPath)}.`);
    }
  }
}

function validateStringArray(value, field, errors) {
  if (!Array.isArray(value) || value.some((entry) => !nonEmptyString(entry))) {
    errors.push(`${field} must be an array of non-empty strings.`);
  }
}

function validateMilestone(milestone, errors) {
  if (!isObject(milestone)) {
    errors.push('current_milestone must be an object.');
    return;
  }
  for (const field of ['id', 'name', 'label']) {
    if (!nonEmptyString(milestone[field])) errors.push(`current_milestone.${field} is required.`);
  }
}

function validateCurrentEngineeringAction(action, errors) {
  if (!isObject(action)) {
    errors.push('current_engineering_action must be an object.');
    return;
  }
  for (const field of ['id', 'title']) {
    if (!nonEmptyString(action[field])) errors.push(`current_engineering_action.${field} is required.`);
  }
  if (!ACTION_STATUSES.includes(action.status)) errors.push('current_engineering_action.status is invalid.');
  if (typeof action.authorized !== 'boolean') errors.push('current_engineering_action.authorized must be boolean.');
  if (!uniqueStrings(action.gate_ids)) errors.push('current_engineering_action.gate_ids must contain unique non-empty strings.');
}

function validateNextProductAction(action, errors) {
  if (!isObject(action)) {
    errors.push('next_product_action_after_stabilization must be an object.');
    return;
  }
  for (const field of ['id', 'title', 'after_engineering_action_id']) {
    if (!nonEmptyString(action[field])) errors.push(`next_product_action_after_stabilization.${field} is required.`);
  }
  if (!ACTION_STATUSES.includes(action.status)) errors.push('next_product_action_after_stabilization.status is invalid.');
  if (!uniqueStrings(action.gate_ids)) errors.push('next_product_action_after_stabilization.gate_ids must contain unique non-empty strings.');
}

function validateEvidenceDefinitions(evidence, errors) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    errors.push('evidence must contain at least one metadata-defined evidence record.');
    return;
  }
  const ids = new Set();
  const paths = new Set();
  for (const [index, item] of evidence.entries()) {
    if (!isObject(item)) {
      errors.push(`evidence[${index}] must be an object.`);
      continue;
    }
    for (const field of ['id', 'path', 'role']) {
      if (!nonEmptyString(item[field])) errors.push(`evidence[${index}].${field} is required.`);
    }
    if (nonEmptyString(item.id) && ids.has(item.id)) errors.push(`evidence ID is duplicated: ${item.id}.`);
    if (nonEmptyString(item.path) && paths.has(item.path)) errors.push(`evidence path is duplicated: ${item.path}.`);
    ids.add(item.id);
    paths.add(item.path);
    if (typeof item.required !== 'boolean') errors.push(`evidence[${index}].required must be boolean.`);
    if (!isObject(item.digest) || item.digest.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/i.test(item.digest?.value || '')) {
      errors.push(`evidence[${index}].digest must contain a sha256 algorithm and 64-character value.`);
    }
  }
}

function validateDecisionGates(gates, evidenceIds, errors) {
  if (!Array.isArray(gates)) {
    errors.push('decision_gates must be an array.');
    return;
  }
  const ids = new Set();
  for (const [index, gate] of gates.entries()) {
    if (!isObject(gate)) {
      errors.push(`decision_gates[${index}] must be an object.`);
      continue;
    }
    for (const field of ['id', 'title']) {
      if (!nonEmptyString(gate[field])) errors.push(`decision_gates[${index}].${field} is required.`);
    }
    if (nonEmptyString(gate.id) && ids.has(gate.id)) errors.push(`decision gate ID is duplicated: ${gate.id}.`);
    ids.add(gate.id);
    if (!GATE_STATUSES.includes(gate.status)) errors.push(`decision_gates[${index}].status is invalid.`);
    if (typeof gate.blocks_following_actions !== 'boolean') errors.push(`decision_gates[${index}].blocks_following_actions must be boolean.`);
    if (!uniqueStrings(gate.evidence_ids) || gate.evidence_ids.length === 0) {
      errors.push(`decision_gates[${index}].evidence_ids must contain at least one unique evidence ID.`);
    } else {
      for (const evidenceId of gate.evidence_ids) {
        if (!evidenceIds.has(evidenceId)) errors.push(`decision gate ${gate.id} references unknown evidence: ${evidenceId}.`);
      }
    }
  }
}

function validateActionGateReferences(state, errors) {
  const gateMap = new Map((state.decision_gates || []).map((gate) => [gate.id, gate]));
  const actions = [
    ['current_engineering_action', state.current_engineering_action],
    ['next_product_action_after_stabilization', state.next_product_action_after_stabilization]
  ];
  for (const [field, action] of actions) {
    for (const gateId of action?.gate_ids || []) {
      const gate = gateMap.get(gateId);
      if (!gate) errors.push(`${field} references unknown gate: ${gateId}.`);
      else if (field === 'current_engineering_action' && action.authorized && gate.blocks_following_actions && gate.status !== 'APPROVED') {
        errors.push(`current_engineering_action cannot bypass blocking unapproved gate: ${gateId}.`);
      } else if (action.status === 'COMPLETED' && gate.status !== 'APPROVED') {
        errors.push(`${field} cannot be completed while gate ${gateId} is not approved.`);
      }
    }
  }
}

function validateForbiddenActions(state, errors) {
  const items = state.forbidden_actions;
  if (!Array.isArray(items)) {
    errors.push('forbidden_actions must be an array.');
    return;
  }
  const ids = new Set();
  const gateIds = new Set((state.decision_gates || []).map((gate) => gate.id));
  const actionIds = new Set([
    state.current_engineering_action?.id,
    state.next_product_action_after_stabilization?.id
  ].filter(Boolean));
  for (const [index, item] of items.entries()) {
    if (!isObject(item)) {
      errors.push(`forbidden_actions[${index}] must be an object.`);
      continue;
    }
    for (const field of ['id', 'action_id', 'description']) {
      if (!nonEmptyString(item[field])) errors.push(`forbidden_actions[${index}].${field} is required.`);
    }
    if (nonEmptyString(item.id) && ids.has(item.id)) errors.push(`forbidden action ID is duplicated: ${item.id}.`);
    ids.add(item.id);
    if (!FORBIDDEN_SEVERITIES.includes(item.severity)) errors.push(`forbidden_actions[${index}].severity is invalid.`);
    if (!FORBIDDEN_ENFORCEMENTS.includes(item.enforcement)) errors.push(`forbidden_actions[${index}].enforcement is invalid.`);
    if (!isObject(item.condition) || !CONDITION_TYPES.includes(item.condition?.type)) {
      errors.push(`forbidden_actions[${index}].condition is invalid.`);
      continue;
    }
    if (item.action_id === state.current_engineering_action?.id && state.current_engineering_action?.authorized) {
      errors.push(`forbidden action cannot also be the current authorized action: ${item.action_id}.`);
    }
    if (item.condition.type === 'until_gate_approved') {
      if (!nonEmptyString(item.condition.gate_id) || !gateIds.has(item.condition.gate_id)) {
        errors.push(`forbidden_actions[${index}] references unknown gate.`);
      }
    }
    if (item.condition.type === 'until_gates_approved') {
      if (!uniqueStrings(item.condition.gate_ids) || item.condition.gate_ids.length === 0 || item.condition.gate_ids.some((id) => !gateIds.has(id))) {
        errors.push(`forbidden_actions[${index}] references unknown gates.`);
      }
    }
    if (item.condition.type === 'while_status' && !PROJECT_STATUSES.includes(item.condition.status)) {
      errors.push(`forbidden_actions[${index}].condition.status is invalid.`);
    }
    if (item.condition.type === 'until_engineering_action_completed' && !actionIds.has(item.condition.engineering_action_id)) {
      errors.push(`forbidden_actions[${index}] references unknown engineering action.`);
    }
  }
}

function validateWorkingTreeEntries(entries, errors) {
  if (!Array.isArray(entries)) {
    errors.push('working_tree.entries must be an array.');
    return;
  }
  let previousPath = null;
  const paths = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry)) {
      errors.push(`working_tree.entries[${index}] must be an object.`);
      continue;
    }
    if (!['tracked', 'untracked'].includes(entry.kind)) errors.push(`working_tree.entries[${index}].kind is invalid.`);
    if (entry.path_encoding !== 'base64' || !nonEmptyString(entry.path)) {
      errors.push(`working_tree.entries[${index}] must contain a base64 path.`);
      continue;
    }
    const pathBytes = Buffer.from(entry.path, 'base64');
    if (pathBytes.length === 0 || pathBytes.toString('base64') !== entry.path) {
      errors.push(`working_tree.entries[${index}].path is not canonical base64.`);
      continue;
    }
    if (paths.has(entry.path)) errors.push(`working_tree.entries contains a duplicate path at index ${index}.`);
    paths.add(entry.path);
    if (previousPath && Buffer.compare(previousPath, pathBytes) >= 0) {
      errors.push('working_tree.entries must be sorted by raw path bytes.');
    }
    previousPath = pathBytes;
  }
}

function validateWorkingTreeFingerprint(fingerprint, errors) {
  if (!isObject(fingerprint)) {
    errors.push('working_tree.fingerprint must be an object.');
    return;
  }
  if (fingerprint.version !== WORKING_TREE_FINGERPRINT_VERSION) {
    errors.push(`working_tree.fingerprint.version must be ${WORKING_TREE_FINGERPRINT_VERSION}.`);
  }
  if (fingerprint.algorithm !== WORKING_TREE_FINGERPRINT_ALGORITHM) {
    errors.push(`working_tree.fingerprint.algorithm must be ${WORKING_TREE_FINGERPRINT_ALGORITHM}.`);
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint.value || '')) {
    errors.push('working_tree.fingerprint.value must be a lowercase SHA-256 hash.');
  }
}

function validateStateShape(state) {
  const errors = [];
  if (!isObject(state)) return ['metadata must be an object.'];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in state) || state[field] === undefined || state[field] === null) errors.push(`${field} is required.`);
  }
  if (state.schema_version !== SUPPORTED_SCHEMA_VERSION) errors.push(`schema_version must be ${SUPPORTED_SCHEMA_VERSION}.`);
  if (!Number.isSafeInteger(state.checkpoint_generation) || state.checkpoint_generation < 0) {
    errors.push('checkpoint_generation must be a non-negative safe integer.');
  }
  if (state.project_id !== EXPECTED_PROJECT_ID) errors.push(`project_id must be ${EXPECTED_PROJECT_ID}.`);
  if (!nonEmptyString(state.canonical_project_name)) errors.push('canonical_project_name must be a non-empty string.');
  validateMilestone(state.current_milestone, errors);
  if (!PROJECT_STATUSES.includes(state.status)) errors.push('status is not in the supported project status enum.');
  if (typeof state.blocker !== 'string') errors.push('blocker must be a string.');
  if (state.status === 'BLOCKED' && !nonEmptyString(state.blocker)) errors.push('BLOCKED status requires a non-empty blocker.');
  if (!nonEmptyString(state.verified_at) || Number.isNaN(Date.parse(state.verified_at))) errors.push('verified_at must be an ISO timestamp.');
  if (!nonEmptyString(state.verified_branch)) errors.push('verified_branch is required.');
  if (!/^[0-9a-f]{40}$/i.test(state.verified_base_commit || '')) errors.push('verified_base_commit must be a 40-character commit hash.');
  if (!isObject(state.working_tree)) {
    errors.push('working_tree must be an object.');
  } else {
    if (!['clean', 'dirty'].includes(state.working_tree.state)) errors.push('working_tree.state must be clean or dirty.');
    validateWorkingTreeEntries(state.working_tree.entries, errors);
    validateWorkingTreeFingerprint(state.working_tree.fingerprint, errors);
    if (JSON.stringify(state.working_tree.excluded_paths) !== JSON.stringify([CANONICAL_STATE_FILE])) errors.push(`working_tree.excluded_paths may contain only ${CANONICAL_STATE_FILE}.`);
    if (!Array.isArray(state.working_tree.protected_preexisting_paths)) errors.push('working_tree.protected_preexisting_paths must be an array.');
    const expectedState = state.working_tree.entries?.length ? 'dirty' : 'clean';
    if (state.working_tree.state !== expectedState) errors.push('working_tree.state contradicts working_tree.entries.');
  }
  if (typeof state.real_data_modified !== 'boolean') errors.push('real_data_modified must be boolean.');
  validateVerificationPlan(state.verification_plan, errors);
  validateTestEvidence(state.tests, errors);
  validateBuildEvidence(state.build, errors);
  validateStringArray(state.root_cause_summary, 'root_cause_summary', errors);
  validateStringArray(state.approved_decisions, 'approved_decisions', errors);
  if (!nonEmptyString(state.updated_by)) errors.push('updated_by must be a non-empty string.');
  validateCurrentEngineeringAction(state.current_engineering_action, errors);
  validateNextProductAction(state.next_product_action_after_stabilization, errors);
  if (state.next_product_action_after_stabilization?.after_engineering_action_id !== state.current_engineering_action?.id) {
    errors.push('next_product_action_after_stabilization must reference the current engineering action.');
  }
  if (state.next_product_action_after_stabilization?.id === state.current_engineering_action?.id) {
    errors.push('current engineering action and next product action must be distinct.');
  }
  validateEvidenceDefinitions(state.evidence, errors);
  const evidenceIds = new Set((state.evidence || []).map((item) => item.id));
  validateDecisionGates(state.decision_gates, evidenceIds, errors);
  validateActionGateReferences(state, errors);
  validateForbiddenActions(state, errors);
  const hasLegacyRealDataAuthorization = Object.hasOwn(state, 'real_data_authorization');
  const hasScopedRealDataAuthorizations = Object.hasOwn(state, 'real_data_authorizations');
  if (hasLegacyRealDataAuthorization && hasScopedRealDataAuthorizations) {
    errors.push('real_data_authorization and real_data_authorizations cannot coexist.');
  } else if (hasLegacyRealDataAuthorization) {
    errors.push(...validateScopedRealDataAuthorization(state.real_data_authorization, {
      canonicalActionIds: [
        state.current_engineering_action?.id,
        state.next_product_action_after_stabilization?.id
      ].filter(Boolean)
    }));
  } else if (hasScopedRealDataAuthorizations) {
    errors.push(...validateScopedRealDataAuthorizations(state.real_data_authorizations, {
      canonicalActionIds: [
        state.current_engineering_action?.id,
        state.next_product_action_after_stabilization?.id
      ].filter(Boolean)
    }));
  }
  return errors;
}

function safeEvidencePath(repoRoot, evidencePath) {
  if (!nonEmptyString(evidencePath) || evidencePath.includes('\\') || path.isAbsolute(evidencePath)) return null;
  const normalized = path.posix.normalize(evidencePath);
  if (normalized !== evidencePath || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  const root = fs.realpathSync(repoRoot);
  const absolutePath = path.resolve(root, ...evidencePath.split('/'));
  if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) return null;
  return { root, absolutePath };
}

export function computeEvidenceDigest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function computeProjectStateToken(content) {
  return `${PROJECT_STATE_TOKEN_ALGORITHM}:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function validateEvidence(repoRoot, evidenceDefinitions) {
  const errors = [];
  for (const item of evidenceDefinitions || []) {
    const safePath = safeEvidencePath(repoRoot, item.path);
    if (!safePath) {
      errors.push(`evidence path is unsafe or escapes the repository: ${inline(item.path)}.`);
      continue;
    }
    if (!fs.existsSync(safePath.absolutePath)) {
      if (item.required) errors.push(`evidence file is missing: ${item.path}.`);
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(safePath.absolutePath);
    } catch (error) {
      errors.push(`evidence file cannot be inspected: ${item.path}.`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`evidence symlink is not allowed: ${item.path}.`);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`evidence path is not a regular file: ${item.path}.`);
      continue;
    }
    let realPath;
    try {
      realPath = fs.realpathSync(safePath.absolutePath);
    } catch (error) {
      errors.push(`evidence real path cannot be resolved: ${item.path}.`);
      continue;
    }
    if (realPath === safePath.root || !realPath.startsWith(`${safePath.root}${path.sep}`)) {
      errors.push(`evidence path escapes the repository: ${item.path}.`);
      continue;
    }
    let actualDigest;
    try {
      actualDigest = computeEvidenceDigest(fs.readFileSync(realPath));
    } catch (error) {
      errors.push(`evidence file cannot be hashed: ${item.path}.`);
      continue;
    }
    if (actualDigest !== item.digest.value.toLowerCase()) {
      errors.push(`evidence digest mismatch: ${item.id} (${item.path}).`);
    }
  }
  return errors;
}

function validateGitState(repoRoot, state, { allowWorkingTreeDrift = false } = {}) {
  const errors = [];
  const branch = tryGit(repoRoot, ['branch', '--show-current']);
  if (!branch.ok || !branch.output) errors.push('current Git branch cannot be determined.');
  else if (branch.output !== state.verified_branch) errors.push(`verified_branch mismatch: expected ${state.verified_branch}, current ${branch.output}.`);

  if (/^[0-9a-f]{40}$/i.test(state.verified_base_commit || '')) {
    const commit = tryGit(repoRoot, ['cat-file', '-e', `${state.verified_base_commit}^{commit}`]);
    if (!commit.ok) {
      errors.push(`verified_base_commit does not exist: ${state.verified_base_commit}.`);
    } else {
      const ancestor = tryGit(repoRoot, ['merge-base', '--is-ancestor', state.verified_base_commit, 'HEAD']);
      if (!ancestor.ok) errors.push(`verified_base_commit is not an ancestor of HEAD: ${state.verified_base_commit}.`);
    }
  }

  if (!allowWorkingTreeDrift && isObject(state.working_tree) && Array.isArray(state.working_tree.entries)) {
    try {
      const actual = collectWorkingTreeSnapshot(repoRoot, [CANONICAL_STATE_FILE]);
      if (actual.state !== state.working_tree.state || JSON.stringify(actual.entries) !== JSON.stringify(state.working_tree.entries)) {
        errors.push(`working_tree mismatch: checkpoint has ${state.working_tree.entries.length} entries, current tree has ${actual.entries.length}.`);
      } else if (JSON.stringify(actual.fingerprint) !== JSON.stringify(state.working_tree.fingerprint)) {
        errors.push('working_tree fingerprint mismatch: dirty file contents changed after checkpoint.');
      }
    } catch (error) {
      errors.push(inline(error.message));
    }
  }
  return errors;
}

export function validateProjectState({
  repoRoot,
  statePath = path.join(repoRoot, CANONICAL_STATE_FILE),
  allowWorkingTreeDrift = false,
  verifyGitState = true
}) {
  const errors = [];
  let state = null;
  let document = null;
  if (!fs.existsSync(statePath)) {
    return { ok: false, errors: [`Canonical state file is missing: ${CANONICAL_STATE_FILE}.`], state: null };
  }
  try {
    document = fs.readFileSync(statePath, 'utf8');
    state = parseProjectStateDocument(document);
  } catch (error) {
    return { ok: false, errors: [inline(error.message)], state: null };
  }
  errors.push(...validateStateShape(state));
  if (errors.length === 0 && document !== renderProjectStateDocument(state)) {
    errors.push('Project-state document body or metadata formatting is inconsistent with canonical metadata.');
  }
  if (errors.length === 0) errors.push(...validateEvidence(repoRoot, state.evidence));
  if (errors.length === 0 && verifyGitState) {
    errors.push(...validateGitState(repoRoot, state, { allowWorkingTreeDrift }));
  }
  return {
    ok: errors.length === 0,
    errors,
    state,
    stateToken: document === null ? null : computeProjectStateToken(Buffer.from(document))
  };
}

function validateCheckpointInput(input) {
  const errors = [];
  for (const forbidden of ['tests', 'build', 'realDataModified', 'updatedBy', 'expectedGeneration']) {
    if (Object.hasOwn(input || {}, forbidden)) errors.push(`${forbidden} is caller-supplied verification evidence and is forbidden; use a verification receipt.`);
  }
  if (!isObject(input?.verificationReceipt)) errors.push('verificationReceipt must be an in-process receipt issued by project:verify.');
  if (Object.hasOwn(input || {}, 'verificationReceiptId')) errors.push('verificationReceiptId is forbidden; persisted receipts are not trusted.');
  if (!nonEmptyString(input?.expectedStateToken) ||
      !new RegExp(`^${PROJECT_STATE_TOKEN_ALGORITHM}:[0-9a-f]{64}$`).test(input.expectedStateToken)) {
    errors.push(`expectedStateToken must use ${PROJECT_STATE_TOKEN_ALGORITHM}.`);
  }
  if (!nonEmptyString(input?.expectedWorkingTreeFingerprint) ||
      !/^aiwc-working-tree-fingerprint-v2-sha256:[0-9a-f]{64}$/.test(input.expectedWorkingTreeFingerprint)) {
    errors.push('expectedWorkingTreeFingerprint must use aiwc-working-tree-fingerprint-v2-sha256.');
  }
  if (!isObject(input?.stateUpdates)) errors.push('stateUpdates must be an object.');
  else {
    if (Object.hasOwn(input.stateUpdates, 'real_data_authorization') &&
        Object.hasOwn(input.stateUpdates, 'real_data_authorizations')) {
      errors.push('legacy and multi-scope authorization updates cannot coexist.');
    }
    for (const field of Object.keys(input.stateUpdates)) {
      if (!CHECKPOINT_UPDATE_FIELDS.includes(field)) errors.push(`stateUpdates field is not allowed: ${field}.`);
    }
  }
  if (errors.length) throw new Error(errors.join(' '));
}

export function checkpointProjectState({
  repoRoot,
  statePath,
  input,
  now = new Date(),
  transactionOptions = {}
}) {
  validateCheckpointInput(input);
  const current = validateProjectState({ repoRoot, statePath, allowWorkingTreeDrift: true });
  if (!current.ok) throw new Error(`${PROJECT_STATE_ERROR}: ${current.errors.join(' ')}`);
  const branch = tryGit(repoRoot, ['branch', '--show-current']);
  const head = tryGit(repoRoot, ['rev-parse', 'HEAD']);
  if (!branch.ok || !branch.output || !head.ok || !head.output) {
    throw new Error(`${PROJECT_STATE_ERROR}: Git branch or HEAD is unavailable.`);
  }
  const snapshot = collectWorkingTreeSnapshot(repoRoot, [CANONICAL_STATE_FILE]);
  const workingTreeFingerprint = `${snapshot.fingerprint.algorithm}:${snapshot.fingerprint.value}`;
  if (input.expectedStateToken !== current.stateToken) throw new Error('Checkpoint state token is stale.');
  if (input.expectedWorkingTreeFingerprint !== workingTreeFingerprint) throw new Error('Checkpoint working-tree fingerprint is stale.');
  const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockfilePath)) throw new Error('Checkpoint lockfile is missing.');
  const lockfileSha256 = crypto.createHash('sha256').update(fs.readFileSync(lockfilePath)).digest('hex');
  const receipt = consumeVerificationReceipt({
    repoRoot,
    receipt: input.verificationReceipt,
    now,
    bindings: {
      projectId: current.state.project_id,
      branch: branch.output,
      head: head.output,
      stateToken: current.stateToken,
      checkpointGeneration: current.state.checkpoint_generation,
      workingTreeFingerprint,
      lockfileSha256,
      verificationPlan: current.state.verification_plan
    }
  });
  const receiptScope = `verification_receipt:${receipt.receipt_id}`;
  const verifiedTests = [
    {
      name: 'Project-state tests',
      command: receipt.commands.find((command) => command.id === 'project_state_tests').args.join(' '),
      result: `${receipt.tests.project_state.pass}/${receipt.tests.project_state.tests} PASS (${receipt.tests.project_state.skipped} skipped)`,
      verification_scope: receiptScope
    },
    {
      name: current.state.verification_plan.domain_regression.title,
      command: receipt.commands.find((command) => command.id === 'domain_regression_tests').args.join(' '),
      result: `${receipt.tests.domain_regression.pass}/${receipt.tests.domain_regression.tests} PASS (${receipt.tests.domain_regression.skipped} skipped)`,
      verification_scope: receiptScope
    }
  ];
  const verifiedBuild = {
    command: 'pnpm build',
    result: `PASS (Vite ${receipt.build.vite_version}; ${receipt.build.transformed_modules} modules transformed; exit code 0; ${receipt.build.warnings} warnings)`,
    verification_scope: receiptScope
  };
  return runCheckpointTransaction({
    repoRoot,
    statePath,
    expectedStateToken: input.expectedStateToken,
    expectedGeneration: receipt.checkpoint_generation,
    tokenForBytes: computeProjectStateToken,
    generationForBytes: (bytes) => parseProjectStateDocument(bytes.toString('utf8')).checkpoint_generation,
    createCandidate: ({ actualGeneration }) => {
      const before = validateProjectState({ repoRoot, statePath, allowWorkingTreeDrift: true });
      if (!before.ok) throw new Error(`${PROJECT_STATE_ERROR}: ${before.errors.join(' ')}`);
      const branch = tryGit(repoRoot, ['branch', '--show-current']);
      const head = tryGit(repoRoot, ['rev-parse', 'HEAD']);
      if (!branch.ok || !branch.output || !head.ok || !head.output) {
        throw new Error(`${PROJECT_STATE_ERROR}: Git branch or HEAD is unavailable.`);
      }
      const snapshot = collectWorkingTreeSnapshot(repoRoot, [CANONICAL_STATE_FILE]);
      const candidateFingerprint = `${snapshot.fingerprint.algorithm}:${snapshot.fingerprint.value}`;
      const candidateLockfile = crypto.createHash('sha256').update(fs.readFileSync(lockfilePath)).digest('hex');
      if (branch.output !== receipt.branch || head.output !== receipt.head ||
          candidateFingerprint !== receipt.working_tree_fingerprint || candidateLockfile !== receipt.lockfile.sha256) {
        throw new Error('Checkpoint receipt bindings changed before the transaction could write canonical state.');
      }
      const updated = {
        ...structuredClone(before.state),
        ...structuredClone(input.stateUpdates),
        checkpoint_generation: actualGeneration + 1,
        verified_at: now.toISOString(),
        verified_branch: branch.output,
        verified_base_commit: head.output,
        working_tree: {
          ...structuredClone(before.state.working_tree),
          state: snapshot.state,
          entries: snapshot.entries,
          fingerprint: snapshot.fingerprint,
          excluded_paths: [CANONICAL_STATE_FILE]
        },
        real_data_modified: false,
        tests: verifiedTests,
        build: verifiedBuild,
        updated_by: `project:verify receipt ${receipt.receipt_id}`
      };
      if (Object.hasOwn(input.stateUpdates, 'real_data_authorizations')) {
        delete updated.real_data_authorization;
      }
      const candidateErrors = validateStateShape(updated);
      if (candidateErrors.length) {
        throw new Error(`${PROJECT_STATE_ERROR}: candidate state is invalid: ${candidateErrors.join(' ')}`);
      }
      const evidenceErrors = validateEvidence(repoRoot, updated.evidence);
      if (evidenceErrors.length) {
        throw new Error(`${PROJECT_STATE_ERROR}: candidate evidence is invalid: ${evidenceErrors.join(' ')}`);
      }
      return Buffer.from(renderProjectStateDocument(updated));
    },
    validateCandidate: (candidatePath) => {
      const result = validateProjectState({ repoRoot, statePath: candidatePath });
      if (!result.ok) throw new Error(`${PROJECT_STATE_ERROR}: candidate revalidation failed: ${result.errors.join(' ')}`);
    },
    validateInstalled: () => {
      const result = validateProjectState({ repoRoot, statePath });
      if (!result.ok) throw new Error(`${PROJECT_STATE_ERROR}: checkpoint revalidation failed: ${result.errors.join(' ')}`);
      return result;
    },
    validateRestored: () => {
      const result = validateProjectState({ repoRoot, statePath, allowWorkingTreeDrift: true });
      if (!result.ok) throw new Error(`${PROJECT_STATE_ERROR}: restored canonical is invalid: ${result.errors.join(' ')}`);
    },
    faultInjector: transactionOptions.faultInjector
  });
}

export function inspectProjectStateCheckpoint(repoRoot) {
  return inspectCheckpointTransaction(repoRoot);
}

export function recoverProjectStateCheckpoint({ repoRoot, statePath, transactionOptions = {} }) {
  return recoverCheckpointTransaction({
    repoRoot,
    statePath,
    validateCanonical: () => {
      const result = validateProjectState({ repoRoot, statePath });
      if (!result.ok) throw new Error(`${PROJECT_STATE_ERROR}: recovered canonical is invalid: ${result.errors.join(' ')}`);
      return result;
    },
    faultInjector: transactionOptions.faultInjector
  });
}

export { CHECKPOINT_RECOVERY_REQUIRED };
