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

const Foundation = await import('./inMemoryFoundation.js').catch(() => ({}));

const OWNER_A = ENTITY_TEST_IDS.owner;
const OWNER_B = 'user-entity-contract-b';
const NOW = '2026-07-17T00:00:00.000Z';

function createFoundation() {
  const selfIds = [
    ENTITY_TEST_IDS.self,
    'ent_5061728394a5b6c7d8e9fa0b1c2d3e4f'
  ];
  return Foundation.createInMemoryEntityFoundation({
    now: () => NOW,
    entityIdFactory: () => selfIds.shift()
  });
}

function entity(ownerUserId, entityId, overrides = {}) {
  return fakeEntity({ ownerUserId, entityId, ...overrides });
}

function addEntity(repository, ownerUserId, entityId, overrides = {}, options = {}) {
  return repository.create(ownerUserId, entity(ownerUserId, entityId, overrides), options);
}

function seedRelationEntities(foundation) {
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.self);
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.daughterTwo);
}

function hasCode(error, code) {
  return error?.code === code || error?.issues?.some((issue) => issue.code === code);
}

test('Sprint 2A exposes only in-memory repositories and Unit of Work', () => {
  const foundation = createFoundation();
  assert.equal(foundation.repository.constructor.name, 'InMemoryEntityRepository');
  assert.equal(foundation.aliases.constructor.name, 'InMemoryAliasRepository');
  assert.equal(foundation.relations.constructor.name, 'InMemoryRelationRepository');
  assert.equal(foundation.unitOfWork.constructor.name, 'InMemoryMemoryUnitOfWork');
  assert.equal('database' in foundation, false);
  assert.equal('migrate' in foundation, false);
});

test('EntityRepository creates, reads, updates, archives, and lists by owner', () => {
  const { repository } = createFoundation();
  const created = addEntity(repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
  assert.deepEqual(repository.getById(OWNER_A, created.entityId), created);
  assert.deepEqual(repository.listByOwner(OWNER_A), [created]);

  const updated = repository.update(OWNER_A, created.entityId, {
    expectedVersion: 1,
    changes: { metadata: { label: 'first daughter' }, updatedAt: NOW }
  });
  assert.equal(updated.version, 2);
  assert.deepEqual(updated.metadata, { label: 'first daughter' });

  const archived = repository.archive(OWNER_A, created.entityId, {
    expectedVersion: 2,
    updatedAt: NOW
  });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.version, 3);
});

test('cross-owner Entity lookup is a no-match without existence leakage', () => {
  const { repository } = createFoundation();
  addEntity(repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
  assert.equal(repository.getById(OWNER_B, ENTITY_TEST_IDS.daughterOne), null);
  assert.deepEqual(repository.listByOwner(OWNER_B), []);
});

test('ensureSelfEntity is idempotent and separates ownerUserId from opaque selfEntityId', () => {
  const { repository } = createFoundation();
  const first = repository.ensureSelfEntity(OWNER_A);
  const second = repository.ensureSelfEntity(OWNER_A);
  assert.deepEqual(second, first);
  assert.notEqual(first.entityId, first.ownerUserId);
  assert.equal(first.status, 'active');
  assert.equal(repository.listByOwner(OWNER_A).filter((item) => item.metadata.entityRole === 'self').length, 1);
});

test('the same alias can return two Entity candidates without auto-merge', () => {
  const foundation = createFoundation();
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.friendOne);
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.friendTwo);
  foundation.aliases.addAlias(OWNER_A, fakeEntityAlias());
  foundation.aliases.addAlias(OWNER_A, fakeEntityAlias({
    entityId: ENTITY_TEST_IDS.friendTwo,
    source: { type: 'user_confirmed', id: 'source-alias-2' }
  }));
  const candidates = foundation.aliases.findByAlias(OWNER_A, '小王');
  assert.deepEqual(candidates.map((item) => item.entityId).sort(), [
    ENTITY_TEST_IDS.friendOne,
    ENTITY_TEST_IDS.friendTwo
  ].sort());
  assert.equal(foundation.repository.listByOwner(OWNER_A).length, 2);
});

test('two daughters remain two distinct opaque Entities', () => {
  const { repository } = createFoundation();
  const first = addEntity(repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
  const second = addEntity(repository, OWNER_A, ENTITY_TEST_IDS.daughterTwo);
  assert.notEqual(first.entityId, second.entityId);
  assert.equal(repository.listByOwner(OWNER_A).length, 2);
});

test('multiple current daughter relations are valid', () => {
  const foundation = createFoundation();
  seedRelationEntities(foundation);
  foundation.relations.createRelation(OWNER_A, fakeEntityRelation());
  foundation.relations.createRelation(OWNER_A, fakeEntityRelation({
    relationId: 'rel_daughter_0002',
    targetEntityId: ENTITY_TEST_IDS.daughterTwo,
    source: { type: 'user_confirmed', id: 'source-relation-2' }
  }));
  const relations = foundation.relations.listRelations(OWNER_A, {
    relationKind: 'child',
    role: 'daughter',
    status: 'active'
  });
  assert.equal(relations.length, 2);
});

test('multiple friend and colleague relations are valid without relationKind uniqueness', () => {
  const foundation = createFoundation();
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.self);
  for (const id of [ENTITY_TEST_IDS.friendOne, ENTITY_TEST_IDS.friendTwo]) {
    addEntity(foundation.repository, OWNER_A, id);
  }
  foundation.relations.createRelation(OWNER_A, fakeEntityRelation({
    relationId: 'rel_friend_000001',
    targetEntityId: ENTITY_TEST_IDS.friendOne,
    relationKind: 'friend',
    role: 'friend'
  }));
  foundation.relations.createRelation(OWNER_A, fakeEntityRelation({
    relationId: 'rel_friend_000002',
    targetEntityId: ENTITY_TEST_IDS.friendTwo,
    relationKind: 'friend',
    role: 'friend'
  }));
  foundation.relations.createRelation(OWNER_A, fakeEntityRelation({
    relationId: 'rel_colleague_001',
    targetEntityId: ENTITY_TEST_IDS.friendTwo,
    relationKind: 'colleague',
    role: 'colleague'
  }));
  assert.equal(foundation.relations.listRelations(OWNER_A, { relationKind: 'friend' }).length, 2);
  assert.equal(foundation.relations.listRelations(OWNER_A, { relationKind: 'colleague' }).length, 1);
});

test('effective relation queries use [effectiveFrom, effectiveTo) semantics', () => {
  const foundation = createFoundation();
  seedRelationEntities(foundation);
  foundation.relations.createRelation(OWNER_A, fakeEntityRelation({
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    effectiveTo: '2022-01-01T00:00:00.000Z',
    status: 'ended'
  }));
  assert.equal(foundation.relations.findEffectiveRelations(OWNER_A, '2019-12-31T23:59:59.999Z').length, 0);
  assert.equal(foundation.relations.findEffectiveRelations(OWNER_A, '2020-01-01T00:00:00.000Z').length, 1);
  assert.equal(foundation.relations.findEffectiveRelations(OWNER_A, '2021-12-31T23:59:59.999Z').length, 1);
  assert.equal(foundation.relations.findEffectiveRelations(OWNER_A, '2022-01-01T00:00:00.000Z').length, 0);
});

test('ending a relation does not delete either Entity', () => {
  const foundation = createFoundation();
  seedRelationEntities(foundation);
  const relation = foundation.relations.createRelation(OWNER_A, fakeEntityRelation());
  foundation.relations.endRelation(OWNER_A, relation.relationId, {
    expectedVersion: 1,
    effectiveTo: '2024-01-01T00:00:00.000Z',
    updatedAt: NOW
  });
  assert.ok(foundation.repository.getById(OWNER_A, relation.sourceEntityId));
  assert.ok(foundation.repository.getById(OWNER_A, relation.targetEntityId));
  assert.equal(foundation.relations.findEffectiveRelations(OWNER_A, '2024-01-01T00:00:00.000Z').length, 0);
});

test('ending a relation never rebinds an existing MemoryRecordV2', () => {
  const foundation = createFoundation();
  seedRelationEntities(foundation);
  const relation = foundation.relations.createRelation(OWNER_A, fakeEntityRelation());
  const memory = foundation.memories.create(OWNER_A, fakeMemoryRecordV2());
  foundation.relations.endRelation(OWNER_A, relation.relationId, {
    expectedVersion: 1,
    effectiveTo: '2024-01-01T00:00:00.000Z',
    updatedAt: NOW
  });
  assert.equal(
    foundation.memories.getById(OWNER_A, memory.memoryId).subjectEntityId,
    ENTITY_TEST_IDS.daughterOne
  );
});

test('disabling an alias does not delete its Entity', () => {
  const foundation = createFoundation();
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.friendOne);
  foundation.aliases.addAlias(OWNER_A, fakeEntityAlias());
  foundation.aliases.disableAlias(OWNER_A, '小王', ENTITY_TEST_IDS.friendOne, {
    expectedVersion: 1,
    updatedAt: NOW
  });
  assert.deepEqual(foundation.aliases.findByAlias(OWNER_A, '小王'), []);
  assert.ok(foundation.repository.getById(OWNER_A, ENTITY_TEST_IDS.friendOne));
});

test('Unit of Work rolls back every staged write when any step fails', async () => {
  const foundation = createFoundation();
  await assert.rejects(
    foundation.unitOfWork.run({ ownerUserId: OWNER_A }, async ({ repository, aliases }) => {
      addEntity(repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
      aliases.addAlias(OWNER_A, fakeEntityAlias({ entityId: ENTITY_TEST_IDS.friendOne }));
    }),
    (error) => hasCode(error, 'ENTITY_NOT_FOUND')
  );
  assert.equal(foundation.repository.getById(OWNER_A, ENTITY_TEST_IDS.daughterOne), null);
  assert.deepEqual(foundation.aliases.findByAlias(OWNER_A, '小王'), []);
});

test('Entity version updates use CAS and reject stale overwrites', () => {
  const { repository } = createFoundation();
  const created = addEntity(repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
  repository.update(OWNER_A, created.entityId, {
    expectedVersion: 1,
    changes: { metadata: { revision: 2 }, updatedAt: NOW }
  });
  assert.throws(
    () => repository.update(OWNER_A, created.entityId, {
      expectedVersion: 1,
      changes: { metadata: { stale: true }, updatedAt: NOW }
    }),
    (error) => hasCode(error, 'CAS_CONFLICT')
  );
  assert.deepEqual(repository.getById(OWNER_A, created.entityId).metadata, { revision: 2 });
});

test('a CAS conflict inside Unit of Work rolls back other staged writes', async () => {
  const foundation = createFoundation();
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.friendOne);
  await assert.rejects(
    foundation.unitOfWork.run({ ownerUserId: OWNER_A }, async ({ repository, aliases }) => {
      aliases.addAlias(OWNER_A, fakeEntityAlias());
      repository.update(OWNER_A, ENTITY_TEST_IDS.friendOne, {
        expectedVersion: 0,
        changes: { metadata: { stale: true }, updatedAt: NOW }
      });
    }),
    (error) => hasCode(error, 'CAS_CONFLICT')
  );
  assert.deepEqual(foundation.aliases.findByAlias(OWNER_A, '小王'), []);
  assert.equal(foundation.repository.getById(OWNER_A, ENTITY_TEST_IDS.friendOne).version, 1);
});

test('idempotency keys prevent duplicate create and duplicate Unit of Work execution', async () => {
  const foundation = createFoundation();
  const input = entity(OWNER_A, ENTITY_TEST_IDS.daughterOne);
  const first = foundation.repository.create(OWNER_A, input, { idempotencyKey: 'create-daughter-1' });
  const second = foundation.repository.create(OWNER_A, structuredClone(input), { idempotencyKey: 'create-daughter-1' });
  assert.deepEqual(second, first);
  assert.equal(foundation.repository.listByOwner(OWNER_A).length, 1);

  let executions = 0;
  const context = { ownerUserId: OWNER_A, idempotencyKey: 'uow-once' };
  const run = () => foundation.unitOfWork.run(context, async () => {
    executions += 1;
    return { ok: true };
  });
  assert.deepEqual(await run(), { ok: true });
  assert.deepEqual(await run(), { ok: true });
  assert.equal(executions, 1);
});

test('owner mismatch fails closed for Entity, Alias, Relation, and Memory writes', async () => {
  const foundation = createFoundation();
  for (const callback of [
    () => foundation.repository.create(OWNER_B, entity(OWNER_A, ENTITY_TEST_IDS.daughterOne)),
    () => foundation.aliases.addAlias(OWNER_B, fakeEntityAlias()),
    () => foundation.relations.createRelation(OWNER_B, fakeEntityRelation()),
    () => foundation.memories.create(OWNER_B, fakeMemoryRecordV2())
  ]) assert.throws(callback, (error) => hasCode(error, 'OWNER_SCOPE_MISMATCH'));

  await assert.rejects(
    foundation.unitOfWork.run({ ownerUserId: OWNER_A }, async ({ repository }) => {
      repository.create(OWNER_B, entity(OWNER_B, ENTITY_TEST_IDS.daughterOne));
    }),
    (error) => hasCode(error, 'OWNER_SCOPE_MISMATCH')
  );
});

test('Unit of Work can atomically write Entity, Alias, Relation, and MemoryRecordV2', async () => {
  const foundation = createFoundation();
  await foundation.unitOfWork.run({
    ownerUserId: OWNER_A,
    idempotencyKey: 'complete-entity-write'
  }, async ({ repository, aliases, relations, memories }) => {
    addEntity(repository, OWNER_A, ENTITY_TEST_IDS.self);
    addEntity(repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    aliases.addAlias(OWNER_A, fakeEntityAlias({ entityId: ENTITY_TEST_IDS.daughterOne }));
    relations.createRelation(OWNER_A, fakeEntityRelation());
    memories.create(OWNER_A, fakeMemoryRecordV2());
  });
  assert.equal(foundation.repository.listByOwner(OWNER_A).length, 2);
  assert.equal(foundation.aliases.findByAlias(OWNER_A, '小王').length, 1);
  assert.equal(foundation.relations.listRelations(OWNER_A).length, 1);
  assert.ok(foundation.memories.getById(OWNER_A, 'memory-v2-0001'));
});

test('V1 and V2 remain independent and valid in the same process', () => {
  const foundation = createFoundation();
  addEntity(foundation.repository, OWNER_A, ENTITY_TEST_IDS.daughterOne);
  const v2 = foundation.memories.create(OWNER_A, fakeMemoryRecordV2());
  const v1 = {
    id: 'memory-v1-0001', schemaVersion: 'v1', userId: OWNER_A,
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
  assert.equal(v2.schemaVersion, 'v2');
});
