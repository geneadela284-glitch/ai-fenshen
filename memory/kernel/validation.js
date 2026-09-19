import {
  MEMORY_CONFIRMATIONS,
  MEMORY_EVENT_TYPES,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_TYPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MemoryConfirmation,
  MemorySensitivity,
  MemorySourceType,
  MemoryStatus
} from './enums.js';
import { createMemoryKernelError } from './errors.js';
import {
  MEMORY_SCHEMA_VERSION,
  MemoryCandidate,
  MemoryConflict,
  MemoryEvent,
  MemoryPolicy,
  MemoryQuery,
  MemoryRecord,
  MemoryResult,
  MemorySource,
  MemoryVersion
} from './schemas.js';

const FORBIDDEN_SECRET_KEY = /(password|api[-_]?key|cookie|session[-_]?token|access[-_]?token|refresh[-_]?token|private[-_]?key|recovery[-_]?code|full[-_]?card[-_]?number|full[-_]?id[-_]?number|auth(?:entication)?[-_]?secret)/i;

function result(errors = [], warnings = []) {
  return { valid: errors.length === 0, errors, warnings };
}
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function validateShape(value, contract, errors) {
  if (!isObject(value)) {
    errors.push(createMemoryKernelError('', 'INVALID_TYPE', `${contract.name} must be an object.`));
    return false;
  }
  for (const field of contract.required) {
    if (!(field in value) || value[field] === undefined) {
      errors.push(createMemoryKernelError(field, 'REQUIRED', `${field} is required.`));
    }
  }
  for (const field of Object.keys(value)) {
    if (!contract.fields.includes(field)) {
      errors.push(createMemoryKernelError(field, 'UNKNOWN_FIELD', `Unknown field: ${field}`));
    }
  }
  return true;
}

function validateUserScope(userId, trustedUserId, errors) {
  if (!isNonEmptyString(userId)) {
    errors.push(createMemoryKernelError('userId', 'REQUIRED', 'userId is required.'));
  }
  if (!isNonEmptyString(trustedUserId)) {
    errors.push(createMemoryKernelError('userId', 'USER_SCOPE_REQUIRED', 'trustedUserId is required.'));
  } else if (isNonEmptyString(userId) && userId !== trustedUserId) {
    errors.push(createMemoryKernelError('userId', 'USER_SCOPE_MISMATCH', 'userId must match trusted context.'));
  }
}

function validateEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) {
    errors.push(createMemoryKernelError(path, 'INVALID_ENUM', `${path} is invalid.`));
  }
}

function validateUnitNumber(value, path, errors) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(createMemoryKernelError(path, 'INVALID_NUMBER', `${path} must be a number between 0 and 1.`));
  }
}

function validateRequiredDate(value, path, errors) {
  if (!isIsoDate(value)) errors.push(createMemoryKernelError(path, 'INVALID_DATE', `${path} must be an ISO date.`));
}

function validateOptionalDate(value, path, errors) {
  if (value !== null && value !== undefined && !isIsoDate(value)) {
    errors.push(createMemoryKernelError(path, 'INVALID_DATE', `${path} must be an ISO date or null.`));
  }
}

export function findForbiddenSecretPaths(value, path = '') {
  if (!value || typeof value !== 'object') return [];
  const paths = [];
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_SECRET_KEY.test(key)) paths.push(nestedPath);
    paths.push(...findForbiddenSecretPaths(nested, nestedPath));
  }
  return paths;
}

function prefixErrors(errors, prefix) {
  return errors.map((error) => createMemoryKernelError(
    error.path ? `${prefix}.${error.path}` : prefix,
    error.code,
    error.message
  ));
}

export function validateMemorySource(source) {
  const errors = [];
  if (!validateShape(source, MemorySource, errors)) return result(errors);
  validateEnum(source.type, MEMORY_SOURCE_TYPES, 'type', errors);
  if (!isNonEmptyString(source.id)) {
    errors.push(createMemoryKernelError('id', 'SOURCE_REQUIRED', 'source id is required.'));
  }
  return result(errors);
}

export function validateMemoryRecord(record, { trustedUserId } = {}) {
  const errors = [];
  if (!validateShape(record, MemoryRecord, errors)) return result(errors);

  validateUserScope(record.userId, trustedUserId, errors);
  if (record.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    errors.push(createMemoryKernelError('schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be v1.'));
  }
  for (const field of ['id', 'subject', 'predicate']) {
    if (!isNonEmptyString(record[field])) errors.push(createMemoryKernelError(field, 'REQUIRED', `${field} is required.`));
  }
  validateEnum(record.memoryType, MEMORY_TYPES, 'memoryType', errors);
  validateEnum(record.status, MEMORY_STATUSES, 'status', errors);
  validateEnum(record.confirmationStatus, MEMORY_CONFIRMATIONS, 'confirmationStatus', errors);
  validateEnum(record.sensitivity, MEMORY_SENSITIVITIES, 'sensitivity', errors);
  validateUnitNumber(record.confidence, 'confidence', errors);
  validateUnitNumber(record.importance, 'importance', errors);

  const sourceValidation = validateMemorySource(record.source);
  errors.push(...prefixErrors(sourceValidation.errors, 'source'));

  for (const field of ['sourceTimestamp', 'createdAt', 'updatedAt', 'effectiveFrom']) {
    validateRequiredDate(record[field], field, errors);
  }
  for (const field of ['effectiveTo', 'expiresAt']) validateOptionalDate(record[field], field, errors);
  if (isIsoDate(record.effectiveFrom) && isIsoDate(record.effectiveTo) && Date.parse(record.effectiveTo) < Date.parse(record.effectiveFrom)) {
    errors.push(createMemoryKernelError('effectiveTo', 'INVALID_RANGE', 'effectiveTo cannot be before effectiveFrom.'));
  }
  if (isIsoDate(record.createdAt) && isIsoDate(record.updatedAt) && Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    errors.push(createMemoryKernelError('updatedAt', 'INVALID_RANGE', 'updatedAt cannot be before createdAt.'));
  }

  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push(createMemoryKernelError('version', 'INVALID_NUMBER', 'version must be a positive integer.'));
  }
  for (const field of ['retentionPolicy', 'accessPolicy', 'metadata']) {
    if (!isObject(record[field])) errors.push(createMemoryKernelError(field, 'INVALID_TYPE', `${field} must be an object.`));
  }
  if (record.tags !== undefined && record.tags !== null && !Array.isArray(record.tags)) {
    errors.push(createMemoryKernelError('tags', 'INVALID_TYPE', 'tags must be an array or null.'));
  }
  for (const field of ['supersedesId', 'supersededById', 'conflictGroupId', 'checksum']) {
    if (record[field] !== null && record[field] !== undefined && !isNonEmptyString(record[field])) {
      errors.push(createMemoryKernelError(field, 'INVALID_TYPE', `${field} must be a non-empty string or null.`));
    }
  }
  if (record.supersedesId === record.id) {
    errors.push(createMemoryKernelError('supersedesId', 'INVARIANT_VIOLATION', 'Memory cannot supersede itself.'));
  }
  if (record.status === MemoryStatus.SUPERSEDED && !isNonEmptyString(record.supersededById)) {
    errors.push(createMemoryKernelError('supersededById', 'INVARIANT_VIOLATION', 'Superseded Memory requires supersededById.'));
  }
  if (record.source?.type === MemorySourceType.MODEL_INFERRED && record.status === MemoryStatus.CONFIRMED) {
    errors.push(createMemoryKernelError('source.type', 'MODEL_CONFIRMED_FORBIDDEN', 'Model inference cannot be confirmed directly.'));
  }
  if (record.status === MemoryStatus.CONFIRMED && [MemoryConfirmation.PENDING, MemoryConfirmation.USER_REJECTED].includes(record.confirmationStatus)) {
    errors.push(createMemoryKernelError('confirmationStatus', 'INVARIANT_VIOLATION', 'Confirmed Memory requires an approved confirmation status.'));
  }
  if ([MemoryStatus.CANDIDATE, MemoryStatus.PENDING_CONFIRMATION].includes(record.status) && record.confirmationStatus !== MemoryConfirmation.PENDING) {
    errors.push(createMemoryKernelError('confirmationStatus', 'CANDIDATE_STATUS_REQUIRED', 'Candidate Memory must remain pending.'));
  }
  if (record.sensitivity === MemorySensitivity.HIGH && record.status === MemoryStatus.CONFIRMED && record.confirmationStatus !== MemoryConfirmation.USER_CONFIRMED) {
    errors.push(createMemoryKernelError('confirmationStatus', 'CONFIRMATION_REQUIRED', 'High sensitivity Memory requires user confirmation.'));
  }
  for (const path of findForbiddenSecretPaths(record)) {
    errors.push(createMemoryKernelError(path, 'SECRET_FORBIDDEN', 'Authentication secrets cannot enter Memory.'));
  }
  return result(errors);
}

export function validateMemoryCandidate(candidate, { trustedUserId } = {}) {
  const errors = [];
  if (!validateShape(candidate, MemoryCandidate, errors)) return result(errors);
  validateUserScope(candidate.userId, trustedUserId, errors);
  if (candidate.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    errors.push(createMemoryKernelError('schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be v1.'));
  }
  if (!isNonEmptyString(candidate.id)) errors.push(createMemoryKernelError('id', 'REQUIRED', 'id is required.'));
  const sourceValidation = validateMemorySource(candidate.source);
  errors.push(...prefixErrors(sourceValidation.errors, 'source'));
  validateRequiredDate(candidate.createdAt, 'createdAt', errors);
  validateOptionalDate(candidate.expiresAt, 'expiresAt', errors);
  if (typeof candidate.modelGenerated !== 'boolean') {
    errors.push(createMemoryKernelError('modelGenerated', 'INVALID_TYPE', 'modelGenerated must be boolean.'));
  }
  if (!isObject(candidate.metadata)) errors.push(createMemoryKernelError('metadata', 'INVALID_TYPE', 'metadata must be an object.'));

  const proposedValidation = validateMemoryRecord(candidate.proposedMemory, { trustedUserId });
  errors.push(...prefixErrors(proposedValidation.errors, 'proposedMemory'));
  if (candidate.proposedMemory?.userId !== candidate.userId) {
    errors.push(createMemoryKernelError('proposedMemory.userId', 'USER_SCOPE_MISMATCH', 'Candidate and proposed Memory must share userId.'));
  }
  if (![MemoryStatus.CANDIDATE, MemoryStatus.PENDING_CONFIRMATION].includes(candidate.proposedMemory?.status)) {
    errors.push(createMemoryKernelError('proposedMemory.status', 'CANDIDATE_STATUS_REQUIRED', 'Candidate cannot contain a formal status.'));
  }
  if (candidate.modelGenerated && candidate.source?.type !== MemorySourceType.MODEL_INFERRED) {
    errors.push(createMemoryKernelError('source.type', 'INVARIANT_VIOLATION', 'Model-generated Candidate requires model_inferred source.'));
  }
  if (candidate.modelGenerated && [MemorySensitivity.HIGH, MemorySensitivity.RESTRICTED].includes(candidate.proposedMemory?.sensitivity)) {
    errors.push(createMemoryKernelError('proposedMemory.sensitivity', 'CONFIRMATION_REQUIRED', 'A model cannot create high sensitivity Candidates.'));
  }
  return result(errors);
}

export function validateMemoryPolicy(policy) {
  const errors = [];
  if (!validateShape(policy, MemoryPolicy, errors)) return result(errors);
  for (const field of ['retentionPolicy', 'accessPolicy']) {
    if (!isObject(policy[field])) errors.push(createMemoryKernelError(field, 'INVALID_TYPE', `${field} must be an object.`));
  }
  return result(errors);
}

export function validateMemoryQuery(query, { trustedUserId } = {}) {
  const errors = [];
  if (!validateShape(query, MemoryQuery, errors)) return result(errors);
  validateUserScope(query.userId, trustedUserId, errors);
  for (const [field, allowed] of [
    ['memoryType', MEMORY_TYPES],
    ['status', MEMORY_STATUSES],
    ['confirmationStatus', MEMORY_CONFIRMATIONS],
    ['sensitivityMax', MEMORY_SENSITIVITIES]
  ]) {
    if (query[field] !== undefined && query[field] !== null) validateEnum(query[field], allowed, field, errors);
  }
  for (const [field, allowed] of [
    ['memoryTypes', MEMORY_TYPES],
    ['statuses', MEMORY_STATUSES],
    ['confirmationStatuses', MEMORY_CONFIRMATIONS],
    ['sensitivities', MEMORY_SENSITIVITIES]
  ]) {
    if (query[field] !== undefined && query[field] !== null) {
      if (!Array.isArray(query[field])) errors.push(createMemoryKernelError(field, 'INVALID_TYPE', `${field} must be an array.`));
      else query[field].forEach((value) => validateEnum(value, allowed, field, errors));
    }
  }
  validateOptionalDate(query.effectiveAt, 'effectiveAt', errors);
  for (const field of ['id', 'subject', 'predicate', 'cursor', 'sort']) {
    if (query[field] !== undefined && query[field] !== null && !isNonEmptyString(query[field])) {
      errors.push(createMemoryKernelError(field, 'INVALID_TYPE', `${field} must be a non-empty string.`));
    }
  }
  if (query.tags !== undefined && query.tags !== null && (
    !Array.isArray(query.tags) || query.tags.some((tag) => !isNonEmptyString(tag))
  )) {
    errors.push(createMemoryKernelError('tags', 'INVALID_TYPE', 'tags must be an array of non-empty strings.'));
  }
  for (const field of ['includeHistorical', 'includeCandidates']) {
    if (query[field] !== undefined && typeof query[field] !== 'boolean') {
      errors.push(createMemoryKernelError(field, 'INVALID_TYPE', `${field} must be boolean.`));
    }
  }
  if (query.limit !== undefined && query.limit !== null && (!Number.isInteger(query.limit) || query.limit < 1)) {
    errors.push(createMemoryKernelError('limit', 'INVALID_NUMBER', 'limit must be a positive integer.'));
  }
  return result(errors);
}

export function validateMemoryResult(value) {
  const errors = [];
  if (!validateShape(value, MemoryResult, errors)) return result(errors);
  if (typeof value.ok !== 'boolean') errors.push(createMemoryKernelError('ok', 'INVALID_TYPE', 'ok must be boolean.'));
  if (value.metadata !== undefined && !isObject(value.metadata)) errors.push(createMemoryKernelError('metadata', 'INVALID_TYPE', 'metadata must be an object.'));
  if (value.ok === true && value.error !== null) errors.push(createMemoryKernelError('error', 'INVARIANT_VIOLATION', 'Successful result cannot contain an error.'));
  if (value.ok === false && !isObject(value.error)) errors.push(createMemoryKernelError('error', 'REQUIRED', 'Failed result requires an error.'));
  return result(errors);
}

export function validateMemoryVersion(value) {
  const errors = [];
  if (!validateShape(value, MemoryVersion, errors)) return result(errors);
  if (!isNonEmptyString(value.memoryId)) errors.push(createMemoryKernelError('memoryId', 'REQUIRED', 'memoryId is required.'));
  if (!Number.isInteger(value.version) || value.version < 1) errors.push(createMemoryKernelError('version', 'INVALID_NUMBER', 'version must be positive.'));
  validateRequiredDate(value.createdAt, 'createdAt', errors);
  return result(errors);
}

export function validateMemoryConflict(value, { trustedUserId } = {}) {
  const errors = [];
  if (!validateShape(value, MemoryConflict, errors)) return result(errors);
  validateUserScope(value.userId, trustedUserId, errors);
  if (!isNonEmptyString(value.conflictGroupId)) errors.push(createMemoryKernelError('conflictGroupId', 'REQUIRED', 'conflictGroupId is required.'));
  if (!Array.isArray(value.memoryIds)) errors.push(createMemoryKernelError('memoryIds', 'INVALID_TYPE', 'memoryIds must be an array.'));
  else if (new Set(value.memoryIds).size < 2) errors.push(createMemoryKernelError('memoryIds', 'INVALID_RANGE', 'A conflict requires at least two distinct Memory ids.'));
  validateRequiredDate(value.createdAt, 'createdAt', errors);
  return result(errors);
}

export function validateMemoryEvent(value, { trustedUserId } = {}) {
  const errors = [];
  if (!validateShape(value, MemoryEvent, errors)) return result(errors);
  validateUserScope(value.userId, trustedUserId, errors);
  for (const field of ['id', 'memoryId']) if (!isNonEmptyString(value[field])) errors.push(createMemoryKernelError(field, 'REQUIRED', `${field} is required.`));
  validateEnum(value.eventType, MEMORY_EVENT_TYPES, 'eventType', errors);
  validateRequiredDate(value.occurredAt, 'occurredAt', errors);
  if (!isObject(value.metadata)) errors.push(createMemoryKernelError('metadata', 'INVALID_TYPE', 'metadata must be an object.'));
  return result(errors);
}
