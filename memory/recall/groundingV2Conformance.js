import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryQueryV2 } from '../entity/memoryQueryV2.js';
import { rankScopedMemoryCandidatesV2 } from './rankingV2.js';
import { groundRankedEvidenceV2 } from './groundingV2.js';
import { buildSafeAnswerV2 } from './safeAnswerV2.js';
import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const OWNER = ENTITY_TEST_IDS.owner;
const NOW = '2026-07-17T06:00:00.000Z';
const MOTHER = 'ent_5061728394a5b6c7d8e9fa0b1c2d3e4f';

function seed(foundation, entityId, suffix) {
  foundation.repository.create(OWNER, fakeEntity({
    ownerUserId: OWNER,
    entityId,
    source: { type: 'user_confirmed', id: `source-entity-${suffix}` }
  }));
  foundation.memories.create(OWNER, fakeMemoryRecordV2({
    memoryId: `grounding-conformance-${suffix}`,
    ownerUserId: OWNER,
    subjectEntityId: entityId,
    structuredValue: { date: suffix === 'mother' ? '1968-05-06' : '2000-01-02' },
    source: { type: 'user_confirmed', id: `source-memory-${suffix}` }
  }));
}

function request(foundation, entityId, generation = 'grounding-v2-conformance-generation') {
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
  const page = foundation.memories.queryByEntityAndPredicate(context, query);
  const rankingResult = rankScopedMemoryCandidatesV2({
    context,
    query,
    page,
    queryPurpose: 'answer_exact_person_fact',
    ranker: ({ candidates }) => candidates.map((candidate) => ({
      memoryId: candidate.memoryId,
      ownerUserId: candidate.ownerUserId,
      subjectEntityId: candidate.subjectEntityId,
      predicate: candidate.predicate,
      checksum: candidate.checksum,
      provenance: structuredClone(candidate.provenance),
      reasonCodes: ['CONFORMANCE_ORDER']
    }))
  });
  return { context, query, page, rankingResult, repository: foundation.memories };
}

async function openForTest(t, createHarness) {
  const harness = await createHarness();
  t.after(async () => harness.close?.());
  return harness;
}

export function registerGroundingV2Conformance(label, createHarness) {
  test(`${label}: exact Entity evidence uses one shared Grounding conformance`, async (t) => {
    const harness = await openForTest(t, createHarness);
    for (const [entityId, suffix] of [
      [MOTHER, 'mother'],
      [ENTITY_TEST_IDS.daughterOne, 'daughter-one'],
      [ENTITY_TEST_IDS.daughterTwo, 'daughter-two'],
      [ENTITY_TEST_IDS.friendOne, 'friend-one'],
      [ENTITY_TEST_IDS.friendTwo, 'friend-two']
    ]) seed(harness.foundation, entityId, suffix);

    for (const [entityId, suffix] of [
      [MOTHER, 'mother'],
      [ENTITY_TEST_IDS.daughterOne, 'daughter-one'],
      [ENTITY_TEST_IDS.daughterTwo, 'daughter-two'],
      [ENTITY_TEST_IDS.friendOne, 'friend-one'],
      [ENTITY_TEST_IDS.friendTwo, 'friend-two']
    ]) {
      const result = groundRankedEvidenceV2(request(harness.foundation, entityId));
      assert.equal(result.grounded, true);
      assert.equal(result.subjectEntityId, entityId);
      assert.equal(result.selectedMemoryId, `grounding-conformance-${suffix}`);
    }
  });

  test(`${label}: close and reopen preserves Grounded Result and Safe Answer`, async (t) => {
    const harness = await openForTest(t, createHarness);
    seed(harness.foundation, MOTHER, 'mother');
    const before = groundRankedEvidenceV2(request(harness.foundation, MOTHER));
    const beforeAnswer = buildSafeAnswerV2({ type: 'fact', groundingResult: before });
    await harness.reopen();
    const after = groundRankedEvidenceV2(request(harness.foundation, MOTHER));
    const afterAnswer = buildSafeAnswerV2({ type: 'fact', groundingResult: after });
    assert.deepEqual(after, before);
    assert.deepEqual(afterAnswer, beforeAnswer);
  });
}
