import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryEntityFoundation } from '../entity/inMemoryFoundation.js';
import { buildMemoryQueryV2 } from '../entity/memoryQueryV2.js';
import {
  computeLegacyAdapterResultChecksum,
  createLegacyReadAdapterV2
} from './legacyReadAdapterV2.js';
import {
  executeV2FirstRead,
  reconcileV2AndLegacyFacts
} from './v2FirstRead.js';
import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const OWNER = ENTITY_TEST_IDS.owner;
const NOW = '2026-07-17T06:00:00.000Z';
const MOTHER = 'ent_5061728394a5b6c7d8e9fa0b1c2d3e4f';

function request(entityId = MOTHER, generation = 'v2-first-read-test-generation') {
  const context = {
    ownerUserId: OWNER,
    now: NOW,
    repositoryGeneration: generation,
    entityResolution: fakeEntityResolution({
      ownerUserId: OWNER,
      entityId,
      predicate: 'birthday',
      resolvedAt: NOW
    })
  };
  const query = buildMemoryQueryV2(context, {
    subjectEntityId: entityId,
    predicate: 'birthday',
    readMode: 'current',
    limit: 20,
    provenancePolicy: 'trusted_v2'
  });
  return { context, query };
}

function legacyResult(entityId = MOTHER, overrides = {}) {
  const value = {
    legacyMemoryId: `legacy-birthday-${entityId}`,
    ownerUserId: OWNER,
    mappedSubjectEntityId: entityId,
    predicate: 'birthday',
    structuredValue: { date: '1968-05-06' },
    mappingStatus: 'deterministic_mapped',
    mappingEvidence: {
      type: 'stable_mapping_table',
      subjectEntityId: entityId,
      evidenceIds: [`mapping:${entityId}`]
    },
    adapterVersion: 'legacy-read-adapter-v2',
    source: { type: 'user_confirmed', id: `legacy-source-${entityId}` },
    provenance: {
      sourceMode: 'legacy',
      source: { type: 'user_confirmed', id: `legacy-source-${entityId}` },
      mappingStatus: 'deterministic_mapped',
      adapterVersion: 'legacy-read-adapter-v2'
    },
    checksum: '',
    effectiveTime: { effectiveFrom: '1968-05-06T00:00:00.000Z', effectiveTo: null },
    ...structuredClone(overrides)
  };
  if (!Object.hasOwn(overrides, 'checksum')) {
    value.checksum = computeLegacyAdapterResultChecksum(value);
  }
  return value;
}

function adapter(factory, calls = []) {
  return createLegacyReadAdapterV2({
    queryExact(scope) {
      calls.push(scope);
      return typeof factory === 'function' ? factory(calls.length, scope) : structuredClone(factory);
    }
  });
}

function ranker({ candidates }) {
  return candidates.map((candidate) => ({
    memoryId: candidate.memoryId,
    ownerUserId: candidate.ownerUserId,
    subjectEntityId: candidate.subjectEntityId,
    predicate: candidate.predicate,
    checksum: candidate.checksum,
    provenance: structuredClone(candidate.provenance),
    reasonCodes: ['V2_FIRST_READ_SCOPE_OK']
  }));
}

function foundation(entityIds = [MOTHER]) {
  const value = createInMemoryEntityFoundation();
  for (const entityId of entityIds) {
    value.repository.create(OWNER, fakeEntity({
      ownerUserId: OWNER,
      entityId,
      source: { type: 'user_confirmed', id: `entity-source-${entityId}` }
    }));
  }
  return value;
}

function execute({ entityId = MOTHER, v2 = foundation([entityId]), legacyAdapter, customRanker = ranker } = {}) {
  const scope = request(entityId);
  return executeV2FirstRead({
    ...scope,
    v2Repository: v2.memories,
    legacyAdapter,
    queryPurpose: 'answer_exact_person_fact',
    ranker: customRanker
  });
}

function reviewResult(status) {
  const value = legacyResult(MOTHER, {
    mappedSubjectEntityId: null,
    mappingStatus: status,
    mappingEvidence: {
      type: 'insufficient_evidence',
      subjectEntityId: null,
      evidenceIds: [`review:${status}`]
    },
    provenance: {
      sourceMode: 'legacy',
      source: { type: 'user_confirmed', id: `legacy-source-${MOTHER}` },
      mappingStatus: status,
      adapterVersion: 'legacy-read-adapter-v2'
    }
  });
  value.checksum = computeLegacyAdapterResultChecksum(value);
  return value;
}

test('qualified V2 result goes directly to Ranking and never queries Legacy', () => {
  const v2 = foundation();
  v2.memories.create(OWNER, fakeMemoryRecordV2({
    memoryId: 'v2-mother-birthday',
    ownerUserId: OWNER,
    subjectEntityId: MOTHER,
    structuredValue: { date: '1968-05-06' },
    sourceTimestamp: NOW,
    effectiveFrom: NOW
  }));
  const calls = [];
  const result = execute({ v2, legacyAdapter: adapter([legacyResult()], calls) });
  assert.equal(result.outcome, 'fact');
  assert.equal(result.sourceMode, 'v2');
  assert.equal(result.safeAnswer.safeUserMessage, '5月6号。');
  assert.equal(calls.length, 0);
});

test('Legacy fallback is allowed only after V2 result and presence are both empty', () => {
  const calls = [];
  const result = execute({ legacyAdapter: adapter([legacyResult()], calls) });
  assert.equal(result.outcome, 'fact');
  assert.equal(result.sourceMode, 'legacy');
  assert.equal(result.groundingResult.grounded, true);
  assert.equal(result.safeAnswer.safeUserMessage, '5月6号。');
  assert.ok(calls.length >= 2, 'Grounding must reread Legacy evidence');
});

for (const status of ['suggested_review', 'review_required', 'unmappable']) {
  test(`${status} Legacy mapping stops before Ranking`, () => {
    let rankingCalls = 0;
    const result = execute({
      legacyAdapter: adapter([reviewResult(status)]),
      customRanker() {
        rankingCalls += 1;
        return [];
      }
    });
    assert.equal(result.outcome, 'evidence_invalid');
    assert.equal(result.errorCode, 'LEGACY_MAPPING_UNSAFE');
    assert.equal(result.safeAnswer.type, 'evidence_invalid');
    assert.equal(rankingCalls, 0);
  });
}

for (const [label, record] of [
  ['deleted tombstone', { memoryId: 'v2-deleted', status: 'deleted' }],
  ['purged marker', { memoryId: 'v2-purged', status: 'deleted', metadata: { purgedMarker: true } }],
  ['superseded chain', { memoryId: 'v2-superseded', status: 'superseded', supersededById: 'v2-current' }],
  ['explicit presence marker', { memoryId: 'v2-presence', status: 'archived', metadata: { v2PresenceMarker: true } }]
]) {
  test(`${label} suppresses Legacy fallback`, () => {
    const v2 = foundation();
    v2.memories.create(OWNER, fakeMemoryRecordV2({
      ownerUserId: OWNER,
      subjectEntityId: MOTHER,
      ...record
    }));
    const calls = [];
    const result = execute({ v2, legacyAdapter: adapter([legacyResult()], calls) });
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.sourceMode, 'none');
    assert.equal(result.v2Presence.suppressLegacy, true);
    assert.equal(calls.length, 0);
  });
}

test('unresolved V2 conflict marker returns MEMORY_CONFLICT without Legacy fallback', () => {
  const v2 = foundation();
  v2.memories.create(OWNER, fakeMemoryRecordV2({
    memoryId: 'v2-conflict-marker',
    ownerUserId: OWNER,
    subjectEntityId: MOTHER,
    status: 'disputed',
    conflictGroupId: 'v2-conflict-group'
  }));
  const calls = [];
  const result = execute({ v2, legacyAdapter: adapter([legacyResult()], calls) });
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.errorCode, 'MEMORY_CONFLICT');
  assert.equal(result.safeAnswer.type, 'conflict');
  assert.equal(calls.length, 0);
});

test('same V2 and Legacy fact reconciliation returns V2 only without duplicates', () => {
  const v2 = [{ memoryId: 'v2-one', structuredValue: { date: '1968-05-06' } }];
  const legacy = [{ legacyMemoryId: 'legacy-one', structuredValue: { date: '1968-05-06' } }];
  assert.deepEqual(reconcileV2AndLegacyFacts(v2, legacy), {
    outcome: 'use_v2',
    records: v2,
    errorCode: null
  });
});

test('different V2 and Legacy fact reconciliation returns MEMORY_CONFLICT', () => {
  const result = reconcileV2AndLegacyFacts(
    [{ memoryId: 'v2-one', structuredValue: { date: '1968-05-06' } }],
    [{ legacyMemoryId: 'legacy-one', structuredValue: { date: '1969-05-06' } }]
  );
  assert.deepEqual(result, { outcome: 'conflict', records: [], errorCode: 'MEMORY_CONFLICT' });
});

test('two daughters use separate exact Legacy mappings and never mix', () => {
  const entities = [ENTITY_TEST_IDS.daughterOne, ENTITY_TEST_IDS.daughterTwo];
  const v2 = foundation(entities);
  for (const entityId of entities) {
    const result = execute({
      entityId,
      v2,
      legacyAdapter: adapter([legacyResult(entityId)])
    });
    assert.equal(result.outcome, 'fact');
    assert.equal(result.groundingResult.subjectEntityId, entityId);
    assert.ok(result.groundingResult.evidenceMemoryIds.every((id) => id.includes(entityId)));
  }
});

test('same-name friend without deterministic mapping cannot be auto-selected', () => {
  const v2 = foundation([ENTITY_TEST_IDS.friendOne]);
  const result = execute({
    entityId: ENTITY_TEST_IDS.friendOne,
    v2,
    legacyAdapter: adapter([reviewResult('suggested_review')])
  });
  assert.equal(result.outcome, 'evidence_invalid');
  assert.equal(result.errorCode, 'LEGACY_MAPPING_UNSAFE');
});

test('Legacy evidence changing between Ranking and Grounding fails closed', () => {
  const result = execute({
    legacyAdapter: adapter((call) => {
      const value = legacyResult();
      if (call > 1) value.structuredValue = { date: '1969-05-06' };
      value.checksum = computeLegacyAdapterResultChecksum(value);
      return [value];
    })
  });
  assert.equal(result.outcome, 'evidence_invalid');
  assert.equal(result.safeAnswer.type, 'evidence_invalid');
  assert.equal(result.groundingResult.grounded, false);
});

test('V2-first read never invokes V1 or V2 write methods and needs no model', () => {
  const v2 = foundation();
  let writes = 0;
  v2.memories.create = () => { writes += 1; };
  v2.memories.archive = () => { writes += 1; };
  const result = execute({ v2, legacyAdapter: adapter([legacyResult()]) });
  assert.equal(result.outcome, 'fact');
  assert.equal(writes, 0);
  assert.equal(Object.hasOwn(result, 'model'), false);
});

test('Recall index exports the Sprint 4D read boundary without changing final answer integration', async () => {
  const recall = await import('./index.js');
  assert.equal(recall.executeV2FirstRead, executeV2FirstRead);
  assert.equal(recall.createLegacyReadAdapterV2, createLegacyReadAdapterV2);
});
