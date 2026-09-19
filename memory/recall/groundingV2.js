import {
  allowedProvenanceForProvenancePolicy,
  assertMemoryQueryV2ExecutionContext
} from '../entity/memoryQueryV2.js';
import {
  ENTITY_ID_PATTERN,
  PREDICATE_STRUCTURED_VALUE_SCHEMAS
} from '../entity/contracts.js';
import { validateMemoryRecordV2 } from '../entity/validation.js';
import { buildRankingInputV2 } from './rankingV2.js';

const INPUT_FIELDS = Object.freeze([
  'schemaVersion',
  'ownerUserId',
  'subjectEntityId',
  'predicate',
  'queryPurpose',
  'effectiveAt',
  'readMode',
  'rankedMemoryIds',
  'expectedChecksums',
  'expectedProvenance',
  'expectedVersions',
  'queryFingerprint'
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UNSAFE_LEGACY_MAPPING_STATES = new Set([
  'suggested_review',
  'review_required',
  'unmappable',
  'relation_bucket'
]);

export const GROUNDING_V2_ERROR_CODES = Object.freeze({
  evidenceInvalid: 'EVIDENCE_INVALID',
  memoryConflict: 'MEMORY_CONFLICT'
});

export const GroundingInputV2 = Object.freeze({
  name: 'GroundingInputV2',
  schemaVersion: 'v2',
  fields: INPUT_FIELDS,
  required: INPUT_FIELDS,
  unknownFieldPolicy: 'reject',
  evidencePolicy: 'repository-reread-required'
});

export class GroundingV2Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GroundingV2Error';
    this.code = code;
  }
}

function fail(message, code = GROUNDING_V2_ERROR_CODES.evidenceInvalid) {
  throw new GroundingV2Error(code, message);
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

function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertExactFields(value, fields, label) {
  if (!object(value)) fail(`${label} must be an object.`);
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) fail(`Unknown ${label} field: ${unknown}.`);
  const missing = fields.find((field) => !(field in value) || value[field] === undefined);
  if (missing) fail(`${label}.${missing} is required.`);
}

function assertProvenance(value, index) {
  if (!object(value) || !nonEmptyString(value.policy) || !nonEmptyString(value.level) || !object(value.source) ||
      !nonEmptyString(value.source.type) || !nonEmptyString(value.source.id)) {
    fail(`GroundingInputV2 provenance at index ${index} is incomplete.`);
  }
}

function assertAlignedEvidence(input) {
  for (const field of ['rankedMemoryIds', 'expectedChecksums', 'expectedProvenance', 'expectedVersions']) {
    if (!Array.isArray(input[field])) fail(`GroundingInputV2.${field} must be an array.`);
  }
  const size = input.rankedMemoryIds.length;
  if (size === 0) fail('GroundingInputV2 requires at least one ranked memory.');
  if (new Set(input.rankedMemoryIds).size !== size) {
    fail('GroundingInputV2 rankedMemoryIds must be unique.');
  }
  if ([input.expectedChecksums, input.expectedProvenance, input.expectedVersions]
    .some((values) => values.length !== size)) {
    fail('GroundingInputV2 evidence arrays must be positionally aligned.');
  }
  input.rankedMemoryIds.forEach((memoryId, index) => {
    if (!nonEmptyString(memoryId) || !SHA256_PATTERN.test(String(input.expectedChecksums[index] ?? '')) ||
        !Number.isSafeInteger(input.expectedVersions[index]) || input.expectedVersions[index] < 1) {
      fail(`GroundingInputV2 evidence at index ${index} is invalid.`);
    }
    assertProvenance(input.expectedProvenance[index], index);
  });
}

export function assertGroundingInputV2(input, { trustedOwnerUserId } = {}) {
  assertExactFields(input, INPUT_FIELDS, 'GroundingInputV2');
  if (input.schemaVersion !== 'v2' || !nonEmptyString(trustedOwnerUserId) ||
      input.ownerUserId !== trustedOwnerUserId) {
    fail('GroundingInputV2 owner or schema is outside trusted scope.');
  }
  if (!ENTITY_ID_PATTERN.test(String(input.subjectEntityId ?? '')) ||
      !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, input.predicate) ||
      !nonEmptyString(input.queryPurpose) || !isoTimestamp(input.effectiveAt) ||
      !['current', 'historical'].includes(input.readMode) ||
      !SHA256_PATTERN.test(String(input.queryFingerprint ?? ''))) {
    fail('GroundingInputV2 query binding is invalid.');
  }
  assertAlignedEvidence(input);
  return input;
}

function assertRankingPermutation(rankingResult, candidateIds) {
  if (!object(rankingResult) || !object(rankingResult.rankingInput) ||
      !Array.isArray(rankingResult.rankedMemoryIds)) {
    fail('Grounding requires a RankingInputV2 and rankedMemoryIds.');
  }
  const rankedIds = rankingResult.rankedMemoryIds;
  if (rankedIds.length !== candidateIds.length || new Set(rankedIds).size !== rankedIds.length ||
      rankedIds.some((memoryId) => !candidateIds.includes(memoryId)) ||
      candidateIds.some((memoryId) => !rankedIds.includes(memoryId))) {
    fail('rankedMemoryIds must be an exact permutation of RankingInputV2 candidates.');
  }
}

export function buildGroundingInputV2({ context, query, page, rankingResult }) {
  try {
    assertMemoryQueryV2ExecutionContext(context, query);
    if (!object(page) || !Array.isArray(page.items)) fail('Grounding requires one Repository result page.');
    const purpose = rankingResult?.rankingInput?.queryPurpose;
    const rebuiltRankingInput = buildRankingInputV2({ context, query, page, queryPurpose: purpose });
    if (!sameValue(rebuiltRankingInput, rankingResult?.rankingInput)) {
      fail('RankingInputV2 no longer matches the exact Repository page or query fingerprint.');
    }
    assertRankingPermutation(rankingResult, rebuiltRankingInput.candidateMemoryIds);
    const candidates = new Map(page.items.map((candidate) => [candidate.memoryId, candidate]));
    const input = {
      schemaVersion: 'v2',
      ownerUserId: query.ownerUserId,
      subjectEntityId: query.subjectEntityId,
      predicate: query.predicate,
      queryPurpose: rebuiltRankingInput.queryPurpose,
      effectiveAt: query.effectiveAt,
      readMode: query.readMode,
      rankedMemoryIds: [...rankingResult.rankedMemoryIds],
      expectedChecksums: rankingResult.rankedMemoryIds.map((memoryId) => candidates.get(memoryId)?.checksum),
      expectedProvenance: rankingResult.rankedMemoryIds.map((memoryId) =>
        structuredClone(candidates.get(memoryId)?.provenance)),
      expectedVersions: rankingResult.rankedMemoryIds.map((memoryId) => candidates.get(memoryId)?.version),
      queryFingerprint: rebuiltRankingInput.queryFingerprint
    };
    assertGroundingInputV2(input, { trustedOwnerUserId: context.ownerUserId });
    return deepFreeze(input);
  } catch (error) {
    if (error instanceof GroundingV2Error) throw error;
    fail(`GroundingInputV2 rejected upstream evidence: ${error?.code ?? error?.message ?? 'invalid'}.`);
  }
}

function effectiveAt(record, timestamp) {
  const instant = Date.parse(timestamp);
  return Date.parse(record.effectiveFrom) <= instant &&
    (record.effectiveTo === null || record.effectiveTo === undefined || instant < Date.parse(record.effectiveTo)) &&
    (record.expiresAt === null || record.expiresAt === undefined || instant < Date.parse(record.expiresAt));
}

function assertLegacyEvidence(record, provenance) {
  const mappingState = provenance?.mappingState ?? record?.metadata?.legacyMappingState ?? null;
  const relationBucket = mappingState === 'relation_bucket' ||
    /^family:|^relation:/i.test(String(record?.legacySubject ?? ''));
  if (record.legacySubject === null || record.legacySubject === undefined) return;
  if (mappingState !== 'deterministic_mapped' || relationBucket ||
      UNSAFE_LEGACY_MAPPING_STATES.has(mappingState)) {
    fail(`Legacy evidence ${record.memoryId} lacks deterministic Entity mapping.`);
  }
}

function assertEvidenceRecord(record, input, query, index) {
  const memoryId = input.rankedMemoryIds[index];
  if (!object(record) || record.memoryId !== memoryId) fail(`Evidence ${memoryId} could not be reread.`);
  const validation = validateMemoryRecordV2(record, { trustedOwnerUserId: input.ownerUserId });
  if (!validation.valid) {
    fail(`Evidence ${memoryId} failed MemoryRecordV2 validation: ${validation.errors[0]?.code}.`);
  }
  if (record.ownerUserId !== input.ownerUserId ||
      record.subjectEntityId !== input.subjectEntityId ||
      record.predicate !== input.predicate) {
    fail(`Evidence ${memoryId} is outside owner, Entity, or predicate scope.`);
  }
  if (record.checksum !== input.expectedChecksums[index] ||
      record.version !== input.expectedVersions[index]) {
    fail(`Evidence ${memoryId} checksum or version changed after Ranking.`);
  }
  const provenance = input.expectedProvenance[index];
  assertProvenance(provenance, index);
  if (provenance.policy !== query.provenancePolicy || provenance.level !== record.provenance ||
      !sameValue(provenance.source, record.source) ||
      !allowedProvenanceForProvenancePolicy(query.provenancePolicy).includes(record.provenance)) {
    fail(`Evidence ${memoryId} provenance is missing, changed, or outside query policy.`);
  }
  assertLegacyEvidence(record, provenance);
  if (['deleted', 'archived', 'purged'].includes(record.status)) {
    fail(`Evidence ${memoryId} status is not groundable.`);
  }
  if (query.readMode === 'current' &&
      (record.status !== 'confirmed' || record.supersededById !== null && record.supersededById !== undefined)) {
    fail(`Current evidence ${memoryId} is not the latest confirmed version.`);
  }
  if (query.readMode === 'historical' && !['confirmed', 'superseded'].includes(record.status)) {
    fail(`Historical evidence ${memoryId} has an unsupported status.`);
  }
  if (!effectiveAt(record, query.effectiveAt)) {
    fail(`Evidence ${memoryId} is not effective at the requested instant.`);
  }
  if (record.conflictGroupId !== null && record.conflictGroupId !== undefined) {
    fail(`Evidence ${memoryId} belongs to an unresolved conflict.`, GROUNDING_V2_ERROR_CODES.memoryConflict);
  }
  return record;
}

function failureResult(code) {
  const conflict = code === GROUNDING_V2_ERROR_CODES.memoryConflict;
  return deepFreeze({
    grounded: false,
    errorCode: conflict ? GROUNDING_V2_ERROR_CODES.memoryConflict : GROUNDING_V2_ERROR_CODES.evidenceInvalid,
    safeUserMessage: conflict
      ? '这项记录存在不一致，请你确认哪一条是正确的。'
      : '这项记录目前无法确认。',
    clarificationRequired: conflict,
    governanceRequired: true
  });
}

function assertFreshRankingBinding(context, query, freshPage, originalRankingInput) {
  const fresh = buildRankingInputV2({
    context,
    query,
    page: freshPage,
    queryPurpose: originalRankingInput.queryPurpose
  });
  if (!sameValue(fresh, originalRankingInput)) {
    fail('Repository evidence or query fingerprint changed after Ranking.');
  }
}

export function groundRankedEvidenceV2({ context, query, page, rankingResult, repository }) {
  try {
    const input = buildGroundingInputV2({ context, query, page, rankingResult });
    if (!object(repository) || typeof repository.queryByEntityAndPredicate !== 'function' ||
        typeof repository.getById !== 'function') {
      fail('Grounding requires an exact MemoryRecordV2 Repository reread capability.');
    }
    const freshPage = repository.queryByEntityAndPredicate(context, query);
    assertFreshRankingBinding(context, query, freshPage, rankingResult.rankingInput);
    const records = input.rankedMemoryIds.map((memoryId, index) =>
      assertEvidenceRecord(repository.getById(input.ownerUserId, memoryId), input, query, index));
    const selected = records[0];
    const provenance = structuredClone(input.expectedProvenance[0]);
    return deepFreeze({
      grounded: true,
      ownerUserId: input.ownerUserId,
      subjectEntityId: input.subjectEntityId,
      predicate: input.predicate,
      selectedMemoryId: selected.memoryId,
      structuredValue: structuredClone(selected.structuredValue),
      checksum: selected.checksum,
      version: selected.version,
      provenance,
      source: structuredClone(selected.source),
      effectiveTime: {
        queriedAt: input.effectiveAt,
        effectiveFrom: selected.effectiveFrom,
        effectiveTo: selected.effectiveTo ?? null
      },
      evidenceMemoryIds: [...input.rankedMemoryIds],
      answerPolicy: {
        type: 'fact',
        readMode: input.readMode,
        historicalAt: input.readMode === 'historical' ? input.effectiveAt : null,
        immutable: true,
        queryFingerprint: input.queryFingerprint
      }
    });
  } catch (error) {
    return failureResult(error?.code);
  }
}
