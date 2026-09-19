import { createHash } from 'node:crypto';

import { PERSISTENCE_CAPABILITY_MATRIX, PERSISTENCE_CONTRACT_VERSION } from './contracts.js';
import { persistenceError } from './errors.js';

const OPTIONAL_IMPLEMENTED = new Set(['snapshots', 'backup', 'restore', 'checkpoints']);

export const FAKE_PERSISTENCE_CAPABILITIES = Object.freeze({
  adapterId: 'fake-persistence',
  adapterType: 'fake',
  contractVersion: PERSISTENCE_CONTRACT_VERSION,
  features: Object.freeze(Object.fromEntries(
    Object.entries(PERSISTENCE_CAPABILITY_MATRIX).map(([feature, stage]) => [
      feature,
      stage === 'required' || OPTIONAL_IMPLEMENTED.has(feature)
    ])
  ))
});

function clone(value) {
  return structuredClone(value);
}

function freezeClone(value) {
  const output = clone(value);
  const pending = [output];
  while (pending.length) {
    const current = pending.pop();
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      Object.freeze(current);
      pending.push(...Object.values(current));
    }
  }
  return output;
}

function cloneRecords(records) {
  return new Map([...records].map(([key, record]) => [key, clone(record)]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function checksum(records) {
  const entries = [...records].sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(canonical(entries))).digest('hex');
}

function assertKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
}

export class FakePersistenceAdapter {
  constructor({ clock = () => new Date() } = {}) {
    this.capabilities = FAKE_PERSISTENCE_CAPABILITIES;
    this.clock = clock;
    this.isOpen = false;
    this.records = new Map();
    this.transactions = new Map();
    this.backups = new Map();
    this.activeTransactionId = null;
    this.sequence = 0;
  }

  _now() {
    const value = this.clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  _id(prefix) {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  _requireOpen() {
    if (!this.isOpen) throw persistenceError('PERSISTENCE_NOT_OPEN');
  }

  _transaction(transactionId) {
    const transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.descriptor.state !== 'active') {
      throw persistenceError('PERSISTENCE_TRANSACTION_STATE_INVALID');
    }
    return transaction;
  }

  _records(options = {}, mutation = false) {
    this._requireOpen();
    if (options.transactionId) return this._transaction(options.transactionId).records;
    if (mutation && this.activeTransactionId) throw persistenceError('PERSISTENCE_TRANSACTION_STATE_INVALID');
    return this.records;
  }

  async open() {
    this.isOpen = true;
    return freezeClone({ opened: true });
  }

  async close() {
    this.transactions.clear();
    this.activeTransactionId = null;
    this.isOpen = false;
    return freezeClone({ closed: true });
  }

  async read(key, options = {}) {
    assertKey(key);
    const record = this._records(options).get(key);
    if (!record) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
    return freezeClone(record);
  }

  async readMany(keys, options = {}) {
    if (!Array.isArray(keys)) throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
    const records = this._records(options);
    return freezeClone(keys.map((key) => {
      assertKey(key);
      const record = records.get(key);
      if (!record) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
      return record;
    }));
  }

  async scan(query = {}, options = {}) {
    const records = this._records(options);
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
    let offset = 0;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (decoded.v !== 1 || !Number.isInteger(decoded.offset) || decoded.offset < 0) throw new Error('invalid');
        offset = decoded.offset;
      } catch {
        throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
      }
    }
    const ordered = [...records.values()].sort((left, right) => left.key.localeCompare(right.key));
    const items = ordered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < ordered.length
      ? Buffer.from(JSON.stringify({ v: 1, offset: nextOffset })).toString('base64url')
      : null;
    return freezeClone({ items, nextCursor });
  }

  async insert(key, value, options = {}) {
    assertKey(key);
    const records = this._records(options, true);
    if (records.has(key)) throw persistenceError('PERSISTENCE_RECORD_EXISTS');
    const record = { key, value: clone(value), version: 1 };
    records.set(key, record);
    return freezeClone(record);
  }

  async update(key, value, options = {}) {
    assertKey(key);
    if (!Number.isInteger(options.expectedVersion)) throw persistenceError('PERSISTENCE_EXPECTED_VERSION_REQUIRED');
    const records = this._records(options, true);
    const current = records.get(key);
    if (!current) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
    if (current.version !== options.expectedVersion) throw persistenceError('PERSISTENCE_VERSION_CONFLICT');
    const record = { key, value: clone(value), version: current.version + 1 };
    records.set(key, record);
    return freezeClone(record);
  }

  async delete(key, options = {}) {
    assertKey(key);
    if (!Number.isInteger(options.expectedVersion)) throw persistenceError('PERSISTENCE_EXPECTED_VERSION_REQUIRED');
    const records = this._records(options, true);
    const current = records.get(key);
    if (!current) throw persistenceError('PERSISTENCE_RECORD_NOT_FOUND');
    if (current.version !== options.expectedVersion) throw persistenceError('PERSISTENCE_VERSION_CONFLICT');
    records.delete(key);
    return freezeClone({ key, deleted: true, version: current.version });
  }

  async beginTransaction() {
    this._requireOpen();
    if (this.activeTransactionId) throw persistenceError('PERSISTENCE_NESTED_TRANSACTION_UNSUPPORTED');
    const id = this._id('transaction');
    const descriptor = { id, state: 'active', startedAt: this._now(), completedAt: null, metadata: {} };
    this.transactions.set(id, { descriptor, records: cloneRecords(this.records) });
    this.activeTransactionId = id;
    return freezeClone(descriptor);
  }

  async commit(transactionId) {
    this._requireOpen();
    const transaction = this._transaction(transactionId);
    this.records = cloneRecords(transaction.records);
    transaction.descriptor = { ...transaction.descriptor, state: 'committed', completedAt: this._now() };
    this.activeTransactionId = null;
    const result = freezeClone(transaction.descriptor);
    this.transactions.delete(transactionId);
    return result;
  }

  async rollback(transactionId) {
    this._requireOpen();
    const transaction = this._transaction(transactionId);
    transaction.descriptor = { ...transaction.descriptor, state: 'rolled_back', completedAt: this._now() };
    this.activeTransactionId = null;
    const result = freezeClone(transaction.descriptor);
    this.transactions.delete(transactionId);
    return result;
  }

  async createSnapshot() {
    this._requireOpen();
    return freezeClone({
      id: this._id('snapshot'),
      createdAt: this._now(),
      recordCount: this.records.size,
      checksum: checksum(this.records),
      checkpointId: null,
      metadata: {}
    });
  }

  async createBackup() {
    this._requireOpen();
    const id = this._id('backup');
    const descriptor = {
      id,
      createdAt: this._now(),
      recordCount: this.records.size,
      checksum: checksum(this.records),
      format: 'fake-v1',
      encrypted: false,
      handle: `fake:${id}`,
      metadata: {}
    };
    this.backups.set(id, { descriptor, records: cloneRecords(this.records) });
    return freezeClone(descriptor);
  }

  async restore(backupId) {
    this._requireOpen();
    const backup = this.backups.get(backupId);
    if (!backup) throw persistenceError('PERSISTENCE_BACKUP_NOT_FOUND');
    const startedAt = this._now();
    this.records = cloneRecords(backup.records);
    return freezeClone({
      id: this._id('restore'),
      backupId,
      status: 'completed',
      startedAt,
      completedAt: this._now(),
      restoredCount: this.records.size,
      checksum: checksum(this.records),
      metadata: {}
    });
  }

  async healthCheck() {
    return freezeClone({
      status: this.isOpen ? 'healthy' : 'unavailable',
      checkedAt: this._now(),
      latencyMs: 0,
      details: {}
    });
  }

  async integrityCheck() {
    this._requireOpen();
    return freezeClone({
      status: 'valid',
      checkedAt: this._now(),
      recordCount: this.records.size,
      checksum: checksum(this.records),
      issues: []
    });
  }

  async createCheckpoint() {
    const integrity = await this.integrityCheck();
    return freezeClone({
      id: this._id('checkpoint'),
      createdAt: this._now(),
      recordCount: integrity.recordCount,
      checksum: integrity.checksum,
      metadata: {}
    });
  }
}

export function createFakePersistenceAdapter(options) {
  return new FakePersistenceAdapter(options);
}
