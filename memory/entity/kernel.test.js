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

const Kernel = await import('./kernel.js').catch(() => ({}));

function expectKernelIssue(callback, path, code) {
  assert.throws(callback, (error) => {
    assert.equal(error?.name, 'EntityKernelValidationError');
    assert.ok(error.issues?.some((entry) => entry.path === path && entry.code === code));
    return true;
  });
}

test('Entity Model V2 Kernel exposes only non-persistent materializers', () => {
  for (const name of [
    'createEntity',
    'createEntityAlias',
    'createEntityRelation',
    'createMemoryRecordV2'
  ]) assert.equal(typeof Kernel[name], 'function', `${name} must exist`);
  assert.equal('save' in Kernel, false);
  assert.equal('migrate' in Kernel, false);
});

test('MemoryRecordV2 Kernel returns the exact frozen contract snapshot', () => {
  const input = fakeMemoryRecordV2();
  const record = Kernel.createMemoryRecordV2(input, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  });
  assert.deepEqual(record, input);
  assert.deepEqual(Object.keys(record), Object.keys(input));
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.structuredValue));
});

test('Entity Kernel returns the exact frozen contract snapshot', () => {
  const input = fakeEntity();
  const entity = Kernel.createEntity(input, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  });
  assert.deepEqual(entity, input);
  assert.deepEqual(Object.keys(entity), Object.keys(input));
  assert.ok(Object.isFrozen(entity));
  assert.ok(Object.isFrozen(entity.source));
});

test('Kernel rejects unknown fields instead of widening a frozen contract', () => {
  expectKernelIssue(
    () => Kernel.createMemoryRecordV2(fakeMemoryRecordV2({ unexpected: true }), {
      trustedOwnerUserId: ENTITY_TEST_IDS.owner
    }),
    'unexpected',
    'UNKNOWN_FIELD'
  );
});

test('Kernel rejects an unknown predicate fail closed', () => {
  expectKernelIssue(
    () => Kernel.createMemoryRecordV2(fakeMemoryRecordV2({
      predicate: 'unknown-predicate',
      structuredValue: {}
    }), { trustedOwnerUserId: ENTITY_TEST_IDS.owner }),
    'predicate',
    'PREDICATE_SCHEMA_MISSING'
  );
});

test('Kernel rejects missing Entity identity fields', () => {
  const entity = fakeEntity();
  delete entity.entityId;
  expectKernelIssue(
    () => Kernel.createEntity(entity, { trustedOwnerUserId: ENTITY_TEST_IDS.owner }),
    'entityId',
    'REQUIRED'
  );

  const memory = fakeMemoryRecordV2();
  delete memory.subjectEntityId;
  expectKernelIssue(
    () => Kernel.createMemoryRecordV2(memory, { trustedOwnerUserId: ENTITY_TEST_IDS.owner }),
    'subjectEntityId',
    'SUBJECT_ENTITY_REQUIRED'
  );
});

test('Kernel rejects semantic and relation-label Entity IDs', () => {
  for (const subjectEntityId of [
    'family:daughter',
    'family:mother',
    'ent_daughter_0001'
  ]) {
    expectKernelIssue(
      () => Kernel.createMemoryRecordV2(fakeMemoryRecordV2({ subjectEntityId }), {
        trustedOwnerUserId: ENTITY_TEST_IDS.owner
      }),
      'subjectEntityId',
      'ENTITY_ID_INVALID'
    );
  }
});

test('MemoryRecordV2 Kernel checksum is deterministic and canonicalizes structuredValue order', () => {
  const firstInput = fakeMemoryRecordV2({ structuredValue: { date: '2018-05-20' } });
  const secondInput = fakeMemoryRecordV2({ structuredValue: Object.fromEntries([
    ['date', '2018-05-20']
  ]) });
  const first = Kernel.createMemoryRecordV2(firstInput, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  });
  const second = Kernel.createMemoryRecordV2(secondInput, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  });
  assert.equal(first.checksum, second.checksum);
});

test('Kernel rejects structuredValue fields and types outside the predicate schema', () => {
  for (const structuredValue of [
    { date: '2018-05-20', timezone: 'Asia/Shanghai' },
    { date: 20180520 }
  ]) {
    assert.throws(
      () => Kernel.createMemoryRecordV2(fakeMemoryRecordV2({ structuredValue }), {
        trustedOwnerUserId: ENTITY_TEST_IDS.owner
      }),
      (error) => error?.issues?.some((entry) => entry.path.startsWith('structuredValue.'))
    );
  }
});

test('equal aliases remain separate EntityAlias records and are never auto-merged', () => {
  const first = Kernel.createEntityAlias(fakeEntityAlias(), {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  });
  const second = Kernel.createEntityAlias(fakeEntityAlias({
    entityId: ENTITY_TEST_IDS.friendTwo,
    source: { type: 'user_confirmed', id: 'source-alias-2' }
  }), { trustedOwnerUserId: ENTITY_TEST_IDS.owner });
  assert.equal(first.alias, second.alias);
  assert.notEqual(first.entityId, second.entityId);
  assert.equal('mergedEntityId' in first, false);
  assert.equal('mergedEntityId' in second, false);
});

test('EntityRelation Kernel materializes relations without generating Entities', () => {
  const relation = Kernel.createEntityRelation(fakeEntityRelation(), {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  });
  assert.deepEqual(relation, fakeEntityRelation());
  assert.equal('entity' in relation, false);
  assert.equal('generatedEntity' in relation, false);
});

test('V1 and V2 Kernel contracts coexist without changing V1 validation', () => {
  const v1 = {
    id: 'fake-memory-v1',
    schemaVersion: 'v1',
    userId: ENTITY_TEST_IDS.owner,
    memoryType: 'fact',
    subject: 'family:daughter',
    predicate: 'birthday',
    value: '2018-05-20',
    normalizedValue: '2018-05-20',
    source: { type: 'user_explicit', id: 'source-v1' },
    sourceTimestamp: '2026-07-16T12:00:00.000Z',
    createdAt: '2026-07-16T12:00:00.000Z',
    updatedAt: '2026-07-16T12:00:00.000Z',
    effectiveFrom: '2026-07-16T12:00:00.000Z',
    effectiveTo: null,
    confidence: 1,
    importance: 0.8,
    sensitivity: 'low',
    status: 'confirmed',
    confirmationStatus: 'user_confirmed',
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: {},
    accessPolicy: {},
    checksum: 'legacy-checksum',
    tags: [],
    metadata: {}
  };
  assert.equal(validateMemoryRecordV1(v1, {
    trustedUserId: ENTITY_TEST_IDS.owner
  }).valid, true);
  assert.equal(Kernel.createMemoryRecordV2(fakeMemoryRecordV2(), {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  }).schemaVersion, 'v2');
});
