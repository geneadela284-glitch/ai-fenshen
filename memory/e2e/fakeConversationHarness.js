import crypto from 'node:crypto';

import {
  fakeEntity,
  fakeEntityAlias,
  fakeEntityRelation
} from '../../testing/entityFixtures.js';
import { FakeAIEntityResolver } from '../../testing/fakeAIEntityResolver.js';
import { FakeAIMemoryClassifier } from '../../testing/fakeAIMemoryClassifier.js';
import { FakeBusinessRecordAdapter } from '../../testing/fakeBusinessRecordAdapter.js';
import { ConversationEntityContext } from '../entity/conversationEntityContext.js';
import { createEntityResolutionService } from '../entity/entityResolutionService.js';
import { createMemoryCaptureDecisionService } from '../entity/memoryCaptureDecisionService.js';
import { createMemoryCaptureOrchestrator } from '../entity/memoryCaptureOrchestrator.js';
import { createMemoryCaptureStores } from '../entity/memoryCaptureStores.js';
import {
  createMemoryDuplicateConflictInspector,
  createMemorySafeWriteService
} from '../entity/memorySafeWriteService.js';
import {
  computeLegacyAdapterResultChecksum,
  createLegacyReadAdapterV2
} from '../recall/legacyReadAdapterV2.js';
import { createFakeQueryPlanner } from './fakeQueryPlanner.js';
import { createMemoryRecallE2EOrchestrator } from './memoryRecallE2EOrchestrator.js';

const OWNERS = Object.freeze({ a: 'user-sprint4f-a', b: 'user-sprint4f-b' });

function opaque(prefix, suffix) {
  return `ent_${prefix.repeat(30)}${suffix}`;
}

const ENTITY_IDS = Object.freeze({
  a: Object.freeze({
    self: opaque('a', '01'), mother: opaque('a', '02'), father: opaque('a', '03'),
    daughterRain: opaque('a', '04'), daughterSnow: opaque('a', '05'),
    friendCollege: opaque('a', '06'), friendNeighbor: opaque('a', '07')
  }),
  b: Object.freeze({
    self: opaque('b', '01'), mother: opaque('b', '02'), father: opaque('b', '03'),
    daughterRain: opaque('b', '04'), daughterSnow: opaque('b', '05'),
    friendCollege: opaque('b', '06'), friendNeighbor: opaque('b', '07')
  })
});

const TEXT = Object.freeze({
  motherBirthday: '我妈妈5月6号生日。',
  askMotherBirthday: '我妈什么时候生日？',
  correctMotherBirthday: '我说错了，我妈妈生日是5月8号。',
  ambiguousDaughterBirthday: '我女儿5月10号生日。',
  rainBirthday: '小雨5月10号生日。',
  snowBirthday: '小雪5月11号生日。',
  askRainBirthday: '小雨什么时候生日？',
  ambiguousLinBirthday: '小林5月12号生日。',
  collegeLinBirthday: '大学同学小林5月12号生日。',
  neighborLinBirthday: '邻居小林5月13号生日。',
  askCollegeLinBirthday: '大学同学小林什么时候生日？',
  askFatherBirthday: '我爸爸什么时候生日？',
  askOtherOwnerMotherBirthday: '另一位用户的妈妈什么时候生日？',
  askContextBirthday: '她什么时候生日？',
  businessRecord: '买菜100元。'
});

function proposal(structuredValue, overrides = {}) {
  return {
    proposedDecision: 'store_silently',
    memoryType: 'fact',
    predicate: 'birthday',
    confidence: 0.99,
    importance: 0.8,
    sensitivity: 'low',
    retentionPolicy: { mode: 'long_term', expiresAt: null },
    reasonCodes: ['long_term_personal_fact'],
    suggestedStructuredValue: structuredValue,
    containsPersonalFact: true,
    needsClarification: false,
    explicitBusinessIntent: false,
    ...structuredClone(overrides)
  };
}

function classifierProposals() {
  return {
    [TEXT.motherBirthday]: proposal({ date: '1960-05-06' }),
    [TEXT.correctMotherBirthday]: proposal({ date: '1960-05-08' }),
    [TEXT.ambiguousDaughterBirthday]: proposal({ date: '2012-05-10' }),
    [TEXT.rainBirthday]: proposal({ date: '2012-05-10' }),
    [TEXT.snowBirthday]: proposal({ date: '2015-05-11' }),
    [TEXT.ambiguousLinBirthday]: proposal({ date: '1990-05-12' }),
    [TEXT.collegeLinBirthday]: proposal({ date: '1990-05-12' }),
    [TEXT.neighborLinBirthday]: proposal({ date: '1988-05-13' }),
    [TEXT.businessRecord]: proposal({
      direction: 'expense', amount: 100, currency: 'CNY', category: 'groceries'
    }, {
      proposedDecision: 'business_record',
      memoryType: 'financial_record',
      predicate: 'financial_transaction',
      retentionPolicy: { mode: 'business_record', expiresAt: null },
      reasonCodes: ['explicit_business_record'],
      explicitBusinessIntent: true
    })
  };
}

function resolutionProposals() {
  const mother = { kind: 'relation', mention: '妈妈', relationKind: 'parent', role: 'mother' };
  return {
    [TEXT.motherBirthday]: mother,
    [TEXT.askMotherBirthday]: mother,
    [TEXT.correctMotherBirthday]: mother,
    [TEXT.ambiguousDaughterBirthday]: { kind: 'relation', mention: '女儿', relationKind: 'child', role: 'daughter' },
    [TEXT.rainBirthday]: { kind: 'alias', mention: '小雨', alias: '小雨' },
    [TEXT.snowBirthday]: { kind: 'alias', mention: '小雪', alias: '小雪' },
    [TEXT.askRainBirthday]: { kind: 'alias', mention: '小雨', alias: '小雨' },
    [TEXT.ambiguousLinBirthday]: { kind: 'alias', mention: '小林', alias: '小林' },
    [TEXT.collegeLinBirthday]: { kind: 'alias', mention: '大学同学小林', alias: '大学同学小林' },
    [TEXT.neighborLinBirthday]: { kind: 'alias', mention: '邻居小林', alias: '邻居小林' },
    [TEXT.askCollegeLinBirthday]: { kind: 'alias', mention: '大学同学小林', alias: '大学同学小林' },
    [TEXT.askFatherBirthday]: { kind: 'relation', mention: '爸爸', relationKind: 'parent', role: 'father' },
    [TEXT.askOtherOwnerMotherBirthday]: { kind: 'entity', mention: '另一位用户的妈妈', entityId: ENTITY_IDS.b.mother },
    [TEXT.askContextBirthday]: { kind: 'context', mention: '她' },
    [TEXT.businessRecord]: { kind: 'self', mention: '我' }
  };
}

function seedOwner(foundation, ownerUserId, ids, ownerKey) {
  const createEntity = (entityId, metadata = {}) => foundation.repository.create(ownerUserId, fakeEntity({
    ownerUserId,
    entityId,
    metadata,
    source: { type: 'user_confirmed', id: `e2e-entity:${ownerUserId}:${entityId}` }
  }));
  createEntity(ids.self, { entityRole: 'self' });
  for (const id of [ids.mother, ids.father, ids.daughterRain, ids.daughterSnow, ids.friendCollege, ids.friendNeighbor]) {
    createEntity(id);
  }
  const addAlias = (alias, entityId, index) => foundation.aliases.addAlias(ownerUserId, fakeEntityAlias({
    ownerUserId,
    alias,
    entityId,
    source: { type: 'user_confirmed', id: `e2e-alias:${ownerKey}:${index}` }
  }));
  addAlias('小雨', ids.daughterRain, 1);
  addAlias('小雪', ids.daughterSnow, 2);
  addAlias('小林', ids.friendCollege, 3);
  addAlias('小林', ids.friendNeighbor, 4);
  addAlias('大学同学小林', ids.friendCollege, 5);
  addAlias('邻居小林', ids.friendNeighbor, 6);
  const relation = (name, targetEntityId, relationKind, role) => foundation.relations.createRelation(
    ownerUserId,
    fakeEntityRelation({
      ownerUserId,
      relationId: `rel_e2e_${ownerKey}_${name}`,
      sourceEntityId: ids.self,
      targetEntityId,
      relationKind,
      role,
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      source: { type: 'user_confirmed', id: `e2e-relation:${ownerKey}:${name}` }
    })
  );
  relation('mother', ids.mother, 'parent', 'mother');
  relation('father', ids.father, 'parent', 'father');
  relation('daughter_rain', ids.daughterRain, 'child', 'daughter');
  relation('daughter_snow', ids.daughterSnow, 'child', 'daughter');
}

function plannerQuestions() {
  return Object.fromEntries([
    TEXT.askMotherBirthday,
    TEXT.askRainBirthday,
    TEXT.askCollegeLinBirthday,
    TEXT.askFatherBirthday,
    TEXT.askOtherOwnerMotherBirthday,
    TEXT.askContextBirthday
  ].map((question) => [question, 'birthday']));
}

function legacyResult(scope, mappingStatus) {
  const deterministic = mappingStatus === 'deterministic_mapped';
  const value = {
    legacyMemoryId: `legacy-e2e:${scope.ownerUserId}:${scope.subjectEntityId}`,
    ownerUserId: scope.ownerUserId,
    mappedSubjectEntityId: deterministic ? scope.subjectEntityId : null,
    predicate: scope.predicate,
    structuredValue: { date: '1960-05-06' },
    mappingStatus,
    mappingEvidence: {
      type: deterministic ? 'stable_mapping_table' : 'manual_review_candidate',
      subjectEntityId: deterministic ? scope.subjectEntityId : null,
      evidenceIds: ['fake-e2e-legacy-mapping']
    },
    adapterVersion: 'fake-e2e-legacy-adapter-v1',
    source: { type: 'user_confirmed', id: 'fake-e2e-legacy-source' },
    provenance: {
      sourceMode: 'legacy',
      source: { type: 'user_confirmed', id: 'fake-e2e-legacy-source' },
      mappingStatus,
      adapterVersion: 'fake-e2e-legacy-adapter-v1'
    },
    checksum: '',
    effectiveTime: { effectiveFrom: '1960-05-06T00:00:00.000Z', effectiveTo: null }
  };
  value.checksum = computeLegacyAdapterResultChecksum(value);
  return value;
}

export function createFakeConversationHarness({
  backend,
  legacyMode = 'none',
  businessFailure = false,
  initialNow = '2026-07-17T10:00:00.000Z'
} = {}) {
  if (!backend?.foundation) throw new TypeError('Fake Conversation Harness requires a fake Foundation backend.');
  let currentNow = initialNow;
  let initialized = false;
  let closed = false;
  let runtime = null;
  let runtimeGeneration = 0;
  let traces = { capture: [], ranking: [], legacy: [] };
  const now = () => currentNow;
  const businessRecordAdapter = new FakeBusinessRecordAdapter({ now, fail: businessFailure });

  function buildRuntime() {
    traces = { capture: [], ranking: [], legacy: [] };
    const foundation = backend.foundation;
    const aiResolver = new FakeAIEntityResolver(resolutionProposals());
    const classifier = new FakeAIMemoryClassifier(classifierProposals());
    const conversationContext = new ConversationEntityContext({ now });
    const resolutionService = createEntityResolutionService({
      repository: foundation.repository,
      aliases: foundation.aliases,
      relations: foundation.relations,
      aiResolver,
      conversationContext,
      now
    });
    const inspector = createMemoryDuplicateConflictInspector({ memories: foundation.memories, now });
    const decisionService = createMemoryCaptureDecisionService({ classifier, inspector, now });
    const memoryIdFactory = () => `memory-e2e-${crypto.randomUUID()}`;
    const safeWriteService = createMemorySafeWriteService({ foundation, inspector, now, memoryIdFactory });
    const stores = createMemoryCaptureStores({ now });
    const captureOrchestrator = createMemoryCaptureOrchestrator({
      resolutionService,
      decisionService,
      safeWriteService,
      pendingCandidates: stores.pendingCandidates,
      temporaryContexts: stores.temporaryContexts,
      businessRecordAdapter,
      now
    });
    const queryPlanner = createFakeQueryPlanner({ questions: plannerQuestions(), now });
    const legacyAdapter = legacyMode === 'none'
      ? { query() { return []; } }
      : createLegacyReadAdapterV2({
        queryExact(scope) {
          traces.legacy.push(structuredClone(scope));
          return [legacyResult(scope, legacyMode === 'deterministic' ? 'deterministic_mapped' : legacyMode)];
        }
      });
    runtime = createMemoryRecallE2EOrchestrator({
      foundation,
      resolutionService,
      captureOrchestrator,
      pendingCandidates: stores.pendingCandidates,
      queryPlanner,
      legacyAdapter,
      traces,
      now,
      memoryIdFactory
    });
    runtimeGeneration += 1;
  }

  const api = {
    backend,
    owners: OWNERS,
    entityIds: ENTITY_IDS,
    text: TEXT,
    businessRecordAdapter,

    get foundation() { return backend.foundation; },
    get traces() { return traces; },
    get runtimeGeneration() { return runtimeGeneration; },

    async initialize() {
      if (initialized) return;
      seedOwner(backend.foundation, OWNERS.a, ENTITY_IDS.a, 'a');
      seedOwner(backend.foundation, OWNERS.b, ENTITY_IDS.b, 'b');
      buildRuntime();
      initialized = true;
    },

    advanceTo(timestamp) {
      if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) throw new TypeError('timestamp is invalid.');
      currentNow = timestamp;
    },

    capture(text, {
      ownerUserId = OWNERS.a,
      conversationId = 'conversation-default',
      idempotencyKey = `capture:${crypto.randomUUID()}`
    } = {}) {
      return runtime.capture({ ownerUserId, text, locale: 'zh-CN', conversationId, idempotencyKey });
    },

    confirm(confirmationToken, { ownerUserId = OWNERS.a, accepted } = {}) {
      return runtime.confirm({ ownerUserId, confirmationToken, accepted });
    },

    recall(question, {
      ownerUserId = OWNERS.a,
      conversationId = 'conversation-recall',
      readMode = 'current',
      effectiveAt
    } = {}) {
      return runtime.recall({ ownerUserId, question, conversationId, readMode, effectiveAt });
    },

    queryPage(question, {
      ownerUserId = OWNERS.a,
      conversationId = 'conversation-query-page',
      readMode = 'current',
      effectiveAt,
      limit,
      cursor
    } = {}) {
      return runtime.queryPage({
        ownerUserId, question, conversationId, readMode, effectiveAt, limit, cursor
      });
    },

    lifecycle(action, options) {
      const ownerUserId = options.ownerUserId ?? OWNERS.a;
      const memory = backend.foundation.memories.getById(ownerUserId, options.memoryId);
      return runtime.lifecycle(action, {
        ownerUserId,
        subjectEntityId: options.subjectEntityId ?? memory?.subjectEntityId,
        predicate: options.predicate ?? memory?.predicate ?? 'birthday',
        memoryId: options.memoryId,
        expectedVersion: options.expectedVersion,
        idempotencyKey: options.idempotencyKey,
        confirmed: options.confirmed ?? false,
        structuredValue: options.structuredValue ?? null
      });
    },

    listMemories({ ownerUserId = OWNERS.a, subjectEntityId, status } = {}) {
      const ids = subjectEntityId ? [subjectEntityId] : Object.values(
        ownerUserId === OWNERS.a ? ENTITY_IDS.a : ENTITY_IDS.b
      );
      return ids.flatMap((entityId) => backend.foundation.memories
        .listByEntityAndPredicateForLifecycle(ownerUserId, entityId, 'birthday'))
        .filter((memory) => status === undefined || memory.status === status);
    },

    getMemory(memoryId, ownerUserId = OWNERS.a) {
      return backend.foundation.memories.getById(ownerUserId, memoryId);
    },

    verifyAIProposal(contract, proposal) {
      return runtime.verifyAIProposal(contract, proposal);
    },

    async restart() {
      if (typeof backend.reopen !== 'function') throw new Error('Backend does not support restart.');
      await backend.reopen();
      buildRuntime();
    },

    async close() {
      if (closed) return;
      closed = true;
      await backend.close();
    }
  };
  return api;
}
