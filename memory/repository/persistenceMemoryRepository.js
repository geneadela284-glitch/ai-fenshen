import { validateMemoryRepositoryInterface } from '../kernel/index.js';
import { validateRepositoryContext } from './contracts.js';
import { repositoryError } from './errors.js';
import { InMemoryMemoryRepository } from './inMemoryRepository.js';
import { stableHash } from './utils.js';

const MUTATIONS = new Set([
  'create', 'createMany', 'update', 'confirm', 'reject', 'dispute', 'archive',
  'expire', 'supersede', 'moveToRecycleBin', 'restore', 'purge'
]);

function validateContext(context) {
  const validation = validateRepositoryContext(context);
  if (!validation.valid) throw repositoryError(validation.errors[0].code);
}

function mapPersistenceError(error, fallback = 'MEMORY_TRANSACTION_FAILED') {
  if (error?.code === 'PERSISTENCE_VERSION_CONFLICT') return repositoryError('MEMORY_VERSION_CONFLICT');
  if (error?.code === 'PERSISTENCE_RECORD_EXISTS') return repositoryError('INVARIANT_VIOLATION');
  if (error?.code === 'PERSISTENCE_LOCKED') return repositoryError('MEMORY_TRANSACTION_FAILED');
  return error?.code?.startsWith('MEMORY_') || [
    'INVALID_TYPE', 'INVALID_ENUM', 'INVALID_RANGE', 'INVALID_TRANSITION',
    'INVARIANT_VIOLATION', 'REQUIRED', 'SECRET_FORBIDDEN', 'USER_SCOPE_MISMATCH'
  ].includes(error?.code) ? error : repositoryError(fallback);
}

async function scanAll(adapter, namespace, userId) {
  const items = [];
  let cursor = null;
  do {
    const page = await adapter.scan({ namespace, userId, limit: 100, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function cloneState(state) {
  return {
    records: new Map([...state.records].map(([key, value]) => [key, structuredClone(value)])),
    idempotency: new Map([...state.idempotency].map(([key, value]) => [key, structuredClone(value)])),
    audit: structuredClone(state.audit)
  };
}

export class PersistenceMemoryRepository {
  constructor({ adapter, clock = () => new Date(), maxQueryLimit = 100, recycleBinDays = 7 } = {}) {
    if (!adapter) throw repositoryError('INVARIANT_VIOLATION');
    this.adapter = adapter;
    this.clock = clock;
    this.maxQueryLimit = maxQueryLimit;
    this.recycleBinDays = recycleBinDays;
    this.opened = false;
    this.transactionActive = false;
  }

  async _ensureOpen() {
    if (!this.opened) {
      await this.adapter.open();
      this.opened = true;
    }
  }

  async _loadState(userId) {
    await this._ensureOpen();
    const [recordRows, idempotencyRows] = await Promise.all([
      scanAll(this.adapter, 'memory', userId),
      scanAll(this.adapter, 'idempotency', userId)
    ]);
    return {
      records: new Map(recordRows.map((row) => [row.key, structuredClone(row.value)])),
      idempotency: new Map(idempotencyRows.map((row) => [row.key, structuredClone(row.value)])),
      audit: []
    };
  }

  _engine(state) {
    return new InMemoryMemoryRepository(
      { clock: this.clock, maxQueryLimit: this.maxQueryLimit, recycleBinDays: this.recycleBinDays },
      { state }
    );
  }

  async _persistState(userId, before, after) {
    const transaction = await this.adapter.beginTransaction();
    const tx = { transactionId: transaction.id };
    try {
      for (const [id, previous] of before.records) {
        const current = after.records.get(id);
        if (!current) {
          await this.adapter.delete(id, { ...tx, namespace: 'memory', userId, expectedVersion: previous.version });
        } else if (stableHash(previous) !== stableHash(current)) {
          await this.adapter.update(id, current, { ...tx, namespace: 'memory', userId, expectedVersion: previous.version });
        }
      }
      for (const [id, current] of after.records) {
        if (!before.records.has(id)) await this.adapter.insert(id, current, { ...tx, namespace: 'memory', userId });
      }
      for (const [key] of before.idempotency) {
        if (!after.idempotency.has(key)) {
          await this.adapter.delete(key, { ...tx, namespace: 'idempotency', userId, expectedVersion: 1 });
        }
      }
      for (const [key, entry] of after.idempotency) {
        if (!before.idempotency.has(key)) {
          await this.adapter.insert(key, entry, { ...tx, namespace: 'idempotency', userId });
        }
      }
      await this.adapter.commit(transaction.id);
    } catch (error) {
      try { await this.adapter.rollback(transaction.id); } catch { /* transaction already failed */ }
      throw mapPersistenceError(error);
    }
  }

  async _run(context, method, args) {
    validateContext(context);
    const mutation = MUTATIONS.has(method);
    if (mutation && this.transactionActive) throw repositoryError('MEMORY_TRANSACTION_FAILED');
    const state = await this._loadState(context.authenticatedUserId);
    const before = cloneState(state);
    const engine = this._engine(state);
    const result = await engine[method](context, ...args);
    if (mutation) {
      try {
        await this._persistState(context.authenticatedUserId, before, state);
      } catch (error) {
        if (method === 'createMany') throw repositoryError('MEMORY_BATCH_ATOMICITY_FAILED');
        throw error;
      }
    }
    return result;
  }

  getById(context, memoryId) { return this._run(context, 'getById', [memoryId]); }
  query(context, query) { return this._run(context, 'query', [query]); }
  count(context, query) { return this._run(context, 'count', [query]); }
  getVersionChain(context, memoryId) { return this._run(context, 'getVersionChain', [memoryId]); }
  getConflictGroup(context, conflictGroupId) { return this._run(context, 'getConflictGroup', [conflictGroupId]); }
  create(context, record, options) { return this._run(context, 'create', [record, options]); }
  createMany(context, records, options) { return this._run(context, 'createMany', [records, options]); }
  update(context, memoryId, patch, options) { return this._run(context, 'update', [memoryId, patch, options]); }
  confirm(context, memoryId, data, options) { return this._run(context, 'confirm', [memoryId, data, options]); }
  reject(context, memoryId, data, options) { return this._run(context, 'reject', [memoryId, data, options]); }
  dispute(context, memoryId, data, options) { return this._run(context, 'dispute', [memoryId, data, options]); }
  archive(context, memoryId, data, options) { return this._run(context, 'archive', [memoryId, data, options]); }
  expire(context, memoryId, data, options) { return this._run(context, 'expire', [memoryId, data, options]); }
  supersede(context, memoryId, replacement, options) { return this._run(context, 'supersede', [memoryId, replacement, options]); }
  moveToRecycleBin(context, memoryId, options) { return this._run(context, 'moveToRecycleBin', [memoryId, options]); }
  restore(context, memoryId, options) { return this._run(context, 'restore', [memoryId, options]); }
  purge(context, memoryId, options) { return this._run(context, 'purge', [memoryId, options]); }

  async withTransaction(context, callback, options = {}) {
    validateContext(context);
    if (this.transactionActive) throw repositoryError('MEMORY_NESTED_TRANSACTION_UNSUPPORTED');
    if (typeof callback !== 'function') throw repositoryError('INVALID_TYPE');
    this.transactionActive = true;
    try {
      const state = await this._loadState(context.authenticatedUserId);
      const before = cloneState(state);
      const engine = this._engine(state);
      const result = await engine.withTransaction(context, callback, options);
      await this._persistState(context.authenticatedUserId, before, state);
      return result;
    } catch (error) {
      if (error?.code === 'MEMORY_NESTED_TRANSACTION_UNSUPPORTED') throw error;
      throw repositoryError('MEMORY_TRANSACTION_FAILED');
    } finally {
      this.transactionActive = false;
    }
  }

  async close() {
    if (this.opened) await this.adapter.close();
    this.opened = false;
  }
}

export function createPersistenceMemoryRepository(options) {
  const repository = new PersistenceMemoryRepository(options);
  if (!validateMemoryRepositoryInterface(repository).valid) throw repositoryError('INVARIANT_VIOLATION');
  return repository;
}
