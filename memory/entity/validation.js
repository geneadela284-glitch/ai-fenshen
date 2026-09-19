import crypto from 'node:crypto';

import {
  ENTITY_ALIAS_STATUSES,
  ENTITY_MODEL_SCHEMA_VERSION,
  ENTITY_RELATION_STATUSES,
  ENTITY_RESOLUTION_STATUSES,
  ENTITY_STATUSES,
  ENTITY_TYPES,
  ENTITY_ID_PATTERN,
  MEMORY_RECORD_V2_CHECKSUM_FIELDS,
  MEMORY_V2_CONFIRMATION_STATUSES,
  MEMORY_V2_PROVENANCE_LEVELS,
  MEMORY_V2_SENSITIVITIES,
  MEMORY_V2_STATUSES,
  PREDICATE_STRUCTURED_VALUE_SCHEMAS,
  Entity,
  EntityAlias,
  EntityRelation,
  EntityResolution,
  EntitySource,
  MemoryRecordV2
} from './contracts.js';

const RELATION_ID_PATTERN = /^rel_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function issue(path, code, message) {
  return Object.freeze({ path, code, message });
}

function result(errors = [], warnings = []) {
  return { valid: errors.length === 0, errors, warnings };
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoDate(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isoCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

export function canonicalSerializeMemoryRecordV2ChecksumInput(value) {
  const payload = {};
  for (const field of MEMORY_RECORD_V2_CHECKSUM_FIELDS) {
    payload[field] = field === 'structuredValue'
      ? canonicalize(value?.[field])
      : value?.[field];
  }
  return JSON.stringify(payload);
}

export function computeMemoryRecordV2Checksum(value) {
  return crypto.createHash('sha256')
    .update(canonicalSerializeMemoryRecordV2ChecksumInput(value))
    .digest('hex');
}

function validateShape(value, contract, errors) {
  if (!object(value)) {
    errors.push(issue('', 'INVALID_TYPE', `${contract.name} must be an object.`));
    return false;
  }
  for (const field of contract.required) {
    if (!(field in value) || value[field] === undefined) {
      errors.push(issue(field, 'REQUIRED', `${field} is required.`));
    }
  }
  for (const field of Object.keys(value)) {
    if (!contract.fields.includes(field)) {
      errors.push(issue(field, 'UNKNOWN_FIELD', `Unknown field: ${field}`));
    }
  }
  return true;
}

function validateSchemaVersion(value, errors) {
  if (value !== ENTITY_MODEL_SCHEMA_VERSION) {
    errors.push(issue('schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be v2.'));
  }
}

function validateOwner(ownerUserId, trustedOwnerUserId, errors) {
  if (!nonEmptyString(ownerUserId)) {
    errors.push(issue('ownerUserId', 'REQUIRED', 'ownerUserId is required.'));
  }
  if (!nonEmptyString(trustedOwnerUserId)) {
    errors.push(issue('ownerUserId', 'OWNER_SCOPE_REQUIRED', 'trustedOwnerUserId is required.'));
  } else if (nonEmptyString(ownerUserId) && ownerUserId !== trustedOwnerUserId) {
    errors.push(issue('ownerUserId', 'OWNER_SCOPE_MISMATCH', 'ownerUserId must match trusted context.'));
  }
}

function validateEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) errors.push(issue(path, 'INVALID_ENUM', `${path} is invalid.`));
}

function validateEntityId(value, path, errors, { requiredCode = 'ENTITY_ID_INVALID' } = {}) {
  if (!ENTITY_ID_PATTERN.test(String(value || ''))) {
    errors.push(issue(path, requiredCode, `${path} must be an opaque Entity ID.`));
  }
}

function validateRelationId(value, path, errors) {
  if (!RELATION_ID_PATTERN.test(String(value || ''))) {
    errors.push(issue(path, 'RELATION_ID_INVALID', `${path} must be an opaque Relation ID.`));
  }
}

function validateVersion(value, path, errors) {
  if (!Number.isInteger(value) || value < 1) {
    errors.push(issue(path, 'INVALID_NUMBER', `${path} must be a positive integer.`));
  }
}

function validateChecksum(value, path, errors) {
  if (!SHA256_PATTERN.test(String(value || ''))) {
    errors.push(issue(path, 'CHECKSUM_INVALID', `${path} must be a SHA-256 hex digest.`));
  }
}

function validateRequiredDate(value, path, errors) {
  if (!isoDate(value)) errors.push(issue(path, 'INVALID_DATE', `${path} must be an ISO date.`));
}

function validateOptionalDate(value, path, errors) {
  if (value !== null && value !== undefined && !isoDate(value)) {
    errors.push(issue(path, 'INVALID_DATE', `${path} must be an ISO date or null.`));
  }
}

function validateUnitNumber(value, path, errors) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(issue(path, 'INVALID_NUMBER', `${path} must be between zero and one.`));
  }
}

function validateStructuredValue(predicate, value, errors) {
  const schema = PREDICATE_STRUCTURED_VALUE_SCHEMAS[predicate];
  if (!schema) {
    errors.push(issue('predicate', 'PREDICATE_SCHEMA_MISSING', 'predicate must have a registered structuredValue schema.'));
    return;
  }
  if (!object(value)) {
    errors.push(issue('structuredValue', 'INVALID_TYPE', 'structuredValue must be an object.'));
    return;
  }
  for (const field of schema.required) {
    if (!(field in value) || value[field] === undefined) {
      errors.push(issue(`structuredValue.${field}`, 'REQUIRED', `${field} is required.`));
    }
  }
  for (const field of Object.keys(value)) {
    if (!schema.fields.includes(field)) {
      errors.push(issue(`structuredValue.${field}`, 'UNKNOWN_FIELD', `Unknown structuredValue field: ${field}`));
    }
  }
  for (const [field, type] of Object.entries(schema.fieldTypes)) {
    if (field in value && type === 'iso-date' && !isoCalendarDate(value[field])) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} must be a valid YYYY-MM-DD calendar date.`));
    } else if (field in value && type === 'calendar-type' && !['gregorian', 'lunar', 'unknown'].includes(value[field])) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} must be gregorian, lunar, or unknown.`));
    } else if (field in value && type === 'year-or-null' &&
        value[field] !== null && (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 9999)) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} must be a valid year or null.`));
    } else if (field in value && type === 'month' &&
        (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 12)) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} must be a valid month.`));
    } else if (field in value && type === 'day' &&
        (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 31)) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} must be a valid day.`));
    } else if (field in value && type === 'lunar-leap-month' && ![true, false, 'unknown'].includes(value[field])) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} must be boolean or unknown.`));
    } else if (field in value && type === 'recurrence' && !['yearly', 'one_time', 'unknown'].includes(value[field])) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} is invalid.`));
    } else if (field in value && type === 'string' && !nonEmptyString(value[field])) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} must be a non-empty string.`));
    } else if (field in value && type === 'string-array' &&
        (!Array.isArray(value[field]) || value[field].length === 0 ||
          !value[field].every(nonEmptyString) ||
          new Set(value[field].map((item) => item.trim())).size !== value[field].length)) {
      errors.push(issue(`structuredValue.${field}`, 'INVALID_TYPE', `${field} must be a non-empty array of unique strings.`));
    }
  }
  if (value.calendarType !== 'lunar' && value.lunarLeapMonth !== undefined && value.lunarLeapMonth !== 'unknown') {
    errors.push(issue('structuredValue.lunarLeapMonth', 'INVARIANT_VIOLATION', 'lunarLeapMonth requires lunar calendarType.'));
  }
  if (value.calendarType === 'lunar' && Number.isInteger(value.day) && value.day > 30) {
    errors.push(issue('structuredValue.day', 'INVALID_TYPE', 'Lunar day cannot exceed 30.'));
  }
}

function prefixErrors(errors, prefix) {
  return errors.map((error) => issue(
    error.path ? `${prefix}.${error.path}` : prefix,
    error.code,
    error.message
  ));
}

function validateSource(source) {
  const errors = [];
  if (!validateShape(source, EntitySource, errors)) return result(errors);
  for (const field of ['type', 'id']) {
    if (!nonEmptyString(source[field])) errors.push(issue(field, 'SOURCE_REQUIRED', `${field} is required.`));
  }
  return result(errors);
}

function validateAuditFields(value, errors) {
  validateVersion(value.version, 'version', errors);
  validateChecksum(value.checksum, 'checksum', errors);
  validateRequiredDate(value.createdAt, 'createdAt', errors);
  validateRequiredDate(value.updatedAt, 'updatedAt', errors);
  if (isoDate(value.createdAt) && isoDate(value.updatedAt) && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    errors.push(issue('updatedAt', 'INVALID_RANGE', 'updatedAt cannot be before createdAt.'));
  }
  if (!object(value.metadata)) errors.push(issue('metadata', 'INVALID_TYPE', 'metadata must be an object.'));
  errors.push(...prefixErrors(validateSource(value.source).errors, 'source'));
}

export function validateEntity(value, { trustedOwnerUserId } = {}) {
  const errors = [];
  if (!validateShape(value, Entity, errors)) return result(errors);
  validateSchemaVersion(value.schemaVersion, errors);
  validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
  validateEntityId(value.entityId, 'entityId', errors);
  validateEnum(value.type, ENTITY_TYPES, 'type', errors);
  validateEnum(value.status, ENTITY_STATUSES, 'status', errors);
  validateAuditFields(value, errors);
  return result(errors);
}

export function validateEntityAlias(value, { trustedOwnerUserId } = {}) {
  const errors = [];
  if (!validateShape(value, EntityAlias, errors)) return result(errors);
  validateSchemaVersion(value.schemaVersion, errors);
  validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
  if (!nonEmptyString(value.alias)) errors.push(issue('alias', 'REQUIRED', 'alias is required.'));
  validateEntityId(value.entityId, 'entityId', errors);
  validateUnitNumber(value.confidence, 'confidence', errors);
  validateEnum(value.status, ENTITY_ALIAS_STATUSES, 'status', errors);
  validateVersion(value.version, 'version', errors);
  validateRequiredDate(value.createdAt, 'createdAt', errors);
  validateRequiredDate(value.updatedAt, 'updatedAt', errors);
  if (!object(value.metadata)) errors.push(issue('metadata', 'INVALID_TYPE', 'metadata must be an object.'));
  errors.push(...prefixErrors(validateSource(value.source).errors, 'source'));
  return result(errors);
}

export function validateEntityRelation(value, { trustedOwnerUserId } = {}) {
  const errors = [];
  if (!validateShape(value, EntityRelation, errors)) return result(errors);
  validateSchemaVersion(value.schemaVersion, errors);
  validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
  validateRelationId(value.relationId, 'relationId', errors);
  validateEntityId(value.sourceEntityId, 'sourceEntityId', errors);
  validateEntityId(value.targetEntityId, 'targetEntityId', errors);
  if (value.sourceEntityId === value.targetEntityId) {
    errors.push(issue('targetEntityId', 'INVARIANT_VIOLATION', 'A relation cannot target its source Entity.'));
  }
  for (const field of ['relationKind', 'role']) {
    if (!nonEmptyString(value[field])) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
  }
  validateRequiredDate(value.effectiveFrom, 'effectiveFrom', errors);
  validateOptionalDate(value.effectiveTo, 'effectiveTo', errors);
  if (isoDate(value.effectiveFrom) && isoDate(value.effectiveTo) && Date.parse(value.effectiveTo) <= Date.parse(value.effectiveFrom)) {
    errors.push(issue('effectiveTo', 'INVALID_RANGE', 'effectiveTo must be after effectiveFrom.'));
  }
  validateEnum(value.status, ENTITY_RELATION_STATUSES, 'status', errors);
  validateAuditFields(value, errors);
  return result(errors);
}

export function classifyResolutionCandidates(candidateEntityIds) {
  if (!Array.isArray(candidateEntityIds) || candidateEntityIds.some((id) => !ENTITY_ID_PATTERN.test(String(id || '')))) {
    throw new TypeError('candidateEntityIds must be an array of opaque Entity IDs.');
  }
  const count = new Set(candidateEntityIds).size;
  if (count === 0) return 'no_match';
  if (count === 1) return 'exact';
  return 'ambiguous';
}

export function validateEntityResolution(value, { trustedOwnerUserId } = {}) {
  const errors = [];
  if (!validateShape(value, EntityResolution, errors)) return result(errors);
  validateSchemaVersion(value.schemaVersion, errors);
  validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
  validateEnum(value.resolutionStatus, ENTITY_RESOLUTION_STATUSES, 'resolutionStatus', errors);
  validateEnum(value.entityType, ENTITY_TYPES, 'entityType', errors);
  for (const field of ['relationKind', 'role', 'predicate']) {
    if (value[field] !== null && !nonEmptyString(value[field])) {
      errors.push(issue(field, 'INVALID_TYPE', `${field} must be a non-empty string or null.`));
    }
  }
  if (!Array.isArray(value.candidateEntityIds)) {
    errors.push(issue('candidateEntityIds', 'INVALID_TYPE', 'candidateEntityIds must be an array.'));
  } else {
    value.candidateEntityIds.forEach((id) => validateEntityId(id, 'candidateEntityIds', errors));
  }
  if (!Array.isArray(value.sourceRelationIds) || value.sourceRelationIds.some((id) => !nonEmptyString(id))) {
    errors.push(issue('sourceRelationIds', 'INVALID_TYPE', 'sourceRelationIds must be an array of non-empty strings.'));
  }
  for (const field of ['resolutionReason', 'policyVersion']) {
    if (!nonEmptyString(value[field])) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
  }
  validateRequiredDate(value.resolvedAt, 'resolvedAt', errors);

  const candidateIds = Array.isArray(value.candidateEntityIds) ? [...new Set(value.candidateEntityIds)] : [];
  if (value.resolutionStatus === 'exact') {
    validateEntityId(value.entityId, 'entityId', errors);
    if (candidateIds.length > 0) {
      errors.push(issue('candidateEntityIds', 'RESOLUTION_AMBIGUOUS', 'Exact resolution cannot retain candidate Entity IDs.'));
    }
  } else if (value.resolutionStatus === 'ambiguous') {
    if (value.entityId !== null) errors.push(issue('entityId', 'RESOLUTION_AMBIGUOUS', 'Ambiguous resolution cannot select an Entity.'));
    if (candidateIds.length < 2) errors.push(issue('candidateEntityIds', 'RESOLUTION_AMBIGUOUS', 'Ambiguous resolution requires multiple Entity candidates.'));
  } else if (value.resolutionStatus === 'no_match') {
    if (value.entityId !== null) errors.push(issue('entityId', 'INVARIANT_VIOLATION', 'No-match resolution cannot select an Entity.'));
    if (candidateIds.length !== 0) errors.push(issue('candidateEntityIds', 'INVARIANT_VIOLATION', 'No-match resolution cannot retain candidates.'));
  }
  return result(errors);
}

export function validateMemoryRecordV2(value, { trustedOwnerUserId, resolution } = {}) {
  const errors = [];
  if (!validateShape(value, MemoryRecordV2, errors)) return result(errors);
  validateSchemaVersion(value.schemaVersion, errors);
  validateOwner(value.ownerUserId, trustedOwnerUserId, errors);
  for (const field of ['memoryId', 'memoryType', 'predicate']) {
    if (!nonEmptyString(value[field])) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
  }
  if (!nonEmptyString(value.subjectEntityId)) {
    errors.push(issue('subjectEntityId', 'SUBJECT_ENTITY_REQUIRED', 'Confirmed MemoryRecordV2 requires subjectEntityId.'));
  } else {
    validateEntityId(value.subjectEntityId, 'subjectEntityId', errors);
  }
  validateStructuredValue(value.predicate, value.structuredValue, errors);
  if (value.displayValue !== null && value.displayValue !== undefined && !nonEmptyString(value.displayValue)) errors.push(issue('displayValue', 'INVALID_TYPE', 'displayValue must be a string or null.'));
  if (value.legacySubject !== null && value.legacySubject !== undefined && !nonEmptyString(value.legacySubject)) errors.push(issue('legacySubject', 'INVALID_TYPE', 'legacySubject must be a string or null.'));
  validateEnum(value.status, MEMORY_V2_STATUSES, 'status', errors);
  validateEnum(value.confirmationStatus, MEMORY_V2_CONFIRMATION_STATUSES, 'confirmationStatus', errors);
  validateEnum(value.provenance, MEMORY_V2_PROVENANCE_LEVELS, 'provenance', errors);
  validateEnum(value.sensitivity, MEMORY_V2_SENSITIVITIES, 'sensitivity', errors);
  validateUnitNumber(value.confidence, 'confidence', errors);
  validateUnitNumber(value.importance, 'importance', errors);
  for (const field of ['sourceTimestamp', 'createdAt', 'updatedAt', 'effectiveFrom']) validateRequiredDate(value[field], field, errors);
  for (const field of ['effectiveTo', 'expiresAt']) validateOptionalDate(value[field], field, errors);
  if (isoDate(value.effectiveFrom) && isoDate(value.effectiveTo) && Date.parse(value.effectiveTo) <= Date.parse(value.effectiveFrom)) {
    errors.push(issue('effectiveTo', 'INVALID_RANGE', 'effectiveTo must be after effectiveFrom.'));
  }
  validateVersion(value.version, 'version', errors);
  validateChecksum(value.checksum, 'checksum', errors);
  if (SHA256_PATTERN.test(String(value.checksum || '')) &&
      value.checksum !== computeMemoryRecordV2Checksum(value)) {
    errors.push(issue('checksum', 'CHECKSUM_MISMATCH', 'checksum does not match canonical MemoryRecordV2 input.'));
  }
  errors.push(...prefixErrors(validateSource(value.source).errors, 'source'));
  for (const field of ['retentionPolicy', 'accessPolicy', 'metadata']) {
    if (!object(value[field])) errors.push(issue(field, 'INVALID_TYPE', `${field} must be an object.`));
  }
  if (value.tags !== undefined && value.tags !== null && (
    !Array.isArray(value.tags) || value.tags.some((tag) => !nonEmptyString(tag))
  )) {
    errors.push(issue('tags', 'INVALID_TYPE', 'tags must be an array of non-empty strings.'));
  }
  for (const field of ['supersedesId', 'supersededById', 'conflictGroupId']) {
    if (value[field] !== null && value[field] !== undefined && !nonEmptyString(value[field])) errors.push(issue(field, 'INVALID_TYPE', `${field} must be a string or null.`));
  }
  if (resolution !== undefined) {
    const resolutionValidation = validateEntityResolution(resolution, { trustedOwnerUserId });
    if (!resolutionValidation.valid || resolution.resolutionStatus !== 'exact') {
      errors.push(issue('resolution', 'RESOLUTION_EXACT_REQUIRED', 'Only exact Entity resolution can authorize a MemoryRecordV2 write.'));
    } else if (resolution.entityId !== value.subjectEntityId) {
      errors.push(issue('subjectEntityId', 'ENTITY_SCOPE_MISMATCH', 'Memory subjectEntityId must match the resolved Entity.'));
    }
  }
  return result(errors);
}

export function validateEntityScopedRecordSet(records, { trustedOwnerUserId, subjectEntityId, predicate } = {}) {
  const errors = [];
  if (!Array.isArray(records)) return result([issue('records', 'INVALID_TYPE', 'records must be an array.')]);
  validateEntityId(subjectEntityId, 'subjectEntityId', errors);
  if (!nonEmptyString(predicate)) errors.push(issue('predicate', 'REQUIRED', 'predicate is required.'));
  records.forEach((record, index) => {
    const recordValidation = validateMemoryRecordV2(record, { trustedOwnerUserId });
    errors.push(...prefixErrors(recordValidation.errors, `records[${index}]`));
    if (record.ownerUserId !== trustedOwnerUserId) {
      errors.push(issue(`records[${index}].ownerUserId`, 'OWNER_SCOPE_MISMATCH', 'Record owner is outside the trusted scope.'));
    }
    if (record.subjectEntityId !== subjectEntityId) {
      errors.push(issue(`records[${index}].subjectEntityId`, 'ENTITY_SCOPE_MISMATCH', 'Record Entity is outside the exact scope.'));
    }
    if (record.predicate !== predicate) {
      errors.push(issue(`records[${index}].predicate`, 'PREDICATE_SCOPE_MISMATCH', 'Record predicate is outside the exact scope.'));
    }
  });
  return result(errors);
}

export function validateMemoryCorrectionV2(current, replacement, { trustedOwnerUserId } = {}) {
  const errors = [
    ...prefixErrors(validateMemoryRecordV2(current, { trustedOwnerUserId }).errors, 'current'),
    ...prefixErrors(validateMemoryRecordV2(replacement, { trustedOwnerUserId }).errors, 'replacement')
  ];
  if (current?.subjectEntityId !== replacement?.subjectEntityId) {
    errors.push(issue('subjectEntityId', 'ENTITY_REBIND_REQUIRES_GOVERNANCE', 'Ordinary correction must preserve subjectEntityId.'));
  }
  return result(errors);
}
