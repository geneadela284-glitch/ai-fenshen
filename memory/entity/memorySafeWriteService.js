import {
  ENTITY_MODEL_SCHEMA_VERSION,
  MEMORY_DECISION_TYPES,
  PREDICATE_STRUCTURED_VALUE_SCHEMAS
} from './contracts.js';
import { validateMemoryDecision } from './memoryDecisionPolicy.js';

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} is required.`);
  return value;
}

function exactResolution(ownerUserId, resolution) {
  return resolution?.resolutionStatus === 'exact' &&
    resolution.ownerUserId === ownerUserId &&
    typeof resolution.entityId === 'string';
}

function resolutionContract(resolution, predicate) {
  const relationEvidence = resolution.evidence?.find((item) => item.type === 'effective_relation') ?? null;
  return {
    schemaVersion: ENTITY_MODEL_SCHEMA_VERSION,
    resolutionStatus: 'exact',
    ownerUserId: resolution.ownerUserId,
    entityType: resolution.entityType,
    entityId: resolution.entityId,
    relationKind: relationEvidence?.relationKind ?? null,
    role: relationEvidence?.role ?? null,
    predicate,
    candidateEntityIds: [],
    sourceRelationIds: relationEvidence?.relationId ? [relationEvidence.relationId] : [],
    resolutionReason: resolution.resolutionMethod,
    policyVersion: 'memory-capture-orchestration-v1',
    resolvedAt: resolution.resolvedAt
  };
}

export function createMemoryDuplicateConflictInspector({ memories, now = () => new Date().toISOString() }) {
  if (!memories || typeof memories.queryByEntityAndPredicate !== 'function') {
    throw new TypeError('Memory duplicate/conflict inspector requires MemoryRecordV2 Repository.');
  }
  return Object.freeze({
    async inspect({ ownerUserId, subjectEntityId, predicate, suggestedStructuredValue }) {
      if (!ownerUserId || !subjectEntityId || !predicate || suggestedStructuredValue == null) {
        return immutable({ conflictStatus: 'unknown', duplicateStatus: 'unknown', matchingMemoryIds: [] });
      }
      const records = memories.queryByEntityAndPredicate(ownerUserId, subjectEntityId, predicate, { status: 'confirmed' })
        .filter((record) => record.effectiveTo === null || Date.parse(now()) < Date.parse(record.effectiveTo));
      const exact = records.filter((record) => sameValue(record.structuredValue, suggestedStructuredValue));
      if (exact.length) {
        return immutable({
          conflictStatus: 'none', duplicateStatus: 'exact',
          matchingMemoryIds: exact.map((record) => record.memoryId)
        });
      }
      if (records.length) {
        return immutable({
          conflictStatus: 'conflict', duplicateStatus: 'none',
          matchingMemoryIds: records.map((record) => record.memoryId)
        });
      }
      return immutable({ conflictStatus: 'none', duplicateStatus: 'none', matchingMemoryIds: [] });
    }
  });
}

function memoryCandidate({ decision, resolution, memoryId, now, confirmationStatus, correction, sourceMessageId }) {
  const trustedSourceMessageId = typeof sourceMessageId === 'string' && sourceMessageId.trim()
    ? sourceMessageId.trim()
    : null;
  return {
    memoryId,
    schemaVersion: ENTITY_MODEL_SCHEMA_VERSION,
    ownerUserId: decision.ownerUserId,
    memoryType: decision.memoryType,
    subjectEntityId: decision.subjectEntityId,
    predicate: decision.predicate,
    structuredValue: structuredClone(decision.suggestedStructuredValue),
    displayValue: null,
    legacySubject: null,
    source: trustedSourceMessageId
      ? { type: 'conversation_message', id: trustedSourceMessageId }
      : { type: 'capture_orchestrator', id: decision.sourceTextDigest },
    provenance: confirmationStatus === 'user_confirmed' ? 'user_confirmed' : 'user_stated',
    sourceTimestamp: decision.decidedAt,
    createdAt: now,
    updatedAt: now,
    effectiveFrom: now,
    effectiveTo: null,
    confidence: decision.confidence,
    importance: decision.importance,
    sensitivity: decision.sensitivity,
    status: 'confirmed',
    confirmationStatus,
    expiresAt: decision.retentionPolicy.expiresAt,
    version: 1,
    supersedesId: correction?.memoryId ?? null,
    supersededById: null,
    conflictGroupId: correction ? correction.conflictGroupId ?? `conflict:${correction.memoryId}` : null,
    retentionPolicy: structuredClone(decision.retentionPolicy),
    accessPolicy: { ownerOnly: true },
    checksum: '',
    tags: [],
    metadata: {
      policyVersion: decision.policyVersion,
      reasonCodes: [...decision.reasonCodes],
      resolutionMethod: resolution.resolutionMethod,
      ...(trustedSourceMessageId ? { sourceMessageId: trustedSourceMessageId } : {})
    }
  };
}

export function createMemorySafeWriteService({
  foundation,
  inspector,
  now = () => new Date().toISOString(),
  memoryIdFactory
}) {
  if (!foundation?.unitOfWork || typeof foundation.unitOfWork.run !== 'function') {
    throw new TypeError('Safe write requires MemoryUnitOfWork.');
  }
  if (!inspector || typeof inspector.inspect !== 'function') throw new TypeError('Safe write requires duplicate/conflict inspector.');
  if (typeof now !== 'function' || typeof memoryIdFactory !== 'function') {
    throw new TypeError('Safe write requires clock and memoryId factories.');
  }
  return Object.freeze({
    async inspect({ ownerUserId, resolution, decision }) {
      if (!exactResolution(ownerUserId, resolution) || decision?.ownerUserId !== ownerUserId ||
          decision?.subjectEntityId !== resolution.entityId) {
        throw new Error('Exact owner-scoped Entity resolution is required.');
      }
      return inspector.inspect({
        ownerUserId,
        subjectEntityId: decision.subjectEntityId,
        predicate: decision.predicate,
        suggestedStructuredValue: decision.suggestedStructuredValue
      });
    },
    async write({
      ownerUserId,
      resolution,
      decision,
      idempotencyKey,
      confirmationStatus = 'system_verified',
      confirmedConflictMemoryId = null,
      sourceMessageId = null
    }) {
      required(ownerUserId, 'ownerUserId');
      required(idempotencyKey, 'idempotencyKey');
      if (!exactResolution(ownerUserId, resolution) || decision?.ownerUserId !== ownerUserId ||
          decision?.subjectEntityId !== resolution.entityId) {
        throw new Error('Exact owner-scoped Entity resolution is required.');
      }
      const decisionValidation = validateMemoryDecision(decision);
      if (!decisionValidation.valid) throw new TypeError('MemoryDecision is invalid.');
      if (!MEMORY_DECISION_TYPES.includes(decision.memoryType)) throw new TypeError('memoryType is invalid.');
      if (!PREDICATE_STRUCTURED_VALUE_SCHEMAS[decision.predicate]) throw new TypeError('predicate is not registered for MemoryRecordV2.');
      if (!['long_term', 'ttl'].includes(decision.retentionPolicy.mode)) throw new TypeError('retentionPolicy does not permit formal Memory.');
      if (!['public', 'low'].includes(decision.sensitivity) && confirmationStatus !== 'user_confirmed') {
        throw new Error('Sensitive Memory requires user confirmation.');
      }
      const inspection = await inspector.inspect({
        ownerUserId,
        subjectEntityId: decision.subjectEntityId,
        predicate: decision.predicate,
        suggestedStructuredValue: decision.suggestedStructuredValue
      });
      if (inspection.duplicateStatus === 'exact') {
        return immutable({ outcome: 'duplicate_detected', memoryId: inspection.matchingMemoryIds[0] });
      }
      if (inspection.conflictStatus === 'conflict' && !confirmedConflictMemoryId) {
        return immutable({ outcome: 'confirmation_required', conflictMemoryIds: inspection.matchingMemoryIds });
      }
      if (confirmedConflictMemoryId && !inspection.matchingMemoryIds.includes(confirmedConflictMemoryId)) {
        throw new Error('Confirmed conflict is stale or outside the current owner scope.');
      }

      const memoryId = required(memoryIdFactory(), 'memoryId');
      const contractResolution = resolutionContract(resolution, decision.predicate);
      return foundation.unitOfWork.run({ ownerUserId, idempotencyKey }, async ({ memories }) => {
        const correction = confirmedConflictMemoryId
          ? memories.getById(ownerUserId, confirmedConflictMemoryId)
          : null;
        if (confirmedConflictMemoryId && (!correction || correction.status !== 'confirmed' ||
            correction.subjectEntityId !== decision.subjectEntityId || correction.predicate !== decision.predicate)) {
          throw new Error('Confirmed conflict Memory is invalid.');
        }
        if (correction) {
          memories.archive(ownerUserId, correction.memoryId, {
            expectedVersion: correction.version,
            updatedAt: now()
          });
        }
        const memory = memories.create(ownerUserId, memoryCandidate({
          decision,
          resolution,
          memoryId,
          now: now(),
          confirmationStatus,
          correction,
          sourceMessageId
        }), {
          idempotencyKey: `${idempotencyKey}:memory`,
          resolution: contractResolution
        });
        return immutable({ outcome: 'memory_written', memory });
      });
    }
  });
}
