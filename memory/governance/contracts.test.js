import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GovernanceAccessMode,
  GovernanceAuditAction,
  GovernanceConflictDecision,
  GovernanceOperation,
  GovernanceSensitivity,
  GovernanceStatus,
  createGovernanceResult,
  governanceSensitivityToKernel,
  validateMemoryGovernanceContext
} from './index.js';
import { fakeGovernanceContext } from './testing/fixtures.js';

for (const field of [
  'authenticatedUserId', 'actorType', 'actorId', 'requestId', 'correlationId', 'timestamp',
  'timezone', 'locale', 'purpose', 'operation', 'confirmationToken', 'expectedVersion',
  'policyVersion', 'metadata'
]) {
  test(`GovernanceContext requires ${field}`, () => {
    const context = fakeGovernanceContext();
    delete context[field];
    assert.equal(validateMemoryGovernanceContext(context).valid, false);
  });
}

test('GovernanceContext rejects a frontend userId field', () => {
  assert.equal(validateMemoryGovernanceContext(fakeGovernanceContext({ userId: 'fake-user-b' })).valid, false);
});
test('GovernanceContext rejects secret metadata', () => {
  const result = validateMemoryGovernanceContext(fakeGovernanceContext({ metadata: { accessToken: 'fake-only' } }));
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'SECRET_FORBIDDEN');
});

test('GovernanceContext rejects an invalid timestamp', () => {
  assert.equal(validateMemoryGovernanceContext(fakeGovernanceContext({ timestamp: 'later' })).valid, false);
});

test('GovernanceContext requires expectedVersion for a mutation', () => {
  const result = validateMemoryGovernanceContext(fakeGovernanceContext({ operation: 'delete' }), { mutation: true });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === 'MEMORY_EXPECTED_VERSION_REQUIRED'), true);
});

test('GovernanceContext accepts a positive expectedVersion for a mutation', () => {
  assert.equal(validateMemoryGovernanceContext(fakeGovernanceContext({ operation: 'delete', expectedVersion: 1 }), { mutation: true }).valid, true);
});

test('GovernanceContext rejects an invalid confirmation token', () => {
  assert.equal(validateMemoryGovernanceContext(fakeGovernanceContext({ confirmationToken: '' })).valid, false);
});

for (const [label, kernel] of [
  ['normal', 'public'], ['personal', 'low'], ['sensitive', 'medium'], ['highly_sensitive', 'high']
]) {
  test(`Governance sensitivity ${label} maps to Kernel ${kernel}`, () => {
    assert.equal(governanceSensitivityToKernel(label), kernel);
  });
}

test('prohibited is not a selectable governance sensitivity', () => {
  assert.equal(Object.values(GovernanceSensitivity).includes('prohibited'), false);
  assert.throws(() => governanceSensitivityToKernel('prohibited'));
});

for (const status of ['completed', 'confirmation_required', 'needs_clarification', 'conflict', 'rejected', 'not_found', 'failed']) {
  test(`GovernanceStatus exposes ${status}`, () => {
    assert.equal(Object.values(GovernanceStatus).includes(status), true);
  });
}

for (const operation of ['view', 'history', 'correct', 'resolve_conflict', 'delete', 'restore', 'purge', 'change_sensitivity', 'change_access', 'audit', 'export', 'batch']) {
  test(`GovernanceOperation exposes ${operation}`, () => {
    assert.equal(Object.values(GovernanceOperation).includes(operation), true);
  });
}

for (const decision of ['keep_a', 'keep_b', 'keep_both', 'mark_uncertain', 'defer', 'merge_as_new_version', 'reject_all']) {
  test(`GovernanceConflictDecision exposes ${decision}`, () => {
    assert.equal(Object.values(GovernanceConflictDecision).includes(decision), true);
  });
}

for (const mode of ['private', 'assistant_only', 'task_scoped', 'explicitly_shared', 'archived_only']) {
  test(`GovernanceAccessMode exposes ${mode}`, () => {
    assert.equal(Object.values(GovernanceAccessMode).includes(mode), true);
  });
}

for (const action of [
  'governance_viewed', 'correction_proposed', 'memory_corrected', 'conflict_case_opened',
  'conflict_resolved', 'memory_deleted', 'memory_restored', 'memory_purged',
  'sensitivity_changed', 'access_policy_changed', 'export_requested', 'export_completed',
  'governance_failed'
]) {
  test(`GovernanceAuditAction exposes ${action}`, () => {
    assert.equal(Object.values(GovernanceAuditAction).includes(action), true);
  });
}

test('GovernanceResult clearly states reversibility and next action', () => {
  const result = createGovernanceResult({
    status: 'completed', operation: 'delete', memoryId: 'fake-memory', affectedMemoryIds: ['fake-memory'],
    reversible: true, undoUntil: '2026-07-22T12:00:00.000Z', confirmationRequired: false,
    warnings: [], reasonCode: 'MEMORY_MOVED_TO_RECYCLE_BIN', safeMessage: '已移入回收站，可在 7 天内恢复。',
    auditEventId: 'fake-audit', createdAt: '2026-07-15T12:00:00.000Z'
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.reversible, true);
  assert.equal(Object.isFrozen(result), true);
});
