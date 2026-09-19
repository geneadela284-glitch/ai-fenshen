import crypto from 'node:crypto';

import {
  assertMemoryQueryV2ExecutionContext,
  allowedProvenanceForProvenancePolicy
} from '../entity/memoryQueryV2.js';
import {
  ENTITY_ID_PATTERN,
  PREDICATE_STRUCTURED_VALUE_SCHEMAS
} from '../entity/contracts.js';
import { validateMemoryRecordV2 } from '../entity/validation.js';

const INPUT_FIELDS = Object.freeze([
  'schemaVersion',
  'ownerUserId',
  'subjectEntityId',
  'predicate',
  'queryPurpose',
  'effectiveAt',
  'candidateMemoryIds',
  'candidateChecksums',
  'candidateProvenance',
  'candidateStatuses',
  'queryFingerprint'
]);

const OUTPUT_FIELDS = Object.freeze([
  'memoryId',
  'ownerUserId',
  'subjectEntityId',
  'predicate',
  'checksum',
  'provenance',
  'reasonCodes'
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UNSAFE_LEGACY_MAPPING_STATES = new Set([
  'suggested_review',
  'review_required',
  'unmappable',
  'relation_bucket'
]);

export const RANKING_V2_ERROR_CODES = Object.freeze({
  scopeViolation: 'RANKING_SCOPE_VIOLATION',
  inputEmpty: 'RANKING_INPUT_EMPTY',
  candidateDuplicate: 'RANKING_CANDIDATE_DUPLICATE',
  outputMismatch: 'RANKING_OUTPUT_MISMATCH',
  evidenceInvalid: 'EVIDENCE_INVALID',
  legacyMappingUnsafe: 'LEGACY_MAPPING_UNSAFE'
});

export const RankingInputV2 = Object.freeze({
  name: 'RankingInputV2',
  schemaVersion: 'v2',
  fields: INPUT_FIELDS,
  required: INPUT_FIELDS,
  unknownFieldPolicy: 'reject',
  candidatePolicy: 'single-repository-result-page-only',
  emptyCandidatePolicy: 'reject'
});

export class RankingV2Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RankingV2Error';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RankingV2Error(code, message);
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

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function frozenClone(value) {
  return deepFreeze(structuredClone(value));
}

function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function assertExactFields(value, fields, code, label) {
  if (!object(value)) fail(code, `${label} must be an object.`);
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) fail(code, `Unknown ${label} field: ${unknown}.`);
  const missing = fields.find((field) => !(field in value) || value[field] === undefined);
  if (missing) fail(code, `${label}.${missing} is required.`);
}

function assertAlignedCandidateArrays(input) {
  for (const field of ['candidateMemoryIds', 'candidateChecksums', 'candidateProvenance', 'candidateStatuses']) {
    if (!Array.isArray(input[field])) fail('RANKING_SCOPE_VIOLATION', `${field} must be an array.`);
  }
  const size = input.candidateMemoryIds.length;
  if (size === 0) fail('RANKING_INPUT_EMPTY', 'RankingInputV2 requires at least one candidate.');
  if ([input.candidateChecksums, input.candidateProvenance, input.candidateStatuses].some((values) => values.length !== size)) {
    fail('RANKING_SCOPE_VIOLATION', 'RankingInputV2 candidate evidence arrays must be positionally aligned.');
  }
  if (new Set(input.candidateMemoryIds).size !== size) {
    fail('RANKING_CANDIDATE_DUPLICATE', 'RankingInputV2 candidateMemoryIds must be unique.');
  }
}

function assertProvenance(provenance, query, record) {
  if (!object(provenance) || !object(provenance.source) ||
      !nonEmptyString(provenance.level) || !nonEmptyString(provenance.source.type) ||
      !nonEmptyString(provenance.source.id)) {
    fail('EVIDENCE_INVALID', `Candidate ${record.memoryId} has incomplete provenance.`);
  }
  if (provenance.policy !== query.provenancePolicy || provenance.level !== record.provenance ||
      !sameValue(provenance.source, record.source)) {
    fail('EVIDENCE_INVALID', `Candidate ${record.memoryId} provenance does not match Repository evidence.`);
  }
  if (!allowedProvenanceForProvenancePolicy(query.provenancePolicy).includes(record.provenance)) {
    fail('EVIDENCE_INVALID', `Candidate ${record.memoryId} provenance is outside query policy.`);
  }
}

function assertLegacyBoundary(record, provenance, sourceMode) {
  const mappingState = provenance?.mappingState ?? null;
  const legacy = sourceMode === 'legacy' || provenance?.sourceMode === 'legacy' || record?.legacySubject !== null;
  const relationBucket = mappingState === 'relation_bucket' || /^family:|^relation:/i.test(String(record?.legacySubject ?? ''));
  if (!legacy && !relationBucket) return;
  if (mappingState !== 'deterministic_mapped' || relationBucket || UNSAFE_LEGACY_MAPPING_STATES.has(mappingState)) {
    fail('LEGACY_MAPPING_UNSAFE', `Candidate ${record?.memoryId ?? ''} lacks deterministic Legacy Entity mapping.`);
  }
}

function assertEffective(record, effectiveAt) {
  const instant = Date.parse(effectiveAt);
  return Date.parse(record.effectiveFrom) <= instant &&
    (record.effectiveTo === null || record.effectiveTo === undefined || instant < Date.parse(record.effectiveTo)) &&
    (record.expiresAt === null || record.expiresAt === undefined || instant < Date.parse(record.expiresAt));
}

function recordWithoutRankingProvenance(candidate) {
  const record = structuredClone(candidate);
  const level = record.provenance?.level;
  delete record.provenance;
  record.provenance = level;
  return record;
}

function assertRepositoryPageScope(context, query, page) {
  try {
    assertMemoryQueryV2ExecutionContext(context, query);
  } catch (error) {
    fail('RANKING_SCOPE_VIOLATION', `Ranking requires one valid exact MemoryQueryV2 scope: ${error.message}`);
  }
  if (!object(page) || !Array.isArray(page.items) || !object(page.scope)) {
    fail('RANKING_SCOPE_VIOLATION', 'Ranking requires one Repository result page.');
  }
  const expected = {
    ownerUserId: query.ownerUserId,
    subjectEntityId: query.subjectEntityId,
    predicate: query.predicate,
    effectiveAt: query.effectiveAt,
    readMode: query.readMode,
    repositoryGeneration: context.repositoryGeneration
  };
  for (const [field, value] of Object.entries(expected)) {
    if (page.scope[field] !== value) {
      fail('RANKING_SCOPE_VIOLATION', `Repository page ${field} differs from MemoryQueryV2.`);
    }
  }
}

function validateCandidateSet(context, query, page) {
  assertRepositoryPageScope(context, query, page);
  if (page.items.length === 0) fail('RANKING_INPUT_EMPTY', 'Empty Repository results must not invoke Ranking.');
  const ids = page.items.map((candidate) => candidate?.memoryId);
  if (ids.some((memoryId) => !nonEmptyString(memoryId))) {
    fail('EVIDENCE_INVALID', 'Every Ranking candidate requires a memoryId.');
  }
  if (new Set(ids).size !== ids.length) {
    fail('RANKING_CANDIDATE_DUPLICATE', 'Repository result contains a duplicate memoryId.');
  }

  for (const candidate of page.items) {
    assertLegacyBoundary(candidate, candidate?.provenance, page.scope.sourceMode);
    if (!object(candidate?.provenance)) {
      fail('EVIDENCE_INVALID', `Candidate ${candidate.memoryId} has no provenance.`);
    }
    const record = recordWithoutRankingProvenance(candidate);
    if (record.ownerUserId !== query.ownerUserId ||
        record.subjectEntityId !== query.subjectEntityId ||
        record.predicate !== query.predicate) {
      fail('RANKING_SCOPE_VIOLATION', `Candidate ${record.memoryId} is outside owner, Entity, or predicate scope.`);
    }
    const validation = validateMemoryRecordV2(record, { trustedOwnerUserId: context.ownerUserId });
    if (!validation.valid) {
      fail('EVIDENCE_INVALID', `Candidate ${candidate.memoryId} failed evidence validation: ${validation.errors[0]?.code}.`);
    }
    assertProvenance(candidate.provenance, query, record);
    const historicalSuperseded = query.readMode === 'historical' && record.status === 'superseded';
    if (!query.allowedStatuses.includes(record.status) ||
        ['deleted', 'archived', 'purged'].includes(record.status) ||
        (record.status === 'superseded' && !historicalSuperseded)) {
      fail('RANKING_SCOPE_VIOLATION', `Candidate ${record.memoryId} status is not rankable.`);
    }
    if (!assertEffective(record, query.effectiveAt)) {
      fail('RANKING_SCOPE_VIOLATION', `Candidate ${record.memoryId} is not effective at query time.`);
    }
    if (query.readMode === 'current' &&
        record.supersededById !== null && record.supersededById !== undefined) {
      fail('RANKING_SCOPE_VIOLATION', `Candidate ${record.memoryId} has been superseded.`);
    }
    if (record.conflictGroupId !== null && record.conflictGroupId !== undefined) {
      fail('RANKING_SCOPE_VIOLATION', `Candidate ${record.memoryId} has an unresolved conflict.`);
    }
  }
  return true;
}

function fingerprintBinding(context, query, queryPurpose, page) {
  return {
    contract: 'ranking-input-v2',
    ownerUserId: query.ownerUserId,
    subjectEntityId: query.subjectEntityId,
    predicate: query.predicate,
    queryPurpose,
    effectiveAt: query.effectiveAt,
    memoryType: query.memoryType,
    allowedStatuses: query.allowedStatuses,
    provenancePolicy: query.provenancePolicy,
    readMode: query.readMode,
    repositoryGeneration: context.repositoryGeneration,
    candidates: page.items.map((candidate) => ({
      memoryId: candidate.memoryId,
      checksum: candidate.checksum,
      provenance: candidate.provenance,
      status: candidate.status
    }))
  };
}

export function assertRankingInputV2(input, { trustedOwnerUserId } = {}) {
  assertExactFields(input, INPUT_FIELDS, 'RANKING_SCOPE_VIOLATION', 'RankingInputV2');
  if (input.schemaVersion !== 'v2' || !nonEmptyString(trustedOwnerUserId) || input.ownerUserId !== trustedOwnerUserId) {
    fail('RANKING_SCOPE_VIOLATION', 'RankingInputV2 owner or schema is outside trusted scope.');
  }
  if (!ENTITY_ID_PATTERN.test(String(input.subjectEntityId ?? '')) ||
      !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, input.predicate) ||
      !nonEmptyString(input.queryPurpose) || !isoTimestamp(input.effectiveAt) ||
      !SHA256_PATTERN.test(String(input.queryFingerprint ?? ''))) {
    fail('RANKING_SCOPE_VIOLATION', 'RankingInputV2 query binding is invalid.');
  }
  assertAlignedCandidateArrays(input);
  input.candidateMemoryIds.forEach((memoryId, index) => {
    const provenance = input.candidateProvenance[index];
    if (!nonEmptyString(memoryId) || !SHA256_PATTERN.test(String(input.candidateChecksums[index] ?? '')) ||
        !nonEmptyString(input.candidateStatuses[index]) || !object(provenance) ||
        !nonEmptyString(provenance.policy) || !nonEmptyString(provenance.level) || !object(provenance.source) ||
        !nonEmptyString(provenance.source.type) || !nonEmptyString(provenance.source.id)) {
      fail('EVIDENCE_INVALID', `RankingInputV2 candidate evidence at index ${index} is invalid.`);
    }
  });
  return input;
}

export function buildRankingInputV2({ context, query, page, queryPurpose }) {
  if (!nonEmptyString(queryPurpose)) fail('RANKING_SCOPE_VIOLATION', 'queryPurpose is required.');
  validateCandidateSet(context, query, page);
  const input = {
    schemaVersion: 'v2',
    ownerUserId: query.ownerUserId,
    subjectEntityId: query.subjectEntityId,
    predicate: query.predicate,
    queryPurpose,
    effectiveAt: query.effectiveAt,
    candidateMemoryIds: page.items.map((candidate) => candidate.memoryId),
    candidateChecksums: page.items.map((candidate) => candidate.checksum),
    candidateProvenance: page.items.map((candidate) => structuredClone(candidate.provenance)),
    candidateStatuses: page.items.map((candidate) => candidate.status),
    queryFingerprint: sha256(stableJson(fingerprintBinding(context, query, queryPurpose, page)))
  };
  assertRankingInputV2(input, { trustedOwnerUserId: context.ownerUserId });
  return deepFreeze(input);
}

export function verifyRankingOutputV2(output, input, candidates) {
  if (!Array.isArray(output) || output.length !== candidates.length) {
    fail('RANKING_OUTPUT_MISMATCH', 'Ranking output count must equal input count.');
  }
  const byId = new Map(candidates.map((candidate) => [candidate.memoryId, candidate]));
  const outputIds = output.map((item) => item?.memoryId);
  if (new Set(outputIds).size !== outputIds.length ||
      outputIds.some((memoryId) => !byId.has(memoryId)) ||
      input.candidateMemoryIds.some((memoryId) => !outputIds.includes(memoryId))) {
    fail('RANKING_OUTPUT_MISMATCH', 'Ranking output must be a permutation of candidateMemoryIds.');
  }
  for (const item of output) {
    assertExactFields(item, OUTPUT_FIELDS, 'RANKING_OUTPUT_MISMATCH', 'Ranking output item');
    const original = byId.get(item.memoryId);
    if (item.ownerUserId !== input.ownerUserId || item.ownerUserId !== original.ownerUserId ||
        item.subjectEntityId !== input.subjectEntityId || item.subjectEntityId !== original.subjectEntityId ||
        item.predicate !== input.predicate || item.predicate !== original.predicate ||
        item.checksum !== original.checksum || !sameValue(item.provenance, original.provenance)) {
      fail('RANKING_OUTPUT_MISMATCH', `Ranking changed scope or evidence for ${item.memoryId}.`);
    }
    if (!Array.isArray(item.reasonCodes) || item.reasonCodes.length === 0 ||
        item.reasonCodes.some((code) => !nonEmptyString(code)) ||
        new Set(item.reasonCodes).size !== item.reasonCodes.length) {
      fail('RANKING_OUTPUT_MISMATCH', `Ranking reason codes are invalid for ${item.memoryId}.`);
    }
  }
  return true;
}

export function rankScopedMemoryCandidatesV2({ context, query, page, queryPurpose, ranker }) {
  const input = buildRankingInputV2({ context, query, page, queryPurpose });
  const candidates = frozenClone(page.items);
  const rank = typeof ranker === 'function' ? ranker : ranker?.rank?.bind(ranker);
  if (typeof rank !== 'function') fail('RANKING_SCOPE_VIOLATION', 'A scoped Ranking implementation is required.');
  const output = rank(deepFreeze({ input, candidates }));
  verifyRankingOutputV2(output, input, candidates);
  const reasonCodesByMemoryId = Object.fromEntries(output.map((item) => [
    item.memoryId,
    Object.freeze([...item.reasonCodes])
  ]));
  return deepFreeze({
    rankingInput: input,
    rankedMemoryIds: output.map((item) => item.memoryId),
    reasonCodesByMemoryId
  });
}
