import { findForbiddenSecretPaths } from '../kernel/index.js';
import { RepositoryActorType } from '../repository/index.js';

export const MigrationSourceKind = Object.freeze({
  CHATGPT: 'chatgpt', WECHAT: 'wechat', EMAIL: 'email', CALENDAR: 'calendar',
  NOTES: 'notes', KNOWLEDGE: 'knowledge', FILES: 'files', PHOTOS: 'photos', FAKE: 'fake'
});

export const MigrationCandidateStatus = Object.freeze({
  READY_FOR_APPROVAL: 'ready_for_approval', DUPLICATE: 'duplicate', CONFLICT: 'conflict',
  SENSITIVE_APPROVAL_REQUIRED: 'sensitive_approval_required', PROHIBITED: 'prohibited'
});

export const MigrationPlanStatus = Object.freeze({
  DRAFT: 'draft', APPROVAL_REQUIRED: 'approval_required', APPROVED: 'approved',
  EXECUTED: 'executed', ROLLED_BACK: 'rolled_back', CANCELLED: 'cancelled'
});

export const MigrationApprovalStatus = Object.freeze({ APPROVED: 'approved', CANCELLED: 'cancelled' });
export const MigrationExecutionStatus = Object.freeze({ COMPLETED: 'completed', FAILED: 'failed', ROLLED_BACK: 'rolled_back' });
export const MigrationAuditAction = Object.freeze({
  SCAN_STARTED: 'migration_scan_started', SCAN_COMPLETED: 'migration_scan_completed',
  PLAN_CREATED: 'migration_plan_created', DRY_RUN_COMPLETED: 'migration_dry_run_completed',
  APPROVED: 'migration_approved', CANCELLED: 'migration_cancelled',
  STARTED: 'migration_started', COMPLETED: 'migration_completed', FAILED: 'migration_failed',
  ROLLBACK_STARTED: 'migration_rollback_started', ROLLED_BACK: 'migration_rolled_back'
});

const SAFE_MESSAGES = Object.freeze({
  MIGRATION_SOURCE_INVALID: 'Migration source is invalid.',
  REQUIRED: 'Migration input is missing a required field.',
  INVALID_TYPE: 'Migration input has an invalid type.',
  INVALID_ENUM: 'Migration input has an invalid enum value.',
  INVALID_DATE: 'Migration input has an invalid date.',
  UNKNOWN_FIELD: 'Migration input has an unknown field.',
  USER_SCOPE_MISMATCH: 'Migration user scope is invalid.',
  USER_SCOPE_REQUIRED: 'Migration user scope is required.',
  UNSUPPORTED_SCHEMA_VERSION: 'Migration schema version is unsupported.',
  INTERFACE_METHOD_MISSING: 'Migration interface method is missing.',
  SECRET_FORBIDDEN: 'Migration metadata contains prohibited secret material.',
  INVALID_NUMBER: 'Migration input has an invalid number.',
  MIGRATION_ITEM_INVALID: 'Migration source item is invalid.',
  MIGRATION_SOURCE_SCAN_FAILED: 'Migration source scan failed.',
  MIGRATION_SCAN_LIMIT_EXCEEDED: 'Migration scan exceeds the safe item limit.',
  MIGRATION_PLAN_INVALID: 'Migration plan is invalid.',
  MIGRATION_APPROVAL_REQUIRED: 'Migration plan requires user approval.',
  MIGRATION_USER_APPROVAL_REQUIRED: 'Migration approval must come from the owning user.',
  MIGRATION_SENSITIVE_APPROVAL_REQUIRED: 'Sensitive migration candidate requires explicit approval.',
  MIGRATION_CANDIDATE_NOT_ELIGIBLE: 'Migration candidate is not eligible for approval.',
  MIGRATION_TARGET_INVALID: 'Migration candidate target is invalid.',
  MIGRATION_TRANSACTION_FAILED: 'Migration transaction failed and was rolled back.',
  MIGRATION_ROLLBACK_FAILED: 'Migration rollback failed and was rolled back.',
  MIGRATION_ROLLBACK_NOT_AVAILABLE: 'Migration rollback is not available.',
  MIGRATION_FAILED: 'Migration operation failed.'
});

export class MigrationError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(SAFE_MESSAGES, code) ? code : 'MIGRATION_FAILED';
    super(SAFE_MESSAGES[safeCode]);
    this.name = 'MigrationError';
    this.code = safeCode;
  }
}

const CONTEXT_FIELDS = Object.freeze([
  'authenticatedUserId', 'actorType', 'actorId', 'requestId', 'correlationId',
  'timestamp', 'purpose', 'policyVersion', 'metadata'
]);
const SOURCE_FIELDS = Object.freeze(['id', 'userId', 'kind', 'label', 'schemaVersion', 'metadata', 'scan']);

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function string(value) { return typeof value === 'string' && value.trim().length > 0; }
function issue(path, code) { return Object.freeze({ path, code, message: code }); }

export function deepFreezeMigration(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreezeMigration(nested);
  return value;
}

export function validateMigrationContext(context) {
  const errors = [];
  if (!object(context)) return { valid: false, errors: [issue('', 'INVALID_TYPE')], warnings: [] };
  for (const field of CONTEXT_FIELDS) if (!(field in context)) errors.push(issue(field, 'REQUIRED'));
  for (const field of Object.keys(context)) if (!CONTEXT_FIELDS.includes(field)) errors.push(issue(field, 'UNKNOWN_FIELD'));
  for (const field of ['authenticatedUserId', 'actorId', 'requestId', 'correlationId', 'purpose', 'policyVersion']) {
    if (!string(context[field])) errors.push(issue(field, 'REQUIRED'));
  }
  if (!Object.values(RepositoryActorType).includes(context.actorType)) errors.push(issue('actorType', 'INVALID_ENUM'));
  if (!string(context.timestamp) || Number.isNaN(Date.parse(context.timestamp))) errors.push(issue('timestamp', 'INVALID_DATE'));
  if (!object(context.metadata)) errors.push(issue('metadata', 'INVALID_TYPE'));
  else for (const path of findForbiddenSecretPaths(context.metadata, 'metadata')) errors.push(issue(path, 'SECRET_FORBIDDEN'));
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function createMigrationSource(source, { trustedUserId } = {}) {
  if (!object(source)) throw new MigrationError('INVALID_TYPE');
  for (const field of SOURCE_FIELDS) if (!(field in source)) throw new MigrationError('REQUIRED');
  for (const field of Object.keys(source)) if (!SOURCE_FIELDS.includes(field)) throw new MigrationError('UNKNOWN_FIELD');
  if (!string(source.id) || !string(source.userId) || !string(source.label)) throw new MigrationError('REQUIRED');
  if (!string(trustedUserId)) throw new MigrationError('USER_SCOPE_REQUIRED');
  if (source.userId !== trustedUserId) throw new MigrationError('USER_SCOPE_MISMATCH');
  if (!Object.values(MigrationSourceKind).includes(source.kind)) throw new MigrationError('INVALID_ENUM');
  if (source.schemaVersion !== 'v1') throw new MigrationError('UNSUPPORTED_SCHEMA_VERSION');
  if (typeof source.scan !== 'function') throw new MigrationError('INTERFACE_METHOD_MISSING');
  if (!object(source.metadata)) throw new MigrationError('INVALID_TYPE');
  if (findForbiddenSecretPaths(source.metadata).length) throw new MigrationError('SECRET_FORBIDDEN');
  return deepFreezeMigration({ ...structuredClone({ ...source, scan: undefined }), scan: source.scan });
}

export function createMigrationCandidate(value) { return deepFreezeMigration(structuredClone(value)); }
export function createMigrationPlan(value) { return deepFreezeMigration(structuredClone(value)); }
export function createMigrationReport(value) { return deepFreezeMigration(structuredClone(value)); }
