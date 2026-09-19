import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryQueryV2 } from './memoryQueryV2.js';
import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const OWNER = ENTITY_TEST_IDS.owner;
const OTHER_OWNER = 'user-v2-presence-other';
const ENTITY = ENTITY_TEST_IDS.daughterOne;
const OTHER_ENTITY = ENTITY_TEST_IDS.daughterTwo;
const NOW = '2026-07-17T06:00:00.000Z';

function context(ownerUserId = OWNER, entityId = ENTITY) {
  return {
    ownerUserId,
    now: NOW,
    repositoryGeneration: 'v2-presence-conformance-generation',
    entityResolution: fakeEntityResolution({
      ownerUserId,
      entityId,
      predicate: 'birthday',
      resolvedAt: NOW
    })
  };
}

function query(ownerUserId = OWNER, entityId = ENTITY) {
  return buildMemoryQueryV2(context(ownerUserId, entityId), {
    subjectEntityId: entityId,
    predicate: 'birthday',
    readMode: 'current',
    limit: 20,
    provenancePolicy: 'trusted_v2'
  });
}

function addEntity(foundation, ownerUserId, entityId) {
  foundation.repository.create(ownerUserId, fakeEntity({
    ownerUserId,
    entityId,
    source: { type: 'user_confirmed', id: `entity:${ownerUserId}:${entityId}` }
  }));
}

function addMemory(foundation, overrides) {
  foundation.memories.create(overrides.ownerUserId ?? OWNER, fakeMemoryRecordV2({
    ownerUserId: OWNER,
    subjectEntityId: ENTITY,
    predicate: 'birthday',
    ...structuredClone(overrides)
  }));
}

async function openForTest(t, createHarness) {
  const harness = await createHarness();
  t.after(async () => harness.close?.());
  return harness;
}

export function registerV2PresenceConformance(label, createHarness) {
  test(`${label}: every V2 presence barrier is reported from one exact scope`, async (t) => {
    const harness = await openForTest(t, createHarness);
    addEntity(harness.foundation, OWNER, ENTITY);
    for (const record of [
      { memoryId: 'presence-confirmed' },
      { memoryId: 'presence-deleted', status: 'deleted' },
      { memoryId: 'presence-purged', status: 'deleted', metadata: { purgedMarker: true } },
      { memoryId: 'presence-superseded', status: 'superseded', supersededById: 'presence-current' },
      { memoryId: 'presence-explicit', status: 'archived', metadata: { v2PresenceMarker: true } },
      { memoryId: 'presence-conflict', status: 'disputed', conflictGroupId: 'presence-conflict-group' }
    ]) addMemory(harness.foundation, record);

    const presence = harness.foundation.memories.inspectPresenceByEntityAndPredicate(
      context(),
      query()
    );
    assert.equal(presence.suppressLegacy, true);
    assert.deepEqual(presence.reasons, [
      'confirmed_v2',
      'deleted_tombstone',
      'purged_marker',
      'superseded_chain',
      'explicit_v2_presence',
      'unresolved_conflict'
    ]);
    assert.deepEqual(presence.memoryIds, [
      'presence-confirmed',
      'presence-conflict',
      'presence-deleted',
      'presence-explicit',
      'presence-purged',
      'presence-superseded'
    ]);
  });

  test(`${label}: presence is exact owner Entity predicate scoped without a full scan`, async (t) => {
    const harness = await openForTest(t, createHarness);
    addEntity(harness.foundation, OWNER, ENTITY);
    addEntity(harness.foundation, OWNER, OTHER_ENTITY);
    addEntity(harness.foundation, OTHER_OWNER, ENTITY);
    addMemory(harness.foundation, {
      memoryId: 'presence-wrong-entity',
      subjectEntityId: OTHER_ENTITY,
      status: 'deleted'
    });
    addMemory(harness.foundation, {
      memoryId: 'presence-wrong-owner',
      ownerUserId: OTHER_OWNER,
      status: 'deleted'
    });
    await harness.assertNoFullScan?.();
    const presence = harness.foundation.memories.inspectPresenceByEntityAndPredicate(context(), query());
    assert.equal(presence.suppressLegacy, false);
    assert.deepEqual(presence.memoryIds, []);
  });

  test(`${label}: close and reopen preserves suppression state`, async (t) => {
    const harness = await openForTest(t, createHarness);
    addEntity(harness.foundation, OWNER, ENTITY);
    addMemory(harness.foundation, {
      memoryId: 'presence-restart-deleted',
      status: 'deleted'
    });
    const before = harness.foundation.memories.inspectPresenceByEntityAndPredicate(context(), query());
    await harness.reopen();
    const after = harness.foundation.memories.inspectPresenceByEntityAndPredicate(context(), query());
    assert.deepEqual(after, before);
  });
}
