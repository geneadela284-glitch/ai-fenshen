import {
  MemoryConfirmation,
  MemoryStatus,
  canTransitionMemoryStatus,
  validateMemoryQuery,
  validateMemoryRecord,
  validateMemoryRepositoryInterface
} from '../kernel/index.js';
import { validateRepositoryContext } from './contracts.js';
import { repositoryError } from './errors.js';
import { clone, freezeClone, stableHash } from './utils.js';

const MUTABLE_FIELDS = Object.freeze(new Set([
  'importance', 'sensitivity', 'tags', 'metadata', 'retentionPolicy',
  'accessPolicy', 'effectiveFrom', 'effectiveTo', 'expiresAt', 'conflictGroupId'
]));

const SENSITIVITY_RANK = Object.freeze({ public: 0, low: 1, medium: 2, high: 3, restricted: 4 });
const HISTORICAL_STATUSES = Object.freeze([
  MemoryStatus.DISPUTED, MemoryStatus.SUPERSEDED, MemoryStatus.EXPIRED, MemoryStatus.ARCHIVED
]);
const CANDIDATE_STATUSES = Object.freeze([MemoryStatus.CANDIDATE, MemoryStatus.PENDING_CONFIRMATION]);
const SORTS = Object.freeze(new Set([
  'createdAt:asc', 'createdAt:desc', 'updatedAt:asc',
  'updatedAt:desc', 'importance:asc', 'importance:desc'
]));

function state() {
  return { records: new Map(), idempotency: new Map(), audit: [] };
}

function cloneState(source) {
  return {
    records: new Map([...source.records].map(([id, record]) => [id, clone(record)])),
    idempotency: new Map([...source.idempotency].map(([key, entry]) => [key, clone(entry)])),
    audit: clone(source.audit)
  };
}

function nowIso(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function validateContext(context) {
  const validation = validateRepositoryContext(context);
  if (!validation.valid) throw repositoryError(validation.errors[0].code);
}

function validateOptions(options = {}, expectedVersionRequired = false) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw repositoryError('INVALID_TYPE');
  if (expectedVersionRequired && !Number.isInteger(options.expectedVersion)) {
    throw repositoryError('MEMORY_EXPECTED_VERSION_REQUIRED');
  }
  if (options.expectedVersion !== null && options.expectedVersion !== undefined && (!Number.isInteger(options.expectedVersion) || options.expectedVersion < 1)) {
    throw repositoryError('MEMORY_EXPECTED_VERSION_REQUIRED');
  }
  if (options.idempotencyKey !== null && options.idempotencyKey !== undefined && (typeof options.idempotencyKey !== 'string' || !options.idempotencyKey.trim())) {
    throw repositoryError('INVALID_TYPE');
  }
}

function assertVersion(record, expectedVersion) {
  if (record.version !== expectedVersion) throw repositoryError('MEMORY_VERSION_CONFLICT');
}

function safeReason(value) {
  return typeof value === 'string' && /^[a-z0-9_:-]{1,80}$/i.test(value) ? value : 'unspecified';
}

function queryValues(query, singular, plural) {
  if (query[singular] !== undefined && query[singular] !== null) return [query[singular]];
  return Array.isArray(query[plural]) ? query[plural] : null;
}

function cursorValue(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value?.v !== 1 || !Number.isInteger(value.offset) || value.offset < 0 || typeof value.queryHash !== 'string') {
      throw new Error('invalid cursor');
    }
    return value;
  } catch {
    throw repositoryError('INVALID_TYPE');
  }
}

function encodeCursor(offset, queryHash) {
  return Buffer.from(JSON.stringify({ v: 1, offset, queryHash })).toString('base64url');
}

export class InMemoryMemoryRepository {
  constructor({ clock = () => new Date(), maxQueryLimit = 100, recycleBinDays = 7 } = {}, internal = null) {
    this.clock = clock;
    this.maxQueryLimit = maxQueryLimit;
    this.recycleBinDays = recycleBinDays;
    this._state = internal?.state || state();
    this._root = internal?.root || this;
    this._inTransaction = internal?.inTransaction === true;
    this._transactionUserId = internal?.transactionUserId || null;
    this._transactionActive = false;
  }

  _validateContext(context) {
    validateContext(context);
    if (this._inTransaction && context.authenticatedUserId !== this._transactionUserId) {
      throw repositoryError('MEMORY_RECORD_NOT_FOUND');
    }
  }

  _assertMutationAllowed() {
    if (this._root._transactionActive && !this._inTransaction) {
      throw repositoryError('MEMORY_TRANSACTION_FAILED');
    }
  }

  _record(context, memoryId, { includeDeleted = false } = {}) {
    const record = this._state.records.get(memoryId);
    if (!record || record.userId !== context.authenticatedUserId || (!includeDeleted && record.status === MemoryStatus.DELETED)) {
      throw repositoryError('MEMORY_RECORD_NOT_FOUND');
    }
    return record;
  }

  async _idempotency(context, operation, options, payload, createResult) {
    if (!options?.idempotencyKey) return createResult();
    const key = `${context.authenticatedUserId}\u0000${operation}\u0000${options.idempotencyKey}`;
    const requestHash = stableHash(payload);
    const existing = this._state.idempotency.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw repositoryError('MEMORY_IDEMPOTENCY_CONFLICT');
      const record = this._state.records.get(existing.recordId);
      if (existing.resultKind === 'supersede' && record) {
        const previous = this._state.records.get(record.supersedesId);
        return freezeClone({ previous, current: record });
      }
      if (existing.resultKind === 'records') {
        const records = existing.recordIds.map((recordId) => this._state.records.get(recordId));
        if (records.every(Boolean)) return freezeClone(records);
      }
      return record ? freezeClone(record) : freezeClone(existing.safeResult);
    }
    const result = await createResult();
    const recordId = result?.current?.id || result?.id || null;
    this._state.idempotency.set(key, {
      requestHash,
      recordId,
      recordIds: Array.isArray(result) ? result.map((item) => item.id) : null,
      resultKind: Array.isArray(result) ? 'records' : result?.current?.id ? 'supersede' : result?.purged ? 'purge' : 'record',
      safeResult: result?.purged ? clone(result) : null
    });
    return result;
  }

  _audit(context, operation, recordId, options = {}) {
    this._state.audit.push({
      operation,
      recordIdHash: stableHash(recordId),
      actorType: context.actorType,
      requestIdHash: stableHash(options.requestId || context.requestId),
      reasonCode: safeReason(options.operationReason),
      timestamp: nowIso(this.clock)
    });
  }

  async getById(context, memoryId) {
    this._validateContext(context);
    return freezeClone(this._record(context, memoryId));
  }

  async query(context, query = {}) {
    this._validateContext(context);
    const items = this._select(context, query);
    const limit = query.limit ?? Math.min(50, this.maxQueryLimit);
    if (limit > this.maxQueryLimit) throw repositoryError('INVALID_RANGE');
    const queryHash = stableHash({ ...query, cursor: null });
    const decoded = cursorValue(query.cursor);
    if (decoded && decoded.queryHash !== queryHash) throw repositoryError('INVALID_TYPE');
    const offset = decoded?.offset || 0;
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset, queryHash) : null;
    return freezeClone({ items: page, nextCursor });
  }

  async count(context, query = {}) {
    this._validateContext(context);
    return this._select(context, { ...query, cursor: null, limit: null }).length;
  }

  _select(context, query) {
    if (query.userId !== context.authenticatedUserId) throw repositoryError('MEMORY_RECORD_NOT_FOUND');
    const validation = validateMemoryQuery(query, { trustedUserId: context.authenticatedUserId });
    if (!validation.valid) throw repositoryError(validation.errors[0].code);
    const allowedStatuses = new Set([MemoryStatus.CONFIRMED]);
    if (query.includeHistorical) HISTORICAL_STATUSES.forEach((status) => allowedStatuses.add(status));
    if (query.includeCandidates) CANDIDATE_STATUSES.forEach((status) => allowedStatuses.add(status));
    const memoryTypes = queryValues(query, 'memoryType', 'memoryTypes');
    const statuses = queryValues(query, 'status', 'statuses');
    const confirmations = queryValues(query, 'confirmationStatus', 'confirmationStatuses');
    const sensitivities = Array.isArray(query.sensitivities) ? query.sensitivities : null;
    const explicitDeleted = statuses?.includes(MemoryStatus.DELETED) === true;
    if (explicitDeleted) allowedStatuses.add(MemoryStatus.DELETED);
    const explicitRejected = confirmations?.includes(MemoryConfirmation.USER_REJECTED) === true;
    const effectiveAt = query.effectiveAt ? Date.parse(query.effectiveAt) : null;
    const sort = query.sort || 'createdAt:asc';
    if (!SORTS.has(sort)) throw repositoryError('INVALID_ENUM');
    const [sortField, direction] = sort.split(':');
    const directionMultiplier = direction === 'desc' ? -1 : 1;

    return [...this._state.records.values()]
      .filter((record) => record.userId === context.authenticatedUserId)
      .filter((record) => (explicitDeleted || record.status !== MemoryStatus.DELETED) && allowedStatuses.has(record.status))
      .filter((record) => explicitRejected || record.confirmationStatus !== MemoryConfirmation.USER_REJECTED)
      .filter((record) => !query.id || record.id === query.id)
      .filter((record) => !memoryTypes || memoryTypes.includes(record.memoryType))
      .filter((record) => !statuses || statuses.includes(record.status))
      .filter((record) => !confirmations || confirmations.includes(record.confirmationStatus))
      .filter((record) => !sensitivities || sensitivities.includes(record.sensitivity))
      .filter((record) => query.sensitivityMax === undefined || SENSITIVITY_RANK[record.sensitivity] <= SENSITIVITY_RANK[query.sensitivityMax])
      .filter((record) => !query.subject || record.subject === query.subject)
      .filter((record) => !query.predicate || record.predicate === query.predicate)
      .filter((record) => !query.tags || query.tags.every((tag) => record.tags?.includes(tag)))
      .filter((record) => effectiveAt === null || (
        Date.parse(record.effectiveFrom) <= effectiveAt &&
        (record.effectiveTo === null || record.effectiveTo === undefined || effectiveAt < Date.parse(record.effectiveTo))
      ))
      .sort((left, right) => {
        const leftValue = left[sortField];
        const rightValue = right[sortField];
        const compared = typeof leftValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
        return compared * directionMultiplier || left.id.localeCompare(right.id);
      });
  }

  async getVersionChain(context, memoryId) {
    this._validateContext(context);
    const start = this._record(context, memoryId);
    const previous = [];
    const seen = new Set([start.id]);
    let current = start;
    while (current.supersedesId) {
      current = this._state.records.get(current.supersedesId);
      if (!current || current.userId !== context.authenticatedUserId || seen.has(current.id)) throw repositoryError('INVARIANT_VIOLATION');
      seen.add(current.id);
      previous.unshift(current);
    }
    const next = [];
    current = start;
    while (current.supersededById) {
      current = this._state.records.get(current.supersededById);
      if (!current || current.userId !== context.authenticatedUserId || seen.has(current.id)) throw repositoryError('INVARIANT_VIOLATION');
      seen.add(current.id);
      next.push(current);
    }
    return freezeClone([...previous, start, ...next]);
  }

  async getConflictGroup(context, conflictGroupId) {
    this._validateContext(context);
    const records = [...this._state.records.values()].filter((record) => (
      record.userId === context.authenticatedUserId &&
      record.conflictGroupId === conflictGroupId &&
      record.status !== MemoryStatus.DELETED
    ));
    if (!records.length) throw repositoryError('MEMORY_RECORD_NOT_FOUND');
    records.sort((left, right) => left.id.localeCompare(right.id));
    return freezeClone(records);
  }

  async create(context, memoryRecord, options = {}) {
    this._validateContext(context);
    this._assertMutationAllowed();
    validateOptions(options);
    return this._idempotency(context, 'create', options, memoryRecord, () => {
      const validation = validateMemoryRecord(memoryRecord, { trustedUserId: context.authenticatedUserId });
      if (!validation.valid) throw repositoryError(validation.errors[0].code);
      if (memoryRecord.version !== 1 || this._state.records.has(memoryRecord.id)) throw repositoryError('INVARIANT_VIOLATION');
      const record = clone(memoryRecord);
      this._state.records.set(record.id, record);
      this._audit(context, 'create', record.id, options);
      return freezeClone(record);
    });
  }

  async createMany(context, records, options = {}) {
    this._validateContext(context);
    this._assertMutationAllowed();
    validateOptions(options);
    if (!Array.isArray(records)) throw repositoryError('INVALID_TYPE');
    return this._idempotency(context, 'createMany', options, records, async () => {
      const working = cloneState(this._state);
      const transaction = new InMemoryMemoryRepository(
        { clock: this.clock, maxQueryLimit: this.maxQueryLimit, recycleBinDays: this.recycleBinDays },
        { state: working, root: this._root, inTransaction: true, transactionUserId: context.authenticatedUserId }
      );
      try {
        const created = [];
        for (const record of records) created.push(await transaction.create(context, record, { ...options, idempotencyKey: null }));
        this._state.records = working.records;
        this._state.idempotency = working.idempotency;
        this._state.audit = working.audit;
        return freezeClone(created);
      } catch {
        throw repositoryError('MEMORY_BATCH_ATOMICITY_FAILED');
      }
    });
  }

  async update(context, memoryId, patch, options = {}) {
    this._validateContext(context);
    this._assertMutationAllowed();
    validateOptions(options, true);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw repositoryError('INVALID_TYPE');
    for (const field of Object.keys(patch)) {
      if (!MUTABLE_FIELDS.has(field)) throw repositoryError('INVARIANT_VIOLATION');
    }
    return this._idempotency(context, `update:${memoryId}`, options, patch, () => {
      const current = this._record(context, memoryId);
      assertVersion(current, options.expectedVersion);
      const updated = {
        ...clone(current),
        ...clone(patch),
        updatedAt: nowIso(this.clock),
        version: current.version + 1
      };
      const validation = validateMemoryRecord(updated, { trustedUserId: context.authenticatedUserId });
      if (!validation.valid) throw repositoryError(validation.errors[0].code);
      this._state.records.set(memoryId, updated);
      this._audit(context, 'update', memoryId, options);
      return freezeClone(updated);
    });
  }

  _changeStatus(context, memoryId, data, options, operation, status, confirmationStatus = null) {
    this._validateContext(context);
    this._assertMutationAllowed();
    validateOptions(options, true);
    return this._idempotency(context, `${operation}:${memoryId}`, options, { data, expectedVersion: options.expectedVersion }, () => {
      const current = this._record(context, memoryId);
      assertVersion(current, options.expectedVersion);
      if (!canTransitionMemoryStatus(current.status, status)) throw repositoryError('INVALID_TRANSITION');
      const updated = {
        ...clone(current),
        status,
        confirmationStatus: confirmationStatus || current.confirmationStatus,
        updatedAt: nowIso(this.clock),
        version: current.version + 1
      };
      const validation = validateMemoryRecord(updated, { trustedUserId: context.authenticatedUserId });
      if (!validation.valid) throw repositoryError(validation.errors[0].code);
      this._state.records.set(memoryId, updated);
      this._audit(context, operation, memoryId, options);
      return freezeClone(updated);
    });
  }

  async confirm(context, memoryId, data = {}, options = {}) {
    const confirmationStatus = data.confirmationStatus || MemoryConfirmation.USER_CONFIRMED;
    return this._changeStatus(context, memoryId, data, options, 'confirm', MemoryStatus.CONFIRMED, confirmationStatus);
  }

  async reject(context, memoryId, data = {}, options = {}) {
    return this._changeStatus(context, memoryId, data, options, 'reject', MemoryStatus.ARCHIVED, MemoryConfirmation.USER_REJECTED);
  }

  async dispute(context, memoryId, data = {}, options = {}) {
    return this._changeStatus(context, memoryId, data, options, 'dispute', MemoryStatus.DISPUTED);
  }

  async archive(context, memoryId, data = {}, options = {}) {
    return this._changeStatus(context, memoryId, data, options, 'archive', MemoryStatus.ARCHIVED);
  }

  async expire(context, memoryId, data = {}, options = {}) {
    return this._changeStatus(context, memoryId, data, options, 'expire', MemoryStatus.EXPIRED);
  }

  async supersede(context, currentMemoryId, replacementRecord, options = {}) {
    this._validateContext(context);
    this._assertMutationAllowed();
    validateOptions(options, true);
    if (replacementRecord?.id === currentMemoryId) throw repositoryError('INVARIANT_VIOLATION');
    return this._idempotency(
      context,
      `supersede:${currentMemoryId}`,
      options,
      { replacementRecord, expectedVersion: options.expectedVersion },
      () => {
        const current = this._record(context, currentMemoryId);
        assertVersion(current, options.expectedVersion);
        if (![MemoryStatus.CONFIRMED, MemoryStatus.DISPUTED].includes(current.status)) throw repositoryError('INVALID_TRANSITION');
        const working = cloneState(this._state);
        try {
          const replacement = {
            ...clone(replacementRecord),
            supersedesId: current.id,
            supersededById: null,
            version: 1
          };
          const replacementValidation = validateMemoryRecord(replacement, { trustedUserId: context.authenticatedUserId });
          if (!replacementValidation.valid || working.records.has(replacement.id)) throw new Error('invalid replacement');
          const previous = {
            ...clone(current),
            status: MemoryStatus.SUPERSEDED,
            supersededById: replacement.id,
            updatedAt: nowIso(this.clock),
            version: current.version + 1
          };
          const previousValidation = validateMemoryRecord(previous, { trustedUserId: context.authenticatedUserId });
          if (!previousValidation.valid) throw new Error('invalid previous');
          working.records.set(previous.id, previous);
          working.records.set(replacement.id, replacement);
          this._state.records = working.records;
          this._state.idempotency = working.idempotency;
          this._state.audit = working.audit;
          this._audit(context, 'supersede', replacement.id, options);
          return freezeClone({ previous, current: replacement });
        } catch {
          throw repositoryError('MEMORY_TRANSACTION_FAILED');
        }
      }
    );
  }

  async moveToRecycleBin(context, memoryId, options = {}) {
    this._validateContext(context);
    this._assertMutationAllowed();
    validateOptions(options, true);
    return this._idempotency(context, `recycle:${memoryId}`, options, { expectedVersion: options.expectedVersion }, () => {
      const current = this._record(context, memoryId);
      assertVersion(current, options.expectedVersion);
      if (!canTransitionMemoryStatus(current.status, MemoryStatus.DELETED)) throw repositoryError('INVALID_TRANSITION');
      const deletedAt = nowIso(this.clock);
      const purgeAfter = new Date(Date.parse(deletedAt) + this.recycleBinDays * 24 * 60 * 60 * 1000).toISOString();
      const deleted = {
        ...clone(current),
        status: MemoryStatus.DELETED,
        updatedAt: deletedAt,
        version: current.version + 1,
        metadata: {
          ...clone(current.metadata),
          recycleBin: {
            previousStatus: current.status,
            deletedAt,
            purgeAfter,
            reasonCode: safeReason(options.operationReason)
          }
        }
      };
      const validation = validateMemoryRecord(deleted, { trustedUserId: context.authenticatedUserId });
      if (!validation.valid) throw repositoryError(validation.errors[0].code);
      this._state.records.set(memoryId, deleted);
      this._audit(context, 'move_to_recycle_bin', memoryId, options);
      return freezeClone(deleted);
    });
  }

  async restore(context, memoryId, options = {}) {
    this._validateContext(context);
    this._assertMutationAllowed();
    validateOptions(options, true);
    return this._idempotency(context, `restore:${memoryId}`, options, { expectedVersion: options.expectedVersion }, () => {
      const current = this._record(context, memoryId, { includeDeleted: true });
      assertVersion(current, options.expectedVersion);
      if (current.status !== MemoryStatus.DELETED || !current.metadata?.recycleBin) throw repositoryError('INVALID_TRANSITION');
      if (Date.parse(nowIso(this.clock)) >= Date.parse(current.metadata.recycleBin.purgeAfter)) throw repositoryError('INVALID_TRANSITION');
      const metadata = clone(current.metadata);
      const recycleBin = metadata.recycleBin;
      delete metadata.recycleBin;
      metadata.recycleHistory = [
        ...(Array.isArray(metadata.recycleHistory) ? metadata.recycleHistory : []),
        {
          deletedAt: recycleBin.deletedAt,
          restoredAt: nowIso(this.clock),
          reasonCode: safeReason(options.operationReason)
        }
      ];
      const restored = {
        ...clone(current),
        status: recycleBin.previousStatus,
        updatedAt: nowIso(this.clock),
        version: current.version + 1,
        metadata
      };
      const validation = validateMemoryRecord(restored, { trustedUserId: context.authenticatedUserId });
      if (!validation.valid) throw repositoryError(validation.errors[0].code);
      this._state.records.set(memoryId, restored);
      this._audit(context, 'restore', memoryId, options);
      return freezeClone(restored);
    });
  }

  async purge(context, memoryId, options = {}) {
    this._validateContext(context);
    this._assertMutationAllowed();
    validateOptions(options, true);
    return this._idempotency(context, `purge:${memoryId}`, options, { expectedVersion: options.expectedVersion }, () => {
      const current = this._record(context, memoryId, { includeDeleted: true });
      assertVersion(current, options.expectedVersion);
      this._state.records.delete(memoryId);
      for (const [key, entry] of this._state.idempotency) {
        if (entry.recordId === memoryId) this._state.idempotency.delete(key);
      }
      this._audit(context, 'purge', memoryId, options);
      return freezeClone({ id: memoryId, purged: true, reasonCode: safeReason(options.operationReason) });
    });
  }

  async withTransaction(context, callback, options = {}) {
    this._validateContext(context);
    if (this._inTransaction || this._root._transactionActive) {
      throw repositoryError('MEMORY_NESTED_TRANSACTION_UNSUPPORTED');
    }
    if (typeof callback !== 'function') throw repositoryError('INVALID_TYPE');
    this._root._transactionActive = true;
    const working = cloneState(this._state);
    const transaction = new InMemoryMemoryRepository(
      { clock: this.clock, maxQueryLimit: this.maxQueryLimit, recycleBinDays: this.recycleBinDays },
      { state: working, root: this._root, inTransaction: true, transactionUserId: context.authenticatedUserId }
    );
    try {
      const transactionContext = {
        ...context,
        transactionId: options.transactionId || context.transactionId || context.requestId
      };
      const result = await callback(transaction, freezeClone(transactionContext));
      this._state.records = working.records;
      this._state.idempotency = working.idempotency;
      this._state.audit = working.audit;
      return freezeClone(result);
    } catch (error) {
      if (error?.code === 'MEMORY_NESTED_TRANSACTION_UNSUPPORTED') throw error;
      throw repositoryError('MEMORY_TRANSACTION_FAILED');
    } finally {
      this._root._transactionActive = false;
    }
  }

  reset() {
    this._state.records.clear();
    this._state.idempotency.clear();
    this._state.audit.length = 0;
  }

  inspectSafeState() {
    return freezeClone({
      recordCount: this._state.records.size,
      idempotencyCount: this._state.idempotency.size,
      audit: this._state.audit
    });
  }
}

export function createInMemoryMemoryRepository(options) {
  const repository = new InMemoryMemoryRepository(options);
  if (!validateMemoryRepositoryInterface(repository).valid) throw repositoryError('INVARIANT_VIOLATION');
  return repository;
}
