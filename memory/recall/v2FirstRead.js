import { assertMemoryQueryV2ExecutionContext } from '../entity/memoryQueryV2.js';
import {
  LegacyBoundaryError,
  createLegacyEvidenceRepositoryV2
} from './legacyReadAdapterV2.js';
import { groundRankedEvidenceV2 } from './groundingV2.js';
import { rankScopedMemoryCandidatesV2 } from './rankingV2.js';
import { buildSafeAnswerV2 } from './safeAnswerV2.js';

export const V2_FIRST_READ_ERROR_CODES = Object.freeze({
  memoryConflict: 'MEMORY_CONFLICT',
  evidenceInvalid: 'EVIDENCE_INVALID',
  legacyMappingUnsafe: 'LEGACY_MAPPING_UNSAFE'
});

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function failedGrounding(errorCode) {
  const conflict = errorCode === V2_FIRST_READ_ERROR_CODES.memoryConflict;
  return deepFreeze({
    grounded: false,
    errorCode: conflict ? 'MEMORY_CONFLICT' : 'EVIDENCE_INVALID',
    safeUserMessage: conflict
      ? '这项记录存在不一致，请你确认哪一条是正确的。'
      : '这项记录目前无法确认。',
    clarificationRequired: conflict,
    governanceRequired: true
  });
}

function emptyResult(query, v2Presence) {
  return deepFreeze({
    outcome: 'not_found',
    sourceMode: 'none',
    errorCode: null,
    v2Presence,
    page: null,
    rankingResult: null,
    groundingResult: null,
    safeAnswer: buildSafeAnswerV2({ type: 'not_found', query })
  });
}

function failureResult(query, v2Presence, sourceMode, errorCode) {
  const conflict = errorCode === V2_FIRST_READ_ERROR_CODES.memoryConflict;
  const groundingResult = failedGrounding(errorCode);
  return deepFreeze({
    outcome: conflict ? 'conflict' : 'evidence_invalid',
    sourceMode,
    errorCode,
    v2Presence,
    page: null,
    rankingResult: null,
    groundingResult,
    safeAnswer: buildSafeAnswerV2({
      type: conflict ? 'conflict' : 'evidence_invalid',
      groundingResult,
      scope: query
    })
  });
}

function factResult({ context, query, repository, page, v2Presence, sourceMode, queryPurpose, ranker }) {
  const rankingResult = rankScopedMemoryCandidatesV2({
    context,
    query,
    page,
    queryPurpose,
    ranker
  });
  const groundingResult = groundRankedEvidenceV2({
    context,
    query,
    page,
    rankingResult,
    repository
  });
  if (!groundingResult.grounded) {
    const errorCode = groundingResult.errorCode ?? V2_FIRST_READ_ERROR_CODES.evidenceInvalid;
    return deepFreeze({
      outcome: errorCode === 'MEMORY_CONFLICT' ? 'conflict' : 'evidence_invalid',
      sourceMode,
      errorCode,
      v2Presence,
      page,
      rankingResult,
      groundingResult,
      safeAnswer: buildSafeAnswerV2({
        type: errorCode === 'MEMORY_CONFLICT' ? 'conflict' : 'evidence_invalid',
        groundingResult,
        scope: query
      })
    });
  }
  return deepFreeze({
    outcome: 'fact',
    sourceMode,
    errorCode: null,
    v2Presence,
    page,
    rankingResult,
    groundingResult,
    safeAnswer: buildSafeAnswerV2({ type: 'fact', groundingResult })
  });
}

export function reconcileV2AndLegacyFacts(v2Records, legacyRecords) {
  if (!Array.isArray(v2Records) || !Array.isArray(legacyRecords)) {
    throw new TypeError('V2 and Legacy records must be arrays.');
  }
  if (v2Records.length === 0) {
    return { outcome: 'use_legacy', records: legacyRecords, errorCode: null };
  }
  if (legacyRecords.length === 0 || legacyRecords.every((legacy) =>
    v2Records.some((v2) => sameValue(v2.structuredValue, legacy.structuredValue)))) {
    return { outcome: 'use_v2', records: v2Records, errorCode: null };
  }
  return { outcome: 'conflict', records: [], errorCode: 'MEMORY_CONFLICT' };
}

export function executeV2FirstRead({
  context,
  query,
  v2Repository,
  legacyAdapter,
  queryPurpose,
  ranker
} = {}) {
  assertMemoryQueryV2ExecutionContext(context, query);
  if (!v2Repository || typeof v2Repository.queryByEntityAndPredicate !== 'function' ||
      typeof v2Repository.inspectPresenceByEntityAndPredicate !== 'function' ||
      typeof v2Repository.getById !== 'function') {
    return failureResult(query, null, 'none', 'EVIDENCE_INVALID');
  }

  const v2Page = v2Repository.queryByEntityAndPredicate(context, query);
  const v2Presence = v2Repository.inspectPresenceByEntityAndPredicate(context, query);
  if (v2Presence.reasons.includes('unresolved_conflict')) {
    return failureResult(query, v2Presence, 'v2', 'MEMORY_CONFLICT');
  }
  if (v2Page.items.length > 0) {
    return factResult({
      context,
      query,
      repository: v2Repository,
      page: v2Page,
      v2Presence,
      sourceMode: 'v2',
      queryPurpose,
      ranker
    });
  }
  if (v2Presence.suppressLegacy) return emptyResult(query, v2Presence);
  if (!legacyAdapter || typeof legacyAdapter.query !== 'function') return emptyResult(query, v2Presence);

  try {
    const repository = createLegacyEvidenceRepositoryV2({ context, query, legacyAdapter });
    const page = repository.queryByEntityAndPredicate(context, query);
    if (page.items.length === 0) return emptyResult(query, v2Presence);
    return factResult({
      context,
      query,
      repository,
      page,
      v2Presence,
      sourceMode: 'legacy',
      queryPurpose,
      ranker
    });
  } catch (error) {
    const errorCode = error instanceof LegacyBoundaryError
      ? error.code
      : error?.code ?? 'EVIDENCE_INVALID';
    return failureResult(query, v2Presence, 'legacy', errorCode);
  }
}
