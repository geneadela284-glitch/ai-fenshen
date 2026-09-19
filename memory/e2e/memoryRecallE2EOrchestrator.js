import { createMemoryLifecycleV2 } from '../entity/memoryLifecycleV2.js';
import { buildMemoryQueryV2 } from '../entity/memoryQueryV2.js';
import { executeV2FirstRead } from '../recall/v2FirstRead.js';
import { buildSafeAnswerV2, verifySafeAnswerProposalV2 } from '../recall/safeAnswerV2.js';

function resolutionContract(resolution, predicate) {
  const relation = resolution.evidence?.find((item) => item.type === 'effective_relation') ?? null;
  return Object.freeze({
    schemaVersion: 'v2',
    resolutionStatus: 'exact',
    ownerUserId: resolution.ownerUserId,
    entityType: resolution.entityType,
    entityId: resolution.entityId,
    relationKind: relation?.relationKind ?? null,
    role: relation?.role ?? null,
    predicate,
    candidateEntityIds: [],
    sourceRelationIds: relation?.relationId ? [relation.relationId] : [],
    resolutionReason: resolution.resolutionMethod,
    policyVersion: 'fake-query-planner-v1',
    resolvedAt: resolution.resolvedAt
  });
}

function failedResolution(ownerUserId, resolution) {
  const scope = { ownerUserId, subjectEntityId: null, predicate: 'birthday' };
  if (resolution.resolutionStatus === 'ambiguous') {
    return Object.freeze({
      outcome: 'clarification',
      resolution,
      safeAnswer: buildSafeAnswerV2({
        type: 'clarification',
        scope,
        clarificationQuestion: resolution.clarificationQuestion
      })
    });
  }
  return Object.freeze({
    outcome: 'no_match',
    resolution,
    safeAnswer: buildSafeAnswerV2({ type: 'not_found', query: scope })
  });
}

export function createMemoryRecallE2EOrchestrator({
  foundation,
  resolutionService,
  captureOrchestrator,
  pendingCandidates,
  queryPlanner,
  legacyAdapter,
  traces,
  now = () => new Date().toISOString(),
  memoryIdFactory
} = {}) {
  const lifecycle = createMemoryLifecycleV2({ foundation, now, memoryIdFactory });
  const ranker = ({ input, candidates }) => {
    traces.ranking.push(structuredClone({ input, candidates }));
    return candidates.map((candidate) => ({
      memoryId: candidate.memoryId,
      ownerUserId: candidate.ownerUserId,
      subjectEntityId: candidate.subjectEntityId,
      predicate: candidate.predicate,
      checksum: candidate.checksum,
      provenance: structuredClone(candidate.provenance),
      reasonCodes: ['FAKE_E2E_SCOPE_VERIFIED']
    }));
  };

  async function resolve(ownerUserId, text, conversationId, purpose) {
    return resolutionService.resolve({
      ownerUserId,
      text,
      locale: 'zh-CN',
      conversationId,
      purpose,
      effectiveAt: now()
    });
  }

  async function plannedQuery({ ownerUserId, question, conversationId, readMode, effectiveAt, limit, cursor }) {
    const resolution = await resolve(ownerUserId, question, conversationId, 'recall');
    if (resolution.resolutionStatus !== 'exact') return { resolution, failure: failedResolution(ownerUserId, resolution) };
    const plan = queryPlanner.plan({ ownerUserId, question, entityResolution: resolution, readMode, effectiveAt });
    const context = {
      ownerUserId,
      now: now(),
      repositoryGeneration: 'sprint4f-fake-e2e-generation-v1',
      entityResolution: resolutionContract(resolution, plan.predicate)
    };
    const query = buildMemoryQueryV2(context, {
      subjectEntityId: plan.subjectEntityId,
      predicate: plan.predicate,
      readMode: plan.readMode,
      ...(plan.readMode === 'historical' ? { effectiveAt: plan.effectiveAt } : {}),
      provenancePolicy: 'trusted_v2',
      limit: limit ?? 20,
      cursor: cursor ?? null
    });
    return { resolution, plan, context, query, failure: null };
  }

  return Object.freeze({
    async capture(input) {
      const result = await captureOrchestrator.process(input);
      traces.capture.push(structuredClone({ input, result }));
      return result;
    },

    async confirm({ ownerUserId, confirmationToken, accepted }) {
      const pending = pendingCandidates.get(ownerUserId, confirmationToken);
      if (!accepted || pending.candidate.kind !== 'memory' || !pending.candidate.conflictMemoryId) {
        return captureOrchestrator.confirm({ ownerUserId, confirmationToken, accepted });
      }
      const candidate = pending.candidate;
      const current = foundation.memories.getById(ownerUserId, candidate.conflictMemoryId);
      const result = await lifecycle.execute({ ownerUserId }, {
        schemaVersion: 'v2',
        lifecycleAction: 'correction',
        subjectEntityId: candidate.resolution.entityId,
        predicate: candidate.decision.predicate,
        memoryId: current.memoryId,
        expectedVersion: current.version,
        idempotencyKey: candidate.idempotencyKey,
        structuredValue: structuredClone(candidate.decision.suggestedStructuredValue),
        confirmed: false
      });
      pendingCandidates.consume(ownerUserId, confirmationToken);
      return result;
    },

    async recall({ ownerUserId, question, conversationId, readMode = 'current', effectiveAt }) {
      const planned = await plannedQuery({ ownerUserId, question, conversationId, readMode, effectiveAt });
      if (planned.failure) return planned.failure;
      const result = executeV2FirstRead({
        context: planned.context,
        query: planned.query,
        v2Repository: foundation.memories,
        legacyAdapter,
        queryPurpose: planned.plan.queryPurpose,
        ranker
      });
      return Object.freeze({ ...result, resolution: planned.resolution, queryPlan: planned.plan });
    },

    async queryPage({ ownerUserId, question, conversationId, readMode = 'current', effectiveAt, limit, cursor }) {
      const planned = await plannedQuery({
        ownerUserId, question, conversationId, readMode, effectiveAt, limit, cursor
      });
      if (planned.failure) return planned.failure;
      return Object.freeze({
        ...planned,
        page: foundation.memories.queryByEntityAndPredicate(planned.context, planned.query)
      });
    },

    lifecycle(action, { ownerUserId, subjectEntityId, predicate = 'birthday', memoryId,
      expectedVersion, idempotencyKey, confirmed = false, structuredValue = null }) {
      return lifecycle.execute({ ownerUserId }, {
        schemaVersion: 'v2',
        lifecycleAction: action,
        subjectEntityId,
        predicate,
        memoryId,
        expectedVersion,
        idempotencyKey,
        structuredValue,
        confirmed
      });
    },

    verifyAIProposal: verifySafeAnswerProposalV2
  });
}
