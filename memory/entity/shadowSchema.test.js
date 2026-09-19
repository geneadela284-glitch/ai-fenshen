import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Entity,
  EntityAlias,
  EntityRelation,
  MemoryRecordV2
} from './contracts.js';

const ShadowSchema = await import('./shadowSchema.js').catch(() => ({}));

test('V2 shadow schema descriptor is isolated and contains no executable migration', () => {
  const descriptor = ShadowSchema.ENTITY_V2_SHADOW_SCHEMA;
  assert.equal(descriptor.id, 'entity-v2-shadow-schema-v1');
  assert.equal(descriptor.targetSchemaVersion, 'v2');
  assert.equal(descriptor.deploymentMode, 'shadow-only');
  assert.equal('databasePath' in descriptor, false);
  assert.equal('sql' in descriptor, false);
  assert.equal('migrate' in ShadowSchema, false);
  assert.ok(Object.isFrozen(descriptor));
});

test('V2 shadow schema tables map exactly to the frozen Kernel contracts', () => {
  const tables = Object.fromEntries(
    ShadowSchema.ENTITY_V2_SHADOW_SCHEMA.tables.map((table) => [table.name, table])
  );
  assert.deepEqual(Object.keys(tables), [
    'entities',
    'entity_aliases',
    'entity_relations',
    'memory_records_v2'
  ]);
  assert.deepEqual(tables.entities.fields, Entity.fields);
  assert.deepEqual(tables.entity_aliases.fields, EntityAlias.fields);
  assert.deepEqual(tables.entity_relations.fields, EntityRelation.fields);
  assert.deepEqual(tables.memory_records_v2.fields, MemoryRecordV2.fields);
  assert.deepEqual(tables.entities.primaryKey, ['ownerUserId', 'entityId']);
  assert.deepEqual(tables.memory_records_v2.primaryKey, ['ownerUserId', 'memoryId']);
});

test('V2 shadow schema descriptor records owner-scoped Entity references', () => {
  const tables = Object.fromEntries(
    ShadowSchema.ENTITY_V2_SHADOW_SCHEMA.tables.map((table) => [table.name, table])
  );
  assert.deepEqual(tables.entity_aliases.foreignKeys, [{
    fields: ['ownerUserId', 'entityId'],
    references: { table: 'entities', fields: ['ownerUserId', 'entityId'] }
  }]);
  assert.deepEqual(tables.memory_records_v2.foreignKeys, [{
    fields: ['ownerUserId', 'subjectEntityId'],
    references: { table: 'entities', fields: ['ownerUserId', 'entityId'] }
  }]);
});
