import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_STAGE,
  FAKE_PERSISTENCE_CAPABILITIES,
  PERSISTENCE_ADAPTER_METHODS,
  PERSISTENCE_CAPABILITY_MATRIX,
  PersistenceAdapter,
  PersistenceBackup,
  PersistenceCapabilities,
  PersistenceCheckpoint,
  PersistenceError,
  PersistenceHealth,
  PersistenceIntegrity,
  PersistenceRestore,
  PersistenceSnapshot,
  PersistenceTransaction,
  SQLitePersistenceAdapterSkeleton,
  createFakePersistenceAdapter,
  validatePersistenceAdapter,
  validatePersistenceCapabilities,
  validateProductionPersistenceCapabilities
} from './index.js';

const CONTRACT_FIELDS = new Map([
  [PersistenceCapabilities, ['adapterId', 'adapterType', 'contractVersion', 'features']],
  [PersistenceTransaction, ['id', 'state', 'startedAt', 'completedAt', 'metadata']],
  [PersistenceSnapshot, ['id', 'createdAt', 'recordCount', 'checksum', 'checkpointId', 'metadata']],
  [PersistenceBackup, ['id', 'createdAt', 'recordCount', 'checksum', 'format', 'encrypted', 'handle', 'metadata']],
  [PersistenceRestore, ['id', 'backupId', 'status', 'startedAt', 'completedAt', 'restoredCount', 'checksum', 'metadata']],
  [PersistenceHealth, ['status', 'checkedAt', 'latencyMs', 'details']],
  [PersistenceIntegrity, ['status', 'checkedAt', 'recordCount', 'checksum', 'issues']],
  [PersistenceCheckpoint, ['id', 'createdAt', 'recordCount', 'checksum', 'metadata']]
]);

test('PersistenceAdapter freezes one storage-neutral interface', () => {
  assert.equal(PersistenceAdapter.name, 'PersistenceAdapter');
  assert.deepEqual(PersistenceAdapter.requiredMethods, PERSISTENCE_ADAPTER_METHODS);
  assert.deepEqual(PersistenceAdapter.requiredProperties, ['capabilities']);
  assert.ok(Object.isFrozen(PersistenceAdapter));
  assert.ok(Object.isFrozen(PERSISTENCE_ADAPTER_METHODS));
});

for (const [contract, fields] of CONTRACT_FIELDS) {
  test(`${contract.name} freezes its exact contract fields`, () => {
    assert.deepEqual(contract.fields, fields);
    assert.ok(Object.isFrozen(contract));
    assert.ok(Object.isFrozen(contract.fields));
  });
}

test('capability stages are exact and frozen', () => {
  assert.deepEqual(CAPABILITY_STAGE, { REQUIRED: 'required', OPTIONAL: 'optional', FUTURE: 'future' });
  assert.ok(Object.isFrozen(CAPABILITY_STAGE));
});

test('capability matrix classifies every feature once', () => {
  assert.deepEqual(PERSISTENCE_CAPABILITY_MATRIX, {
    transactions: 'required',
    optimisticConcurrency: 'required',
    batchAtomicity: 'required',
    cursorPagination: 'required',
    healthCheck: 'required',
    integrityCheck: 'required',
    snapshots: 'optional',
    backup: 'optional',
    restore: 'optional',
    checkpoints: 'optional',
    encryptionAtRest: 'optional',
    fullTextSearch: 'future',
    vectorSearch: 'future',
    sync: 'future'
  });
  assert.ok(Object.isFrozen(PERSISTENCE_CAPABILITY_MATRIX));
});

test('Fake Persistence declares only implemented capabilities', () => {
  assert.equal(validatePersistenceCapabilities(FAKE_PERSISTENCE_CAPABILITIES).valid, true);
  assert.equal(validateProductionPersistenceCapabilities(FAKE_PERSISTENCE_CAPABILITIES).valid, true);
  assert.equal(FAKE_PERSISTENCE_CAPABILITIES.features.encryptionAtRest, false);
  assert.equal(FAKE_PERSISTENCE_CAPABILITIES.features.vectorSearch, false);
  assert.ok(Object.isFrozen(FAKE_PERSISTENCE_CAPABILITIES.features));
});

test('capability validation rejects missing and unknown features', () => {
  const missing = structuredClone(FAKE_PERSISTENCE_CAPABILITIES);
  delete missing.features.transactions;
  assert.ok(validatePersistenceCapabilities(missing).errors.some((error) => error.path === 'features.transactions'));
  const unknown = structuredClone(FAKE_PERSISTENCE_CAPABILITIES);
  unknown.features.magicStorage = true;
  assert.ok(validatePersistenceCapabilities(unknown).errors.some((error) => error.path === 'features.magicStorage'));
});

test('production capability validation requires every required feature', () => {
  const capabilities = structuredClone(FAKE_PERSISTENCE_CAPABILITIES);
  capabilities.features.transactions = false;
  const validation = validateProductionPersistenceCapabilities(capabilities);
  assert.ok(validation.errors.some((error) => error.path === 'features.transactions'));
});

test('adapter validator accepts Fake Persistence', () => {
  assert.equal(validatePersistenceAdapter(createFakePersistenceAdapter()).valid, true);
});

for (const method of [
  'open', 'close', 'read', 'readMany', 'scan', 'insert', 'update', 'delete',
  'beginTransaction', 'commit', 'rollback', 'createSnapshot', 'createBackup',
  'restore', 'healthCheck', 'integrityCheck', 'createCheckpoint'
]) {
  test(`adapter validator requires ${method}`, () => {
    const adapter = createFakePersistenceAdapter();
    adapter[method] = null;
    assert.ok(validatePersistenceAdapter(adapter).errors.some((error) => error.path === method));
  });
}

test('PersistenceError exposes a stable safe code', () => {
  const error = new PersistenceError('PERSISTENCE_RECORD_NOT_FOUND');
  assert.equal(error.code, 'PERSISTENCE_RECORD_NOT_FOUND');
  assert.equal(error.message.includes('secret'), false);
});

test('SQLite skeleton has no implementation and fails closed', async () => {
  const skeleton = new SQLitePersistenceAdapterSkeleton();
  assert.equal(skeleton.implemented, false);
  assert.equal(validatePersistenceAdapter(skeleton).valid, true);
  await assert.rejects(() => skeleton.open(), (error) => error.code === 'PERSISTENCE_ADAPTER_NOT_IMPLEMENTED');
});
