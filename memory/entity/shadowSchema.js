import {
  Entity,
  EntityAlias,
  EntityRelation,
  MemoryRecordV2
} from './contracts.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function reference(fields, table, targetFields) {
  return {
    fields,
    references: { table, fields: targetFields }
  };
}

function table(name, contract, primaryKey, foreignKeys = []) {
  return {
    name,
    contract: contract.name,
    fields: contract.fields,
    primaryKey,
    foreignKeys
  };
}

export const ENTITY_V2_SHADOW_SCHEMA = deepFreeze({
  id: 'entity-v2-shadow-schema-v1',
  targetSchemaVersion: 'v2',
  deploymentMode: 'shadow-only',
  tables: [
    table('entities', Entity, ['ownerUserId', 'entityId']),
    table('entity_aliases', EntityAlias, ['ownerUserId', 'alias', 'entityId'], [
      reference(['ownerUserId', 'entityId'], 'entities', ['ownerUserId', 'entityId'])
    ]),
    table('entity_relations', EntityRelation, ['ownerUserId', 'relationId'], [
      reference(['ownerUserId', 'sourceEntityId'], 'entities', ['ownerUserId', 'entityId']),
      reference(['ownerUserId', 'targetEntityId'], 'entities', ['ownerUserId', 'entityId'])
    ]),
    table('memory_records_v2', MemoryRecordV2, ['ownerUserId', 'memoryId'], [
      reference(['ownerUserId', 'subjectEntityId'], 'entities', ['ownerUserId', 'entityId'])
    ])
  ]
});
