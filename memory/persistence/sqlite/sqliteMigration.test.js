import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { PersistenceError } from '../errors.js';
import {
  MEMORY_SQLITE_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
  inspectSQLiteMigrationState,
  resolveMemoryDatabasePath,
  runSQLiteMigrations
} from './migrationRunner.js';

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sqlite-migration-'));
  test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('memory SQLite path stays inside its trusted root', () => {
  const rootDirectory = temporaryDirectory();
  assert.equal(
    resolveMemoryDatabasePath({ rootDirectory, databasePath: 'memory.sqlite' }),
    path.join(rootDirectory, 'memory.sqlite')
  );
  assert.throws(
    () => resolveMemoryDatabasePath({ rootDirectory, databasePath: '../auth.sqlite' }),
    (error) => error instanceof PersistenceError && error.code === 'PERSISTENCE_PATH_INVALID'
  );
});

test('migration initializes schema v1 and required tables atomically', () => {
  const db = new DatabaseSync(':memory:');
  const state = runSQLiteMigrations(db);
  assert.equal(state.currentVersion, MEMORY_SQLITE_SCHEMA_VERSION);
  assert.deepEqual(state.plan, []);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  for (const table of ['idempotency_records', 'memories', 'migration_history', 'persistence_checkpoints', 'schema_meta']) {
    assert.ok(tables.includes(table), table);
  }
  db.close();
});

test('migration repeat is idempotent and preserves one history row', () => {
  const db = new DatabaseSync(':memory:');
  runSQLiteMigrations(db);
  runSQLiteMigrations(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_history').get().count, 1);
  db.close();
});

test('migration rejects an unknown higher version without overwriting it', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version = 2');
  assert.throws(
    () => runSQLiteMigrations(db),
    (error) => error instanceof PersistenceError && error.code === 'PERSISTENCE_SCHEMA_VERSION_UNSUPPORTED'
  );
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  db.close();
});

test('migration checksum mismatch fails closed', () => {
  const db = new DatabaseSync(':memory:');
  runSQLiteMigrations(db);
  const changed = [{ ...SQLITE_MIGRATIONS[0], checksum: '0'.repeat(64) }];
  assert.throws(
    () => inspectSQLiteMigrationState(db, { migrations: changed }),
    (error) => error instanceof PersistenceError && error.code === 'PERSISTENCE_MIGRATION_CHECKSUM_MISMATCH'
  );
  db.close();
});

test('failed migration rolls back every statement', () => {
  const db = new DatabaseSync(':memory:');
  const migrations = [{ version: 1, name: 'broken', sql: 'CREATE TABLE must_rollback(id TEXT); INVALID SQL;' }];
  assert.throws(
    () => runSQLiteMigrations(db, { migrations }),
    (error) => error instanceof PersistenceError && error.code === 'PERSISTENCE_MIGRATION_FAILED'
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'must_rollback'").get().count, 0);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  db.close();
});
