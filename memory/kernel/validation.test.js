import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateMemoryCandidate,
  validateMemoryConflict,
  validateMemoryEvent,
  validateMemoryPolicy,
  validateMemoryQuery,
  validateMemoryRecord,
  validateMemoryResult,
  validateMemorySource,
  validateMemoryVersion
} from './index.js';

const TRUSTED_USER_ID = 'fake-user-a';
const ISO_NOW = '2030-01-02T03:04:05.000Z';

function fakeRecord(overrides = {}) {
  return {
    id: 'fake-memory-001',
    schemaVersion: 'v1',
    userId: TRUSTED_USER_ID,
    memoryType: 'preference',
    subject: 'fake-user-a',
    predicate: 'prefers_drink',
    value: 'tea',
    normalizedValue: 'tea',
    source: { type: 'user_explicit', id: 'fake-source-001' },
    sourceTimestamp: ISO_NOW,
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    effectiveFrom: ISO_NOW,
    effectiveTo: null,
    confidence: 0.85,
    importance: 0.7,
    sensitivity: 'low',
    status: 'confirmed',
    confirmationStatus: 'user_confirmed',
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: { mode: 'until_deleted' },
    accessPolicy: { scope: 'private' },
    checksum: 'fake-checksum-001',
    tags: ['fixture'],
    metadata: { fixture: true },
    ...overrides
  };
}

function hasCode(validation, code, path = null) {
  return validation.errors.some((error) => error.code === code && (path === null || error.path === path));
}

test('valid fake MemoryRecord passes without storage access', () => {
  assert.deepEqual(validateMemoryRecord(fakeRecord(), { trustedUserId: TRUSTED_USER_ID }), {
    valid: true,
    errors: [],
    warnings: []
  });
});
for (const field of [
  'id', 'schemaVersion', 'userId', 'memoryType', 'subject', 'predicate',
  'value', 'normalizedValue', 'source', 'sourceTimestamp', 'createdAt',
  'updatedAt', 'effectiveFrom', 'confidence', 'importance', 'sensitivity',
  'status', 'confirmationStatus', 'version', 'retentionPolicy',
  'accessPolicy', 'metadata'
]) {
  test(`MemoryRecord rejects missing required field ${field}`, () => {
    const record = fakeRecord();
    delete record[field];
    const validation = validateMemoryRecord(record, { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'REQUIRED', field));
  });
}

test('MemoryRecord rejects unknown top-level fields', () => {
  const validation = validateMemoryRecord(fakeRecord({ surprise: true }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'UNKNOWN_FIELD', 'surprise'));
});

test('MemoryRecord rejects a missing trusted user context', () => {
  const validation = validateMemoryRecord(fakeRecord());
  assert.ok(hasCode(validation, 'USER_SCOPE_REQUIRED', 'userId'));
});

test('MemoryRecord rejects a userId that differs from trusted context', () => {
  const validation = validateMemoryRecord(fakeRecord({ userId: 'fake-user-b' }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'USER_SCOPE_MISMATCH', 'userId'));
});

for (const invalidStatus of ['', 'active', 'forgotten', 'needs_confirmation', 'CONFIRMED', null, 1]) {
  test(`MemoryRecord rejects invalid status ${String(invalidStatus)}`, () => {
    const validation = validateMemoryRecord(fakeRecord({ status: invalidStatus }), { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'INVALID_ENUM', 'status'));
  });
}

for (const invalidSensitivity of ['', 'secret', 'critical', 'HIGH', null, 1]) {
  test(`MemoryRecord rejects invalid sensitivity ${String(invalidSensitivity)}`, () => {
    const validation = validateMemoryRecord(fakeRecord({ sensitivity: invalidSensitivity }), { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'INVALID_ENUM', 'sensitivity'));
  });
}

for (const invalidConfirmation of ['', 'confirmed', 'rejected', 'PENDING', null, 1]) {
  test(`MemoryRecord rejects invalid confirmation ${String(invalidConfirmation)}`, () => {
    const validation = validateMemoryRecord(fakeRecord({ confirmationStatus: invalidConfirmation }), { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'INVALID_ENUM', 'confirmationStatus'));
  });
}

for (const invalidConfidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
  test(`MemoryRecord rejects invalid confidence ${String(invalidConfidence)}`, () => {
    const validation = validateMemoryRecord(fakeRecord({ confidence: invalidConfidence }), { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'INVALID_NUMBER', 'confidence'));
  });
}

for (const invalidImportance of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
  test(`MemoryRecord rejects invalid importance ${String(invalidImportance)}`, () => {
    const validation = validateMemoryRecord(fakeRecord({ importance: invalidImportance }), { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'INVALID_NUMBER', 'importance'));
  });
}

for (const invalidSchema of ['', 'v2', '1', 1, null]) {
  test(`MemoryRecord rejects unsupported schema ${String(invalidSchema)}`, () => {
    const validation = validateMemoryRecord(fakeRecord({ schemaVersion: invalidSchema }), { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion'));
  });
}

test('MemorySource rejects a missing source object', () => {
  assert.ok(hasCode(validateMemorySource(null), 'INVALID_TYPE'));
});

test('MemorySource rejects an unknown source type', () => {
  assert.ok(hasCode(validateMemorySource({ type: 'chat_log', id: 'fake-source' }), 'INVALID_ENUM', 'type'));
});

test('MemorySource rejects an empty source id', () => {
  assert.ok(hasCode(validateMemorySource({ type: 'user_explicit', id: '' }), 'SOURCE_REQUIRED', 'id'));
});

test('model_inferred cannot be a confirmed MemoryRecord', () => {
  const validation = validateMemoryRecord(fakeRecord({
    source: { type: 'model_inferred', id: 'fake-model-proposal' },
    status: 'confirmed',
    confirmationStatus: 'system_verified'
  }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'MODEL_CONFIRMED_FORBIDDEN', 'source.type'));
});

test('model_inferred may remain a low-confidence candidate', () => {
  const validation = validateMemoryRecord(fakeRecord({
    source: { type: 'model_inferred', id: 'fake-model-proposal' },
    status: 'candidate',
    confirmationStatus: 'pending',
    confidence: 0.2
  }), { trustedUserId: TRUSTED_USER_ID });
  assert.equal(validation.valid, true);
});

test('high sensitivity confirmed memory requires user confirmation', () => {
  const validation = validateMemoryRecord(fakeRecord({
    sensitivity: 'high',
    confirmationStatus: 'system_verified'
  }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'CONFIRMATION_REQUIRED', 'confirmationStatus'));
});

test('high sensitivity confirmed memory accepts explicit user confirmation', () => {
  const validation = validateMemoryRecord(fakeRecord({
    sensitivity: 'high',
    confirmationStatus: 'user_confirmed'
  }), { trustedUserId: TRUSTED_USER_ID });
  assert.equal(validation.valid, true);
});

for (const secretKey of [
  'password', 'apiKey', 'cookie', 'sessionToken', 'accessToken',
  'refreshToken', 'privateKey', 'recoveryCode', 'fullCardNumber', 'fullIdNumber'
]) {
  test(`MemoryRecord rejects forbidden secret field ${secretKey}`, () => {
    const validation = validateMemoryRecord(fakeRecord({
      metadata: { fixture: true, nested: { [secretKey]: 'fake-secret-canary' } }
    }), { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'SECRET_FORBIDDEN'));
  });
}

test('MemoryRecord rejects effectiveTo before effectiveFrom', () => {
  const validation = validateMemoryRecord(fakeRecord({ effectiveTo: '2029-01-01T00:00:00.000Z' }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'INVALID_RANGE', 'effectiveTo'));
});

for (const field of ['sourceTimestamp', 'createdAt', 'updatedAt', 'effectiveFrom']) {
  test(`MemoryRecord rejects invalid ISO timestamp in ${field}`, () => {
    const validation = validateMemoryRecord(fakeRecord({ [field]: 'not-a-date' }), { trustedUserId: TRUSTED_USER_ID });
    assert.ok(hasCode(validation, 'INVALID_DATE', field));
  });
}

test('MemoryRecord rejects non-positive version', () => {
  const validation = validateMemoryRecord(fakeRecord({ version: 0 }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'INVALID_NUMBER', 'version'));
});

test('MemoryRecord rejects a self supersedes link', () => {
  const validation = validateMemoryRecord(fakeRecord({ supersedesId: 'fake-memory-001' }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'INVARIANT_VIOLATION', 'supersedesId'));
});

test('superseded MemoryRecord requires supersededById', () => {
  const validation = validateMemoryRecord(fakeRecord({
    status: 'superseded',
    confirmationStatus: 'user_confirmed'
  }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'INVARIANT_VIOLATION', 'supersededById'));
});

test('MemoryRecord rejects non-array tags', () => {
  const validation = validateMemoryRecord(fakeRecord({ tags: 'fixture' }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'INVALID_TYPE', 'tags'));
});

test('MemoryRecord rejects non-object metadata', () => {
  const validation = validateMemoryRecord(fakeRecord({ metadata: [] }), { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'INVALID_TYPE', 'metadata'));
});

function fakeCandidate(overrides = {}) {
  return {
    id: 'fake-candidate-001',
    schemaVersion: 'v1',
    userId: TRUSTED_USER_ID,
    proposedMemory: fakeRecord({
      id: 'fake-proposal-001',
      source: { type: 'model_inferred', id: 'fake-model-proposal' },
      status: 'candidate',
      confirmationStatus: 'pending',
      confidence: 0.2
    }),
    source: { type: 'model_inferred', id: 'fake-model-proposal' },
    createdAt: ISO_NOW,
    expiresAt: '2030-01-03T03:04:05.000Z',
    modelGenerated: true,
    metadata: { fixture: true },
    ...overrides
  };
}

test('valid fake MemoryCandidate passes', () => {
  assert.equal(validateMemoryCandidate(fakeCandidate(), { trustedUserId: TRUSTED_USER_ID }).valid, true);
});

test('MemoryCandidate cannot propose confirmed memory', () => {
  const candidate = fakeCandidate();
  candidate.proposedMemory = fakeRecord();
  const validation = validateMemoryCandidate(candidate, { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'CANDIDATE_STATUS_REQUIRED', 'proposedMemory.status'));
});

test('model-generated candidate cannot carry high sensitivity', () => {
  const candidate = fakeCandidate();
  candidate.proposedMemory = fakeRecord({
    source: { type: 'model_inferred', id: 'fake-model-proposal' },
    status: 'candidate',
    confirmationStatus: 'pending',
    confidence: 0.2,
    sensitivity: 'high'
  });
  const validation = validateMemoryCandidate(candidate, { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'CONFIRMATION_REQUIRED', 'proposedMemory.sensitivity'));
});

test('MemoryPolicy accepts object policies', () => {
  assert.equal(validateMemoryPolicy({ retentionPolicy: {}, accessPolicy: {} }).valid, true);
});

test('MemoryPolicy rejects non-object access policy', () => {
  assert.ok(hasCode(validateMemoryPolicy({ retentionPolicy: {}, accessPolicy: 'private' }), 'INVALID_TYPE', 'accessPolicy'));
});

test('MemoryQuery requires trusted user scope', () => {
  assert.ok(hasCode(validateMemoryQuery({ userId: TRUSTED_USER_ID }), 'USER_SCOPE_REQUIRED', 'userId'));
});

test('MemoryQuery rejects cross-user scope', () => {
  const validation = validateMemoryQuery({ userId: 'fake-user-b' }, { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'USER_SCOPE_MISMATCH', 'userId'));
});

test('MemoryResult accepts a successful empty result', () => {
  assert.equal(validateMemoryResult({ ok: true, data: [], error: null, metadata: {} }).valid, true);
});

test('MemoryResult rejects success with an error', () => {
  assert.ok(hasCode(validateMemoryResult({ ok: true, data: [], error: { code: 'fake' }, metadata: {} }), 'INVARIANT_VIOLATION', 'error'));
});

test('MemoryVersion accepts a traceable version', () => {
  assert.equal(validateMemoryVersion({ memoryId: 'fake-memory', version: 2, supersedesId: 'fake-memory-v1', supersededById: null, checksum: 'fake-checksum', createdAt: ISO_NOW }).valid, true);
});

test('MemoryConflict requires at least two memory ids', () => {
  const validation = validateMemoryConflict({ conflictGroupId: 'fake-conflict', userId: TRUSTED_USER_ID, memoryIds: ['fake-memory'], createdAt: ISO_NOW }, { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'INVALID_RANGE', 'memoryIds'));
});

test('MemoryEvent rejects an unknown event type', () => {
  const validation = validateMemoryEvent({ id: 'fake-event', userId: TRUSTED_USER_ID, memoryId: 'fake-memory', eventType: 'written', occurredAt: ISO_NOW, metadata: {} }, { trustedUserId: TRUSTED_USER_ID });
  assert.ok(hasCode(validation, 'INVALID_ENUM', 'eventType'));
});
