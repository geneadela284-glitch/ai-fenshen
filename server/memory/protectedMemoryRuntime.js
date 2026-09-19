import crypto from 'node:crypto';
import path from 'node:path';

import { assertScopedRealDataOperation } from '../../core/safety/scopedRealDataAuthorization.js';
import { parseFamilyBirthdayStatement } from '../../memory/capture/familyBirthdayParser.js';
import { ConversationEntityContext } from '../../memory/entity/conversationEntityContext.js';
import { createEntityResolutionService } from '../../memory/entity/entityResolutionService.js';
import { createMemoryCaptureDecisionService } from '../../memory/entity/memoryCaptureDecisionService.js';
import { createMemoryCaptureOrchestrator } from '../../memory/entity/memoryCaptureOrchestrator.js';
import { createMemoryCaptureStores } from '../../memory/entity/memoryCaptureStores.js';
import { createMemoryLifecycleV2 } from '../../memory/entity/memoryLifecycleV2.js';
import { buildMemoryQueryV2 } from '../../memory/entity/memoryQueryV2.js';
import { PREDICATE_STRUCTURED_VALUE_SCHEMAS } from '../../memory/entity/contracts.js';
import {
  createMemoryDuplicateConflictInspector,
  createMemorySafeWriteService
} from '../../memory/entity/memorySafeWriteService.js';
import { createSQLiteEntityFoundation } from '../../memory/entity/sqliteFoundation.js';
import { buildSafeAnswerV2 } from '../../memory/recall/safeAnswerV2.js';
import { executeV2FirstRead } from '../../memory/recall/v2FirstRead.js';
import { buildConversationContextPack } from './conversationContextPack.js';
import { deterministicGroundedAnswer } from './groundedMemoryResponder.js';
import { buildMemoryEvidenceBundle } from './memoryEvidenceBundle.js';
import { evaluateSemanticMemoryContract } from './semanticMemoryContract.js';
import { validateSemanticMemoryPlan } from './semanticMemoryPlanSchema.js';
import { legacyEntityRelationDescriptor } from '../agent/entityRelationCanonicalizer.js';

const CORRECTION_PREFIX = /^我(?:刚才)?(?:记错|说错)了[，,：:\s]*/;
const BIRTHDAY_QUERY = /(?:什么时候生日|生日(?:是)?(?:哪天|几月几号|几号)|什么时候出生|何时出生|出生于什么时候)/;
const UNKNOWN_MEMORY = '我目前还不知道。';
const NO_MORE_MEMORY = '我目前只记录到这些，没有更多已确认的信息。';
const UNKNOWN_YEAR_SENTINEL = 2000;
const PREFERENCE_PREDICATE = 'preference_statement';
const FAVORITE_PREFERENCE_PREDICATE = 'favorite_preference_statement';
const PREFERENCE_FOLLOW_UP = /^(?:还喜欢(?:吃|喝|用|看|听|玩)?什么[？?]?|还有呢[？?]?)[。！!]*$/;
const PREFERENCE_MARKERS = Object.freeze(['最喜欢', '最爱', '喜欢', '偏好', '爱']);
const PREFERENCE_ACTIONS = Object.freeze(['吃', '喝', '用', '看', '听', '玩']);
const FAMILY_RELATIONS = Object.freeze([
  Object.freeze({ role: 'mother', relationKind: 'parent', label: '妈妈', aliases: Object.freeze(['妈妈', '母亲', '妈']) }),
  Object.freeze({ role: 'father', relationKind: 'parent', label: '爸爸', aliases: Object.freeze(['爸爸', '父亲', '爸']) }),
  Object.freeze({ role: 'daughter', relationKind: 'child', label: '女儿', aliases: Object.freeze(['女儿', '闺女', '孩子']) })
]);

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function entityId(ownerId, role) {
  return `ent_${digest(`${ownerId}:${role}`).slice(0, 32)}`;
}

function memoryId() {
  return `memory-m9-2-${crypto.randomUUID()}`;
}

function normalizeFactText(value) {
  return String(value || '').trim().replace(CORRECTION_PREFIX, '');
}

function familyReference(value) {
  const text = normalizeFactText(value);
  for (const relation of FAMILY_RELATIONS) {
    if (relation.aliases.some((alias) => [
      `我${alias}`, `我的${alias}`, `我家${alias}`, `咱${alias}`, `咱家${alias}`
    ].some((mention) => text.includes(mention)))) return relation;
  }
  return null;
}

function familyRole(value) {
  return familyReference(value)?.role ?? null;
}

function preferenceExpression(value) {
  const text = normalizeFactText(value);
  const marker = PREFERENCE_MARKERS
    .map((candidate) => ({ candidate, index: text.indexOf(candidate) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index || right.candidate.length - left.candidate.length)[0];
  if (!marker) return null;
  let tail = text.slice(marker.index + marker.candidate.length).trim();
  const action = PREFERENCE_ACTIONS.find((candidate) => tail.startsWith(candidate));
  if (action) tail = tail.slice(action.length).trim();
  tail = tail.replace(/^(?:的|的是|是)\s*/, '').trim();
  const query = /^(?:什么|哪些|哪种|啥)(?:呢)?[？?。！!]*$/.test(tail);
  const favorite = marker.candidate === '最喜欢' || marker.candidate === '最爱';
  if (query) return Object.freeze({ query: true, value: null, favorite });
  const normalizedValue = tail
    .split(/[，,。！？!?]/, 1)[0]
    .replace(/\s*(?:而)?不是.*$/, '')
    .trim();
  if (!normalizedValue || /^(?:什么|哪些|哪种|啥)$/.test(normalizedValue)) return null;
  return Object.freeze({ query: false, value: normalizedValue, favorite });
}

function isContextPronoun(value) {
  return /^(?:她|他)(?:现在|目前|最近)?/.test(normalizeFactText(value));
}

function preferenceQuery(value) {
  const expression = preferenceExpression(value);
  return expression?.query === true && (Boolean(familyReference(value)) || isContextPronoun(value));
}

function durableStatement(value) {
  const normalized = normalizeFactText(value);
  const birthday = parseFamilyBirthdayStatement(normalized);
  if (birthday && !birthday.uncertain) return Object.freeze({ kind: 'birthday', semantic: birthday.semantic });
  const preference = preferenceExpression(normalized);
  if (preference && !preference.query && (familyReference(normalized) || isContextPronoun(normalized))) {
    return Object.freeze({
      kind: 'preference',
      semantic: Object.freeze({
        relation: familyRole(normalized),
        value: preference.value,
        predicate: preference.favorite ? FAVORITE_PREFERENCE_PREDICATE : PREFERENCE_PREDICATE
      })
    });
  }
  return null;
}

function isBirthdayQuery(value) {
  return BIRTHDAY_QUERY.test(String(value || '')) && Boolean(familyRole(value));
}

function queryDescriptor(value) {
  if (isBirthdayQuery(value)) return Object.freeze({ predicate: 'birthday', role: familyRole(value) });
  if (preferenceQuery(value)) {
    const expression = preferenceExpression(value);
    return Object.freeze({
      predicate: expression?.favorite ? FAVORITE_PREFERENCE_PREDICATE : PREFERENCE_PREDICATE,
      role: familyRole(value)
    });
  }
  return null;
}

function deterministicQueryPlan(descriptor, inheritedContext = null) {
  return Object.freeze({
    intent: 'memory_query',
    subject: Object.freeze({ relation_to_owner: descriptor.role }),
    predicate: descriptor.predicate,
    value: null,
    qualifiers: Object.freeze({ calendar_type: 'unknown', temporal_scope: 'stable' }),
    inherited_context: Object.freeze({
      previous_entity: inheritedContext?.previous_entity || null,
      previous_predicate: inheritedContext?.previous_predicate || null,
      previously_returned_values: Object.freeze([...(inheritedContext?.previously_returned_values || [])])
    })
  });
}

function isMemoryQuery(value) {
  return Boolean(queryDescriptor(value));
}

function isCorrectionStatement(value) {
  const text = String(value || '');
  return CORRECTION_PREFIX.test(text) || /(?:不是|改成|更正为)/.test(text) ||
    /(?:她|他).*(?:现在|目前|最近).*(?:喜欢|偏好|爱)/.test(text);
}

function answerOnlyProposal() {
  return {
    proposedDecision: 'answer_only',
    memoryType: null,
    predicate: null,
    confidence: 1,
    importance: 0,
    sensitivity: 'low',
    retentionPolicy: { mode: 'none', expiresAt: null },
    reasonCodes: ['information_query'],
    suggestedStructuredValue: null,
    containsPersonalFact: false,
    needsClarification: false,
    explicitBusinessIntent: false
  };
}

function ignoreProposal() {
  return {
    ...answerOnlyProposal(),
    proposedDecision: 'ignore',
    confidence: 0.99,
    reasonCodes: ['not_a_durable_memory']
  };
}

function birthdayProposal(parsed) {
  const year = parsed.semantic.year || UNKNOWN_YEAR_SENTINEL;
  return {
    proposedDecision: 'store_silently',
    memoryType: 'fact',
    predicate: 'birthday',
    confidence: 0.99,
    importance: 0.8,
    sensitivity: 'low',
    retentionPolicy: { mode: 'long_term', expiresAt: null },
    reasonCodes: parsed.semantic.year ? ['long_term_personal_fact'] : ['long_term_personal_fact', 'year_not_provided'],
    suggestedStructuredValue: {
      date: `${String(year).padStart(4, '0')}-${String(parsed.semantic.month).padStart(2, '0')}-${String(parsed.semantic.day).padStart(2, '0')}`
    },
    containsPersonalFact: true,
    needsClarification: false,
    explicitBusinessIntent: false
  };
}

function preferenceProposal(parsed) {
  const predicate = parsed.semantic.predicate || PREFERENCE_PREDICATE;
  const structuredValue = predicate === PREFERENCE_PREDICATE
    ? { value: parsed.semantic.value, values: [parsed.semantic.value] }
    : { value: parsed.semantic.value };
  return {
    proposedDecision: 'store_silently',
    memoryType: 'preference',
    predicate,
    confidence: 0.96,
    importance: 0.75,
    sensitivity: 'low',
    retentionPolicy: { mode: 'long_term', expiresAt: null },
    reasonCodes: ['stable_personal_preference'],
    suggestedStructuredValue: structuredValue,
    containsPersonalFact: true,
    needsClarification: false,
    explicitBusinessIntent: false
  };
}

class DeterministicFamilyEntityResolver {
  async resolve({ text, conversationEntityContext }) {
    const relation = familyReference(text);
    if (!relation && isContextPronoun(text) && conversationEntityContext?.entityId) {
      return { kind: 'context', mention: String(text).trim().slice(0, 1) };
    }
    if (!relation) return { kind: 'none', mention: '' };
    return {
      kind: 'relation',
      mention: relation.label,
      relationKind: relation.relationKind,
      role: relation.role
    };
  }
}

class DeterministicMemoryCandidateClassifier {
  async classify({ text }) {
    const normalized = normalizeFactText(text);
    if (isMemoryQuery(normalized)) return answerOnlyProposal();
    const parsed = durableStatement(normalized);
    if (parsed?.kind === 'birthday') return birthdayProposal(parsed);
    if (parsed?.kind === 'preference') return preferenceProposal(parsed);
    return ignoreProposal();
  }
}

function resolutionContract(resolution, predicate) {
  const relation = resolution.evidence?.find((item) => item.type === 'effective_relation') || null;
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
    policyVersion: 'm9-2-protected-memory-query-v1',
    resolvedAt: resolution.resolvedAt
  });
}

function rankExact({ input, candidates }) {
  return candidates.map((candidate) => ({
    memoryId: candidate.memoryId,
    ownerUserId: candidate.ownerUserId,
    subjectEntityId: candidate.subjectEntityId,
    predicate: candidate.predicate,
    checksum: candidate.checksum,
    provenance: structuredClone(candidate.provenance),
    reasonCodes: ['EXACT_OWNER_ENTITY_PREDICATE']
  }));
}

function productSafeAnswer(result, scope) {
  if (result?.safeAnswer?.type === 'fact') {
    const fact = trustedMemoryFact(result, result.safeAnswer);
    if (fact?.type === 'birthday' && fact.yearKnown) {
      return Object.freeze({ ...result.safeAnswer, safeUserMessage: `${fact.displayDate}。` });
    }
    return result.safeAnswer;
  }
  return Object.freeze({
    ...buildSafeAnswerV2({ type: 'not_found', query: scope }),
    safeUserMessage: UNKNOWN_MEMORY
  });
}

function trustedMemoryFact(result, safeAnswer) {
  if ([PREFERENCE_PREDICATE, FAVORITE_PREFERENCE_PREDICATE].includes(safeAnswer?.predicate)) {
    const value = String(safeAnswer?.immutableFact?.value || '').trim();
    const values = Array.isArray(safeAnswer?.immutableFact?.values)
      ? safeAnswer.immutableFact.values.map((item) => String(item).trim()).filter(Boolean)
      : (value ? [value] : []);
    return values.length ? Object.freeze({
      type: safeAnswer.predicate === FAVORITE_PREFERENCE_PREDICATE ? 'favorite_preference' : 'preference',
      value,
      values
    }) : null;
  }
  const match = String(safeAnswer?.immutableFact?.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const reasonCodes = result?.page?.items?.[0]?.metadata?.reasonCodes;
  const yearKnown = !Array.isArray(reasonCodes) || !reasonCodes.includes('year_not_provided');
  return Object.freeze({
    type: 'birthday',
    displayDate: yearKnown ? `${Number(yearText)}年${month}月${day}日` : `${month}月${day}日`,
    yearKnown,
    ...(yearKnown ? { year: Number(yearText) } : {}),
    month,
    day
  });
}

function authorizedAccess({ authorization, scope, databasePath, actionId, operation }) {
  return assertScopedRealDataOperation({
    authorization,
    scope,
    databasePath,
    ownerSource: 'authenticated_session',
    operation,
    actionId
  });
}

export function createProtectedMemoryRuntime({
  databasePath,
  repositoryRoot = process.cwd(),
  authorization,
  scope,
  actionId,
  now = () => new Date().toISOString(),
  semanticPlanner = null,
  groundedResponder = null
} = {}) {
  const resolvedDatabasePath = path.resolve(databasePath || '');
  const root = path.dirname(resolvedDatabasePath);
  const realDataAccess = {
    authorization,
    scope,
    ownerSource: 'authenticated_session',
    actionId
  };
  const foundation = createSQLiteEntityFoundation({
    shadowRoot: root,
    databasePath: resolvedDatabasePath,
    repositoryRoot,
    now,
    realDataAccess
  });
  const conversationContext = new ConversationEntityContext({ now });
  const resolutionService = createEntityResolutionService({
    repository: foundation.repository,
    aliases: foundation.aliases,
    relations: foundation.relations,
    aiResolver: new DeterministicFamilyEntityResolver(),
    conversationContext,
    now
  });
  const inspector = createMemoryDuplicateConflictInspector({ memories: foundation.memories, now });
  const decisionService = createMemoryCaptureDecisionService({
    classifier: new DeterministicMemoryCandidateClassifier(),
    inspector,
    now
  });
  const safeWriteService = createMemorySafeWriteService({
    foundation,
    inspector,
    now,
    memoryIdFactory: memoryId
  });
  const stores = createMemoryCaptureStores({ now });
  const businessRecordAdapter = Object.freeze({
    async inspect() { return { duplicateStatus: 'none', recordId: null }; },
    async commit() { return { committed: false, recordId: null }; }
  });
  const captureOrchestrator = createMemoryCaptureOrchestrator({
    resolutionService,
    decisionService,
    safeWriteService,
    pendingCandidates: stores.pendingCandidates,
    temporaryContexts: stores.temporaryContexts,
    businessRecordAdapter,
    now
  });
  const lifecycleService = createMemoryLifecycleV2({ foundation, now, memoryIdFactory: memoryId });
  const queryContinuations = new Map();

  function plannerContinuation(ownerId, conversationId) {
    const continuation = queryContinuations.get(continuationKey(ownerId, conversationId));
    return continuation ? {
      previous_entity: continuation.role || null,
      previous_predicate: continuation.plannerPredicate || continuation.predicate || null,
      previously_returned_values: [...(continuation.returnedValues || [])]
    } : null;
  }

  function bindTrustedContinuation(plan, trustedContext) {
    const trusted = trustedContext && typeof trustedContext === 'object' ? trustedContext : {};
    const inherited = plan?.inherited_context && typeof plan.inherited_context === 'object'
      ? plan.inherited_context
      : {};
    const sameTrustedScope = plan?.subject?.relation_to_owner === trusted.previous_entity &&
      plan?.predicate === trusted.previous_predicate;
    return Object.freeze({
      ...structuredClone(plan),
      inherited_context: Object.freeze({
        previous_entity: inherited.previous_entity || trusted.previous_entity || null,
        previous_predicate: inherited.previous_predicate || trusted.previous_predicate || null,
        previously_returned_values: Object.freeze(
          sameTrustedScope && Array.isArray(trusted.previously_returned_values) && trusted.previously_returned_values.length
            ? [...trusted.previously_returned_values]
            : [...(inherited.previously_returned_values || [])]
        )
      })
    });
  }

  function continuationKey(ownerId, conversationId) {
    return `${ownerId}::${conversationId}`;
  }

  function rememberPlannerContext(ownerId, conversationId, {
    role, predicate, plannerPredicate = predicate, subjectEntityId = null, returnedValues = []
  } = {}) {
    if (!role || !predicate) return;
    const key = continuationKey(ownerId, conversationId);
    queryContinuations.delete(key);
    queryContinuations.set(key, Object.freeze({
      predicate,
      plannerPredicate,
      role,
      subjectEntityId,
      returnedValues: Object.freeze([...returnedValues])
    }));
    if (queryContinuations.size > 1000) queryContinuations.delete(queryContinuations.keys().next().value);
  }

  function rememberQueryContext(ownerId, conversationId, descriptor, safeAnswer) {
    const returnedValues = (Array.isArray(safeAnswer?.immutableFact?.values)
      ? safeAnswer.immutableFact.values
      : [safeAnswer?.immutableFact?.value]).filter(Boolean);
    rememberPlannerContext(ownerId, conversationId, {
      predicate: descriptor?.predicate,
      plannerPredicate: descriptor?.plannerPredicate || descriptor?.predicate,
      role: descriptor?.role,
      subjectEntityId: safeAnswer?.subjectEntityId ?? null,
      returnedValues
    });
  }

  function descriptorFor(ownerId, conversationId, message) {
    const explicit = queryDescriptor(message);
    if (explicit) return { ...explicit, followUp: false };
    if (!PREFERENCE_FOLLOW_UP.test(normalizeFactText(message))) return null;
    const continuation = queryContinuations.get(continuationKey(ownerId, conversationId));
    return continuation ? { ...continuation, followUp: true } : null;
  }

  function ensureFamily(ownerId, role, relationDescriptor = null) {
    const descriptor = relationDescriptor || FAMILY_RELATIONS.find((entry) => entry.role === role);
    if (!descriptor) throw new Error('Unsupported family relation.');
    const self = foundation.repository.ensureSelfEntity(ownerId);
    const targetId = entityId(ownerId, role);
    let target = foundation.repository.getById(ownerId, targetId);
    const timestamp = now();
    if (!target) {
      target = foundation.repository.create(ownerId, {
        schemaVersion: 'v2',
        entityId: targetId,
        ownerUserId: ownerId,
        type: 'person',
        status: 'active',
        version: 1,
        source: { type: 'system_verified', id: `m9-2-family:${role}` },
        checksum: digest(`${ownerId}:${targetId}:1`),
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: { familyRole: role }
      }, { idempotencyKey: `m9-2-family-entity:${role}` });
    }
    const existing = foundation.relations.listRelations(ownerId, {
      sourceEntityId: self.entityId,
      targetEntityId: target.entityId,
      relationKind: descriptor.relationKind,
      role,
      status: 'active'
    });
    if (existing.length === 0) {
      foundation.relations.createRelation(ownerId, {
        schemaVersion: 'v2',
        relationId: `rel_m9_2_${digest(`${ownerId}:${role}`).slice(0, 20)}`,
        ownerUserId: ownerId,
        sourceEntityId: self.entityId,
        targetEntityId: target.entityId,
        relationKind: descriptor.relationKind,
        role,
        effectiveFrom: '2000-01-01T00:00:00.000Z',
        effectiveTo: null,
        status: 'active',
        version: 1,
        source: { type: 'system_verified', id: `m9-2-family-relation:${role}` },
        checksum: digest(`${ownerId}:${self.entityId}:${target.entityId}:${role}:1`),
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {}
      }, { idempotencyKey: `m9-2-family-relation:${role}` });
    }
    return target;
  }

  async function recall({ ownerId, conversationId, message, descriptor }) {
    authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'query' });
    if (descriptor?.followUp) {
      const query = {
        ownerUserId: ownerId,
        subjectEntityId: descriptor.subjectEntityId,
        predicate: descriptor.predicate
      };
      const safeAnswer = Object.freeze({
        ...buildSafeAnswerV2({ type: 'not_found', query }),
        safeUserMessage: NO_MORE_MEMORY
      });
      return {
        kind: 'query',
        safeAnswer,
        trustedContext: { source: 'memory_query_v2_grounding', grounded: false, evidence: [] }
      };
    }
    const role = descriptor?.role ?? null;
    const predicate = descriptor?.predicate ?? null;
    if (!predicate) return { kind: 'none', outcome: 'ignored' };
    if (role) ensureFamily(ownerId, role);
    const resolution = await resolutionService.resolve({
      ownerUserId: ownerId,
      text: message,
      locale: 'zh-CN',
      conversationId,
      purpose: 'recall',
      effectiveAt: now()
    });
    const emptyScope = { ownerUserId: ownerId, subjectEntityId: null, predicate };
    if (resolution.resolutionStatus !== 'exact') {
      return {
        kind: 'query',
        safeAnswer: productSafeAnswer(null, emptyScope),
        trustedContext: { source: 'memory_query_v2_grounding', grounded: false, evidence: [] }
      };
    }
    const context = {
      ownerUserId: ownerId,
      now: now(),
      repositoryGeneration: 'm9-2-protected-acceptance-v1',
      entityResolution: resolutionContract(resolution, predicate)
    };
    const query = buildMemoryQueryV2(context, {
      subjectEntityId: resolution.entityId,
      predicate,
      readMode: 'current',
      provenancePolicy: 'trusted_v2',
      limit: 5,
      cursor: null
    });
    const result = executeV2FirstRead({
      context,
      query,
      v2Repository: foundation.memories,
      legacyAdapter: null,
      queryPurpose: 'answer_exact_person_fact',
      ranker: rankExact
    });
    const safeAnswer = productSafeAnswer(result, query);
    const response = {
      kind: 'query',
      safeAnswer,
      trustedContext: {
        source: 'memory_query_v2_grounding',
        grounded: safeAnswer.grounded,
        entity: { id: safeAnswer.subjectEntityId, role },
        fact: trustedMemoryFact(result, safeAnswer),
        evidence: safeAnswer.evidenceMemoryIds,
        confidence: result?.groundingResult?.grounded ? 1 : 0,
        version: result?.groundingResult?.version ?? null,
        provenance: result?.groundingResult?.provenance ?? null
      }
    };
    rememberQueryContext(ownerId, conversationId, descriptor, safeAnswer);
    return response;
  }

  function semanticDescriptor(plan) {
    return legacyEntityRelationDescriptor(plan?.subject?.relation_to_owner, {
      reference: plan?.subject?.normalized_reference
    });
  }

  function semanticRole(plan) {
    return semanticDescriptor(plan)?.role || null;
  }

  async function semanticResolution({ ownerId, conversationId, plan, purpose }) {
    const descriptor = semanticDescriptor(plan);
    if (!descriptor) return { resolutionStatus: 'no_match', ownerUserId: ownerId, reason: 'unsupported_semantic_relation' };
    const target = ensureFamily(ownerId, descriptor.role, descriptor);
    const self = foundation.repository.ensureSelfEntity(ownerId);
    const relation = foundation.relations.listRelations(ownerId, {
      sourceEntityId: self.entityId,
      targetEntityId: target.entityId,
      relationKind: descriptor.relationKind,
      role: descriptor.role,
      status: 'active'
    })[0];
    if (!relation) return { resolutionStatus: 'no_match', ownerUserId: ownerId, reason: 'missing_owner_relation' };
    conversationContext.recordExact({
      ownerUserId: ownerId,
      conversationId,
      entityId: target.entityId,
      entityType: target.type
    });
    return Object.freeze({
      resolutionStatus: 'exact',
      ownerUserId: ownerId,
      entityId: target.entityId,
      entityType: target.type,
      evidence: Object.freeze([Object.freeze({
        type: 'effective_relation',
        relationId: relation.relationId,
        relationKind: relation.relationKind,
        role: relation.role,
        entityId: target.entityId
      })]),
      confidence: 1,
      resolutionMethod: `canonical_relation_adapter:${purpose}`,
      resolvedAt: now()
    });
  }

  function semanticDecision({ ownerId, resolution, predicate, structuredValue, sensitivity, plan, message }) {
    const memoryType = predicate === 'birthday' ? 'fact' : 'preference';
    const decidedAt = now();
    return Object.freeze({
      schemaVersion: 'v2',
      decision: 'store_silently',
      memoryType,
      ownerUserId: ownerId,
      subjectEntityId: resolution.entityId,
      predicate,
      confidence: plan.confidence,
      importance: predicate === 'birthday' ? 0.8 : 0.75,
      sensitivity,
      retentionPolicy: { mode: 'long_term', expiresAt: null },
      reasonCodes: [`semantic_memory_orchestrator_v1:${plan.intent}`],
      sourceTextDigest: digest(message),
      entityResolutionStatus: 'exact',
      confirmationRequired: false,
      acknowledgementPolicy: 'silent',
      duplicateCheckRequired: true,
      suggestedStructuredValue: structuredClone(structuredValue),
      responsePolicy: 'silent',
      policyVersion: 'semantic-memory-contract-v1',
      decidedAt
    });
  }

  function currentRecords(ownerId, subjectEntityId, predicate) {
    return foundation.memories.queryByEntityAndPredicate(ownerId, subjectEntityId, predicate, { status: 'confirmed' })
      .filter((record) => !record.supersededById && record.effectiveTo === null);
  }

  async function semanticRecall({ ownerId, conversationId, message, plan, invocation = {} }) {
    authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'query' });
    const initial = evaluateSemanticMemoryContract({ plan, existingRecords: [] });
    if (initial.decision !== 'ACCEPT' || initial.operation !== 'query') {
      return { kind: 'clarification', outcome: 'semantic_ask', content: initial.question || '请再明确一点。' };
    }
    const resolution = await semanticResolution({ ownerId, conversationId, plan, purpose: 'recall' });
    const role = semanticRole(plan);
    if (resolution.resolutionStatus !== 'exact') {
      return {
        kind: 'query',
        safeAnswer: Object.freeze({
          type: 'not_found', grounded: false, evidenceMemoryIds: Object.freeze([]),
          safeUserMessage: UNKNOWN_MEMORY
        }),
        evidenceBundle: buildMemoryEvidenceBundle({ ownerId, records: [] }),
        trustedContext: { source: 'memory_query_v2_grounding', grounded: false, evidence: [] }
      };
    }
    const predicate = initial.predicate;
    const records = currentRecords(ownerId, resolution.entityId, predicate);
    const returned = plan.inherited_context?.previously_returned_values || [];
    if (returned.length > 0) {
      return {
        kind: 'query',
        safeAnswer: Object.freeze({ ...buildSafeAnswerV2({ type: 'not_found', query: { ownerUserId: ownerId, subjectEntityId: resolution.entityId, predicate } }), safeUserMessage: NO_MORE_MEMORY }),
        evidenceBundle: buildMemoryEvidenceBundle({ ownerId, records }),
        trustedContext: { source: 'memory_query_v2_grounding', grounded: false, evidence: [] }
      };
    }
    const context = {
      ownerUserId: ownerId,
      now: now(),
      repositoryGeneration: 'm11-semantic-memory-orchestrator-v1',
      entityResolution: resolutionContract(resolution, predicate)
    };
    const query = buildMemoryQueryV2(context, {
      subjectEntityId: resolution.entityId,
      predicate,
      readMode: 'current',
      provenancePolicy: 'trusted_v2',
      limit: 20,
      cursor: null
    });
    const result = executeV2FirstRead({
      context, query, v2Repository: foundation.memories, legacyAdapter: null,
      queryPurpose: 'answer_exact_person_fact', ranker: rankExact
    });
    const selectedIds = new Set(result?.safeAnswer?.evidenceMemoryIds || []);
    const selected = result?.outcome === 'fact'
      ? records.filter((record) => selectedIds.size === 0 || selectedIds.has(record.memoryId))
      : [];
    const evidenceBundle = buildMemoryEvidenceBundle({ ownerId, records: selected });
    if (!evidenceBundle.evidence.length) {
      return {
        kind: 'query',
        safeAnswer: Object.freeze({ ...buildSafeAnswerV2({ type: 'not_found', query }), safeUserMessage: UNKNOWN_MEMORY }),
        evidenceBundle,
        trustedContext: { source: 'memory_query_v2_grounding', grounded: false, evidence: [] }
      };
    }
    const asksForGregorianConversion = plan.qualifiers?.calendar_type === 'gregorian' &&
      plan.qualifiers?.temporal_scope === 'this_year';
    const hasLunarBirthday = evidenceBundle.evidence.some((item) =>
      item.predicate === 'birthday' && item.qualifiers.calendar_type === 'lunar');
    if (asksForGregorianConversion && hasLunarBirthday) {
      return {
        kind: 'query',
        safeAnswer: Object.freeze({
          ...result.safeAnswer,
          safeUserMessage: '我目前还不能可靠换算农历生日对应的公历日期。',
          evidenceCoverage: 'deterministic_conversion_unavailable'
        }),
        evidenceBundle,
        trustedContext: {
          source: 'memory_query_v2_grounding', grounded: true,
          entity: { id: resolution.entityId, role },
          evidence: evidenceBundle.evidence.map((item) => item.evidence_id)
        }
      };
    }
    const subjectLabel = semanticDescriptor(plan)?.label || '这位家人';
    const response = groundedResponder?.respond
      ? await groundedResponder.respond({ bundle: evidenceBundle, subjectLabel, invocation })
      : { answer: deterministicGroundedAnswer(evidenceBundle, subjectLabel), source: 'deterministic_fallback' };
    const safeAnswer = Object.freeze({
      ...result.safeAnswer,
      safeUserMessage: response.answer,
      evidenceCoverage: response.source,
      ...(response.event ? { coverageEvent: response.event } : {})
    });
    rememberQueryContext(ownerId, conversationId, { predicate, plannerPredicate: plan.predicate, role }, safeAnswer);
    const continuation = queryContinuations.get(continuationKey(ownerId, conversationId));
    if (continuation) {
      queryContinuations.set(continuationKey(ownerId, conversationId), Object.freeze({
        ...continuation,
        returnedValues: Object.freeze(evidenceBundle.evidence.flatMap((item) =>
          item.value?.kind === 'string_set'
            ? item.value.items
            : item.value?.kind === 'single_string'
              ? [item.value.item]
              : []))
      }));
    }
    return {
      kind: 'query', safeAnswer, evidenceBundle,
      trustedContext: {
        source: 'memory_query_v2_grounding', grounded: true,
        entity: { id: resolution.entityId, role },
        evidence: evidenceBundle.evidence.map((item) => item.evidence_id)
      }
    };
  }

  async function semanticCapture({ ownerId, conversationId, message, clientRequestId, sourceMessageId, plan }) {
    authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'capture' });
    const resolution = await semanticResolution({ ownerId, conversationId, plan, purpose: 'capture' });
    if (resolution.resolutionStatus !== 'exact') {
      return { kind: 'clarification', outcome: 'semantic_ask', content: '你指的是哪一位家人？' };
    }
    const preliminary = evaluateSemanticMemoryContract({ plan, existingRecords: [], sourceText: message });
    const predicate = preliminary.predicate;
    if (!predicate) return { kind: 'clarification', outcome: 'semantic_ask', content: preliminary.question || '请再明确一点。' };
    const records = currentRecords(ownerId, resolution.entityId, predicate);
    const contract = evaluateSemanticMemoryContract({ plan, existingRecords: records, sourceText: message });
    if (contract.decision === 'ASK') {
      return { kind: 'clarification', outcome: 'semantic_ask', content: contract.question || '请再明确一点。' };
    }
    if (contract.decision === 'REJECT') return { kind: 'none', outcome: 'ignored' };
    if (contract.decision === 'NO_OP') {
      return {
        kind: 'capture', outcome: 'duplicate_detected', acknowledgement: 'none',
        memoryId: records[0]?.memoryId || null
      };
    }
    const idempotencyKey = `conversation:${conversationId}:${clientRequestId}:semantic-v1`;
    if (contract.decision === 'DELETE' || contract.operation === 'negate') {
      const current = records[0] || null;
      if (!current) return { kind: 'capture', outcome: 'duplicate_detected', acknowledgement: 'none' };
      if (contract.operation === 'negate' && predicate === PREFERENCE_PREDICATE) {
        const existingValues = Array.isArray(current.structuredValue?.values)
          ? current.structuredValue.values
          : [current.structuredValue?.value].filter(Boolean);
        const removed = new Set(contract.removeValues || []);
        const values = existingValues.filter((item) => !removed.has(item));
        if (values.length) {
          authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'correct' });
          const corrected = await lifecycleService.execute({ ownerUserId: ownerId }, {
            schemaVersion: 'v2', lifecycleAction: 'correction', subjectEntityId: resolution.entityId,
            predicate, memoryId: current.memoryId, expectedVersion: current.version,
            idempotencyKey, structuredValue: { value: values.join('、'), values }, confirmed: false,
            sourceMessageId
          });
          return { kind: 'capture', outcome: corrected.outcome === 'corrected' ? 'memory_corrected' : corrected.outcome, acknowledgement: 'none' };
        }
      }
      authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'delete' });
      const deleted = await lifecycleService.execute({ ownerUserId: ownerId }, {
        schemaVersion: 'v2', lifecycleAction: 'delete', subjectEntityId: resolution.entityId,
        predicate, memoryId: current.memoryId, expectedVersion: current.version,
        idempotencyKey, structuredValue: null, confirmed: false, sourceMessageId
      });
      return { kind: 'capture', outcome: deleted.outcome, acknowledgement: 'none' };
    }
    const current = records[0] || null;
    const confirmedConflictMemoryId = ['MERGE', 'SUPERSEDE', 'UPDATE'].includes(contract.decision)
      ? current?.memoryId || null
      : null;
    if (contract.decision === 'ASK') return { kind: 'clarification', outcome: 'semantic_ask', content: contract.question };
    if (confirmedConflictMemoryId) {
      authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'correct' });
      const corrected = await lifecycleService.execute({ ownerUserId: ownerId }, {
        schemaVersion: 'v2', lifecycleAction: 'correction', subjectEntityId: resolution.entityId,
        predicate, memoryId: current.memoryId, expectedVersion: current.version,
        idempotencyKey, structuredValue: contract.structuredValue, confirmed: false, sourceMessageId
      });
      return {
        kind: 'capture', outcome: corrected.outcome === 'corrected' ? 'memory_corrected' : corrected.outcome,
        acknowledgement: 'none', memoryId: corrected.memoryId
      };
    }
    const decision = semanticDecision({
      ownerId, resolution, predicate, structuredValue: contract.structuredValue,
      sensitivity: contract.sensitivity, plan, message
    });
    const written = await safeWriteService.write({
      ownerUserId: ownerId, resolution, decision, idempotencyKey,
      sourceMessageId
    });
    return {
      kind: 'capture',
      outcome: confirmedConflictMemoryId && written.outcome === 'memory_written' ? 'memory_corrected' : written.outcome,
      acknowledgement: 'none',
      memoryId: written.memory?.memoryId || written.memoryId || null
    };
  }

  async function semanticProcess({ ownerId, conversationId, message, clientRequestId, sourceMessageId,
    conversationMessages = [], captureEligible, suppliedPlan = null, invocation = {} }) {
    const trustedContinuation = plannerContinuation(ownerId, conversationId);
    const contextPack = buildConversationContextPack({
      messages: conversationMessages,
      trustedContext: trustedContinuation
    });
    const planned = suppliedPlan
      ? { ok: true, plan: suppliedPlan }
      : await semanticPlanner.plan({ message, contextPack, invocation });
    if (!planned?.ok) {
      return { kind: 'clarification', outcome: 'semantic_plan_failed', content: '我还不能确定你的意思，请再明确一点。' };
    }
    const validation = validateSemanticMemoryPlan(planned.plan, {
      text: message,
      minimumConfidence: suppliedPlan ? 0 : 0.78
    });
    if (!validation.valid) {
      return { kind: 'clarification', outcome: 'semantic_plan_failed', content: '我还不能确定你的意思，请再明确一点。' };
    }
    const boundPlan = bindTrustedContinuation(planned.plan, trustedContinuation);
    if (boundPlan.intent === 'ordinary_chat') return { kind: 'none', outcome: 'ignored' };
    if (boundPlan.intent === 'ambiguous' || boundPlan.requires_confirmation) {
      return { kind: 'clarification', outcome: 'semantic_ask', content: '请补充一个最必要的明确信息。' };
    }
    if (boundPlan.intent === 'memory_query') {
      try {
        const recalled = await semanticRecall({
          ownerId,
          conversationId,
          message,
          plan: boundPlan,
          invocation
        });
        return {
          ...recalled,
          semanticContext: Object.freeze({
            intent: boundPlan.intent,
            relation_to_owner: boundPlan.subject?.relation_to_owner || null,
            predicate: boundPlan.predicate || null,
            qualifiers: Object.freeze(structuredClone(boundPlan.qualifiers || {}))
          })
        };
      } catch {
        return { kind: 'query_error', outcome: 'query_failed', content: '暂时无法读取长期记忆，请稍后再试。' };
      }
    }
    if (!captureEligible) return { kind: 'none', outcome: 'capture_skipped' };
    if (!String(sourceMessageId || '').trim()) {
      return { kind: 'clarification', outcome: 'capture_failed', content: '这条信息暂时没能记下来，请稍后再试。' };
    }
    const captured = await semanticCapture({
      ownerId, conversationId, message, clientRequestId, sourceMessageId, plan: boundPlan
    });
    if (captured?.kind === 'capture') {
      const role = semanticRole(boundPlan);
      const predicate = evaluateSemanticMemoryContract({ plan: boundPlan, existingRecords: [], sourceText: message }).predicate;
      rememberPlannerContext(ownerId, conversationId, {
        role, predicate, plannerPredicate: boundPlan.predicate,
        subjectEntityId: role ? entityId(ownerId, role) : null, returnedValues: []
      });
    }
    return captured;
  }

  async function capture({ ownerId, conversationId, message, clientRequestId }) {
    authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'capture' });
    const normalized = normalizeFactText(message);
    const parsed = durableStatement(normalized);
    if (!parsed) return { kind: 'none', outcome: 'ignored' };
    if (parsed.semantic.relation) ensureFamily(ownerId, parsed.semantic.relation);
    const result = await captureOrchestrator.process({
      ownerUserId: ownerId,
      text: normalized,
      locale: 'zh-CN',
      conversationId,
      idempotencyKey: `conversation:${conversationId}:${clientRequestId}`
    });
    const preferenceConflict = parsed.kind === 'preference' && result.outcome === 'confirmation_required';
    if (!preferenceConflict && (!isCorrectionStatement(message) || result.outcome !== 'confirmation_required')) {
      return { kind: 'capture', ...result };
    }
    authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'correct' });
    const pending = stores.pendingCandidates.get(ownerId, result.confirmationToken);
    const current = foundation.memories.getById(ownerId, pending.candidate.conflictMemoryId);
    let structuredValue = structuredClone(pending.candidate.decision.suggestedStructuredValue);
    if (preferenceConflict && pending.candidate.decision.predicate === PREFERENCE_PREDICATE) {
      const currentValues = Array.isArray(current.structuredValue?.values)
        ? current.structuredValue.values
        : [current.structuredValue?.value].filter(Boolean);
      const incomingValues = Array.isArray(structuredValue?.values)
        ? structuredValue.values
        : [structuredValue?.value].filter(Boolean);
      const values = [...new Set([...currentValues, ...incomingValues]
        .map((item) => String(item).trim()).filter(Boolean))];
      structuredValue = { value: values.join('、'), values };
    }
    const corrected = await lifecycleService.execute({ ownerUserId: ownerId }, {
      schemaVersion: 'v2',
      lifecycleAction: 'correction',
      subjectEntityId: pending.candidate.resolution.entityId,
      predicate: pending.candidate.decision.predicate,
      memoryId: current.memoryId,
      expectedVersion: current.version,
      idempotencyKey: `conversation:${conversationId}:${clientRequestId}:correction`,
      structuredValue,
      confirmed: false
    });
    stores.pendingCandidates.consume(ownerId, result.confirmationToken);
    return { kind: 'capture', outcome: 'memory_corrected', acknowledgement: 'none', memoryId: corrected.memoryId };
  }

  return Object.freeze({
    databasePath: resolvedDatabasePath,
    trustedContext(ownerId, conversationId) {
      const owner = String(ownerId || '').trim();
      const conversation = String(conversationId || '').trim();
      if (!owner || !conversation) return null;
      return Object.freeze({
        owner_id: owner,
        conversation_id: conversation,
        ...plannerContinuation(owner, conversation)
      });
    },
    async resolveToolEvidence({ ownerId, conversationId, requirements = [] } = {}) {
      const owner = String(ownerId || '').trim();
      if (!owner) throw new Error('Authenticated Session owner is required.');
      authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: 'query' });
      const records = [];
      for (const requirement of requirements) {
        const plan = {
          subject: { relation_to_owner: requirement?.entity_relation || null },
          predicate: requirement?.predicate || null
        };
        const resolution = await semanticResolution({ ownerId: owner, conversationId, plan, purpose: 'recall' });
        if (resolution.resolutionStatus !== 'exact' || !plan.predicate) continue;
        records.push(...currentRecords(owner, resolution.entityId, plan.predicate));
      }
      const unique = [...new Map(records.map((record) => [record.memoryId, record])).values()];
      return buildMemoryEvidenceBundle({ ownerId: owner, records: unique });
    },
    isMemoryQuery(message, { ownerId, conversationId } = {}) {
      if (isMemoryQuery(message)) return true;
      return Boolean(ownerId && conversationId && descriptorFor(ownerId, conversationId, message));
    },
    isMemoryCandidate(message, { ownerId, conversationId } = {}) {
      if (isMemoryQuery(message) || durableStatement(message) || isCorrectionStatement(message)) return true;
      return Boolean(ownerId && conversationId && descriptorFor(ownerId, conversationId, message));
    },
    async processUserMessage({ ownerId, conversationId, message, clientRequestId, sourceMessageId = null,
      conversationMessages = [], captureEligible = true, invocation = {} }) {
      if (!String(ownerId || '').trim()) throw new Error('Authenticated Session owner is required.');
      if (semanticPlanner?.plan) {
        const semantic = await semanticProcess({
          ownerId, conversationId, message, clientRequestId, sourceMessageId,
          conversationMessages, captureEligible, invocation
        });
        return semantic;
      }
      const descriptor = descriptorFor(ownerId, conversationId, message);
      if (descriptor) return recall({ ownerId, conversationId, message, descriptor });
      if (!captureEligible) return { kind: 'none', outcome: 'capture_skipped' };
      return capture({ ownerId, conversationId, message, clientRequestId });
    },
    async processSemanticPlan({ ownerId, conversationId, message, clientRequestId, sourceMessageId = null,
      conversationMessages = [], captureEligible = true, invocation = {} }, plan) {
      if (!String(ownerId || '').trim()) throw new Error('Authenticated Session owner is required.');
      return semanticProcess({
        ownerId, conversationId, message, clientRequestId, sourceMessageId,
        conversationMessages, captureEligible, suppliedPlan: plan, invocation
      });
    },
    async lifecycle({ ownerId, action, memoryId: targetMemoryId, subjectEntityId, predicate,
      expectedVersion, clientRequestId, confirmed = false, structuredValue = null }) {
      authorizedAccess({ authorization, scope, databasePath: resolvedDatabasePath, actionId, operation: action });
      if (!foundation.memories.getById(ownerId, targetMemoryId)) throw new Error('Memory not found in owner scope.');
      return lifecycleService.execute({ ownerUserId: ownerId }, {
        schemaVersion: 'v2',
        lifecycleAction: action,
        subjectEntityId,
        predicate,
        memoryId: targetMemoryId,
        expectedVersion,
        idempotencyKey: clientRequestId,
        structuredValue: action === 'correction' ? structuredValue : null,
        confirmed
      });
    },
    inspectOwner(ownerId) {
      const entities = foundation.repository.listByOwner(ownerId);
      const predicates = Object.keys(PREDICATE_STRUCTURED_VALUE_SCHEMAS);
      const allMemories = entities.flatMap((entity) => predicates.flatMap((predicate) =>
        foundation.memories.listByEntityAndPredicateForLifecycle(ownerId, entity.entityId, predicate)));
      return {
        entities,
        allMemories,
        currentMemories: allMemories.filter((memory) => memory.status === 'confirmed' && !memory.supersededById)
      };
    },
    exportOwner(ownerId) {
      return foundation.exportOwner(ownerId);
    },
    deleteOwner(ownerId) {
      const owner = String(ownerId || '').trim();
      if (!owner) throw new Error('Authenticated Session owner is required.');
      stores.pendingCandidates.clearOwner(owner);
      stores.temporaryContexts.clearOwner(owner);
      for (const key of queryContinuations.keys()) {
        if (key.startsWith(`${owner}::`)) queryContinuations.delete(key);
      }
      conversationContext.clearOwner?.(owner);
      return foundation.deleteOwner(owner);
    },
    verifyOwnerDeleted(ownerId) {
      const owner = String(ownerId || '').trim();
      if (!foundation.verifyOwnerDeleted(owner)) return false;
      if (stores.pendingCandidates.size(owner) !== 0) return false;
      if (stores.temporaryContexts.listActive(owner).length !== 0) return false;
      return ![...queryContinuations.keys()].some((key) => key.startsWith(`${owner}::`));
    },
    diagnostics: foundation.diagnostics,
    close() {
      queryContinuations.clear();
      foundation.close();
    }
  });
}
