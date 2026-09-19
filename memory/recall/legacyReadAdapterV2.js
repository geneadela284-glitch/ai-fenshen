import crypto from 'node:crypto';

import {
  ENTITY_ID_PATTERN,
  PREDICATE_STRUCTURED_VALUE_SCHEMAS
} from '../entity/contracts.js';
import {
  assertMemoryQueryV2ExecutionContext,
  finalizeMemoryQueryV2Page
} from '../entity/memoryQueryV2.js';
import { computeMemoryRecordV2Checksum } from '../entity/validation.js';

export const LEGACY_MAPPING_STATUSES = Object.freeze([
  'deterministic_mapped',
  'suggested_review',
  'review_required',
  'unmappable'
]);

export const LEGACY_BOUNDARY_ERROR_CODES = Object.freeze({
  resultInvalid: 'LEGACY_RESULT_INVALID',
  scopeViolation: 'LEGACY_SCOPE_VIOLATION',
  mappingUnsafe: 'LEGACY_MAPPING_UNSAFE'
});

const RESULT_FIELDS = Object.freeze([
  'legacyMemoryId',
  'ownerUserId',
  'mappedSubjectEntityId',
  'predicate',
  'structuredValue',
  'mappingStatus',
  'mappingEvidence',
  'adapterVersion',
  'source',
  'provenance',
  'checksum',
  'effectiveTime'
]);

const QUERY_FIELDS = Object.freeze([
  'ownerUserId',
  'subjectEntityId',
  'predicate',
  'effectiveAt',
  'readMode',
  'limit'
]);

const DETERMINISTIC_EVIDENCE_TYPES = new Set([
  'explicit_entity_binding',
  'stable_mapping_table'
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const LegacyAdapterResultV2 = Object.freeze({
  name: 'LegacyAdapterResultV2',
  schemaVersion: 'v2',
  fields: RESULT_FIELDS,
  required: RESULT_FIELDS,
  unknownFieldPolicy: 'reject',
  writePolicy: 'read-only'
});

export class LegacyBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LegacyBoundaryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LegacyBoundaryError(code, message);
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertExactFields(value, fields, code, label) {
  if (!object(value)) fail(code, `${label} must be an object.`);
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) fail(code, `Unknown ${label} field: ${unknown}.`);
  const missing = fields.find((field) => !(field in value) || value[field] === undefined);
  if (missing) fail(code, `${label}.${missing} is required.`);
}

function checksumInput(value) {
  return Object.fromEntries(RESULT_FIELDS
    .filter((field) => field !== 'checksum')
    .map((field) => [field, structuredClone(value?.[field])]));
}

export function computeLegacyAdapterResultChecksum(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(checksumInput(value))))
    .digest('hex');
}

function assertSource(value, label) {
  if (!object(value) || !nonEmptyString(value.type) || !nonEmptyString(value.id) ||
      Object.keys(value).some((field) => !['type', 'id'].includes(field))) {
    fail('LEGACY_RESULT_INVALID', `${label} must contain exact type and id fields.`);
  }
}

function assertMappingEvidence(value) {
  assertExactFields(
    value,
    ['type', 'subjectEntityId', 'evidenceIds'],
    'LEGACY_RESULT_INVALID',
    'mappingEvidence'
  );
  if (!nonEmptyString(value.type) || !Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0 ||
      value.evidenceIds.some((id) => !nonEmptyString(id))) {
    fail('LEGACY_RESULT_INVALID', 'mappingEvidence must include a type and non-empty evidence IDs.');
  }
  if (value.subjectEntityId !== null && !ENTITY_ID_PATTERN.test(String(value.subjectEntityId))) {
    fail('LEGACY_SCOPE_VIOLATION', 'mappingEvidence subject must be an opaque Entity ID or null.');
  }
}

function assertProvenance(value, result) {
  assertExactFields(
    value,
    ['sourceMode', 'source', 'mappingStatus', 'adapterVersion'],
    'LEGACY_RESULT_INVALID',
    'provenance'
  );
  assertSource(value.source, 'provenance.source');
  if (value.sourceMode !== 'legacy' || value.mappingStatus !== result.mappingStatus ||
      value.adapterVersion !== result.adapterVersion || !sameValue(value.source, result.source)) {
    fail('LEGACY_RESULT_INVALID', 'Legacy provenance is incomplete or inconsistent.');
  }
}

function assertEffectiveTime(value) {
  assertExactFields(
    value,
    ['effectiveFrom', 'effectiveTo'],
    'LEGACY_RESULT_INVALID',
    'effectiveTime'
  );
  if (!isoTimestamp(value.effectiveFrom) ||
      (value.effectiveTo !== null && !isoTimestamp(value.effectiveTo)) ||
      (value.effectiveTo !== null && Date.parse(value.effectiveTo) <= Date.parse(value.effectiveFrom))) {
    fail('LEGACY_RESULT_INVALID', 'Legacy effective time is invalid.');
  }
}

export function assertLegacyAdapterResultV2(result, {
  trustedOwnerUserId,
  subjectEntityId,
  predicate
} = {}) {
  assertExactFields(result, RESULT_FIELDS, 'LEGACY_RESULT_INVALID', 'LegacyAdapterResultV2');
  if (!nonEmptyString(result.legacyMemoryId) || !nonEmptyString(result.adapterVersion) ||
      !LEGACY_MAPPING_STATUSES.includes(result.mappingStatus) ||
      !object(result.structuredValue) || !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, result.predicate)) {
    fail('LEGACY_RESULT_INVALID', 'Legacy adapter result fields are invalid.');
  }
  if (!nonEmptyString(trustedOwnerUserId) || result.ownerUserId !== trustedOwnerUserId ||
      result.predicate !== predicate) {
    fail('LEGACY_SCOPE_VIOLATION', 'Legacy result is outside trusted owner or predicate scope.');
  }
  if (result.mappedSubjectEntityId !== null &&
      !ENTITY_ID_PATTERN.test(String(result.mappedSubjectEntityId))) {
    fail('LEGACY_SCOPE_VIOLATION', 'Legacy mapping must use an opaque Entity ID.');
  }
  if (result.mappedSubjectEntityId !== null && result.mappedSubjectEntityId !== subjectEntityId) {
    fail('LEGACY_SCOPE_VIOLATION', 'Legacy result is mapped to a different Entity.');
  }
  assertSource(result.source, 'source');
  assertMappingEvidence(result.mappingEvidence);
  assertProvenance(result.provenance, result);
  assertEffectiveTime(result.effectiveTime);
  if (!SHA256_PATTERN.test(String(result.checksum)) ||
      result.checksum !== computeLegacyAdapterResultChecksum(result)) {
    fail('LEGACY_RESULT_INVALID', 'Legacy result checksum is invalid.');
  }
  return result;
}

export function assertDeterministicLegacyResultV2(result, scope = {}) {
  assertLegacyAdapterResultV2(result, scope);
  if (result.mappingStatus !== 'deterministic_mapped' ||
      !ENTITY_ID_PATTERN.test(String(result.mappedSubjectEntityId)) ||
      result.mappingEvidence.subjectEntityId !== result.mappedSubjectEntityId ||
      !DETERMINISTIC_EVIDENCE_TYPES.has(result.mappingEvidence.type)) {
    fail('LEGACY_MAPPING_UNSAFE', 'Legacy result lacks deterministic Entity mapping evidence.');
  }
  return result;
}

function assertQueryScope(context, query) {
  assertExactFields(query, QUERY_FIELDS, 'LEGACY_SCOPE_VIOLATION', 'Legacy query');
  if (!object(context) || !nonEmptyString(context.ownerUserId) ||
      query.ownerUserId !== context.ownerUserId ||
      !ENTITY_ID_PATTERN.test(String(query.subjectEntityId)) ||
      !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, query.predicate) ||
      !isoTimestamp(query.effectiveAt) || !['current', 'historical'].includes(query.readMode) ||
      !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) {
    fail('LEGACY_SCOPE_VIOLATION', 'Legacy query scope is invalid.');
  }
}

export function createLegacyReadAdapterV2({ queryExact } = {}) {
  if (typeof queryExact !== 'function') {
    fail('LEGACY_RESULT_INVALID', 'Legacy adapter requires one exact read function.');
  }
  return Object.freeze({
    query(context, query) {
      assertQueryScope(context, query);
      const scope = deepFreeze({
        ownerUserId: query.ownerUserId,
        subjectEntityId: query.subjectEntityId,
        predicate: query.predicate,
        effectiveAt: query.effectiveAt,
        readMode: query.readMode,
        limit: query.limit
      });
      const results = queryExact(scope);
      if (!Array.isArray(results)) {
        fail('LEGACY_RESULT_INVALID', 'Legacy exact query must return an array.');
      }
      return deepFreeze(results.map((result) => {
        assertLegacyAdapterResultV2(result, {
          trustedOwnerUserId: context.ownerUserId,
          subjectEntityId: query.subjectEntityId,
          predicate: query.predicate
        });
        return structuredClone(result);
      }));
    }
  });
}

function legacyQuery(query) {
  return {
    ownerUserId: query.ownerUserId,
    subjectEntityId: query.subjectEntityId,
    predicate: query.predicate,
    effectiveAt: query.effectiveAt,
    readMode: query.readMode,
    limit: query.limit
  };
}

function evidenceMemoryId(result) {
  return `legacy:${result.adapterVersion}:${result.legacyMemoryId}`;
}

function toEvidenceRecord(result, query) {
  const effectiveFrom = result.effectiveTime.effectiveFrom;
  const record = {
    memoryId: evidenceMemoryId(result),
    schemaVersion: 'v2',
    ownerUserId: result.ownerUserId,
    memoryType: query.memoryType ?? 'fact',
    subjectEntityId: result.mappedSubjectEntityId,
    predicate: result.predicate,
    structuredValue: structuredClone(result.structuredValue),
    displayValue: null,
    legacySubject: `legacy:${result.legacyMemoryId}`,
    source: structuredClone(result.source),
    provenance: result.source.type === 'user_confirmed'
      ? 'user_confirmed'
      : result.source.type === 'system_verified'
        ? 'system_verified'
        : 'imported_unverified',
    sourceTimestamp: effectiveFrom,
    createdAt: effectiveFrom,
    updatedAt: effectiveFrom,
    effectiveFrom,
    effectiveTo: result.effectiveTime.effectiveTo,
    confidence: 1,
    importance: 0.5,
    sensitivity: 'low',
    status: 'confirmed',
    confirmationStatus: result.source.type === 'user_confirmed' ? 'user_confirmed' : 'system_verified',
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: {},
    accessPolicy: {},
    checksum: '',
    tags: [],
    metadata: {
      legacyMemoryId: result.legacyMemoryId,
      legacyAdapterVersion: result.adapterVersion,
      legacyAdapterChecksum: result.checksum,
      legacyMappingStatus: result.mappingStatus,
      legacyMappingEvidence: structuredClone(result.mappingEvidence)
    }
  };
  record.checksum = computeMemoryRecordV2Checksum(record);
  return record;
}

function enrichedProvenance(result, query) {
  return {
    policy: query.provenancePolicy,
    level: result.source.type === 'user_confirmed'
      ? 'user_confirmed'
      : result.source.type === 'system_verified'
        ? 'system_verified'
        : 'imported_unverified',
    source: structuredClone(result.source),
    sourceMode: 'legacy',
    mappingState: result.mappingStatus,
    mappingEvidence: structuredClone(result.mappingEvidence),
    adapterVersion: result.adapterVersion,
    legacyMemoryId: result.legacyMemoryId,
    legacyChecksum: result.checksum
  };
}

export function buildLegacyEvidencePageV2({ context, query, legacyResults }) {
  assertMemoryQueryV2ExecutionContext(context, query);
  if (!Array.isArray(legacyResults)) {
    fail('LEGACY_RESULT_INVALID', 'Legacy evidence page requires an array.');
  }
  const scope = {
    trustedOwnerUserId: context.ownerUserId,
    subjectEntityId: query.subjectEntityId,
    predicate: query.predicate
  };
  const deterministic = legacyResults.map((result) => {
    assertDeterministicLegacyResultV2(result, scope);
    return result;
  });
  const resultsByMemoryId = new Map(deterministic.map((result) => [evidenceMemoryId(result), result]));
  const page = finalizeMemoryQueryV2Page(
    deterministic.map((result) => toEvidenceRecord(result, query)),
    context,
    query
  );
  return deepFreeze({
    items: page.items.map((candidate) => ({
      ...structuredClone(candidate),
      provenance: enrichedProvenance(resultsByMemoryId.get(candidate.memoryId), query)
    })),
    nextCursor: page.nextCursor,
    scope: {
      ...structuredClone(page.scope),
      sourceMode: 'legacy'
    }
  });
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function recordFromCandidate(candidate) {
  const record = structuredClone(candidate);
  const level = record.provenance?.level;
  delete record.provenance;
  record.provenance = level;
  return record;
}

export function createLegacyEvidenceRepositoryV2({ context, query, legacyAdapter } = {}) {
  assertMemoryQueryV2ExecutionContext(context, query);
  if (!legacyAdapter || typeof legacyAdapter.query !== 'function') {
    fail('LEGACY_RESULT_INVALID', 'Legacy evidence repository requires a read-only adapter.');
  }
  const binding = stableJson({ context, query });
  let recordsById = new Map();
  function read(actualContext, actualQuery) {
    assertMemoryQueryV2ExecutionContext(actualContext, actualQuery);
    if (stableJson({ context: actualContext, query: actualQuery }) !== binding) {
      fail('LEGACY_SCOPE_VIOLATION', 'Legacy evidence repository scope changed.');
    }
    const page = buildLegacyEvidencePageV2({
      context: actualContext,
      query: actualQuery,
      legacyResults: legacyAdapter.query(actualContext, legacyQuery(actualQuery))
    });
    recordsById = new Map(page.items.map((candidate) => [
      candidate.memoryId,
      recordFromCandidate(candidate)
    ]));
    return page;
  }
  return Object.freeze({
    queryByEntityAndPredicate: read,
    getById(ownerUserId, memoryId) {
      if (ownerUserId !== context.ownerUserId || !nonEmptyString(memoryId)) return null;
      const value = recordsById.get(memoryId);
      return value ? deepFreeze(structuredClone(value)) : null;
    }
  });
}
