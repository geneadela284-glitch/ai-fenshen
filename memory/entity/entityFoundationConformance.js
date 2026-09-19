import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMemoryRecord as validateMemoryRecordV1 } from '../kernel/index.js';
import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityAlias,
  fakeEntityRelation,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const OWNER_A = ENTITY_TEST_IDS.owner;
const OWNER_B = 'user-entity-contract-b';
const NOW = '2026-07-16T12:00:00.000Z';

function entity(ownerUserId, entityId, overrides = {}) {
  return fakeEntity({
    ownerUserId,
    entityId,
    source: { type: 'user_confirmed', id: `source-${entityId}` },
    ...overrides
  });
}

function addEntity(repository, ownerUserId, entityId, overrides) {
  return repository.create(ownerUserId, entity(ownerUserId, entityId, overrides));
}

async function openForTest(t, createHarness) {
  const harness = await createHarness();
  t.after(async () => harness.close?.());
  return harness.foundation;
}

export function registerEntityFoundationConformance(label, createHarness) {
  test(`${label}: Entity create/read/list is owner-isolated`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    assert.equal(foundation.repository.getById(OWNER_A, ENTITY_TEST_IDS.daughterOne).ownerUserId, OWNER_A);
    assert.equal(foundation.repository.getById(OWNER_B, ENTITY_TEST_IDS.daughterOne), null);
    assert.equal(foundation.repository.listByOwner(OWNER_B).length, 0);
  });

  test(`${label}: ensureSelfEntity is owner-scoped and idempotent`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    const first = foundation.repository.ensureSelfEntity(OWNER_A);
    const second = foundation.repository.ensureSelfEntity(OWNER_A);
    assert.deepEqual(second, first);
    assert.equal(first.ownerUserId, OWNER_A);
    assert.notEqual(first.entityId.includes(OWNER_A), true);
    assert.equal(foundation.repository.listByOwner(OWNER_A, { status: 'active' })
      .filter((value) => value.metadata?.entityRole === 'self').length, 1);
  });

  test(`${label}: one alias can return multiple candidates without merging`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.friendOne);
    addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.friendTwo);
    foundation.aliases.addAlias(OWNER_A, fakeEntityAlias());
    foundation.aliases.addAlias(OWNER_A, fakeEntityAlias({
      entityId: ENTITY_TEST_IDS.friendTwo,
      source: { type: 'user_confirmed', id: 'source-alias-2' }
    }));
    assert.deepEqual(foundation.aliases.findByAlias(OWNER_A, '小王').map((item) => item.entityId), [
      ENTITY_TEST_IDS.friendOne,
      ENTITY_TEST_IDS.friendTwo
    ]);
    assert.deepEqual(foundation.aliases.findByAlias(OWNER_B, '小王'), []);
    foundation.aliases.disableAlias(OWNER_A, '小王', ENTITY_TEST_IDS.friendOne, {
      expectedVersion: 1,
      updatedAt: NOW
    });
    assert.ok(foundation.repository.getById(OWNER_A, ENTITY_TEST_IDS.friendOne));
  });

  test(`${label}: multiple daughter and friend relations use half-open effective time`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    for (const id of [ENTITY_TEST_IDS.self, ENTITY_TEST_IDS.daughterOne, ENTITY_TEST_IDS.daughterTwo,
      ENTITY_TEST_IDS.friendOne, ENTITY_TEST_IDS.friendTwo]) {
      addEntity(foundation.repository, OWNER_A, id);
    }
    const relations = [
      fakeEntityRelation(),
      fakeEntityRelation({ relationId: 'rel_daughter_0002', targetEntityId: ENTITY_TEST_IDS.daughterTwo }),
      fakeEntityRelation({
        relationId: 'rel_friend_000001', targetEntityId: ENTITY_TEST_IDS.friendOne,
        relationKind: 'friend', role: 'friend'
      }),
      fakeEntityRelation({
        relationId: 'rel_friend_000002', targetEntityId: ENTITY_TEST_IDS.friendTwo,
        relationKind: 'friend', role: 'friend'
      })
    ];
    relations.forEach((relation) => foundation.relations.createRelation(OWNER_A, relation));
    const memory = foundation.memories.create(OWNER_A, fakeMemoryRecordV2());
    assert.notEqual(ENTITY_TEST_IDS.daughterOne, ENTITY_TEST_IDS.daughterTwo);
    assert.equal(foundation.relations.listRelations(OWNER_A, { relationKind: 'child' }).length, 2);
    assert.equal(foundation.relations.listRelations(OWNER_A, { relationKind: 'friend' }).length, 2);
    assert.deepEqual(foundation.relations.listRelations(OWNER_B), []);
    const ended = foundation.relations.endRelation(OWNER_A, 'rel_daughter_0001', {
      expectedVersion: 1,
      effectiveTo: '2024-01-01T00:00:00.000Z',
      updatedAt: NOW
    });
    assert.equal(foundation.relations.findEffectiveRelations(OWNER_A, ended.effectiveFrom, {
      relationKind: 'child'
    }).length, 2);
    assert.equal(foundation.relations.findEffectiveRelations(OWNER_A, ended.effectiveTo, {
      relationKind: 'child'
    }).length, 1);
    assert.ok(foundation.repository.getById(OWNER_A, ended.targetEntityId));
    assert.equal(foundation.memories.getById(OWNER_A, memory.memoryId).subjectEntityId,
      ENTITY_TEST_IDS.daughterOne);
  });

  test(`${label}: MemoryRecordV2 is exactly scoped by owner, Entity, predicate, and status`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    const created = foundation.memories.create(OWNER_A, fakeMemoryRecordV2());
    assert.equal(created.subjectEntityId, ENTITY_TEST_IDS.daughterOne);
    assert.equal(foundation.memories.getById(OWNER_B, created.memoryId), null);
    assert.equal(foundation.memories.queryByEntityAndPredicate(
      OWNER_A, ENTITY_TEST_IDS.daughterOne, 'birthday', { status: 'confirmed' }
    ).length, 1);
    assert.equal(foundation.memories.queryByEntityAndPredicate(
      OWNER_A, ENTITY_TEST_IDS.daughterTwo, 'birthday'
    ).length, 0);
    foundation.memories.archive(OWNER_A, created.memoryId, { expectedVersion: 1, updatedAt: NOW });
    assert.equal(foundation.memories.getById(OWNER_A, created.memoryId).status, 'archived');
  });

  test(`${label}: Unit of Work rolls back all writes on failure and CAS conflict`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.friendOne);
    await assert.rejects(foundation.unitOfWork.run({ ownerUserId: OWNER_A }, async ({ repository, aliases }) => {
      aliases.addAlias(OWNER_A, fakeEntityAlias());
      repository.update(OWNER_A, ENTITY_TEST_IDS.friendOne, {
        expectedVersion: 0,
        changes: { metadata: { stale: true }, updatedAt: NOW }
      });
    }), (error) => error?.code === 'CAS_CONFLICT');
    assert.deepEqual(foundation.aliases.findByAlias(OWNER_A, '小王'), []);
    assert.equal(foundation.repository.getById(OWNER_A, ENTITY_TEST_IDS.friendOne).version, 1);
  });

  test(`${label}: repository and Unit of Work idempotency prevent duplicate writes`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    const input = entity(OWNER_A, ENTITY_TEST_IDS.daughterOne);
    foundation.repository.create(OWNER_A, input, { idempotencyKey: 'entity-once' });
    foundation.repository.create(OWNER_A, structuredClone(input), { idempotencyKey: 'entity-once' });
    let runs = 0;
    const execute = () => foundation.unitOfWork.run({ ownerUserId: OWNER_A, idempotencyKey: 'uow-once' }, async () => {
      runs += 1;
      return { ok: true };
    });
    assert.deepEqual(await execute(), { ok: true });
    assert.deepEqual(await execute(), { ok: true });
    assert.equal(runs, 1);
    assert.equal(foundation.repository.listByOwner(OWNER_A).length, 1);
  });

  test(`${label}: owner mismatches fail closed across all repositories`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    for (const callback of [
      () => foundation.repository.create(OWNER_B, entity(OWNER_A, ENTITY_TEST_IDS.daughterOne)),
      () => foundation.aliases.addAlias(OWNER_B, fakeEntityAlias()),
      () => foundation.relations.createRelation(OWNER_B, fakeEntityRelation()),
      () => foundation.memories.create(OWNER_B, fakeMemoryRecordV2())
    ]) assert.throws(callback, (error) => error?.code === 'OWNER_SCOPE_MISMATCH');
  });

  test(`${label}: unknown query filters fail closed instead of widening scope`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    assert.throws(
      () => foundation.repository.listByOwner(OWNER_A, { unsupported: true }),
      (error) => error?.code === 'UNKNOWN_FILTER'
    );
    assert.throws(
      () => foundation.relations.listRelations(OWNER_A, { unsupported: true }),
      (error) => error?.code === 'UNKNOWN_FILTER'
    );
    assert.throws(
      () => foundation.memories.queryByEntityAndPredicate(
        OWNER_A, ENTITY_TEST_IDS.daughterOne, 'birthday', { unsupported: true }
      ),
      (error) => error?.code === 'UNKNOWN_FILTER'
    );
  });

  test(`${label}: V1 and V2 contracts coexist without mutation`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    assert.equal(foundation.memories.create(OWNER_A, fakeMemoryRecordV2()).schemaVersion, 'v2');
    const v1 = {
      id: 'memory-v1-conformance', schemaVersion: 'v1', userId: OWNER_A,
      memoryType: 'fact', subject: 'family:daughter', predicate: 'birthday',
      value: '2018-05-20', normalizedValue: '2018-05-20',
      source: { type: 'user_explicit', id: 'source-v1' }, sourceTimestamp: NOW,
      createdAt: NOW, updatedAt: NOW, effectiveFrom: NOW, effectiveTo: null,
      confidence: 1, importance: 0.8, sensitivity: 'low', status: 'confirmed',
      confirmationStatus: 'user_confirmed', expiresAt: null, version: 1,
      supersedesId: null, supersededById: null, conflictGroupId: null,
      retentionPolicy: {}, accessPolicy: {}, checksum: 'legacy-checksum', tags: [], metadata: {}
    };
    assert.equal(validateMemoryRecordV1(v1, { trustedUserId: OWNER_A }).valid, true);
  });
}
