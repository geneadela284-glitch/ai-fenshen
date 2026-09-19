import { createHash } from 'node:crypto';
import path from 'node:path';

import { persistenceError } from '../errors.js';

export const MEMORY_SQLITE_SCHEMA_VERSION = 1;

const SCHEMA_V1_SQL = `
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE migration_history (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  user_id TEXT NOT NULL CHECK (length(trim(user_id)) > 0),
  memory_type TEXT NOT NULL,
  subject_json TEXT NOT NULL CHECK (json_valid(subject_json)),
  predicate TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  normalized_value_json TEXT NOT NULL CHECK (json_valid(normalized_value_json)),
  summary TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmation_status TEXT NOT NULL,
  expires_at TEXT,
  supersedes_id TEXT,
  superseded_by_id TEXT,
  conflict_group_id TEXT,
  retention_policy TEXT NOT NULL CHECK (json_valid(retention_policy)),
  access_policy TEXT NOT NULL CHECK (json_valid(access_policy)),
  version INTEGER NOT NULL CHECK (version >= 1),
  checksum TEXT,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  deleted_at TEXT,
  purge_after TEXT
) STRICT;

CREATE INDEX memories_user_status_created_idx ON memories(user_id, status, created_at, id);
CREATE INDEX memories_user_subject_predicate_idx ON memories(user_id, predicate, id);
CREATE INDEX memories_user_conflict_idx ON memories(user_id, conflict_group_id, id);
CREATE INDEX memories_user_supersedes_idx ON memories(user_id, supersedes_id, superseded_by_id);

CREATE TABLE idempotency_records (
  user_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  record_id TEXT,
  record_ids_json TEXT CHECK (record_ids_json IS NULL OR json_valid(record_ids_json)),
  result_kind TEXT NOT NULL,
  safe_result_json TEXT CHECK (safe_result_json IS NULL OR json_valid(safe_result_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation, idempotency_key)
) STRICT;

CREATE TABLE persistence_records (
  storage_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE persistence_checkpoints (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  checksum TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
) STRICT;

INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1');
`;

function migrationChecksum(migration) {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest('hex');
}

const migrationV1 = { version: 1, name: 'memory_schema_v1', sql: SCHEMA_V1_SQL };
export const SQLITE_MIGRATIONS = Object.freeze([
  Object.freeze({ ...migrationV1, checksum: migrationChecksum(migrationV1) })
]);

function normalizedMigrations(migrations) {
  return migrations.map((migration) => ({
    ...migration,
    checksum: migration.checksum || migrationChecksum(migration)
  }));
}

function currentVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version);
}

function tableExists(db, name) {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.found === 1;
}

export function resolveMemoryDatabasePath({
  rootDirectory = path.resolve('data/memory'),
  databasePath = 'memory.sqlite'
} = {}) {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, databasePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw persistenceError('PERSISTENCE_PATH_INVALID');
  return resolved;
}

export function inspectSQLiteMigrationState(db, { migrations = SQLITE_MIGRATIONS } = {}) {
  const ordered = normalizedMigrations(migrations).sort((left, right) => left.version - right.version);
  const latest = ordered.at(-1)?.version || 0;
  const current = currentVersion(db);
  if (current > latest) throw persistenceError('PERSISTENCE_SCHEMA_VERSION_UNSUPPORTED');

  const history = current === 0
    ? []
    : tableExists(db, 'migration_history')
      ? db.prepare('SELECT version, name, checksum, applied_at AS appliedAt FROM migration_history ORDER BY version').all()
      : (() => { throw persistenceError('PERSISTENCE_CORRUPT'); })();

  for (let version = 1; version <= current; version += 1) {
    const expected = ordered.find((migration) => migration.version === version);
    const applied = history.find((entry) => entry.version === version);
    if (!expected || !applied) throw persistenceError('PERSISTENCE_CORRUPT');
    if (expected.checksum !== applied.checksum || expected.name !== applied.name) {
      throw persistenceError('PERSISTENCE_MIGRATION_CHECKSUM_MISMATCH');
    }
  }

  return Object.freeze({
    currentVersion: current,
    latestVersion: latest,
    history: Object.freeze(history.map((entry) => Object.freeze({ ...entry }))),
    plan: Object.freeze(ordered.filter((migration) => migration.version > current).map((migration) => migration.version))
  });
}

export function runSQLiteMigrations(db, { migrations = SQLITE_MIGRATIONS, now = () => new Date() } = {}) {
  const ordered = normalizedMigrations(migrations).sort((left, right) => left.version - right.version);
  let state = inspectSQLiteMigrationState(db, { migrations: ordered });
  for (const migration of ordered.filter((item) => item.version > state.currentVersion)) {
    if (migration.version !== state.currentVersion + 1) throw persistenceError('PERSISTENCE_SCHEMA_VERSION_UNSUPPORTED');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(migration.sql);
      db.prepare('INSERT INTO migration_history(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, migration.checksum, now().toISOString());
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* transaction did not start */ }
      throw persistenceError('PERSISTENCE_MIGRATION_FAILED');
    }
    state = inspectSQLiteMigrationState(db, { migrations: ordered });
  }
  return state;
}
