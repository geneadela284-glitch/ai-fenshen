import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validatePersistenceAdapter,
  validateProductionPersistenceCapabilities
} from './contracts.js';

const VALUE = Object.freeze({ text: 'fictional-value', fixture: true });

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

export function runPersistenceAdapterConformanceSuite(factory) {
  if (typeof factory !== 'function') throw new TypeError('factory must be a function');

  async function setup() {
    const adapter = factory();
    await adapter.open();
    return adapter;
  }

  test('persistence conformance: adapter surface is valid', () => {
    assert.equal(validatePersistenceAdapter(factory()).valid, true);
  });

  test('persistence conformance: required capabilities are enabled', () => {
    assert.equal(validateProductionPersistenceCapabilities(factory().capabilities).valid, true);
  });

  test('persistence conformance: data operations require open', async () => {
    await rejectsCode(() => factory().read('missing'), 'PERSISTENCE_NOT_OPEN');
  });

  test('persistence conformance: open and close are explicit', async () => {
    const adapter = factory();
    await adapter.open();
    await adapter.close();
    await rejectsCode(() => adapter.read('missing'), 'PERSISTENCE_NOT_OPEN');
  });

  test('persistence conformance: insert starts at version one', async () => {
    const adapter = await setup();
    assert.deepEqual(await adapter.insert('alpha', VALUE), { key: 'alpha', value: VALUE, version: 1 });
  });

  test('persistence conformance: read returns inserted data', async () => {
    const adapter = await setup();
    const inserted = await adapter.insert('alpha', VALUE);
    assert.deepEqual(await adapter.read('alpha'), inserted);
  });

  test('persistence conformance: duplicate insert is rejected', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    await rejectsCode(() => adapter.insert('alpha', VALUE), 'PERSISTENCE_RECORD_EXISTS');
  });

  test('persistence conformance: missing read uses safe not-found', async () => {
    const adapter = await setup();
    await rejectsCode(() => adapter.read('missing'), 'PERSISTENCE_RECORD_NOT_FOUND');
  });

  test('persistence conformance: input mutation cannot change stored data', async () => {
    const adapter = await setup();
    const input = { nested: { value: 'before' } };
    await adapter.insert('alpha', input);
    input.nested.value = 'after';
    assert.equal((await adapter.read('alpha')).value.nested.value, 'before');
  });

  test('persistence conformance: returned data cannot change stored data', async () => {
    const adapter = await setup();
    const result = await adapter.insert('alpha', { nested: { value: 'before' } });
    assert.throws(() => { result.value.nested.value = 'after'; }, TypeError);
    assert.equal((await adapter.read('alpha')).value.nested.value, 'before');
  });

  test('persistence conformance: readMany preserves requested key order', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', { n: 1 });
    await adapter.insert('beta', { n: 2 });
    assert.deepEqual((await adapter.readMany(['beta', 'alpha'])).map((item) => item.key), ['beta', 'alpha']);
  });

  test('persistence conformance: update requires expectedVersion', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    await rejectsCode(() => adapter.update('alpha', { changed: true }), 'PERSISTENCE_EXPECTED_VERSION_REQUIRED');
  });

  test('persistence conformance: update rejects stale expectedVersion', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    await rejectsCode(() => adapter.update('alpha', { changed: true }, { expectedVersion: 2 }), 'PERSISTENCE_VERSION_CONFLICT');
  });

  test('persistence conformance: update increments version once', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    assert.equal((await adapter.update('alpha', { changed: true }, { expectedVersion: 1 })).version, 2);
  });

  test('persistence conformance: delete requires expectedVersion', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    await rejectsCode(() => adapter.delete('alpha'), 'PERSISTENCE_EXPECTED_VERSION_REQUIRED');
  });

  test('persistence conformance: delete removes the record', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    await adapter.delete('alpha', { expectedVersion: 1 });
    await rejectsCode(() => adapter.read('alpha'), 'PERSISTENCE_RECORD_NOT_FOUND');
  });

  test('persistence conformance: scan is stable and paginated', async () => {
    const adapter = await setup();
    for (const key of ['charlie', 'alpha', 'bravo']) await adapter.insert(key, { key });
    const first = await adapter.scan({ limit: 2 });
    const second = await adapter.scan({ limit: 2, cursor: first.nextCursor });
    assert.deepEqual([...first.items, ...second.items].map((item) => item.key), ['alpha', 'bravo', 'charlie']);
    assert.equal(second.nextCursor, null);
  });

  test('persistence conformance: cursor contains no key or value', async () => {
    const adapter = await setup();
    await adapter.insert('private-key-name', { privateText: 'private-value' });
    await adapter.insert('second', { value: 2 });
    const cursor = (await adapter.scan({ limit: 1 })).nextCursor;
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    assert.equal(decoded.includes('private-key-name'), false);
    assert.equal(decoded.includes('private-value'), false);
  });

  test('persistence conformance: transaction reads its own writes', async () => {
    const adapter = await setup();
    const transaction = await adapter.beginTransaction();
    await adapter.insert('alpha', VALUE, { transactionId: transaction.id });
    assert.equal((await adapter.read('alpha', { transactionId: transaction.id })).key, 'alpha');
  });

  test('persistence conformance: uncommitted transaction is externally invisible', async () => {
    const adapter = await setup();
    const transaction = await adapter.beginTransaction();
    await adapter.insert('alpha', VALUE, { transactionId: transaction.id });
    await rejectsCode(() => adapter.read('alpha'), 'PERSISTENCE_RECORD_NOT_FOUND');
  });

  test('persistence conformance: root writes are rejected during an active transaction', async () => {
    const adapter = await setup();
    await adapter.beginTransaction();
    await rejectsCode(() => adapter.insert('outside', VALUE), 'PERSISTENCE_TRANSACTION_STATE_INVALID');
  });

  test('persistence conformance: commit publishes all transaction writes', async () => {
    const adapter = await setup();
    const transaction = await adapter.beginTransaction();
    await adapter.insert('alpha', VALUE, { transactionId: transaction.id });
    await adapter.insert('beta', VALUE, { transactionId: transaction.id });
    assert.equal((await adapter.commit(transaction.id)).state, 'committed');
    assert.deepEqual((await adapter.readMany(['alpha', 'beta'])).map((item) => item.key), ['alpha', 'beta']);
  });

  test('persistence conformance: rollback discards all transaction writes', async () => {
    const adapter = await setup();
    const transaction = await adapter.beginTransaction();
    await adapter.insert('alpha', VALUE, { transactionId: transaction.id });
    assert.equal((await adapter.rollback(transaction.id)).state, 'rolled_back');
    await rejectsCode(() => adapter.read('alpha'), 'PERSISTENCE_RECORD_NOT_FOUND');
  });

  test('persistence conformance: nested transaction is rejected', async () => {
    const adapter = await setup();
    await adapter.beginTransaction();
    await rejectsCode(() => adapter.beginTransaction(), 'PERSISTENCE_NESTED_TRANSACTION_UNSUPPORTED');
  });

  test('persistence conformance: completed transaction cannot be reused', async () => {
    const adapter = await setup();
    const transaction = await adapter.beginTransaction();
    await adapter.commit(transaction.id);
    await rejectsCode(() => adapter.commit(transaction.id), 'PERSISTENCE_TRANSACTION_STATE_INVALID');
  });

  test('persistence conformance: snapshot is an immutable descriptor', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    const snapshot = await adapter.createSnapshot();
    assert.equal(snapshot.recordCount, 1);
    assert.equal(typeof snapshot.checksum, 'string');
    assert.ok(Object.isFrozen(snapshot));
  });

  test('persistence conformance: backup is opaque and immutable', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    const backup = await adapter.createBackup();
    assert.equal(backup.recordCount, 1);
    assert.equal('data' in backup, false);
    assert.ok(Object.isFrozen(backup));
  });

  test('persistence conformance: restore replaces state from backup', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', { state: 'before' });
    const backup = await adapter.createBackup();
    await adapter.update('alpha', { state: 'after' }, { expectedVersion: 1 });
    const restored = await adapter.restore(backup.id);
    assert.equal(restored.status, 'completed');
    assert.equal((await adapter.read('alpha')).value.state, 'before');
  });

  test('persistence conformance: missing backup is rejected', async () => {
    const adapter = await setup();
    await rejectsCode(() => adapter.restore('missing'), 'PERSISTENCE_BACKUP_NOT_FOUND');
  });

  test('persistence conformance: open adapter reports healthy', async () => {
    const adapter = await setup();
    assert.equal((await adapter.healthCheck()).status, 'healthy');
  });

  test('persistence conformance: closed adapter reports unavailable', async () => {
    const adapter = factory();
    assert.equal((await adapter.healthCheck()).status, 'unavailable');
  });

  test('persistence conformance: integrity check reports deterministic checksum', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    const first = await adapter.integrityCheck();
    const second = await adapter.integrityCheck();
    assert.equal(first.status, 'valid');
    assert.equal(first.checksum, second.checksum);
    assert.equal(first.recordCount, 1);
  });

  test('persistence conformance: checkpoint captures current integrity state', async () => {
    const adapter = await setup();
    await adapter.insert('alpha', VALUE);
    const checkpoint = await adapter.createCheckpoint();
    assert.equal(checkpoint.recordCount, 1);
    assert.equal(checkpoint.checksum, (await adapter.integrityCheck()).checksum);
  });
}
