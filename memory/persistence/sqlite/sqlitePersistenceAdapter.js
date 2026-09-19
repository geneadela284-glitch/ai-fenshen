import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup as backupDatabase, DatabaseSync } from 'node:sqlite';

import { PERSISTENCE_CAPABILITY_MATRIX, PERSISTENCE_CONTRACT_VERSION } from '../contracts.js';
import { persistenceError } from '../errors.js';
import {
  inspectSQLiteMigrationState,
  resolveMemoryDatabasePath,
  runSQLiteMigrations
} from './migrationRunner.js';
import {
  assertKey,
  assertUserId,
  decodeCursor,
  encodeCursor,
  freezeClone,
  idempotencyParts,
  mapSQLiteError,
  memoryRecordFromRow,
  memoryRecordParameters,
  nowIso,
  parseJson,
  safeDirectory
} from './sqliteAdapterSupport.js';

const OPTIONAL_IMPLEMENTED = new Set(['snapshots', 'backup', 'restore', 'checkpoints']);

export const SQLITE_PERSISTENCE_CAPABILITIES = Object.freeze({
  adapterId: 'memory-sqlite-v1',
  adapterType: 'sqlite',
  contractVersion: PERSISTENCE_CONTRACT_VERSION,
  features: Object.freeze(Object.fromEntries(
    Object.entries(PERSISTENCE_CAPABILITY_MATRIX).map(([feature, stage]) => [
      feature,
      feature === 'encryptionAtRest' ? false : stage === 'required' || OPTIONAL_IMPLEMENTED.has(feature)
    ])
  ))
});

export class SQLitePersistenceAdapter {
  constructor({
    rootDirectory = path.resolve('data/memory'),
    databasePath = 'memory.sqlite',
    backupDirectory = 'backups',
    busyTimeoutMs = 5000,
    readOnly = false,
    clock = () => new Date()
  } = {}) {
    this.capabilities = SQLITE_PERSISTENCE_CAPABILITIES;
    this.rootDirectory = path.resolve(rootDirectory);
    this.databasePath = resolveMemoryDatabasePath({ rootDirectory: this.rootDirectory, databasePath });
    this.backupDirectory = safeDirectory(this.rootDirectory, backupDirectory);
    this.busyTimeoutMs = busyTimeoutMs;
    this.readOnly = readOnly;
    this.clock = clock;
    this.isOpen = false;
    this.writeDb = null;
    this.readDb = null;
    this.activeTransaction = null;
    this.backups = new Map();
  }

  _requireOpen() {
    if (!this.isOpen) throw persistenceError('PERSISTENCE_NOT_OPEN');
  }

  _database(options = {}, mutation = false) {
    this._requireOpen();
    if (mutation && this.readOnly) throw persistenceError('PERSISTENCE_READ_ONLY');
    if (options.transactionId) {
      if (!this.activeTransaction || this.activeTransaction.id !== options.transactionId) {
        throw persistenceError('PERSISTENCE_TRANSACTION_STATE_INVALID');
      }
      return this.writeDb;
    }
    if (mutation && this.activeTransaction) throw persistenceError('PERSISTENCE_TRANSACTION_STATE_INVALID');
    return mutation ? this.writeDb : this.readDb;
  }

  _openConnection(location, readOnly) {
    const db = new DatabaseSync(location, {
      readOnly,
      timeout: this.busyTimeoutMs,
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(this.busyTimeoutMs))}`);
    return db;
  }

  async open() {
    if (this.isOpen) return freezeClone({ opened: true });
    if (this.readOnly && !fs.existsSync(this.databasePath)) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
    if (!this.readOnly) fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    try {
      this.writeDb = this._openConnection(this.databasePath, this.readOnly);
      if (this.readOnly) inspectSQLiteMigrationState(this.writeDb);
      else {
        runSQLiteMigrations(this.writeDb);
        this.writeDb.exec('PRAGMA journal_mode = WAL');
      }
      this.readDb = this.readOnly ? this.writeDb : this._openConnection(this.databasePath, true);
      this.isOpen = true;
      return freezeClone({ opened: true });
    } catch (error) {
      try { this.readDb?.close(); } catch { /* already closed */ }
      try { if (this.writeDb && this.writeDb !== this.readDb) this.writeDb.close(); } catch { /* already closed */ }
      this.readDb = null;
      this.writeDb = null;
      throw mapSQLiteError(error, error?.code?.startsWith('PERSISTENCE_') ? error.code : 'PERSISTENCE_CORRUPT');
    }
  }

  async close() {
    if (!this.isOpen) return freezeClone({ closed: true });
    if (this.activeTransaction) {
      try { this.writeDb.exec('ROLLBACK'); } catch { /* best effort close */ }
      this.activeTransaction = null;
    }
    if (this.readDb && this.readDb !== this.writeDb) this.readDb.close();
    this.writeDb.close();
    this.readDb = null;
    this.writeDb = null;
    this.isOpen = false;
    return freezeClone({ closed: true });
  }

  async read(key, options = {}) {
    assertKey(key);
    if (options.namespace === 'memory') {
      assertUserId(options.userId);
      const row = this._database(options).prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?')
        .get(key, options.userId);
      if (!row) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
      const value = memoryRecordFromRow(row);
      return freezeClone({ key, value, version: value.version });
    }
    if (options.namespace === 'idempotency') {
      assertUserId(options.userId);
      const { operation, idempotencyKey } = idempotencyParts(key, options.userId);
      const row = this._database(options).prepare(
        `SELECT request_hash, record_id, record_ids_json, result_kind, safe_result_json, version
         FROM idempotency_records WHERE user_id = ? AND operation = ? AND idempotency_key = ?`
      ).get(options.userId, operation, idempotencyKey);
      if (!row) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
      return freezeClone({
        key,
        value: {
          requestHash: row.request_hash,
          recordId: row.record_id,
          recordIds: parseJson(row.record_ids_json),
          resultKind: row.result_kind,
          safeResult: parseJson(row.safe_result_json)
        },
        version: row.version
      });
    }
    const row = this._database(options).prepare(
      'SELECT storage_key AS key, value_json AS valueJson, version FROM persistence_records WHERE storage_key = ?'
    ).get(key);
    if (!row) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
    return freezeClone({ key: row.key, value: JSON.parse(row.valueJson), version: row.version });
  }

  async readMany(keys, options = {}) {
    if (!Array.isArray(keys)) throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
    const records = [];
    for (const key of keys) records.push(await this.read(key, options));
    return freezeClone(records);
  }

  async scan(query = {}, options = {}) {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
    const scope = query.namespace || options.namespace || 'generic';
    const offset = decodeCursor(query.cursor, scope);
    if (scope === 'memory') {
      assertUserId(query.userId);
      const rows = this._database(options).prepare(
        'SELECT * FROM memories WHERE user_id = ? ORDER BY id LIMIT ? OFFSET ?'
      ).all(query.userId, limit + 1, offset);
      const items = rows.slice(0, limit).map((row) => {
        const value = memoryRecordFromRow(row);
        return { key: value.id, value, version: value.version };
      });
      return freezeClone({ items, nextCursor: rows.length > limit ? encodeCursor(offset + items.length, scope) : null });
    }
    if (scope === 'idempotency') {
      assertUserId(query.userId);
      const rows = this._database(options).prepare(
        `SELECT operation, idempotency_key, request_hash, record_id, record_ids_json,
                result_kind, safe_result_json, version
         FROM idempotency_records WHERE user_id = ?
         ORDER BY operation, idempotency_key LIMIT ? OFFSET ?`
      ).all(query.userId, limit + 1, offset);
      const items = rows.slice(0, limit).map((row) => ({
        key: `${query.userId}\u0000${row.operation}\u0000${row.idempotency_key}`,
        value: {
          requestHash: row.request_hash,
          recordId: row.record_id,
          recordIds: parseJson(row.record_ids_json),
          resultKind: row.result_kind,
          safeResult: parseJson(row.safe_result_json)
        },
        version: row.version
      }));
      return freezeClone({ items, nextCursor: rows.length > limit ? encodeCursor(offset + items.length, scope) : null });
    }
    if (scope !== 'generic') throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
    const rows = this._database(options).prepare(
      'SELECT storage_key AS key, value_json AS valueJson, version FROM persistence_records ORDER BY storage_key LIMIT ? OFFSET ?'
    ).all(limit + 1, offset);
    const items = rows.slice(0, limit).map((row) => ({ key: row.key, value: JSON.parse(row.valueJson), version: row.version }));
    return freezeClone({ items, nextCursor: rows.length > limit ? encodeCursor(offset + items.length, scope) : null });
  }

  async insert(key, value, options = {}) {
    assertKey(key);
    const db = this._database(options, true);
    if (options.namespace === 'memory') {
      assertUserId(options.userId);
      if (key !== value?.id || value.userId !== options.userId || value.version !== 1) {
        throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
      }
      try {
        db.prepare(`
          INSERT INTO memories(
            id, schema_version, user_id, memory_type, subject_json, predicate, value_json,
            normalized_value_json, summary, source_type, source_id, source_timestamp,
            created_at, updated_at, effective_from, effective_to, confidence, importance,
            sensitivity, status, confirmation_status, expires_at, supersedes_id, superseded_by_id,
            conflict_group_id, retention_policy, access_policy, version, checksum, tags_json,
            metadata_json, deleted_at, purge_after
          ) VALUES (${Array(33).fill('?').join(', ')})
        `).run(...memoryRecordParameters(value));
        return freezeClone({ key, value, version: 1 });
      } catch (error) {
        if (db.prepare('SELECT 1 AS found FROM memories WHERE id = ?').get(key)) {
          throw persistenceError('PERSISTENCE_RECORD_EXISTS');
        }
        throw mapSQLiteError(error);
      }
    }
    if (options.namespace === 'idempotency') {
      assertUserId(options.userId);
      const { operation, idempotencyKey } = idempotencyParts(key, options.userId);
      try {
        db.prepare(`
          INSERT INTO idempotency_records(
            user_id, operation, idempotency_key, request_hash, record_id, record_ids_json,
            result_kind, safe_result_json, version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          options.userId, operation, idempotencyKey, value.requestHash, value.recordId ?? null,
          value.recordIds ? JSON.stringify(value.recordIds) : null, value.resultKind,
          value.safeResult ? JSON.stringify(value.safeResult) : null, nowIso(this.clock)
        );
        return freezeClone({ key, value, version: 1 });
      } catch (error) {
        if (db.prepare(
          'SELECT 1 AS found FROM idempotency_records WHERE user_id = ? AND operation = ? AND idempotency_key = ?'
        ).get(options.userId, operation, idempotencyKey)) throw persistenceError('PERSISTENCE_RECORD_EXISTS');
        throw mapSQLiteError(error);
      }
    }
    try {
      db.prepare('INSERT INTO persistence_records(storage_key, value_json, version, updated_at) VALUES (?, ?, 1, ?)')
        .run(key, JSON.stringify(value), nowIso(this.clock));
      return freezeClone({ key, value, version: 1 });
    } catch (error) {
      if (db.prepare('SELECT 1 AS found FROM persistence_records WHERE storage_key = ?').get(key)) {
        throw persistenceError('PERSISTENCE_RECORD_EXISTS');
      }
      throw mapSQLiteError(error);
    }
  }

  async update(key, value, options = {}) {
    assertKey(key);
    if (!Number.isInteger(options.expectedVersion)) throw persistenceError('PERSISTENCE_EXPECTED_VERSION_REQUIRED');
    const db = this._database(options, true);
    if (options.namespace === 'memory') {
      assertUserId(options.userId);
      if (key !== value?.id || value.userId !== options.userId || value.version !== options.expectedVersion + 1) {
        throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
      }
      const parameters = memoryRecordParameters(value);
      const assignments = [
        'schema_version', 'user_id', 'memory_type', 'subject_json', 'predicate', 'value_json',
        'normalized_value_json', 'summary', 'source_type', 'source_id', 'source_timestamp',
        'created_at', 'updated_at', 'effective_from', 'effective_to', 'confidence', 'importance',
        'sensitivity', 'status', 'confirmation_status', 'expires_at', 'supersedes_id',
        'superseded_by_id', 'conflict_group_id', 'retention_policy', 'access_policy', 'version',
        'checksum', 'tags_json', 'metadata_json', 'deleted_at', 'purge_after'
      ];
      try {
        const result = db.prepare(
          `UPDATE memories SET ${assignments.map((name) => `${name} = ?`).join(', ')}
           WHERE id = ? AND user_id = ? AND version = ?`
        ).run(...parameters.slice(1), key, options.userId, options.expectedVersion);
        if (Number(result.changes) !== 1) {
          const exists = db.prepare('SELECT 1 AS found FROM memories WHERE id = ? AND user_id = ?').get(key, options.userId);
          throw persistenceError(exists ? 'PERSISTENCE_VERSION_CONFLICT' : 'PERSISTENCE_RECORD_NOT_FOUND');
        }
        return freezeClone({ key, value, version: value.version });
      } catch (error) {
        throw mapSQLiteError(error);
      }
    }
    try {
      const result = db.prepare(
        'UPDATE persistence_records SET value_json = ?, version = version + 1, updated_at = ? WHERE storage_key = ? AND version = ?'
      ).run(JSON.stringify(value), nowIso(this.clock), key, options.expectedVersion);
      if (Number(result.changes) !== 1) {
        const exists = db.prepare('SELECT 1 AS found FROM persistence_records WHERE storage_key = ?').get(key);
        throw persistenceError(exists ? 'PERSISTENCE_VERSION_CONFLICT' : 'PERSISTENCE_RECORD_NOT_FOUND');
      }
      return freezeClone({ key, value, version: options.expectedVersion + 1 });
    } catch (error) {
      throw mapSQLiteError(error);
    }
  }

  async delete(key, options = {}) {
    assertKey(key);
    if (!Number.isInteger(options.expectedVersion)) throw persistenceError('PERSISTENCE_EXPECTED_VERSION_REQUIRED');
    const db = this._database(options, true);
    if (options.namespace === 'memory') {
      assertUserId(options.userId);
      try {
        const result = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ? AND version = ?')
          .run(key, options.userId, options.expectedVersion);
        if (Number(result.changes) !== 1) {
          const exists = db.prepare('SELECT 1 AS found FROM memories WHERE id = ? AND user_id = ?').get(key, options.userId);
          throw persistenceError(exists ? 'PERSISTENCE_VERSION_CONFLICT' : 'PERSISTENCE_RECORD_NOT_FOUND');
        }
        return freezeClone({ key, deleted: true, version: options.expectedVersion });
      } catch (error) {
        throw mapSQLiteError(error);
      }
    }
    if (options.namespace === 'idempotency') {
      assertUserId(options.userId);
      const { operation, idempotencyKey } = idempotencyParts(key, options.userId);
      try {
        const result = db.prepare(
          'DELETE FROM idempotency_records WHERE user_id = ? AND operation = ? AND idempotency_key = ? AND version = ?'
        ).run(options.userId, operation, idempotencyKey, options.expectedVersion);
        if (Number(result.changes) !== 1) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
        return freezeClone({ key, deleted: true, version: options.expectedVersion });
      } catch (error) {
        throw mapSQLiteError(error);
      }
    }
    try {
      const result = db.prepare('DELETE FROM persistence_records WHERE storage_key = ? AND version = ?')
        .run(key, options.expectedVersion);
      if (Number(result.changes) !== 1) {
        const exists = db.prepare('SELECT 1 AS found FROM persistence_records WHERE storage_key = ?').get(key);
        throw persistenceError(exists ? 'PERSISTENCE_VERSION_CONFLICT' : 'PERSISTENCE_RECORD_NOT_FOUND');
      }
      return freezeClone({ key, deleted: true, version: options.expectedVersion });
    } catch (error) {
      throw mapSQLiteError(error);
    }
  }

  async beginTransaction() {
    this._requireOpen();
    if (this.readOnly) throw persistenceError('PERSISTENCE_READ_ONLY');
    if (this.activeTransaction) throw persistenceError('PERSISTENCE_NESTED_TRANSACTION_UNSUPPORTED');
    const descriptor = {
      id: `sqlite-transaction-${randomUUID()}`,
      state: 'active',
      startedAt: nowIso(this.clock),
      completedAt: null,
      metadata: {}
    };
    try {
      this.writeDb.exec('BEGIN IMMEDIATE');
      this.activeTransaction = descriptor;
      return freezeClone(descriptor);
    } catch (error) {
      throw mapSQLiteError(error);
    }
  }

  async commit(transactionId) {
    this._requireOpen();
    if (!this.activeTransaction || this.activeTransaction.id !== transactionId) {
      throw persistenceError('PERSISTENCE_TRANSACTION_STATE_INVALID');
    }
    try {
      this.writeDb.exec('COMMIT');
      const result = { ...this.activeTransaction, state: 'committed', completedAt: nowIso(this.clock) };
      this.activeTransaction = null;
      return freezeClone(result);
    } catch (error) {
      throw mapSQLiteError(error, 'PERSISTENCE_TRANSACTION_STATE_INVALID');
    }
  }

  async rollback(transactionId) {
    this._requireOpen();
    if (!this.activeTransaction || this.activeTransaction.id !== transactionId) {
      throw persistenceError('PERSISTENCE_TRANSACTION_STATE_INVALID');
    }
    try {
      this.writeDb.exec('ROLLBACK');
      const result = { ...this.activeTransaction, state: 'rolled_back', completedAt: nowIso(this.clock) };
      this.activeTransaction = null;
      return freezeClone(result);
    } catch (error) {
      throw mapSQLiteError(error, 'PERSISTENCE_TRANSACTION_STATE_INVALID');
    }
  }

  _integrityForDatabase(db) {
    const sqliteResult = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (sqliteResult !== 'ok') throw persistenceError('PERSISTENCE_CORRUPT');
    inspectSQLiteMigrationState(db);
    const genericRows = db.prepare('SELECT storage_key, value_json, version FROM persistence_records ORDER BY storage_key').all();
    const memoryRows = db.prepare('SELECT * FROM memories ORDER BY id').all();
    const issues = [];
    const records = new Map();
    for (const row of memoryRows) {
      try {
        records.set(row.id, memoryRecordFromRow(row));
      } catch {
        issues.push({ recordId: row.id, reasonCode: 'INVALID_MEMORY_RECORD' });
      }
    }
    for (const record of records.values()) {
      for (const [field, relationId] of [['supersedesId', record.supersedesId], ['supersededById', record.supersededById]]) {
        if (!relationId) continue;
        const related = records.get(relationId);
        if (!related) issues.push({ recordId: record.id, reasonCode: `ORPHAN_${field.toUpperCase()}` });
        else if (related.userId !== record.userId) issues.push({ recordId: record.id, reasonCode: 'CROSS_USER_VERSION_RELATION' });
      }
      const seen = new Set([record.id]);
      let current = record;
      while (current.supersededById) {
        current = records.get(current.supersededById);
        if (!current) break;
        if (seen.has(current.id)) {
          issues.push({ recordId: record.id, reasonCode: 'VERSION_CYCLE' });
          break;
        }
        seen.add(current.id);
      }
    }
    const duplicateIdempotency = db.prepare(`
      SELECT user_id FROM idempotency_records
      GROUP BY user_id, operation, idempotency_key HAVING COUNT(*) > 1 LIMIT 1
    `).get();
    if (duplicateIdempotency) issues.push({ recordId: null, reasonCode: 'DUPLICATE_IDEMPOTENCY' });
    const checksum = createHash('sha256')
      .update(JSON.stringify({ genericRows, memoryRows }))
      .digest('hex');
    return { recordCount: genericRows.length + memoryRows.length, checksum, issues };
  }

  async createSnapshot() {
    const integrity = await this.integrityCheck();
    return freezeClone({
      id: `sqlite-snapshot-${randomUUID()}`,
      createdAt: nowIso(this.clock),
      recordCount: integrity.recordCount,
      checksum: integrity.checksum,
      checkpointId: null,
      metadata: {}
    });
  }

  async createBackup() {
    this._requireOpen();
    if (this.activeTransaction) throw persistenceError('PERSISTENCE_TRANSACTION_STATE_INVALID');
    fs.mkdirSync(this.backupDirectory, { recursive: true });
    const id = `sqlite-backup-${randomUUID()}`;
    const targetPath = path.join(this.backupDirectory, `${id}.sqlite`);
    try {
      await backupDatabase(this.writeDb, targetPath);
      const verification = this._verifyDatabaseFile(targetPath);
      const descriptor = {
        id,
        createdAt: nowIso(this.clock),
        recordCount: verification.recordCount,
        checksum: verification.checksum,
        format: 'sqlite-v1',
        encrypted: false,
        handle: `sqlite-backup:${id}`,
        metadata: {}
      };
      this.backups.set(id, { targetPath, descriptor });
      return freezeClone(descriptor);
    } catch (error) {
      try { fs.rmSync(targetPath, { force: true }); } catch { /* best effort */ }
      throw mapSQLiteError(error, 'PERSISTENCE_BACKUP_INVALID');
    }
  }

  _verifyDatabaseFile(targetPath) {
    let db;
    try {
      db = this._openConnection(targetPath, true);
      const integrity = this._integrityForDatabase(db);
      if (integrity.issues.length) throw persistenceError('PERSISTENCE_BACKUP_INVALID');
      return integrity;
    } catch (error) {
      throw mapSQLiteError(error, 'PERSISTENCE_BACKUP_INVALID');
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  async verifyBackup(backupId) {
    const backup = this.backups.get(backupId);
    if (!backup) throw persistenceError('PERSISTENCE_BACKUP_NOT_FOUND');
    const verification = this._verifyDatabaseFile(backup.targetPath);
    if (verification.checksum !== backup.descriptor.checksum) throw persistenceError('PERSISTENCE_BACKUP_INVALID');
    return freezeClone({ status: 'valid', recordCount: verification.recordCount, checksum: verification.checksum });
  }

  async _copyBackupToNewPath(backupId, target) {
    const backup = this.backups.get(backupId);
    if (!backup) throw persistenceError('PERSISTENCE_BACKUP_NOT_FOUND');
    const targetPath = resolveMemoryDatabasePath({ rootDirectory: this.rootDirectory, databasePath: target });
    if (targetPath === this.databasePath) throw persistenceError('PERSISTENCE_PATH_INVALID');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      fs.copyFileSync(backup.targetPath, targetPath, fs.constants.COPYFILE_EXCL);
      const verification = this._verifyDatabaseFile(targetPath);
      if (verification.checksum !== backup.descriptor.checksum) throw persistenceError('PERSISTENCE_BACKUP_INVALID');
      return { targetPath, verification };
    } catch (error) {
      try { fs.rmSync(targetPath, { force: true }); } catch { /* best effort */ }
      throw mapSQLiteError(error, 'PERSISTENCE_BACKUP_INVALID');
    }
  }

  async restoreToNewPath(backupId, target = path.join('restores', `restore-${randomUUID()}.sqlite`)) {
    const { verification } = await this._copyBackupToNewPath(backupId, target);
    return freezeClone({
      id: `sqlite-restore-copy-${randomUUID()}`,
      backupId,
      status: 'completed',
      restoredCount: verification.recordCount,
      checksum: verification.checksum,
      handle: `sqlite-restore:${randomUUID()}`,
      metadata: {}
    });
  }

  async restore(backupId) {
    const startedAt = nowIso(this.clock);
    const { targetPath, verification } = await this._copyBackupToNewPath(
      backupId,
      path.join('restores', `restore-${randomUUID()}.sqlite`)
    );
    await this.close();
    this.databasePath = targetPath;
    this.readOnly = false;
    await this.open();
    return freezeClone({
      id: `sqlite-restore-${randomUUID()}`,
      backupId,
      status: 'completed',
      startedAt,
      completedAt: nowIso(this.clock),
      restoredCount: verification.recordCount,
      checksum: verification.checksum,
      metadata: {}
    });
  }

  async healthCheck() {
    if (!this.isOpen) {
      return freezeClone({ status: 'unavailable', checkedAt: nowIso(this.clock), latencyMs: 0, details: {} });
    }
    const started = Date.now();
    try {
      this.readDb.prepare('SELECT 1 AS ok').get();
      return freezeClone({ status: 'healthy', checkedAt: nowIso(this.clock), latencyMs: Date.now() - started, details: {} });
    } catch {
      return freezeClone({ status: 'unavailable', checkedAt: nowIso(this.clock), latencyMs: Date.now() - started, details: {} });
    }
  }

  async integrityCheck() {
    this._requireOpen();
    try {
      const integrity = this._integrityForDatabase(this.readDb);
      return freezeClone({
        status: integrity.issues.length ? 'invalid' : 'valid',
        checkedAt: nowIso(this.clock),
        recordCount: integrity.recordCount,
        checksum: integrity.checksum,
        issues: integrity.issues
      });
    } catch (error) {
      throw mapSQLiteError(error, 'PERSISTENCE_CORRUPT');
    }
  }

  async createCheckpoint() {
    const integrity = await this.integrityCheck();
    const checkpoint = {
      id: `sqlite-checkpoint-${randomUUID()}`,
      createdAt: nowIso(this.clock),
      recordCount: integrity.recordCount,
      checksum: integrity.checksum,
      metadata: {}
    };
    try {
      this._database({}, true).prepare(
        'INSERT INTO persistence_checkpoints(id, created_at, record_count, checksum, metadata_json) VALUES (?, ?, ?, ?, ?)'
      ).run(checkpoint.id, checkpoint.createdAt, checkpoint.recordCount, checkpoint.checksum, JSON.stringify(checkpoint.metadata));
      return freezeClone(checkpoint);
    } catch (error) {
      throw mapSQLiteError(error);
    }
  }

  async readCheckpoint(checkpointId) {
    assertKey(checkpointId);
    const row = this._database().prepare(
      'SELECT id, created_at AS createdAt, record_count AS recordCount, checksum, metadata_json AS metadataJson FROM persistence_checkpoints WHERE id = ?'
    ).get(checkpointId);
    if (!row) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
    return freezeClone({
      id: row.id,
      createdAt: row.createdAt,
      recordCount: row.recordCount,
      checksum: row.checksum,
      metadata: JSON.parse(row.metadataJson)
    });
  }
}

export function createSQLitePersistenceAdapter(options) {
  return new SQLitePersistenceAdapter(options);
}
