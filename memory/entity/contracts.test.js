import assert from 'node:assert/strict';
import test from 'node:test';

const Contracts = await import('./contracts.js').catch(() => ({}));

const expectedEntityFields = [
  'schemaVersion', 'entityId', 'ownerUserId', 'type', 'status', 'version',
  'source', 'checksum', 'createdAt', 'updatedAt', 'metadata'
];
const expectedAliasFields = [
  'schemaVersion', 'alias', 'entityId', 'ownerUserId', 'source', 'confidence',
  'status', 'version', 'createdAt', 'updatedAt', 'metadata'
];
const expectedRelationFields = [
  'schemaVersion', 'relationId', 'ownerUserId', 'sourceEntityId',
  'targetEntityId', 'relationKind', 'role', 'effectiveFrom', 'effectiveTo',
  'status', 'version', 'source', 'checksum', 'createdAt', 'updatedAt', 'metadata'
];
const expectedMemoryFields = [
  'memoryId', 'schemaVersion', 'ownerUserId', 'memoryType', 'subjectEntityId',
  'predicate', 'structuredValue', 'displayValue', 'legacySubject', 'source',
  'provenance', 'sourceTimestamp', 'createdAt', 'updatedAt', 'effectiveFrom', 'effectiveTo',
  'confidence', 'importance', 'sensitivity', 'status', 'confirmationStatus',
  'expiresAt', 'version', 'supersedesId', 'supersededById', 'conflictGroupId',
  'retentionPolicy', 'accessPolicy', 'checksum', 'tags', 'metadata'
];
const expectedResolutionFields = [
  'schemaVersion', 'resolutionStatus', 'ownerUserId', 'entityType', 'entityId',
  'relationKind', 'role', 'predicate', 'candidateEntityIds', 'sourceRelationIds',
  'resolutionReason', 'policyVersion', 'resolvedAt'
];
const expectedMemoryDecisionFields = [
  'schemaVersion', 'decision', 'memoryType', 'ownerUserId', 'subjectEntityId',
  'predicate', 'confidence', 'importance', 'sensitivity', 'retentionPolicy',
  'reasonCodes', 'sourceTextDigest', 'entityResolutionStatus',
  'confirmationRequired', 'acknowledgementPolicy', 'duplicateCheckRequired',
  'suggestedStructuredValue', 'responsePolicy', 'policyVersion', 'decidedAt'
];

test('Entity Model contract module exists', () => {
  assert.equal(typeof Contracts.Entity, 'object');
});

test('Entity contract freezes the approved identity fields', () => {
  assert.equal(Contracts.ENTITY_MODEL_SCHEMA_VERSION, 'v2');
  assert.deepEqual(Contracts.Entity.fields, expectedEntityFields);
  assert.deepEqual(Contracts.Entity.required, expectedEntityFields);
});

test('EntityAlias contract freezes owner-scoped alias evidence', () => {
  assert.deepEqual(Contracts.EntityAlias.fields, expectedAliasFields);
  assert.deepEqual(Contracts.EntityAlias.required, expectedAliasFields);
});

test('EntityRelation contract freezes temporal multi-instance relation fields', () => {
  assert.deepEqual(Contracts.EntityRelation.fields, expectedRelationFields);
  assert.deepEqual(Contracts.EntityRelation.required, expectedRelationFields);
});

test('MemoryRecordV2 contract freezes subjectEntityId and structuredValue', () => {
  assert.deepEqual(Contracts.MemoryRecordV2.fields, expectedMemoryFields);
  assert.ok(Contracts.MemoryRecordV2.required.includes('subjectEntityId'));
  assert.ok(Contracts.MemoryRecordV2.required.includes('structuredValue'));
  for (const field of ['predicate', 'source', 'provenance', 'checksum', 'version']) {
    assert.ok(Contracts.MemoryRecordV2.required.includes(field));
  }
  assert.equal(Contracts.MemoryRecordV2.required.includes('legacySubject'), false);
  assert.equal(Contracts.MemoryRecordV2.required.includes('displayValue'), false);
  assert.equal(Contracts.MemoryRecordV2.fields.includes('subject'), false);
  assert.equal(Contracts.MemoryRecordV2.fields.includes('userId'), false);
  assert.equal(Contracts.MemoryRecordV2.fields.includes('id'), false);
  assert.ok(Contracts.MemoryRecordV2.required.includes('memoryId'));
});

test('MemoryRecordV2 checksum field order is frozen', () => {
  assert.deepEqual(Contracts.MEMORY_RECORD_V2_CHECKSUM_FIELDS, [
    'memoryId',
    'ownerUserId',
    'subjectEntityId',
    'predicate',
    'structuredValue',
    'provenance',
    'version'
  ]);
});

test('birthday structuredValue schema is closed, legacy-date compatible, and calendar aware', () => {
  assert.deepEqual(Contracts.PREDICATE_STRUCTURED_VALUE_SCHEMAS.birthday, {
    fields: ['date', 'calendarType', 'year', 'month', 'day', 'lunarLeapMonth', 'recurrence'],
    required: ['date'],
    fieldTypes: {
      date: 'iso-date', calendarType: 'calendar-type', year: 'year-or-null', month: 'month', day: 'day',
      lunarLeapMonth: 'lunar-leap-month', recurrence: 'recurrence'
    },
    unknownFieldPolicy: 'reject'
  });
  assert.ok(Object.isFrozen(Contracts.PREDICATE_STRUCTURED_VALUE_SCHEMAS));
  assert.ok(Object.isFrozen(Contracts.PREDICATE_STRUCTURED_VALUE_SCHEMAS.birthday));
});

test('preference schemas keep normal multi-value and favorite single-value facts separate', () => {
  assert.deepEqual(Contracts.PREDICATE_STRUCTURED_VALUE_SCHEMAS.preference_statement, {
    fields: ['value', 'values'],
    required: ['value'],
    fieldTypes: { value: 'string', values: 'string-array' },
    unknownFieldPolicy: 'reject'
  });
  assert.deepEqual(Contracts.PREDICATE_STRUCTURED_VALUE_SCHEMAS.favorite_preference_statement, {
    fields: ['value'],
    required: ['value'],
    fieldTypes: { value: 'string' },
    unknownFieldPolicy: 'reject'
  });
  assert.ok(Object.isFrozen(Contracts.PREDICATE_STRUCTURED_VALUE_SCHEMAS.preference_statement));
  assert.ok(Object.isFrozen(Contracts.PREDICATE_STRUCTURED_VALUE_SCHEMAS.favorite_preference_statement));
});

test('EntityResolution contract freezes exact ambiguous and no_match only', () => {
  assert.deepEqual(Contracts.EntityResolution.fields, expectedResolutionFields);
  assert.deepEqual(Contracts.ENTITY_RESOLUTION_STATUSES, ['exact', 'ambiguous', 'no_match']);
});

test('MemoryDecision freezes the six approved actions and separate confidence and importance', () => {
  assert.deepEqual(Contracts.MEMORY_DECISIONS, [
    'answer_only',
    'ignore',
    'temporary_context',
    'store_silently',
    'confirm_before_store',
    'business_record'
  ]);
  assert.deepEqual(Contracts.MemoryDecision.fields, expectedMemoryDecisionFields);
  assert.deepEqual(Contracts.MemoryDecision.required, expectedMemoryDecisionFields);
  assert.notEqual(
    expectedMemoryDecisionFields.indexOf('confidence'),
    expectedMemoryDecisionFields.indexOf('importance')
  );
});

test('MemoryDecision memory types freeze habit_candidate and reject confirmed habit', () => {
  assert.deepEqual(Contracts.MEMORY_DECISION_TYPES, [
    'fact', 'relationship', 'preference', 'goal', 'life_event',
    'habit_candidate', 'decision', 'constraint', 'temporary_context',
    'financial_record', 'schedule_record', 'health_record'
  ]);
  assert.equal(Contracts.MEMORY_DECISION_TYPES.includes('habit'), false);
});

test('all Entity Model V2 schema descriptors are frozen and reject unknown fields', () => {
  for (const contract of [
    Contracts.Entity,
    Contracts.EntityAlias,
    Contracts.EntityRelation,
    Contracts.MemoryRecordV2,
    Contracts.EntityResolution
  ]) {
    assert.equal(contract.schemaVersion, 'v2');
    assert.equal(contract.unknownFieldPolicy, 'reject');
    assert.ok(Object.isFrozen(contract));
    assert.ok(Object.isFrozen(contract.fields));
    assert.ok(Object.isFrozen(contract.required));
  }
});
