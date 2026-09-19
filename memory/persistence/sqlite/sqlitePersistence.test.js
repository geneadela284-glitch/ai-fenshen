import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { PersistenceError } from '../errors.js';
import { createSQLitePersistenceAdapter } from './sqlitePersistenceAdapter.js';

function fixture() {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sqlite-adapter-'));
  const options = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups', busyTimeoutMs: 25 };
  test.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  return options;
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => error instanceof PersistenceError && error.code === code);
}

function fakeMemoryRecord(id, overrides = {}) {
  return {
    id,
    schemaVersion: 'v1',
    userId: 'fake-user-a',
    memoryType: 'fact',
    subject: 'fictional-subject',
    predicate: 'fictional_predicate',
    value: { text: `fictional-${id}` },
    normalizedValue: { text: `fictional-${id}` },
    source: { type: 'user_explicit', id: `fake-source-${id}` },
    sourceTimestamp: '2026-07-15T10:00:00.000Z',
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    effectiveFrom: '2026-07-15T10:00:00.000Z',
    effectiveTo: null,
    confidence: 0.9,
    importance: 0.7,
    sensitivity: 'low',
    status: 'confirmed',
    confirmationStatus: 'not_required',
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: { mode: 'retain' },
    accessPolicy: { scope: 'private' },
    checksum: `fake-checksum-${id}`,
    tags: ['fictional'],
    metadata: { fixture: true },
    ...overrides
  };
}

test('SQLite capabilities are truthful and encryption at rest is false', () => {
  const adapter = createSQLitePersistenceAdapter(fixture());
  assert.equal(adapter.capabilities.adapterType, 'sqlite');
  assert.equal(adapter.capabilities.features.encryptionAtRest, false);
  assert.equal(adapter.capabilities.features.vectorSearch, false);
  assert.equal(adapter.capabilities.features.sync, false);
});

test('SQLite preserves Unicode, arrays, objects, null, and JSON types across reopen', async () => {
  const options = fixture();
  const value = { text: '中文🧠', array: [1, null, false], object: { nested: true } };
  const first = createSQLitePersistenceAdapter(options);
  await first.open();
  await first.insert('unicode-key', value);
  await first.close();

  const reopened = createSQLitePersistenceAdapter(options);
  await reopened.open();
  assert.deepEqual((await reopened.read('unicode-key')).value, value);
  await reopened.close();
});

test('SQL injection strings remain inert values', async () => {
  const adapter = createSQLitePersistenceAdapter(fixture());
  await adapter.open();
  const key = "x'); DROP TABLE persistence_records; --";
  await adapter.insert(key, { text: "'; DROP TABLE memories; --" });
  assert.equal((await adapter.read(key)).key, key);
  assert.equal((await adapter.integrityCheck()).status, 'valid');
  await adapter.close();
});

test('two SQLite connections reject stale optimistic updates', async () => {
  const options = fixture();
  const first = createSQLitePersistenceAdapter(options);
  const second = createSQLitePersistenceAdapter(options);
  await first.open();
  await second.open();
  await first.insert('shared', { n: 1 });
  assert.equal((await first.read('shared')).version, 1);
  assert.equal((await second.read('shared')).version, 1);
  await first.update('shared', { n: 2 }, { expectedVersion: 1 });
  await rejectsCode(() => second.update('shared', { n: 3 }, { expectedVersion: 1 }), 'PERSISTENCE_VERSION_CONFLICT');
  await first.close();
  await second.close();
});

test('an active write transaction locks another connection safely', async () => {
  const options = fixture();
  const first = createSQLitePersistenceAdapter(options);
  const second = createSQLitePersistenceAdapter(options);
  await first.open();
  await second.open();
  const transaction = await first.beginTransaction();
  await first.insert('inside', { ok: true }, { transactionId: transaction.id });
  await rejectsCode(() => second.insert('blocked', { ok: false }), 'PERSISTENCE_LOCKED');
  await first.rollback(transaction.id);
  await first.close();
  await second.close();
});

test('read-only SQLite fails closed on mutation', async () => {
  const options = fixture();
  const writer = createSQLitePersistenceAdapter(options);
  await writer.open();
  await writer.close();
  const reader = createSQLitePersistenceAdapter({ ...options, readOnly: true });
  await reader.open();
  await rejectsCode(() => reader.insert('blocked', { ok: false }), 'PERSISTENCE_READ_ONLY');
  await reader.close();
});

test('corrupt SQLite file fails closed and is not overwritten', async () => {
  const options = fixture();
  const location = path.join(options.rootDirectory, options.databasePath);
  fs.writeFileSync(location, 'not-a-sqlite-database');
  const before = fs.readFileSync(location);
  await rejectsCode(() => createSQLitePersistenceAdapter(options).open(), 'PERSISTENCE_CORRUPT');
  assert.deepEqual(fs.readFileSync(location), before);
});

test('invalid cursor fails without exposing implementation details', async () => {
  const adapter = createSQLitePersistenceAdapter(fixture());
  await adapter.open();
  await rejectsCode(() => adapter.scan({ cursor: 'invalid-cursor' }), 'PERSISTENCE_INVALID_CONTRACT');
  await adapter.close();
});

test('backup verifies and restore switches to a new path without overwriting source', async () => {
  const options = fixture();
  const adapter = createSQLitePersistenceAdapter(options);
  await adapter.open();
  await adapter.insert('alpha', { state: 'before' });
  const backup = await adapter.createBackup();
  assert.equal((await adapter.verifyBackup(backup.id)).status, 'valid');
  await adapter.update('alpha', { state: 'after' }, { expectedVersion: 1 });
  const sourcePath = options.databasePath;
  const restored = await adapter.restore(backup.id);
  assert.equal(restored.status, 'completed');
  assert.equal((await adapter.read('alpha')).value.state, 'before');
  await adapter.close();
  const source = createSQLitePersistenceAdapter({ ...options, databasePath: sourcePath });
  await source.open();
  assert.equal((await source.read('alpha')).value.state, 'after');
  await source.close();
});

test('checkpoint persists and survives reopen', async () => {
  const options = fixture();
  const adapter = createSQLitePersistenceAdapter(options);
  await adapter.open();
  await adapter.insert('alpha', { ok: true });
  const checkpoint = await adapter.createCheckpoint();
  await adapter.close();
  const reopened = createSQLitePersistenceAdapter(options);
  await reopened.open();
  assert.deepEqual(await reopened.readCheckpoint(checkpoint.id), checkpoint);
  await reopened.close();
});

test('closed adapter operations fail closed', async () => {
  const adapter = createSQLitePersistenceAdapter(fixture());
  await adapter.open();
  await adapter.close();
  await rejectsCode(() => adapter.read('anything'), 'PERSISTENCE_NOT_OPEN');
});

test('direct memory storage remains user-scoped and rejects prohibited content', async () => {
  const adapter = createSQLitePersistenceAdapter(fixture());
  await adapter.open();
  const record = fakeMemoryRecord('isolated');
  await adapter.insert(record.id, record, { namespace: 'memory', userId: 'fake-user-a' });
  await rejectsCode(
    () => adapter.read(record.id, { namespace: 'memory', userId: 'fake-user-b' }),
    'PERSISTENCE_RECORD_NOT_FOUND'
  );
  await rejectsCode(
    () => adapter.insert('forbidden', fakeMemoryRecord('forbidden', {
      metadata: { password: 'fictional-prohibited-value' }
    }), { namespace: 'memory', userId: 'fake-user-a' }),
    'PERSISTENCE_INVALID_CONTRACT'
  );
  await adapter.close();
});

test('integrity issues expose only record id and safe reason code', async () => {
  const options = fixture();
  const adapter = createSQLitePersistenceAdapter(options);
  await adapter.open();
  const record = fakeMemoryRecord('integrity-record');
  await adapter.insert(record.id, record, { namespace: 'memory', userId: record.userId });
  const database = new DatabaseSync(path.join(options.rootDirectory, options.databasePath));
  database.prepare('UPDATE memories SET status = ? WHERE id = ?').run('invalid-status', record.id);
  database.close();
  const result = await adapter.integrityCheck();
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.issues, [{ recordId: record.id, reasonCode: 'INVALID_MEMORY_RECORD' }]);
  assert.equal(JSON.stringify(result).includes(record.value.text), false);
  await adapter.close();
});

test('restoreToNewPath returns an opaque safe descriptor', async () => {
  const adapter = createSQLitePersistenceAdapter(fixture());
  await adapter.open();
  await adapter.insert('safe-restore', { fictional: true });
  const backup = await adapter.createBackup();
  const restored = await adapter.restoreToNewPath(backup.id, 'restores/explicit.sqlite');
  assert.equal(restored.status, 'completed');
  assert.equal('targetPath' in restored, false);
  assert.equal(JSON.stringify(restored).includes(path.sep), false);
  await adapter.close();
});

test('SQLite runtime artifacts and backups are ignored by Git', () => {
  const gitignore = new Set(fs.readFileSync(path.resolve('.gitignore'), 'utf8').split(/\r?\n/));
  for (const pattern of ['*.sqlite', '*.sqlite-wal', '*.sqlite-shm', '*.sqlite-journal', '*.sqlite-backup']) {
    assert.equal(gitignore.has(pattern), true, pattern);
  }
});

test('1,000 fictional records paginate without duplicates or omissions', async () => {
  const adapter = createSQLitePersistenceAdapter(fixture());
  await adapter.open();
  const transaction = await adapter.beginTransaction();
  for (let index = 0; index < 1000; index += 1) {
    await adapter.insert(`fake-${String(index).padStart(4, '0')}`, { index, fixture: true }, { transactionId: transaction.id });
  }
  await adapter.commit(transaction.id);
  const keys = [];
  let cursor = null;
  do {
    const page = await adapter.scan({ limit: 73, cursor });
    keys.push(...page.items.map((item) => item.key));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(keys.length, 1000);
  assert.equal(new Set(keys).size, 1000);
  await adapter.close();
});
