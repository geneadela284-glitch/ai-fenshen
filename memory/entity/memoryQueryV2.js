import crypto from 'node:crypto';

import {
  ENTITY_ID_PATTERN,
  PREDICATE_STRUCTURED_VALUE_SCHEMAS
} from './contracts.js';
import {
  validateEntityResolution,
  validateEntityScopedRecordSet
} from './validation.js';

export const MEMORY_QUERY_V2_MAX_LIMIT = 50;
export const MEMORY_QUERY_V2_DEFAULT_LIMIT = 20;
export const MEMORY_QUERY_V2_READ_MODES = Object.freeze(['current', 'historical']);
export const MEMORY_QUERY_V2_PROVENANCE_POLICIES = Object.freeze({
  trusted_v2: Object.freeze(['user_stated', 'user_confirmed', 'system_verified']),
  user_confirmed_v2: Object.freeze(['user_confirmed'])
});

const QUERY_INPUT_FIELDS = Object.freeze([
  'subjectEntityId',
  'predicate',
  'effectiveAt',
  'memoryType',
  'allowedStatuses',
  'limit',
  'cursor',
  'provenancePolicy',
  'readMode'
]);

const QUERY_FIELDS = Object.freeze([
  'schemaVersion',
  'ownerUserId',
  ...QUERY_INPUT_FIELDS
]);

const HISTORICAL_STATUSES = Object.freeze(['confirmed', 'superseded', 'archived']);
const CURSOR_VERSION = 'memory-query-v2-cursor-v1';
const CURSOR_DOMAIN = 'aiwc-memory-query-v2-cursor';

export const MemoryQueryV2 = Object.freeze({
  name: 'MemoryQueryV2',
  schemaVersion: 'v2',
  fields: QUERY_FIELDS,
  required: QUERY_FIELDS,
  unknownFieldPolicy: 'reject',
  maxLimit: MEMORY_QUERY_V2_MAX_LIMIT,
  cursorPolicy: 'opaque-only'
});

export class MemoryQueryV2Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MemoryQueryV2Error';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MemoryQueryV2Error(code, message);
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoTimestamp(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function freezeQuery(query) {
  Object.freeze(query.allowedStatuses);
  return Object.freeze(query);
}

function assertUnknownFields(value, allowedFields, label) {
  if (!object(value)) fail('QUERY_INVALID', `${label} must be an object.`);
  const unknown = Object.keys(value).find((field) => !allowedFields.includes(field));
  if (unknown) fail('UNKNOWN_FIELD', `Unknown ${label} field: ${unknown}.`);
}

function normalizeStatuses(readMode, value) {
  const statuses = value === undefined
    ? (readMode === 'current' ? ['confirmed'] : [...HISTORICAL_STATUSES])
    : value;
  if (!Array.isArray(statuses) || statuses.length === 0 ||
      statuses.some((status) => !nonEmptyString(status)) ||
      new Set(statuses).size !== statuses.length) {
    fail('STATUS_POLICY_INVALID', 'allowedStatuses must be a non-empty unique allowlist.');
  }
  if (readMode === 'current' && (statuses.length !== 1 || statuses[0] !== 'confirmed')) {
    fail('STATUS_POLICY_INVALID', 'Current reads allow confirmed status only.');
  }
  if (readMode === 'historical' && statuses.some((status) => !HISTORICAL_STATUSES.includes(status))) {
    fail('STATUS_POLICY_INVALID', 'Historical status policy contains an unsupported status.');
  }
  return [...statuses];
}

function normalizeLimit(limit = MEMORY_QUERY_V2_DEFAULT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) {
    fail('LIMIT_INVALID', 'limit must be a positive integer.');
  }
  if (limit > MEMORY_QUERY_V2_MAX_LIMIT) {
    fail('LIMIT_EXCEEDED', `limit cannot exceed ${MEMORY_QUERY_V2_MAX_LIMIT}.`);
  }
  return limit;
}

function assertProvenancePolicy(policy) {
  if (!Object.hasOwn(MEMORY_QUERY_V2_PROVENANCE_POLICIES, policy)) {
    fail('PROVENANCE_POLICY_INVALID', 'provenancePolicy is unsupported.');
  }
}

function assertCursor(cursor) {
  if (cursor !== null && cursor !== undefined && !nonEmptyString(cursor)) {
    fail('CURSOR_INVALID', 'cursor must be an opaque string or null.');
  }
}

function assertSubjectAndPredicate(subjectEntityId, predicate) {
  if (!ENTITY_ID_PATTERN.test(String(subjectEntityId || ''))) {
    fail('ENTITY_ID_INVALID', 'subjectEntityId must be an opaque Entity ID.');
  }
  if (!nonEmptyString(predicate) || !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, predicate)) {
    fail('PREDICATE_INVALID', 'predicate must have a registered structuredValue schema.');
  }
}

function assertMemoryType(memoryType) {
  if (memoryType !== null && !nonEmptyString(memoryType)) {
    fail('MEMORY_TYPE_INVALID', 'memoryType must be a non-empty string or null.');
  }
}

function assertContext(context) {
  if (!object(context) || !nonEmptyString(context.ownerUserId)) {
    fail('OWNER_SCOPE_REQUIRED', 'Trusted context ownerUserId is required.');
  }
  if (!isoTimestamp(context.now)) fail('TRUSTED_TIME_REQUIRED', 'Trusted context now is required.');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function queryBinding(context, query) {
  if (!nonEmptyString(context.repositoryGeneration)) {
    fail('REPOSITORY_GENERATION_REQUIRED', 'Trusted repositoryGeneration is required.');
  }
  return {
    ownerUserId: query.ownerUserId,
    subjectEntityId: query.subjectEntityId,
    predicate: query.predicate,
    effectiveAt: query.effectiveAt,
    memoryType: query.memoryType,
    allowedStatuses: query.allowedStatuses,
    limit: query.limit,
    provenancePolicy: query.provenancePolicy,
    readMode: query.readMode,
    repositoryGeneration: context.repositoryGeneration,
    sort: ['effectiveFrom:desc', 'createdAt:desc', 'memoryId:asc']
  };
}

function cursorSignature(encodedPayload) {
  return sha256(`${CURSOR_DOMAIN}\n${CURSOR_VERSION}\n${encodedPayload}`);
}

function encodeCursor(context, query, record) {
  const payload = {
    bindingHash: sha256(stableJson(queryBinding(context, query))),
    position: {
      effectiveFrom: record.effectiveFrom,
      createdAt: record.createdAt,
      memoryId: record.memoryId
    }
  };
  const encodedPayload = Buffer.from(stableJson(payload)).toString('base64url');
  return `${CURSOR_VERSION}.${encodedPayload}.${cursorSignature(encodedPayload)}`;
}

function decodeCursor(context, query) {
  if (query.cursor === null) return null;
  const parts = String(query.cursor).split('.');
  if (parts.length !== 3) fail('CURSOR_INVALID', 'cursor is malformed.');
  const [version, encodedPayload, signature] = parts;
  if (version !== CURSOR_VERSION) fail('CURSOR_VERSION_UNSUPPORTED', 'cursor version is unsupported.');
  const expected = cursorSignature(encodedPayload);
  const actualBytes = Buffer.from(signature, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    fail('CURSOR_INVALID', 'cursor integrity check failed.');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    fail('CURSOR_INVALID', 'cursor payload is invalid.');
  }
  const bindingHash = sha256(stableJson(queryBinding(context, query)));
  if (payload?.bindingHash !== bindingHash) {
    fail('CURSOR_SCOPE_MISMATCH', 'cursor does not belong to this query scope.');
  }
  const position = payload?.position;
  if (!object(position) || !isoTimestamp(position.effectiveFrom) ||
      !isoTimestamp(position.createdAt) || !nonEmptyString(position.memoryId)) {
    fail('CURSOR_INVALID', 'cursor sort position is invalid.');
  }
  return position;
}

function compareRecords(left, right) {
  for (const [field, direction] of [['effectiveFrom', -1], ['createdAt', -1], ['memoryId', 1]]) {
    const a = String(left[field]);
    const b = String(right[field]);
    if (a < b) return -1 * direction;
    if (a > b) return 1 * direction;
  }
  return 0;
}

function effectiveAt(record, timestamp) {
  const instant = Date.parse(timestamp);
  return Date.parse(record.effectiveFrom) <= instant &&
    (record.effectiveTo === null || record.effectiveTo === undefined || instant < Date.parse(record.effectiveTo)) &&
    (record.expiresAt === null || record.expiresAt === undefined || instant < Date.parse(record.expiresAt));
}

function matchesQueryPolicy(record, query) {
  return record.ownerUserId === query.ownerUserId &&
    record.subjectEntityId === query.subjectEntityId &&
    record.predicate === query.predicate &&
    query.allowedStatuses.includes(record.status) &&
    (query.memoryType === null || record.memoryType === query.memoryType) &&
    allowedProvenanceForProvenancePolicy(query.provenancePolicy).includes(record.provenance) &&
    effectiveAt(record, query.effectiveAt) &&
    (query.readMode !== 'current' || ['user_confirmed', 'system_verified', 'not_required'].includes(record.confirmationStatus));
}

function applyVersionPolicy(records, query) {
  const childrenByParent = new Map();
  for (const record of records) {
    if (!record.supersedesId) continue;
    const children = childrenByParent.get(record.supersedesId) ?? [];
    children.push(record);
    childrenByParent.set(record.supersedesId, children);
  }
  for (const children of childrenByParent.values()) {
    if (children.length > 1) {
      fail('MEMORY_CONFLICT', 'Memory version chain has multiple current branches.');
    }
  }
  const supersededIds = new Set([...childrenByParent.keys()]);
  return records.filter((record) => {
    if (supersededIds.has(record.memoryId)) return false;
    if (query.readMode === 'current' && record.supersededById) return false;
    return true;
  });
}

function resultItem(record, query) {
  return Object.freeze({
    ...structuredClone(record),
    provenance: Object.freeze({
      policy: query.provenancePolicy,
      level: record.provenance,
      source: structuredClone(record.source)
    })
  });
}

export function validateMemoryQueryV2(query, { trustedOwnerUserId } = {}) {
  try {
    assertUnknownFields(query, QUERY_FIELDS, 'MemoryQueryV2');
    for (const field of QUERY_FIELDS) {
      if (!(field in query) || query[field] === undefined) fail('REQUIRED', `${field} is required.`);
    }
    if (query.schemaVersion !== 'v2') fail('UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be v2.');
    if (!nonEmptyString(trustedOwnerUserId)) fail('OWNER_SCOPE_REQUIRED', 'Trusted owner is required.');
    if (query.ownerUserId !== trustedOwnerUserId) fail('OWNER_SCOPE_MISMATCH', 'Query owner is outside trusted scope.');
    assertSubjectAndPredicate(query.subjectEntityId, query.predicate);
    if (!MEMORY_QUERY_V2_READ_MODES.includes(query.readMode)) fail('READ_MODE_INVALID', 'readMode is unsupported.');
    if (!isoTimestamp(query.effectiveAt)) fail('EFFECTIVE_AT_INVALID', 'effectiveAt must be an ISO timestamp.');
    normalizeStatuses(query.readMode, query.allowedStatuses);
    assertMemoryType(query.memoryType);
    normalizeLimit(query.limit);
    assertCursor(query.cursor);
    assertProvenancePolicy(query.provenancePolicy);
    return Object.freeze({ valid: true, errors: Object.freeze([]), warnings: Object.freeze([]) });
  } catch (error) {
    if (!(error instanceof MemoryQueryV2Error)) throw error;
    return Object.freeze({
      valid: false,
      errors: Object.freeze([Object.freeze({ path: '', code: error.code, message: error.message })]),
      warnings: Object.freeze([])
    });
  }
}

export function assertMemoryQueryV2(query, { trustedOwnerUserId } = {}) {
  const validation = validateMemoryQueryV2(query, { trustedOwnerUserId });
  if (!validation.valid) {
    const error = validation.errors[0];
    fail(error.code, error.message);
  }
  return query;
}

export function assertMemoryQueryV2ExecutionContext(context, query) {
  assertContext(context);
  assertMemoryQueryV2(query, { trustedOwnerUserId: context.ownerUserId });
  if (!nonEmptyString(context.repositoryGeneration)) {
    fail('REPOSITORY_GENERATION_REQUIRED', 'Trusted repositoryGeneration is required.');
  }
  const resolution = context.entityResolution;
  if (!object(resolution) || resolution.resolutionStatus !== 'exact') {
    fail('RESOLUTION_EXACT_REQUIRED', 'Repository query requires exact Entity resolution.');
  }
  const validation = validateEntityResolution(resolution, {
    trustedOwnerUserId: context.ownerUserId
  });
  if (!validation.valid) fail('RESOLUTION_INVALID', 'Entity resolution is invalid.');
  if (resolution.entityId !== query.subjectEntityId) {
    fail('ENTITY_SCOPE_MISMATCH', 'Repository query Entity differs from exact resolution.');
  }
  if (resolution.predicate !== null && resolution.predicate !== query.predicate) {
    fail('PREDICATE_SCOPE_MISMATCH', 'Repository query predicate differs from exact resolution.');
  }
  if (query.readMode === 'current' && query.effectiveAt !== context.now) {
    fail('EFFECTIVE_AT_NOT_TRUSTED', 'Current query time differs from trusted context.');
  }
  return true;
}

export function buildMemoryQueryV2(context, input) {
  assertContext(context);
  assertUnknownFields(input, QUERY_INPUT_FIELDS, 'query input');
  const resolution = context.entityResolution;
  if (!object(resolution) || resolution.resolutionStatus !== 'exact') {
    fail('RESOLUTION_EXACT_REQUIRED', 'Only exact Entity resolution may construct MemoryQueryV2.');
  }
  const resolutionValidation = validateEntityResolution(resolution, {
    trustedOwnerUserId: context.ownerUserId
  });
  if (!resolutionValidation.valid) {
    fail('RESOLUTION_INVALID', 'Entity resolution does not satisfy the frozen exact contract.');
  }
  assertSubjectAndPredicate(input.subjectEntityId, input.predicate);
  if (resolution.entityId !== input.subjectEntityId) {
    fail('ENTITY_SCOPE_MISMATCH', 'subjectEntityId must match exact Entity resolution.');
  }
  if (resolution.predicate !== null && resolution.predicate !== input.predicate) {
    fail('PREDICATE_SCOPE_MISMATCH', 'predicate must match exact Entity resolution.');
  }

  const readMode = input.readMode ?? 'current';
  if (!MEMORY_QUERY_V2_READ_MODES.includes(readMode)) fail('READ_MODE_INVALID', 'readMode is unsupported.');
  let effectiveAt;
  if (readMode === 'historical') {
    if (!isoTimestamp(input.effectiveAt)) {
      fail('EFFECTIVE_AT_REQUIRED', 'Historical reads require one explicit ISO effectiveAt.');
    }
    effectiveAt = input.effectiveAt;
  } else {
    if (input.effectiveAt !== undefined && input.effectiveAt !== context.now) {
      fail('EFFECTIVE_AT_NOT_TRUSTED', 'Current effectiveAt comes from trusted context.');
    }
    effectiveAt = context.now;
  }

  const provenancePolicy = input.provenancePolicy ?? 'trusted_v2';
  assertProvenancePolicy(provenancePolicy);
  assertCursor(input.cursor ?? null);
  const query = {
    schemaVersion: 'v2',
    ownerUserId: context.ownerUserId,
    subjectEntityId: input.subjectEntityId,
    predicate: input.predicate,
    effectiveAt,
    memoryType: input.memoryType ?? null,
    allowedStatuses: normalizeStatuses(readMode, input.allowedStatuses),
    limit: normalizeLimit(input.limit),
    cursor: input.cursor ?? null,
    provenancePolicy,
    readMode
  };
  assertMemoryQueryV2(query, { trustedOwnerUserId: context.ownerUserId });
  return freezeQuery(query);
}

export function allowedProvenanceForProvenancePolicy(policy) {
  assertProvenancePolicy(policy);
  return MEMORY_QUERY_V2_PROVENANCE_POLICIES[policy];
}

export function finalizeMemoryQueryV2Page(records, context, query) {
  assertMemoryQueryV2ExecutionContext(context, query);
  const scopedValidation = validateEntityScopedRecordSet(records, {
    trustedOwnerUserId: context.ownerUserId,
    subjectEntityId: query.subjectEntityId,
    predicate: query.predicate
  });
  if (!scopedValidation.valid) {
    fail('REPOSITORY_SCOPE_VIOLATION', scopedValidation.errors[0]?.message || 'Repository returned an invalid record set.');
  }
  const eligible = records.filter((record) => matchesQueryPolicy(record, query));
  const versioned = applyVersionPolicy(eligible, query).sort(compareRecords);
  const position = decodeCursor(context, query);
  let start = 0;
  if (position) {
    const index = versioned.findIndex((record) =>
      record.effectiveFrom === position.effectiveFrom &&
      record.createdAt === position.createdAt &&
      record.memoryId === position.memoryId
    );
    if (index < 0) fail('CURSOR_STALE', 'cursor position no longer exists in this query snapshot.');
    start = index + 1;
  }
  const selected = versioned.slice(start, start + query.limit);
  const hasMore = start + selected.length < versioned.length;
  return Object.freeze({
    items: Object.freeze(selected.map((record) => resultItem(record, query))),
    nextCursor: hasMore && selected.length > 0
      ? encodeCursor(context, query, selected[selected.length - 1])
      : null,
    scope: Object.freeze({
      ownerUserId: query.ownerUserId,
      subjectEntityId: query.subjectEntityId,
      predicate: query.predicate,
      effectiveAt: query.effectiveAt,
      readMode: query.readMode,
      sourceMode: 'v2',
      repositoryGeneration: context.repositoryGeneration
    })
  });
}
