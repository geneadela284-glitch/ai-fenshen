export const MEMORY_SCHEMA_VERSION = 'v1';

function schema(name, fields, required = fields) {
  return Object.freeze({
    name,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    fields: Object.freeze([...fields]),
    required: Object.freeze([...required]),
    unknownFieldPolicy: 'reject'
  });
}

export const MEMORY_RECORD_FIELDS = Object.freeze([
  'id',
  'schemaVersion',
  'userId',
  'memoryType',
  'subject',
  'predicate',
  'value',
  'normalizedValue',
  'source',
  'sourceTimestamp',
  'createdAt',
  'updatedAt',
  'effectiveFrom',
  'effectiveTo',
  'confidence',
  'importance',
  'sensitivity',
  'status',
  'confirmationStatus',
  'expiresAt',
  'version',
  'supersedesId',
  'supersededById',
  'conflictGroupId',
  'retentionPolicy',
  'accessPolicy',
  'checksum',
  'tags',
  'metadata'
]);
export const MemoryRecord = schema('MemoryRecord', MEMORY_RECORD_FIELDS, [
  'id',
  'schemaVersion',
  'userId',
  'memoryType',
  'subject',
  'predicate',
  'value',
  'normalizedValue',
  'source',
  'sourceTimestamp',
  'createdAt',
  'updatedAt',
  'effectiveFrom',
  'effectiveTo',
  'confidence',
  'importance',
  'sensitivity',
  'status',
  'confirmationStatus',
  'version',
  'retentionPolicy',
  'accessPolicy',
  'metadata'
]);

export const MemoryCandidate = schema('MemoryCandidate', [
  'id', 'schemaVersion', 'userId', 'proposedMemory', 'source',
  'createdAt', 'expiresAt', 'modelGenerated', 'metadata'
]);

export const MemorySource = schema('MemorySource', ['type', 'id']);
export const MemoryPolicy = schema('MemoryPolicy', ['retentionPolicy', 'accessPolicy']);
export const MemoryQuery = schema('MemoryQuery', [
  'userId', 'id', 'memoryType', 'memoryTypes', 'status', 'statuses',
  'confirmationStatus', 'confirmationStatuses', 'sensitivityMax', 'sensitivities',
  'subject', 'predicate', 'effectiveAt', 'tags', 'includeHistorical',
  'includeCandidates', 'limit', 'cursor', 'sort'
], ['userId']);
export const MemoryResult = schema('MemoryResult', ['ok', 'data', 'error', 'metadata'], ['ok', 'data', 'error']);
export const MemoryVersion = schema('MemoryVersion', [
  'memoryId', 'version', 'supersedesId', 'supersededById', 'checksum', 'createdAt'
], ['memoryId', 'version', 'createdAt']);
export const MemoryConflict = schema('MemoryConflict', [
  'conflictGroupId', 'userId', 'memoryIds', 'createdAt'
]);
export const MemoryEvent = schema('MemoryEvent', [
  'id', 'userId', 'memoryId', 'eventType', 'occurredAt', 'metadata'
]);
