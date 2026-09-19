import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { decryptBytes, encryptBytes, keyId } from './crypto.js';
import { ownerHash } from './ownerContext.js';

export const RECORD_STORE_SCHEMA_VERSION = 'local-data-space-records-v1';

function error(code) {
  const value = new Error(code);
  value.code = code;
  return value;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw error(code);
  return normalized;
}

function jsonBytes(value) {
  try {
    return Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    throw error('RECORD_PAYLOAD_INVALID');
  }
}

function payloadHash(value) {
  return createHash('sha256').update(jsonBytes(value)).digest('hex');
}

function iso(value, code) {
  try {
    const normalized = new Date(value).toISOString();
    if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(code);
    return normalized;
  } catch {
    throw error(code);
  }
}

export class EncryptedRecordStore {
  constructor({ databasePath, ownerId, spaceId, dataKey, clock = () => new Date() } = {}) {
    this.databasePath = path.resolve(required(databasePath, 'DATABASE_PATH_REQUIRED'));
    this.ownerId = required(ownerId, 'OWNER_REQUIRED');
    this.spaceId = required(spaceId, 'SPACE_ID_REQUIRED');
    this.dataKey = Buffer.from(dataKey || []);
    this.ownerHash = ownerHash(this.ownerId);
    this.clock = clock;
    this.database = null;
    this.opened = false;
  }

  static async open(options = {}) {
    const store = new EncryptedRecordStore(options);
    await store.open();
    return store;
  }

  _requireOpen() {
    if (!this.opened || !this.database) throw error('RECORD_STORE_NOT_OPEN');
  }

  _aad(recordId) {
    return `${this.ownerHash}\u0000${this.spaceId}\u0000${recordId}`;
  }

  _timestamp(value) {
    return value ? iso(value, 'RECORD_TIMESTAMP_INVALID') : iso(this.clock(), 'RECORD_TIMESTAMP_INVALID');
  }

  async open() {
    if (this.opened) return this;
    mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    const existed = existsSync(this.databasePath);
    try {
      this.database = new DatabaseSync(this.databasePath, {
        timeout: 5000,
        enableForeignKeyConstraints: true,
        allowExtension: false
      });
      chmodSync(this.databasePath, 0o600);
      this.database.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
      if (!existed) {
        this.database.exec(`
          CREATE TABLE local_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE local_records (
            record_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            source_id TEXT NOT NULL,
            group_id TEXT,
            relative_path TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            payload TEXT NOT NULL,
            payload_hash TEXT NOT NULL
          );
          CREATE INDEX local_records_kind_created ON local_records(kind, created_at DESC, record_id DESC);
          CREATE INDEX local_records_group_created ON local_records(kind, group_id, created_at DESC, record_id DESC);
        `);
        const insert = this.database.prepare('INSERT INTO local_metadata(key, value) VALUES (?, ?)');
        insert.run('schema_version', RECORD_STORE_SCHEMA_VERSION);
        insert.run('owner_hash', this.ownerHash);
        insert.run('space_id', this.spaceId);
        insert.run('key_id', keyId(this.dataKey));
      } else {
        const metadata = Object.fromEntries(
          this.database.prepare('SELECT key, value FROM local_metadata').all().map((row) => [row.key, row.value])
        );
        if (metadata.schema_version !== RECORD_STORE_SCHEMA_VERSION) throw error('RECORD_STORE_SCHEMA_INVALID');
        if (metadata.owner_hash !== this.ownerHash) throw error('OWNER_MISMATCH');
        if (metadata.space_id !== this.spaceId) throw error('SPACE_MISMATCH');
        if (metadata.key_id !== keyId(this.dataKey)) throw error('KEY_MISMATCH');
      }
      this.opened = true;
      return this;
    } catch (caught) {
      try { this.database?.close(); } catch { /* preserve original failure */ }
      this.database = null;
      this.opened = false;
      if (caught?.code) throw caught;
      throw error('RECORD_STORE_CORRUPT');
    }
  }

  _withTransaction(fn) {
    this._requireOpen();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.database.exec('COMMIT');
      return result;
    } catch (caught) {
      try { this.database.exec('ROLLBACK'); } catch { /* original failure is authoritative */ }
      throw caught;
    }
  }

  _prepareInsert(input = {}) {
    const recordId = required(input.recordId, 'RECORD_ID_REQUIRED');
    const kind = required(input.kind, 'RECORD_KIND_REQUIRED');
    const sourceId = required(input.sourceId, 'SOURCE_ID_REQUIRED');
    const createdAt = this._timestamp(input.createdAt || this.clock());
    const updatedAt = this._timestamp(input.updatedAt || createdAt);
    const encrypted = JSON.stringify(encryptBytes(jsonBytes(input.payload), this.dataKey, { aad: this._aad(recordId) }));
    return {
      recordId,
      kind,
      sourceId,
      groupId: input.groupId ? String(input.groupId) : null,
      relativePath: input.relativePath ? String(input.relativePath) : null,
      createdAt,
      updatedAt,
      encrypted,
      payloadHash: payloadHash(input.payload)
    };
  }

  _insertRow(input) {
    const row = this._prepareInsert(input);
    try {
      this.database.prepare(`
        INSERT INTO local_records(record_id, kind, source_id, group_id, relative_path, created_at, updated_at, payload, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row.recordId, row.kind, row.sourceId, row.groupId, row.relativePath, row.createdAt, row.updatedAt, row.encrypted, row.payloadHash);
    } catch {
      throw error('RECORD_ALREADY_EXISTS');
    }
    return row.recordId;
  }

  _updateRow(recordId, payload, { updatedAt = null } = {}) {
    const id = required(recordId, 'RECORD_ID_REQUIRED');
    const encrypted = JSON.stringify(encryptBytes(jsonBytes(payload), this.dataKey, { aad: this._aad(id) }));
    const updated = this._timestamp(updatedAt || this.clock());
    const result = this.database.prepare(
      'UPDATE local_records SET payload = ?, payload_hash = ?, updated_at = ? WHERE record_id = ?'
    ).run(encrypted, payloadHash(payload), updated, id);
    if (!result.changes) throw error('RECORD_NOT_FOUND');
    return id;
  }

  _deleteRow(recordId) {
    const result = this.database.prepare('DELETE FROM local_records WHERE record_id = ?').run(required(recordId, 'RECORD_ID_REQUIRED'));
    return Number(result.changes || 0);
  }

  async transaction(callback) {
    if (typeof callback !== 'function') throw error('RECORD_TRANSACTION_CALLBACK_REQUIRED');
    this._withTransaction(() => {
      const result = callback({
        insert: (input) => this._insertRow(input),
        update: (recordId, payload, options) => this._updateRow(recordId, payload, options),
        delete: (recordId) => this._deleteRow(recordId)
      });
      if (result && typeof result.then === 'function') throw error('RECORD_TRANSACTION_ASYNC');
    });
    return true;
  }

  async insert(input = {}) {
    const id = required(input.recordId, 'RECORD_ID_REQUIRED');
    await this.transaction(() => this._insertRow(input));
    return this.get(id);
  }

  async update(recordId, payload, options = {}) {
    await this.transaction(() => this._updateRow(recordId, payload, options));
    return this.get(recordId);
  }

  _decode(row) {
    if (!row) return null;
    let payload;
    try {
      payload = JSON.parse(decryptBytes(JSON.parse(row.payload), this.dataKey, { aad: this._aad(row.record_id) }).toString('utf8'));
    } catch {
      throw error('AUTHENTICATION_FAILED');
    }
    if (payloadHash(payload) !== row.payload_hash) throw error('RECORD_INTEGRITY_FAILED');
    return Object.freeze({
      recordId: row.record_id,
      kind: row.kind,
      sourceId: row.source_id,
      groupId: row.group_id,
      relativePath: row.relative_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      payload
    });
  }

  async get(recordId) {
    this._requireOpen();
    return this._decode(this.database.prepare('SELECT * FROM local_records WHERE record_id = ?').get(required(recordId, 'RECORD_ID_REQUIRED')));
  }

  async list({ kind = null, groupId = null, limit = 100000 } = {}) {
    this._requireOpen();
    const bounded = Math.max(1, Math.min(100000, Number(limit) || 1));
    const rows = this.database.prepare(`
      SELECT * FROM local_records
      WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR group_id = ?)
      ORDER BY created_at ASC, record_id ASC LIMIT ?
    `).all(kind, kind, groupId, groupId, bounded);
    return rows.map((row) => this._decode(row));
  }

  async count(kind = null) {
    this._requireOpen();
    const row = this.database.prepare('SELECT COUNT(*) AS total FROM local_records WHERE (? IS NULL OR kind = ?)').get(kind, kind);
    return { total: Number(row?.total || 0) };
  }

  async delete(recordId) {
    await this.transaction(() => this._deleteRow(recordId));
    return true;
  }

  async deleteWhere({ kind = null, groupId = null } = {}) {
    this._requireOpen();
    let result;
    await this.transaction(() => {
      result = this.database.prepare(`
        DELETE FROM local_records
        WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR group_id = ?)
      `).run(kind, kind, groupId, groupId);
    });
    return Number(result?.changes || 0);
  }

  async integrityCheck() {
    this._requireOpen();
    const result = this.database.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (result !== 'ok') throw error('RECORD_STORE_CORRUPT');
    const count = await this.count();
    return Object.freeze({ status: 'ok', recordCount: count.total });
  }

  async vacuum() {
    this._requireOpen();
    this.database.exec('VACUUM');
    return true;
  }

  async close() {
    if (!this.opened) return;
    this.database.close();
    this.database = null;
    this.opened = false;
    this.dataKey.fill(0);
  }
}
