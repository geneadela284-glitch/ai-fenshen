import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_CONFIRMATIONS,
  MEMORY_EVENT_TYPES,
  MEMORY_IMPORTANCE_RANGE,
  MEMORY_KERNEL_ERROR_CODES,
  MEMORY_KERNEL_TYPE_NAMES,
  MEMORY_RECORD_FIELDS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_TYPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MemoryCandidate,
  MemoryConflict,
  MemoryEvent,
  MemoryPolicy,
  MemoryQuery,
  MemoryRecord,
  MemoryResult,
  MemorySource,
  MemoryVersion,
  createMemoryKernelError
} from './index.js';

const expectedStatuses = [
  'candidate',
  'pending_confirmation',
  'confirmed',
  'disputed',
  'superseded',
  'expired',
  'archived',
  'deleted'
];

const expectedConfirmations = [
  'not_required',
  'pending',
  'user_confirmed',
  'user_rejected',
  'system_verified'
];

const expectedSensitivities = ['public', 'low', 'medium', 'high', 'restricted'];
const expectedSourceTypes = [
  'user_explicit',
  'user_confirmed',
  'structured_system_record',
  'repeated_observation',
  'model_inferred',
  'imported',
  'legacy_unknown'
];
const expectedMemoryTypes = [
  'fact',
  'relationship',
  'preference',
  'goal',
  'life_event',
  'habit_routine',
  'constraint',
  'commitment',
  'decision',
  'context',
  'memory_candidate',
  'sensitive_memory'
];
const expectedEventTypes = [
  'candidate_created',
  'confirmation_requested',
  'confirmed',
  'disputed',
  'superseded',
  'expired',
  'archived',
  'deleted'
];
const expectedRecordFields = [
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
];

test('Memory Kernel schema version is v1', () => {
  assert.equal(MEMORY_SCHEMA_VERSION, 'v1');
});
for (const status of expectedStatuses) {
  test(`MemoryStatus includes ${status}`, () => {
    assert.ok(MEMORY_STATUSES.includes(status));
  });
}

test('MemoryStatus contains only the eight approved values', () => {
  assert.deepEqual(MEMORY_STATUSES, expectedStatuses);
  assert.ok(Object.isFrozen(MEMORY_STATUSES));
});

for (const confirmation of expectedConfirmations) {
  test(`MemoryConfirmation includes ${confirmation}`, () => {
    assert.ok(MEMORY_CONFIRMATIONS.includes(confirmation));
  });
}

test('MemoryConfirmation contains only the five approved values', () => {
  assert.deepEqual(MEMORY_CONFIRMATIONS, expectedConfirmations);
  assert.ok(Object.isFrozen(MEMORY_CONFIRMATIONS));
});

for (const sensitivity of expectedSensitivities) {
  test(`MemorySensitivity includes ${sensitivity}`, () => {
    assert.ok(MEMORY_SENSITIVITIES.includes(sensitivity));
  });
}

test('MemorySensitivity contains only the five approved values', () => {
  assert.deepEqual(MEMORY_SENSITIVITIES, expectedSensitivities);
  assert.ok(Object.isFrozen(MEMORY_SENSITIVITIES));
});

for (const sourceType of expectedSourceTypes) {
  test(`MemorySource type includes ${sourceType}`, () => {
    assert.ok(MEMORY_SOURCE_TYPES.includes(sourceType));
  });
}

test('MemorySource types match the approved trust model', () => {
  assert.deepEqual(MEMORY_SOURCE_TYPES, expectedSourceTypes);
});

for (const memoryType of expectedMemoryTypes) {
  test(`MemoryType includes ${memoryType}`, () => {
    assert.ok(MEMORY_TYPES.includes(memoryType));
  });
}

test('MemoryType matches the approved taxonomy', () => {
  assert.deepEqual(MEMORY_TYPES, expectedMemoryTypes);
});

for (const eventType of expectedEventTypes) {
  test(`MemoryEvent type includes ${eventType}`, () => {
    assert.ok(MEMORY_EVENT_TYPES.includes(eventType));
  });
}

test('MemoryImportance is a numeric zero-to-one range', () => {
  assert.deepEqual(MEMORY_IMPORTANCE_RANGE, { min: 0, max: 1 });
  assert.ok(Object.isFrozen(MEMORY_IMPORTANCE_RANGE));
});

for (const field of expectedRecordFields) {
  test(`MemoryRecord schema includes ${field}`, () => {
    assert.ok(MEMORY_RECORD_FIELDS.includes(field));
  });
}

test('MemoryRecord schema contains only approved M1 fields', () => {
  assert.deepEqual(MEMORY_RECORD_FIELDS, expectedRecordFields);
  assert.equal(MemoryRecord.schemaVersion, 'v1');
  assert.equal(MemoryRecord.unknownFieldPolicy, 'reject');
});

for (const [contract, name] of [
  [MemoryRecord, 'MemoryRecord'],
  [MemoryCandidate, 'MemoryCandidate'],
  [MemorySource, 'MemorySource'],
  [MemoryPolicy, 'MemoryPolicy'],
  [MemoryQuery, 'MemoryQuery'],
  [MemoryResult, 'MemoryResult'],
  [MemoryVersion, 'MemoryVersion'],
  [MemoryConflict, 'MemoryConflict'],
  [MemoryEvent, 'MemoryEvent']
]) {
  test(`${name} is a frozen v1 schema contract`, () => {
    assert.equal(contract.name, name);
    assert.equal(contract.schemaVersion, 'v1');
    assert.ok(Object.isFrozen(contract));
    assert.ok(Object.isFrozen(contract.fields));
    assert.ok(Object.isFrozen(contract.required));
  });
}

for (const typeName of [
  'MemoryRecord',
  'MemoryCandidate',
  'MemorySource',
  'MemoryPolicy',
  'MemoryQuery',
  'MemoryResult',
  'MemoryVersion',
  'MemoryConflict',
  'MemoryStatus',
  'MemoryConfirmation',
  'MemorySensitivity',
  'MemoryImportance',
  'MemoryLifecycle',
  'MemoryEvent',
  'MemoryRepository'
]) {
  test(`Type registry exposes ${typeName}`, () => {
    assert.ok(MEMORY_KERNEL_TYPE_NAMES.includes(typeName));
  });
}

for (const code of [
  'INVALID_TYPE',
  'REQUIRED',
  'UNKNOWN_FIELD',
  'UNSUPPORTED_SCHEMA_VERSION',
  'INVALID_ENUM',
  'INVALID_NUMBER',
  'INVALID_DATE',
  'INVALID_RANGE',
  'USER_SCOPE_REQUIRED',
  'USER_SCOPE_MISMATCH',
  'SOURCE_REQUIRED',
  'MODEL_CONFIRMED_FORBIDDEN',
  'CANDIDATE_STATUS_REQUIRED',
  'CONFIRMATION_REQUIRED',
  'SECRET_FORBIDDEN',
  'INVALID_TRANSITION',
  'INTERFACE_METHOD_MISSING',
  'INVARIANT_VIOLATION'
]) {
  test(`Memory Kernel error registry includes ${code}`, () => {
    assert.ok(MEMORY_KERNEL_ERROR_CODES.includes(code));
  });
}

test('createMemoryKernelError returns a frozen structured error', () => {
  const error = createMemoryKernelError('userId', 'REQUIRED', 'userId is required');
  assert.deepEqual(error, {
    path: 'userId',
    code: 'REQUIRED',
    message: 'userId is required'
  });
  assert.ok(Object.isFrozen(error));
});
