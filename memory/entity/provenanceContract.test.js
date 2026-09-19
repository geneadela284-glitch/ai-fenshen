import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as Contracts from './contracts.js';
import { buildMemoryQueryV2 } from './memoryQueryV2.js';
import { createInMemoryEntityFoundation } from './inMemoryFoundation.js';
import { createSQLiteEntityFoundation } from './sqliteFoundation.js';
import { createEntityResolutionService } from './entityResolutionService.js';
import { ConversationEntityContext } from './conversationEntityContext.js';
import { createMemoryCaptureDecisionService } from './memoryCaptureDecisionService.js';
import { createMemoryCaptureOrchestrator } from './memoryCaptureOrchestrator.js';
import { createMemoryCaptureStores } from './memoryCaptureStores.js';
import {
  createMemoryDuplicateConflictInspector,
  createMemorySafeWriteService
} from './memorySafeWriteService.js';
import { executeV2FirstRead } from '../recall/v2FirstRead.js';
import { FakeAIEntityResolver } from '../../testing/fakeAIEntityResolver.js';
import { FakeAIMemoryClassifier } from '../../testing/fakeAIMemoryClassifier.js';
import { FakeBusinessRecordAdapter } from '../../testing/fakeBusinessRecordAdapter.js';
import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityRelation,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const OWNER = ENTITY_TEST_IDS.owner;
const MOTHER = ENTITY_TEST_IDS.friendOne;
const SELF = ENTITY_TEST_IDS.self;
const NOW = '2026-07-17T10:00:00.000Z';
const STATEMENT = '我妈妈5月6号生日。';
const CONFIRMED = '我确认妈妈5月6号生日。';
const AI_UPGRADE = 'AI说这是用户陈述。';

function seed(foundation) {
  for (const [entityId, metadata] of [[SELF, { entityRole: 'self' }], [MOTHER, {}]]) {
    foundation.repository.create(OWNER, fakeEntity({ ownerUserId: OWNER, entityId, metadata }));
  }
  foundation.relations.createRelation(OWNER, fakeEntityRelation({
    relationId: 'rel_provenance_mother',
    ownerUserId: OWNER,
    sourceEntityId: SELF,
    targetEntityId: MOTHER,
    relationKind: 'parent',
    role: 'mother',
    effectiveFrom: '2020-01-01T00:00:00.000Z'
  }));
}

function proposal(overrides = {}) {
  return {
    proposedDecision: 'store_silently',
    memoryType: 'fact',
    predicate: 'birthday',
    confidence: 0.99,
    importance: 0.8,
    sensitivity: 'low',
    retentionPolicy: { mode: 'long_term', expiresAt: null },
    reasonCodes: ['long_term_personal_fact'],
    suggestedStructuredValue: { date: '1960-05-06' },
    containsPersonalFact: true,
    needsClarification: false,
    explicitBusinessIntent: false,
    ...structuredClone(overrides)
  };
}

function captureRuntime(foundation) {
  seed(foundation);
  const aiResolver = new FakeAIEntityResolver(Object.fromEntries(
    [STATEMENT, CONFIRMED, AI_UPGRADE].map((text) => [text, {
      kind: 'relation', mention: '妈妈', relationKind: 'parent', role: 'mother'
    }])
  ));
  const classifier = new FakeAIMemoryClassifier({
    [STATEMENT]: proposal(),
    [CONFIRMED]: proposal({
      proposedDecision: 'confirm_before_store',
      sensitivity: 'high',
      needsClarification: true,
      reasonCodes: ['sensitive_information']
    }),
    [AI_UPGRADE]: proposal({ provenance: 'user_stated' })
  });
  const resolutionService = createEntityResolutionService({
    repository: foundation.repository,
    aliases: foundation.aliases,
    relations: foundation.relations,
    aiResolver,
    conversationContext: new ConversationEntityContext({ now: () => NOW }),
    now: () => NOW
  });
  const inspector = createMemoryDuplicateConflictInspector({ memories: foundation.memories, now: () => NOW });
  const decisionService = createMemoryCaptureDecisionService({ classifier, inspector, now: () => NOW });
  let sequence = 0;
  const safeWriteService = createMemorySafeWriteService({
    foundation,
    inspector,
    now: () => NOW,
    memoryIdFactory: () => `memory-provenance-${++sequence}`
  });
  const stores = createMemoryCaptureStores({ now: () => NOW });
  const orchestrator = createMemoryCaptureOrchestrator({
    resolutionService,
    decisionService,
    safeWriteService,
    pendingCandidates: stores.pendingCandidates,
    temporaryContexts: stores.temporaryContexts,
    businessRecordAdapter: new FakeBusinessRecordAdapter({ now: () => NOW }),
    now: () => NOW
  });
  return { orchestrator, stores };
}

function capture(orchestrator, text, idempotencyKey) {
  return orchestrator.process({
    ownerUserId: OWNER,
    text,
    locale: 'zh-CN',
    conversationId: `conversation:${idempotencyKey}`,
    idempotencyKey
  });
}

function queryRequest(provenancePolicy = 'trusted_v2') {
  const context = {
    ownerUserId: OWNER,
    now: NOW,
    repositoryGeneration: 'provenance-contract-generation',
    entityResolution: fakeEntityResolution({
      ownerUserId: OWNER,
      entityId: MOTHER,
      predicate: 'birthday',
      resolvedAt: NOW
    })
  };
  return {
    context,
    query: buildMemoryQueryV2(context, {
      subjectEntityId: MOTHER,
      predicate: 'birthday',
      readMode: 'current',
      provenancePolicy,
      limit: 20
    })
  };
}

function ranker({ candidates }) {
  return candidates.map((candidate) => ({
    memoryId: candidate.memoryId,
    ownerUserId: candidate.ownerUserId,
    subjectEntityId: candidate.subjectEntityId,
    predicate: candidate.predicate,
    checksum: candidate.checksum,
    provenance: structuredClone(candidate.provenance),
    reasonCodes: ['PROVENANCE_CONTRACT_VERIFIED']
  }));
}

async function inMemoryHarness() {
  return { foundation: createInMemoryEntityFoundation(), async close() {} };
}

async function sqliteHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-provenance-'));
  const databasePath = path.join(root, 'shadow.sqlite');
  let foundation = createSQLiteEntityFoundation({ shadowRoot: root, databasePath, repositoryRoot: process.cwd() });
  return {
    root,
    databasePath,
    get foundation() { return foundation; },
    async reopen() {
      foundation.close();
      foundation = createSQLiteEntityFoundation({ shadowRoot: root, databasePath, repositoryRoot: process.cwd() });
    },
    async close() {
      foundation.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('MemoryRecordV2 freezes five provenance levels independently from source', () => {
  assert.deepEqual(Contracts.MEMORY_V2_PROVENANCE_LEVELS, [
    'user_stated', 'user_confirmed', 'system_verified', 'ai_inferred', 'imported_unverified'
  ]);
  assert.ok(Contracts.MEMORY_RECORD_V2_FIELDS.includes('provenance'));
  assert.ok(Contracts.MEMORY_RECORD_V2_REQUIRED_FIELDS.includes('provenance'));
  assert.ok(Contracts.MEMORY_RECORD_V2_CHECKSUM_FIELDS.includes('provenance'));
});

for (const [label, createHarness] of [
  ['Provenance InMemory', inMemoryHarness],
  ['Provenance Shadow SQLite', sqliteHarness]
]) {
  test(`${label}: store_silently writes capture source with user_stated provenance and no acknowledgement`, async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const runtime = captureRuntime(harness.foundation);
    const result = await capture(runtime.orchestrator, STATEMENT, 'silent');
    assert.equal(result.outcome, 'memory_written');
    assert.equal(result.acknowledgement, 'none');
    assert.equal(result.memory.source.type, 'capture_orchestrator');
    assert.equal(result.memory.provenance, 'user_stated');
  });

  test(`${label}: explicit confirmation writes user_confirmed provenance`, async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const runtime = captureRuntime(harness.foundation);
    const pending = await capture(runtime.orchestrator, CONFIRMED, 'confirm');
    const result = await runtime.orchestrator.confirm({
      ownerUserId: OWNER,
      confirmationToken: pending.confirmationToken,
      accepted: true
    });
    assert.equal(result.memory.provenance, 'user_confirmed');
    assert.equal(result.memory.source.type, 'capture_orchestrator');
  });

  test(`${label}: trusted query accepts three trusted provenance levels and rejects two untrusted levels`, async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    seed(harness.foundation);
    const levels = ['user_stated', 'user_confirmed', 'system_verified', 'ai_inferred', 'imported_unverified'];
    levels.forEach((provenance, index) => harness.foundation.memories.create(OWNER, fakeMemoryRecordV2({
      memoryId: `memory-provenance-level-${index}`,
      ownerUserId: OWNER,
      subjectEntityId: MOTHER,
      provenance,
      source: { type: index % 2 ? 'capture_orchestrator' : 'import_pipeline', id: `source-${index}` },
      createdAt: `2026-07-17T0${index}:00:00.000Z`,
      updatedAt: `2026-07-17T0${index}:00:00.000Z`,
      effectiveFrom: `2026-07-17T0${index}:00:00.000Z`,
      sourceTimestamp: `2026-07-17T0${index}:00:00.000Z`
    })));
    const { context, query } = queryRequest();
    const page = harness.foundation.memories.queryByEntityAndPredicate(context, query);
    assert.deepEqual(new Set(page.items.map((item) => item.provenance.level)), new Set([
      'user_stated', 'user_confirmed', 'system_verified'
    ]));
  });

  test(`${label}: source name cannot grant trust and capture source cannot rescue untrusted provenance`, async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    seed(harness.foundation);
    for (const [memoryId, provenance, sourceType] of [
      ['source-only', 'ai_inferred', 'user_confirmed'],
      ['capture-untrusted', 'imported_unverified', 'capture_orchestrator']
    ]) {
      harness.foundation.memories.create(OWNER, fakeMemoryRecordV2({
        memoryId,
        ownerUserId: OWNER,
        subjectEntityId: MOTHER,
        provenance,
        source: { type: sourceType, id: memoryId }
      }));
    }
    const { context, query } = queryRequest();
    assert.equal(harness.foundation.memories.queryByEntityAndPredicate(context, query).items.length, 0);
  });

  test(`${label}: Ranking and Grounding reread provenance and reject a changed level`, async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    seed(harness.foundation);
    harness.foundation.memories.create(OWNER, fakeMemoryRecordV2({
      memoryId: 'grounded-provenance', ownerUserId: OWNER, subjectEntityId: MOTHER,
      provenance: 'user_stated', source: { type: 'capture_orchestrator', id: 'grounded-source' }
    }));
    const request = queryRequest();
    const result = executeV2FirstRead({
      ...request,
      v2Repository: harness.foundation.memories,
      legacyAdapter: { query() { return []; } },
      queryPurpose: 'answer_exact_person_fact',
      ranker
    });
    assert.equal(result.outcome, 'fact');
    const record = harness.foundation.memories.getById(OWNER, 'grounded-provenance');
    harness.foundation.memories.transition(OWNER, record.memoryId, {
      ...structuredClone(record), provenance: 'ai_inferred', version: record.version + 1
    }, { expectedVersion: record.version });
    const rejected = executeV2FirstRead({
      ...request,
      v2Repository: harness.foundation.memories,
      legacyAdapter: { query() { return []; } },
      queryPurpose: 'answer_exact_person_fact',
      ranker
    });
    assert.equal(rejected.outcome, 'not_found');
  });
}

test('Fake AI cannot inject or upgrade provenance through classifier output', async () => {
  const foundation = createInMemoryEntityFoundation();
  const runtime = captureRuntime(foundation);
  const result = await capture(runtime.orchestrator, AI_UPGRADE, 'ai-upgrade');
  assert.notEqual(result.outcome, 'memory_written');
  assert.equal(foundation.memories.listByEntityAndPredicateForLifecycle(OWNER, MOTHER, 'birthday').length, 0);
});

test('Shadow SQLite close/reopen preserves record provenance in payload JSON without a schema migration', async (t) => {
  const harness = await sqliteHarness();
  t.after(() => harness.close());
  seed(harness.foundation);
  harness.foundation.memories.create(OWNER, fakeMemoryRecordV2({
    memoryId: 'sqlite-provenance-restart', ownerUserId: OWNER, subjectEntityId: MOTHER,
    provenance: 'user_stated', source: { type: 'capture_orchestrator', id: 'sqlite-restart' }
  }));
  await harness.reopen();
  assert.equal(harness.foundation.memories.getById(OWNER, 'sqlite-provenance-restart').provenance, 'user_stated');
});
