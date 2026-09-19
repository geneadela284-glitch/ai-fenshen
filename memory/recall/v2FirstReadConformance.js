import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryQueryV2 } from '../entity/memoryQueryV2.js';
import {
  computeLegacyAdapterResultChecksum,
  createLegacyReadAdapterV2
} from './legacyReadAdapterV2.js';
import { executeV2FirstRead } from './v2FirstRead.js';
import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const OWNER = ENTITY_TEST_IDS.owner;
const ENTITY = ENTITY_TEST_IDS.daughterOne;
const NOW = '2026-07-17T06:00:00.000Z';

function request() {
  const context = {
    ownerUserId: OWNER,
    now: NOW,
    repositoryGeneration: 'v2-first-read-conformance-generation',
    entityResolution: fakeEntityResolution({
      ownerUserId: OWNER,
      entityId: ENTITY,
      predicate: 'birthday',
      resolvedAt: NOW
    })
  };
  return {
    context,
    query: buildMemoryQueryV2(context, {
      subjectEntityId: ENTITY,
      predicate: 'birthday',
      readMode: 'current',
      limit: 20,
      provenancePolicy: 'trusted_v2'
    })
  };
}

function legacyResult() {
  const value = {
    legacyMemoryId: 'legacy-conformance-birthday',
    ownerUserId: OWNER,
    mappedSubjectEntityId: ENTITY,
    predicate: 'birthday',
    structuredValue: { date: '2018-05-20' },
    mappingStatus: 'deterministic_mapped',
    mappingEvidence: {
      type: 'stable_mapping_table',
      subjectEntityId: ENTITY,
      evidenceIds: ['mapping:legacy-conformance-birthday']
    },
    adapterVersion: 'legacy-read-adapter-v2',
    source: { type: 'user_confirmed', id: 'legacy-conformance-source' },
    provenance: {
      sourceMode: 'legacy',
      source: { type: 'user_confirmed', id: 'legacy-conformance-source' },
      mappingStatus: 'deterministic_mapped',
      adapterVersion: 'legacy-read-adapter-v2'
    },
    checksum: '',
    effectiveTime: { effectiveFrom: '2018-05-20T00:00:00.000Z', effectiveTo: null }
  };
  value.checksum = computeLegacyAdapterResultChecksum(value);
  return value;
}

function adapter(calls) {
  return createLegacyReadAdapterV2({
    queryExact(scope) {
      calls.push(scope);
      return [legacyResult()];
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
    reasonCodes: ['CONFORMANCE_SCOPE_OK']
  }));
}

function seedEntity(foundation) {
  foundation.repository.create(OWNER, fakeEntity({
    ownerUserId: OWNER,
    entityId: ENTITY,
    source: { type: 'user_confirmed', id: 'v2-first-conformance-entity' }
  }));
}

function execute(foundation, legacyAdapter) {
  return executeV2FirstRead({
    ...request(),
    v2Repository: foundation.memories,
    legacyAdapter,
    queryPurpose: 'answer_exact_person_fact',
    ranker
  });
}

async function openForTest(t, createHarness) {
  const harness = await createHarness();
  t.after(async () => harness.close?.());
  return harness;
}

export function registerV2FirstReadConformance(label, createHarness) {
  test(`${label}: deterministic Legacy fallback passes Ranking and Grounding reread`, async (t) => {
    const harness = await openForTest(t, createHarness);
    seedEntity(harness.foundation);
    const calls = [];
    const result = execute(harness.foundation, adapter(calls));
    assert.equal(result.outcome, 'fact');
    assert.equal(result.sourceMode, 'legacy');
    assert.equal(result.groundingResult.grounded, true);
    assert.equal(result.groundingResult.subjectEntityId, ENTITY);
    assert.ok(calls.length >= 2);
  });

  test(`${label}: deleted V2 tombstone survives reopen and suppresses Legacy`, async (t) => {
    const harness = await openForTest(t, createHarness);
    seedEntity(harness.foundation);
    harness.foundation.memories.create(OWNER, fakeMemoryRecordV2({
      memoryId: 'v2-first-conformance-deleted',
      ownerUserId: OWNER,
      subjectEntityId: ENTITY,
      status: 'deleted'
    }));
    await harness.reopen();
    const calls = [];
    const result = execute(harness.foundation, adapter(calls));
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.v2Presence.suppressLegacy, true);
    assert.ok(result.v2Presence.reasons.includes('deleted_tombstone'));
    assert.equal(calls.length, 0);
  });
}
