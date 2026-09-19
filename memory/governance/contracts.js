import { findForbiddenSecretPaths } from '../kernel/index.js';
import { RepositoryActorType } from '../repository/index.js';

export const GovernanceOperation = Object.freeze({
  VIEW: 'view', HISTORY: 'history', CORRECT: 'correct', RESOLVE_CONFLICT: 'resolve_conflict',
  DELETE: 'delete', RESTORE: 'restore', PURGE: 'purge', CHANGE_SENSITIVITY: 'change_sensitivity',
  CHANGE_ACCESS: 'change_access', AUDIT: 'audit', EXPORT: 'export', BATCH: 'batch'
});

export const GovernanceStatus = Object.freeze({
  COMPLETED: 'completed', CONFIRMATION_REQUIRED: 'confirmation_required',
  NEEDS_CLARIFICATION: 'needs_clarification', CONFLICT: 'conflict', REJECTED: 'rejected',
  NOT_FOUND: 'not_found', FAILED: 'failed'
});

export const GovernanceSensitivity = Object.freeze({
  NORMAL: 'normal', PERSONAL: 'personal', SENSITIVE: 'sensitive', HIGHLY_SENSITIVE: 'highly_sensitive'
});

export const GovernanceAccessMode = Object.freeze({
  PRIVATE: 'private', ASSISTANT_ONLY: 'assistant_only', TASK_SCOPED: 'task_scoped',
  EXPLICITLY_SHARED: 'explicitly_shared', ARCHIVED_ONLY: 'archived_only'
});

export const GovernanceConflictDecision = Object.freeze({
  KEEP_A: 'keep_a', KEEP_B: 'keep_b', KEEP_BOTH: 'keep_both', MARK_UNCERTAIN: 'mark_uncertain',
  DEFER: 'defer', MERGE_AS_NEW_VERSION: 'merge_as_new_version', REJECT_ALL: 'reject_all'
});

export const GovernanceAuditAction = Object.freeze({
  VIEWED: 'governance_viewed', CORRECTION_PROPOSED: 'correction_proposed', CORRECTED: 'memory_corrected',
  CONFLICT_OPENED: 'conflict_case_opened', CONFLICT_RESOLVED: 'conflict_resolved', DELETED: 'memory_deleted',
  RESTORED: 'memory_restored', PURGED: 'memory_purged', SENSITIVITY_CHANGED: 'sensitivity_changed',
  ACCESS_CHANGED: 'access_policy_changed', EXPORT_REQUESTED: 'export_requested', EXPORT_COMPLETED: 'export_completed',
  FAILED: 'governance_failed'
});

const SENSITIVITY_MAP = Object.freeze({ normal: 'public', personal: 'low', sensitive: 'medium', highly_sensitive: 'high' });
const CONTEXT_FIELDS = Object.freeze([
  'authenticatedUserId', 'actorType', 'actorId', 'requestId', 'correlationId', 'timestamp',
  'timezone', 'locale', 'purpose', 'operation', 'confirmationToken', 'expectedVersion', 'policyVersion', 'metadata'
]);

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function string(value) { return typeof value === 'string' && value.trim().length > 0; }
function issue(path, code) { return Object.freeze({ path, code, message: code }); }

export function deepFreezeGovernance(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreezeGovernance(nested);
  return value;
}

export function governanceSensitivityToKernel(value) {
  if (!(value in SENSITIVITY_MAP)) throw new TypeError('Invalid governance sensitivity.');
  return SENSITIVITY_MAP[value];
}

export function kernelSensitivityToGovernance(value) {
  const entry = Object.entries(SENSITIVITY_MAP).find(([, kernel]) => kernel === value);
  return entry?.[0] || 'highly_sensitive';
}

export function validateMemoryGovernanceContext(context, { mutation = false } = {}) {
  const errors = [];
  if (!object(context)) return { valid: false, errors: [issue('', 'INVALID_TYPE')], warnings: [] };
  for (const field of CONTEXT_FIELDS) if (!(field in context)) errors.push(issue(field, 'REQUIRED'));
  for (const field of Object.keys(context)) if (!CONTEXT_FIELDS.includes(field)) errors.push(issue(field, 'UNKNOWN_FIELD'));
  for (const field of ['authenticatedUserId', 'actorId', 'requestId', 'correlationId', 'timezone', 'locale', 'purpose', 'policyVersion']) {
    if (field in context && !string(context[field])) errors.push(issue(field, 'REQUIRED'));
  }
  if (!Object.values(RepositoryActorType).includes(context.actorType)) errors.push(issue('actorType', 'INVALID_ENUM'));
  if (!Object.values(GovernanceOperation).includes(context.operation)) errors.push(issue('operation', 'INVALID_ENUM'));
  if (!string(context.timestamp) || Number.isNaN(Date.parse(context.timestamp))) errors.push(issue('timestamp', 'INVALID_DATE'));
  if (context.confirmationToken !== null && !string(context.confirmationToken)) errors.push(issue('confirmationToken', 'INVALID_TYPE'));
  if (context.expectedVersion !== null && (!Number.isInteger(context.expectedVersion) || context.expectedVersion < 1)) errors.push(issue('expectedVersion', 'MEMORY_EXPECTED_VERSION_REQUIRED'));
  if (mutation && (!Number.isInteger(context.expectedVersion) || context.expectedVersion < 1)) errors.push(issue('expectedVersion', 'MEMORY_EXPECTED_VERSION_REQUIRED'));
  if (!object(context.metadata)) errors.push(issue('metadata', 'INVALID_TYPE'));
  else for (const path of findForbiddenSecretPaths(context.metadata, 'metadata')) errors.push(issue(path, 'SECRET_FORBIDDEN'));
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function toGovernanceRepositoryContext(context) {
  return deepFreezeGovernance({
    authenticatedUserId: context.authenticatedUserId,
    actorType: context.actorType,
    actorId: context.actorId,
    requestId: context.requestId,
    correlationId: context.correlationId,
    timestamp: context.timestamp,
    policyVersion: context.policyVersion,
    transactionId: null,
    metadata: {}
  });
}

export function createGovernanceResult(values) {
  return deepFreezeGovernance({
    status: values.status,
    operation: values.operation,
    memoryId: values.memoryId ?? null,
    affectedMemoryIds: values.affectedMemoryIds ?? [],
    reversible: values.reversible === true,
    undoUntil: values.undoUntil ?? null,
    confirmationRequired: values.confirmationRequired === true,
    warnings: values.warnings ?? [],
    reasonCode: values.reasonCode,
    safeMessage: values.safeMessage,
    auditEventId: values.auditEventId ?? null,
    createdAt: values.createdAt,
    data: values.data ?? null
  });
}
