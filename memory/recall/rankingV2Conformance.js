import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';
import { buildMemoryQueryV2 } from '../entity/memoryQueryV2.js';
import {
  buildRankingInputV2,
  rankScopedMemoryCandidatesV2
} from './rankingV2.js';

const OWNER = ENTITY_TEST_IDS.owner;
const NOW = '2026-07-17T06:00:00.000Z';
const MOTHER = 'ent_5061728394a5b6c7d8e9fa0b1c2d3e4f';

function addEntity(foundation, entityId) {
  foundation.repository.create(OWNER, fakeEntity({
    ownerUserId: OWNER,
    entityId,
    source: { type: 'user_confirmed', id: `source-${entityId}` }
  }));
}

function addMemory(foundation, entityId, memoryId, date) {
  foundation.memories.create(OWNER, fakeMemoryRecordV2({
    ownerUserId: OWNER,
    subjectEntityId: entityId,
    memoryId,
    structuredValue: { date },
    source: { type: 'user_confirmed', id: `source-${memoryId}` }
  }));
}

function request(foundation, entityId, repositoryGeneration = 'ranking-v2-conformance-generation') {
  const context = {
    ownerUserId: OWNER,
    now: NOW,
    repositoryGeneration,
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
  const page = foundation.memories.queryByEntityAndPredicate(context, query);
  return { context, query, page };
}

function ranker({ candidates }) {
  return [...candidates].reverse().map((candidate) => ({
    memoryId: candidate.memoryId,
    ownerUserId: candidate.ownerUserId,
    subjectEntityId: candidate.subjectEntityId,
    predicate: candidate.predicate,
    checksum: candidate.checksum,
    provenance: structuredClone(candidate.provenance),
    reasonCodes: ['CONFORMANCE_ORDER']
  }));
}

async function openForTest(t, createHarness) {
  const harness = await createHarness();
  t.after(async () => harness.close?.());
  return harness;
}

export function registerRankingV2Conformance(label, createHarness) {
  test(`${label}: exact Entity candidate pages use one RankingInputV2 conformance`, async (t) => {
    const harness = await openForTest(t, createHarness);
    for (const entityId of [MOTHER, ENTITY_TEST_IDS.daughterOne, ENTITY_TEST_IDS.daughterTwo, ENTITY_TEST_IDS.friendOne, ENTITY_TEST_IDS.friendTwo]) {
      addEntity(harness.foundation, entityId);
      addMemory(harness.foundation, entityId, `ranking-${entityId}-a`, '1980-01-01');
      addMemory(harness.foundation, entityId, `ranking-${entityId}-b`, '1980-01-02');
    }
    for (const entityId of [MOTHER, ENTITY_TEST_IDS.daughterOne, ENTITY_TEST_IDS.daughterTwo, ENTITY_TEST_IDS.friendOne, ENTITY_TEST_IDS.friendTwo]) {
      const fixture = request(harness.foundation, entityId);
      const result = rankScopedMemoryCandidatesV2({
        ...fixture,
        queryPurpose: 'answer_exact_person_fact',
        ranker
      });
      assert.equal(result.rankedMemoryIds.length, 2);
      assert.ok(result.rankedMemoryIds.every((memoryId) => memoryId.startsWith(`ranking-${entityId}-`)));
      assert.equal(result.rankingInput.subjectEntityId, entityId);
    }
  });

  test(`${label}: restart preserves RankingInputV2 and query fingerprint`, async (t) => {
    const harness = await openForTest(t, createHarness);
    addEntity(harness.foundation, MOTHER);
    addMemory(harness.foundation, MOTHER, 'ranking-restart-a', '1970-01-01');
    addMemory(harness.foundation, MOTHER, 'ranking-restart-b', '1970-01-02');
    const beforeFixture = request(harness.foundation, MOTHER);
    const before = buildRankingInputV2({
      ...beforeFixture,
      queryPurpose: 'answer_exact_person_fact'
    });
    await harness.reopen();
    const afterFixture = request(harness.foundation, MOTHER);
    const after = buildRankingInputV2({
      ...afterFixture,
      queryPurpose: 'answer_exact_person_fact'
    });
    assert.deepEqual(after, before);
    assert.deepEqual(
      rankScopedMemoryCandidatesV2({ ...afterFixture, queryPurpose: 'answer_exact_person_fact', ranker }).rankedMemoryIds,
      rankScopedMemoryCandidatesV2({ ...beforeFixture, queryPurpose: 'answer_exact_person_fact', ranker }).rankedMemoryIds
    );
  });
}
