import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { categoriesForType, isAllowedCategory } from './constants.js';
import {
  decodeFinanceHistoryCursor,
  encodeFinanceHistoryCursor,
  financeHistoryLogicalStatus,
  financeHistoryQueryFingerprint,
  financeHistoryStatusClause,
  normalizeFinanceHistoryQuery
} from './historyQuery.js';
import { assertMonthlyFinanceReportSnapshot } from './monthlyReportContract.js';
import { buildFinanceQueryPlan, validateFinanceQueryPlan } from './queryPlan.js';

const FINANCE_RELATION_SUBTYPES = new Set(['loan_out', 'loan_in', 'repayment_in', 'repayment_out']);

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return normalized;
}

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function historicalAccountId(ownerId) {
  const digest = createHash('sha256').update(`finance-history\u0000${ownerId}`).digest('hex');
  return `fin_history_${digest.slice(0, 32)}`;
}

function historicalAccount(ownerId) {
  return {
    id: historicalAccountId(ownerId),
    name: '历史账本',
    accountType: 'historical',
    currency: 'CNY',
    status: 'active',
    isSystem: true,
    virtual: true,
    readOnly: true,
    canDelete: false,
    acceptsNewEntries: false,
    createdAt: null,
    updatedAt: null,
    archivedAt: null
  };
}

function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    accountType: row.account_type,
    currency: row.currency,
    status: row.status,
    isSystem: Number(row.is_system) === 1,
    virtual: false,
    readOnly: false,
    canDelete: Number(row.is_system) !== 1,
    acceptsNewEntries: row.status === 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at || null
  };
}

function publicRow(row, { f201Enabled = false, subtype = null } = {}) {
  if (!row) return null;
  const result = {
    id: row.id,
    type: row.type,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    occurredAt: row.occurred_at,
    timezone: row.timezone,
    category: row.category,
    merchant: row.merchant || null,
    counterparty: row.counterparty || null,
    note: row.note || null,
    sourceMessageId: row.source_message_id,
    clientRequestId: row.client_request_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null
  };
  const resolvedSubtype = subtype || row.subtype || null;
  if (resolvedSubtype) {
    result.subtype = resolvedSubtype;
    result.cashDirection = resolvedSubtype.endsWith('_in') ? 'inflow' : 'outflow';
  }
  if (f201Enabled) {
    result.accountId = row.account_id || historicalAccountId(row.owner_id);
    result.version = Number(row.version);
    result.archivedAt = row.archived_at || null;
  }
  return result;
}

function entrySnapshot(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    type: row.type,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    occurredAt: row.occurred_at,
    timezone: row.timezone,
    category: row.category,
    merchant: row.merchant || null,
    counterparty: row.counterparty || null,
    note: row.note || null,
    sourceMessageId: row.source_message_id,
    clientRequestId: row.client_request_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    accountId: row.account_id || null,
    version: Number(row.version),
    archivedAt: row.archived_at || null
  };
}

function publicRevision(row) {
  const beforeDocument = JSON.parse(row.before_json);
  const afterDocument = JSON.parse(row.after_json);
  const { ownerId: _beforeOwnerId, ...before } = beforeDocument.entry;
  const { ownerId: _afterOwnerId, ...after } = afterDocument.entry;
  return {
    id: row.id,
    entryId: row.entry_id,
    entryVersion: Number(row.entry_version),
    mutationType: row.mutation_type,
    before,
    after,
    changes: afterDocument.changes || {},
    clientRequestId: row.client_request_id,
    createdAt: row.created_at
  };
}

function changedFields(before, after) {
  return Object.fromEntries(Object.keys(after)
    .filter((field) => !Object.is(before[field], after[field]))
    .map((field) => [field, { before: before[field], after: after[field] }]));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestFingerprint(payload) {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

function createPayload(row) {
  const payload = {
    type: row.type,
    amountMinor: Number(row.amountMinor ?? row.amount_minor),
    currency: row.currency,
    occurredAt: row.occurredAt ?? row.occurred_at,
    timezone: row.timezone,
    category: row.category,
    merchant: row.merchant || null,
    counterparty: row.counterparty || null,
    note: row.note || null,
    sourceMessageId: row.sourceMessageId ?? row.source_message_id
  };
  if (row.subtype) payload.subtype = row.subtype;
  return payload;
}

function normalizedUpdatePatch(patch = {}) {
  const result = {};
  if (patch.amountMinor !== undefined) result.amountMinor = Number(patch.amountMinor);
  if (patch.category !== undefined) result.category = String(patch.category);
  if (patch.note !== undefined) result.note = String(patch.note || '').trim() || null;
  if (patch.occurredAt !== undefined) result.occurredAt = String(patch.occurredAt);
  return result;
}

function batchEntryRequestId(mutationRequestId, index) {
  const digest = createHash('sha256').update(mutationRequestId).digest('hex').slice(0, 32);
  return `fin_batch_${digest}_${index + 1}`;
}

function batchEntryRequestPattern(mutationRequestId) {
  const digest = createHash('sha256').update(mutationRequestId).digest('hex').slice(0, 32);
  return `fin_batch_${digest}_*`;
}

function batchRequestRows(database, ownerId, mutationRequestId) {
  return database.prepare(`
    SELECT * FROM finance_entries
    WHERE owner_id = ? AND client_request_id GLOB ?
  `).all(ownerId, batchEntryRequestPattern(mutationRequestId));
}

function lifecycleRequest(database, ownerId, mutationRequestId) {
  return database.prepare(`
    SELECT * FROM finance_mutation_requests
    WHERE owner_id = ? AND client_request_id = ?
  `).get(ownerId, mutationRequestId);
}

function localParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function reportEntry(row, index, timezone) {
  const occurredAt = new Date(row.occurred_at);
  const local = localParts(occurredAt, timezone);
  const amountMinor = Number(row.amount_minor);
  return {
    sequence: index + 1,
    occurredAt: row.occurred_at,
    localDate: `${local.year}-${local.month}-${local.day}`,
    localTime: `${local.hour}:${local.minute}`,
    type: row.type,
    category: row.category,
    amountMinor,
    signedAmountMinor: row.type === 'income' ? amountMinor : -amountMinor,
    merchantOrCounterparty: row.merchant || row.counterparty || null,
    note: row.note || null
  };
}

export class FinanceRepository {
  constructor({
    database,
    id = () => `fin_${randomUUID()}`,
    accountId = () => `fin_account_${randomUUID()}`,
    revisionId = () => `fin_revision_${randomUUID()}`,
    clock = () => new Date(),
    timezone = 'Asia/Shanghai',
    f201Enabled = false,
    cursorSecret = randomBytes(32)
  } = {}) {
    this.database = database;
    this.id = id;
    this.accountId = accountId;
    this.revisionId = revisionId;
    this.clock = clock;
    this.timezone = timezone;
    this.f201Enabled = f201Enabled;
    this.cursorSecret = cursorSecret;
  }

  toPublicRow(row) {
    return publicRow(row, { f201Enabled: this.f201Enabled, subtype: this.readSubtype(row) });
  }

  relationTableAvailable() {
    return Boolean(this.database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'finance_entry_relations'
    `).get());
  }

  readSubtype(row) {
    if (!row) return null;
    if (row.subtype) return row.subtype;
    if (!this.relationTableAvailable()) return null;
    return this.database.prepare(`
      SELECT subtype FROM finance_entry_relations WHERE entry_id = ? AND owner_id = ?
    `).get(row.id, row.owner_id ?? row.ownerId)?.subtype || null;
  }

  saveSubtype(row) {
    if (!row?.subtype) return;
    if (!FINANCE_RELATION_SUBTYPES.has(row.subtype)) fail('FINANCE_SUBTYPE_INVALID');
    if (!this.relationTableAvailable()) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS finance_entry_relations (
          entry_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          subtype TEXT NOT NULL CHECK (subtype IN ('loan_out', 'loan_in', 'repayment_in', 'repayment_out')),
          created_at TEXT NOT NULL,
          FOREIGN KEY(entry_id) REFERENCES finance_entries(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_finance_entry_relations_owner_subtype
          ON finance_entry_relations(owner_id, subtype, created_at DESC);
      `);
    }
    const inserted = this.database.prepare(`
      INSERT INTO finance_entry_relations (entry_id, owner_id, subtype, created_at)
      VALUES (?, ?, ?, ?)
    `).run(row.id, row.ownerId, row.subtype, row.createdAt);
    if (Number(inserted.changes) !== 1) fail('FINANCE_SUBTYPE_NOT_COMMITTED');
  }

  requireF201() {
    if (this.f201Enabled) return;
    const error = new Error('FINANCE_F2_0_1_NOT_ENABLED');
    error.code = 'FINANCE_F2_0_1_NOT_ENABLED';
    throw error;
  }

  findDefaultAccount(ownerId) {
    const rows = this.database.prepare(`
      SELECT * FROM finance_accounts
      WHERE owner_id = ? AND is_system = 1 AND account_type = 'cash' AND status = 'active'
      ORDER BY created_at ASC, id ASC
    `).all(ownerId);
    if (rows.length > 1) {
      const error = new Error('FINANCE_DEFAULT_ACCOUNT_AMBIGUOUS');
      error.code = 'FINANCE_DEFAULT_ACCOUNT_AMBIGUOUS';
      throw error;
    }
    return rows[0] || null;
  }

  ensureDefaultAccount(ownerId, now) {
    const existing = this.findDefaultAccount(ownerId);
    if (existing) return existing;
    const id = this.accountId();
    const inserted = this.database.prepare(`
      INSERT INTO finance_accounts (
        id, owner_id, name, account_type, currency, status, is_system,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, '默认账户', 'cash', 'CNY', 'active', 1, ?, ?, NULL)
    `).run(id, ownerId, now, now);
    if (Number(inserted.changes) !== 1) throw new Error('FINANCE_DEFAULT_ACCOUNT_NOT_COMMITTED');
    const committed = this.findDefaultAccount(ownerId);
    if (!committed || committed.id !== id) throw new Error('FINANCE_DEFAULT_ACCOUNT_NOT_VISIBLE');
    return committed;
  }

  listAccounts({ ownerId } = {}) {
    this.requireF201();
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const rows = this.database.prepare(`
      SELECT * FROM finance_accounts
      WHERE owner_id = ?
      ORDER BY is_system DESC, created_at ASC, id ASC
    `).all(owner);
    return [historicalAccount(owner), ...rows.map(publicAccount)];
  }

  getAccount({ ownerId, id } = {}) {
    this.requireF201();
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const account = required(id, 'ACCOUNT_ID_REQUIRED');
    if (account === historicalAccountId(owner)) return historicalAccount(owner);
    return publicAccount(this.database.prepare(`
      SELECT * FROM finance_accounts WHERE id = ? AND owner_id = ?
    `).get(account, owner));
  }

  create(input) {
    const ownerId = required(input.ownerId, 'OWNER_REQUIRED');
    const type = required(input.type, 'TYPE_REQUIRED');
    const amountMinor = Number(input.amountMinor);
    if (!['expense', 'income'].includes(type)) throw new Error('TYPE_INVALID');
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('AMOUNT_INVALID');
    if (!isAllowedCategory(type, input.category)) throw new Error('CATEGORY_INVALID');
    const clientRequestId = this.f201Enabled
      ? required(input.mutationRequestId ?? input.clientRequestId, 'MUTATION_REQUEST_ID_REQUIRED')
      : required(input.clientRequestId, 'CLIENT_REQUEST_ID_REQUIRED');
    const now = this.clock().toISOString();
    const row = {
      id: this.id(), ownerId, type, amountMinor, currency: input.currency || 'CNY',
      occurredAt: required(input.occurredAt, 'OCCURRED_AT_REQUIRED'), timezone: required(input.timezone, 'TIMEZONE_REQUIRED'),
      category: input.category, merchant: input.merchant || null, counterparty: input.counterparty || null,
      note: input.note || null, sourceMessageId: required(input.sourceMessageId, 'SOURCE_MESSAGE_ID_REQUIRED'),
      clientRequestId, status: 'active', createdAt: now, updatedAt: now,
      subtype: input.subtype || null
    };
    if (row.subtype && !FINANCE_RELATION_SUBTYPES.has(row.subtype)) fail('FINANCE_SUBTYPE_INVALID');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.f201Enabled) {
        if (lifecycleRequest(this.database, ownerId, clientRequestId)) {
          fail('FINANCE_IDEMPOTENCY_CONFLICT');
        }
        if (batchRequestRows(this.database, ownerId, clientRequestId).length > 0) {
          fail('FINANCE_IDEMPOTENCY_CONFLICT');
        }
      }
      const existing = this.database.prepare(`
        SELECT * FROM finance_entries WHERE owner_id = ? AND client_request_id = ?
      `).get(ownerId, clientRequestId);
      if (existing) {
        const existingPayload = { ...createPayload(existing), ...(this.readSubtype(existing) ? { subtype: this.readSubtype(existing) } : {}) };
        if (this.f201Enabled && requestFingerprint(existingPayload) !== requestFingerprint(createPayload(row))) {
          fail('FINANCE_IDEMPOTENCY_CONFLICT');
        }
        this.database.exec('COMMIT');
        return this.toPublicRow(existing);
      }
      const defaultAccount = this.f201Enabled ? this.ensureDefaultAccount(ownerId, now) : null;
      const inserted = this.f201Enabled
        ? this.database.prepare(`
          INSERT INTO finance_entries (
            id, owner_id, type, amount_minor, currency, occurred_at, timezone, category, merchant, counterparty,
            note, source_message_id, client_request_id, status, created_at, updated_at, deleted_at, account_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `).run(row.id, row.ownerId, row.type, row.amountMinor, row.currency, row.occurredAt, row.timezone, row.category,
          row.merchant, row.counterparty, row.note, row.sourceMessageId, row.clientRequestId, row.status, row.createdAt,
          row.updatedAt, defaultAccount.id)
        : this.database.prepare(`
          INSERT INTO finance_entries (
            id, owner_id, type, amount_minor, currency, occurred_at, timezone, category, merchant, counterparty,
            note, source_message_id, client_request_id, status, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(row.id, row.ownerId, row.type, row.amountMinor, row.currency, row.occurredAt, row.timezone, row.category,
          row.merchant, row.counterparty, row.note, row.sourceMessageId, row.clientRequestId, row.status, row.createdAt, row.updatedAt);
      if (Number(inserted.changes) !== 1) throw new Error('FINANCE_INSERT_NOT_COMMITTED');
      const committed = this.database.prepare(`
        SELECT * FROM finance_entries WHERE id = ? AND owner_id = ?
      `).get(row.id, ownerId);
      if (!committed) throw new Error('FINANCE_INSERT_NOT_VISIBLE');
      this.saveSubtype(row);
      this.database.exec('COMMIT');
      return this.toPublicRow(committed);
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  createMany(inputs = [], options = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('FINANCE_BATCH_EMPTY');
    const batchMutationRequestId = this.f201Enabled && options.mutationRequestId !== undefined
      ? required(options.mutationRequestId, 'MUTATION_REQUEST_ID_REQUIRED')
      : null;
    const batchOwnerId = batchMutationRequestId
      ? required(options.ownerId, 'OWNER_REQUIRED')
      : null;
    const prepared = inputs.map((input, index) => {
      const source = input || {};
      const ownerId = required(source.ownerId, 'OWNER_REQUIRED');
      if (batchOwnerId && ownerId !== batchOwnerId) fail('FINANCE_BATCH_OWNER_MISMATCH');
      const type = required(source.type, 'TYPE_REQUIRED');
      const amountMinor = Number(source.amountMinor);
      if (!['expense', 'income'].includes(type)) throw new Error('TYPE_INVALID');
      if (source.subtype && !FINANCE_RELATION_SUBTYPES.has(source.subtype)) throw new Error('FINANCE_SUBTYPE_INVALID');
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('AMOUNT_INVALID');
      if (!isAllowedCategory(type, source.category)) throw new Error('CATEGORY_INVALID');
      const clientRequestId = batchMutationRequestId
        ? batchEntryRequestId(batchMutationRequestId, index)
        : this.f201Enabled
          ? required(source.mutationRequestId ?? source.clientRequestId, 'MUTATION_REQUEST_ID_REQUIRED')
          : required(source.clientRequestId, 'CLIENT_REQUEST_ID_REQUIRED');
      const now = this.clock().toISOString();
      return {
        id: this.id(), ownerId, type, amountMinor, currency: source.currency || 'CNY',
        occurredAt: required(source.occurredAt, 'OCCURRED_AT_REQUIRED'),
        timezone: required(source.timezone, 'TIMEZONE_REQUIRED'),
        category: source.category, merchant: source.merchant || null, counterparty: source.counterparty || null,
        note: source.note || null, sourceMessageId: required(source.sourceMessageId, 'SOURCE_MESSAGE_ID_REQUIRED'),
        clientRequestId, status: 'active', createdAt: now, updatedAt: now,
        subtype: source.subtype || null
      };
    });
    const keys = new Set();
    for (const row of prepared) {
      const key = `${row.ownerId}\u0000${row.clientRequestId}`;
      if (keys.has(key)) throw new Error('CLIENT_REQUEST_ID_DUPLICATE');
      keys.add(key);
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (batchMutationRequestId) {
        if (lifecycleRequest(this.database, batchOwnerId, batchMutationRequestId)) {
          fail('FINANCE_IDEMPOTENCY_CONFLICT');
        }
        const existingCreate = this.database.prepare(`
          SELECT id FROM finance_entries WHERE owner_id = ? AND client_request_id = ?
        `).get(batchOwnerId, batchMutationRequestId);
        if (existingCreate) fail('FINANCE_IDEMPOTENCY_CONFLICT');
        const existingBatch = batchRequestRows(this.database, batchOwnerId, batchMutationRequestId);
        if (existingBatch.length > 0) {
          if (existingBatch.length !== prepared.length) fail('FINANCE_IDEMPOTENCY_CONFLICT');
          const byRequestId = new Map(existingBatch.map((row) => [row.client_request_id, row]));
          const replay = prepared.map((row) => {
            const existing = byRequestId.get(row.clientRequestId);
            const existingPayload = existing
              ? { ...createPayload(existing), ...(this.readSubtype(existing) ? { subtype: this.readSubtype(existing) } : {}) }
              : null;
            if (!existing || requestFingerprint(existingPayload) !== requestFingerprint(createPayload(row))) {
              fail('FINANCE_IDEMPOTENCY_CONFLICT');
            }
            return existing;
          });
          this.database.exec('COMMIT');
          return replay.map((row) => this.toPublicRow(row));
        }
      }
      const rows = [];
      const defaultAccounts = new Map();
      for (const row of prepared) {
        const existing = this.database.prepare(`
          SELECT * FROM finance_entries WHERE owner_id = ? AND client_request_id = ?
        `).get(row.ownerId, row.clientRequestId);
        if (existing) {
          const existingPayload = { ...createPayload(existing), ...(this.readSubtype(existing) ? { subtype: this.readSubtype(existing) } : {}) };
          if (this.f201Enabled && requestFingerprint(existingPayload) !== requestFingerprint(createPayload(row))) {
            fail('FINANCE_IDEMPOTENCY_CONFLICT');
          }
          rows.push(existing);
          continue;
        }
        let defaultAccount = null;
        if (this.f201Enabled) {
          defaultAccount = defaultAccounts.get(row.ownerId) || this.ensureDefaultAccount(row.ownerId, row.createdAt);
          defaultAccounts.set(row.ownerId, defaultAccount);
        }
        const inserted = this.f201Enabled
          ? this.database.prepare(`
            INSERT INTO finance_entries (
              id, owner_id, type, amount_minor, currency, occurred_at, timezone, category, merchant, counterparty,
              note, source_message_id, client_request_id, status, created_at, updated_at, deleted_at, account_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
          `).run(row.id, row.ownerId, row.type, row.amountMinor, row.currency, row.occurredAt, row.timezone, row.category,
            row.merchant, row.counterparty, row.note, row.sourceMessageId, row.clientRequestId, row.status, row.createdAt,
            row.updatedAt, defaultAccount.id)
          : this.database.prepare(`
            INSERT INTO finance_entries (
              id, owner_id, type, amount_minor, currency, occurred_at, timezone, category, merchant, counterparty,
              note, source_message_id, client_request_id, status, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          `).run(row.id, row.ownerId, row.type, row.amountMinor, row.currency, row.occurredAt, row.timezone, row.category,
            row.merchant, row.counterparty, row.note, row.sourceMessageId, row.clientRequestId, row.status, row.createdAt, row.updatedAt);
        if (Number(inserted.changes) !== 1) throw new Error('FINANCE_INSERT_NOT_COMMITTED');
        const committed = this.database.prepare(`
          SELECT * FROM finance_entries WHERE id = ? AND owner_id = ?
        `).get(row.id, row.ownerId);
        if (!committed) throw new Error('FINANCE_INSERT_NOT_VISIBLE');
        this.saveSubtype(row);
        rows.push(committed);
      }
      this.database.exec('COMMIT');
      return rows.map((row) => this.toPublicRow(row));
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  get({ ownerId, id, includeDeleted = false }) {
    const row = this.database.prepare(`
      SELECT * FROM finance_entries WHERE id = ? AND owner_id = ? ${includeDeleted ? '' : "AND status = 'active'"}
    `).get(required(id, 'ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED'));
    return this.toPublicRow(row);
  }

  list({ ownerId, limit = 100, includeDeleted = false } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.database.prepare(`
      SELECT * FROM finance_entries
      WHERE owner_id = ? ${includeDeleted ? '' : "AND status = 'active'"}
      ORDER BY occurred_at DESC, created_at DESC, rowid DESC LIMIT ?
    `).all(required(ownerId, 'OWNER_REQUIRED'), safeLimit).map((row) => this.toPublicRow(row));
  }

  listRevisions({ ownerId, entryId } = {}) {
    this.requireF201();
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const id = required(entryId, 'ID_REQUIRED');
    const entry = this.database.prepare(`
      SELECT id FROM finance_entries WHERE id = ? AND owner_id = ?
    `).get(id, owner);
    if (!entry) return null;
    return this.database.prepare(`
      SELECT id, entry_id, entry_version, mutation_type, before_json,
        after_json, client_request_id, created_at
      FROM finance_revisions
      WHERE owner_id = ? AND entry_id = ?
      ORDER BY entry_version DESC, created_at DESC, id DESC
    `).all(owner, id).map(publicRevision);
  }

  queryHistory(input = {}) {
    this.requireF201();
    const query = normalizeFinanceHistoryQuery(input, {
      ownerId: input.ownerId,
      defaultTimezone: this.timezone,
      defaultNow: this.clock()
    });
    const clauses = [
      'owner_id = ?',
      'occurred_at >= ?',
      'occurred_at < ?'
    ];
    const values = [query.ownerId, query.range.startAt, query.range.endAt];
    if (query.types.length) {
      clauses.push(`type IN (${query.types.map(() => '?').join(', ')})`);
      values.push(...query.types);
    }
    if (query.categories.length) {
      clauses.push(`category IN (${query.categories.map(() => '?').join(', ')})`);
      values.push(...query.categories);
    }
    if (query.keyword) {
      const escaped = query.keyword.replace(/[\\%_]/g, '\\$&');
      clauses.push("(merchant LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')");
      values.push(`%${escaped}%`, `%${escaped}%`);
    }
    const sharedWhere = clauses.join(' AND ');
    const fingerprint = financeHistoryQueryFingerprint(query);
    const pageClauses = [...clauses, financeHistoryStatusClause(query.statuses)];
    const pageValues = [...values];
    if (input.cursor) {
      const [occurredAt, createdAt, id] = decodeFinanceHistoryCursor(input.cursor, {
        ownerId: query.ownerId,
        queryFingerprint: fingerprint,
        secret: this.cursorSecret
      });
      pageClauses.push(`(
        occurred_at < ? OR
        (occurred_at = ? AND created_at < ?) OR
        (occurred_at = ? AND created_at = ? AND id < ?)
      )`);
      pageValues.push(occurredAt, occurredAt, createdAt, occurredAt, createdAt, id);
    }
    const rows = this.database.prepare(`
      SELECT * FROM finance_entries
      WHERE ${pageClauses.join(' AND ')}
      ORDER BY occurred_at DESC, created_at DESC, id DESC
      LIMIT ?
    `).all(...pageValues, query.limit + 1);
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last
      ? encodeFinanceHistoryCursor({
        ownerId: query.ownerId,
        queryFingerprint: fingerprint,
        key: [last.occurred_at, last.created_at, last.id]
      }, this.cursorSecret)
      : null;
    const countedStatuses = query.statuses.filter((status) => status !== 'deleted');
    const totals = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END), 0) AS income_minor,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense_minor
      FROM finance_entries
      WHERE ${sharedWhere} AND ${financeHistoryStatusClause(countedStatuses)}
    `).get(...values);
    const incomeMinor = Number(totals.income_minor);
    const expenseMinor = Number(totals.expense_minor);
    const entries = pageRows.map((row) => ({
      ...this.toPublicRow(row),
      status: financeHistoryLogicalStatus(row),
      version: Number(row.version),
      archivedAt: row.archived_at || null
    }));
    return {
      entries,
      nextCursor,
      hasMore,
      summary: { incomeMinor, expenseMinor, balanceMinor: incomeMinor - expenseMinor },
      range: query.range
    };
  }

  // One read transaction supplies the page and its supporting aggregates.
  // It preserves the existing cash-flow policy, including archived entries.
  readExperienceSnapshot(input = {}, { report = false } = {}) {
    this.requireF201();
    const q = normalizeFinanceHistoryQuery(input, { ownerId: input.ownerId, defaultTimezone: this.timezone, defaultNow: this.clock() });
    if (report && q.statuses.includes('deleted')) fail('FINANCE_HISTORY_DELETED_EXPORT');
    const clauses = ['owner_id = ?', 'occurred_at >= ?', 'occurred_at < ?', financeHistoryStatusClause(q.statuses)];
    const values = [q.ownerId, q.range.startAt, q.range.endAt];
    for (const [field, list] of [['type', q.types], ['category', q.categories]]) {
      if (list.length) { clauses.push(`${field} IN (${list.map(() => '?').join(',')})`); values.push(...list); }
    }
    if (q.keyword) {
      const escaped = q.keyword.replace(/[\\%_]/g, '\\$&');
      clauses.push("(merchant LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')"); values.push(`%${escaped}%`, `%${escaped}%`);
    }
    this.database.exec('BEGIN');
    try {
      const page = this.queryHistory(input);
      const rows = this.database.prepare(`SELECT * FROM finance_entries WHERE ${clauses.join(' AND ')} ORDER BY occurred_at ASC, created_at ASC, id ASC`).all(...values);
      const active = rows.filter(row => row.status === 'active' && !row.deleted_at);
      if (active.some(row => row.currency !== 'CNY')) fail('FINANCE_CURRENCY_UNSUPPORTED');
      const categories = new Map(), days = new Map();
      const dayFormatter = new Intl.DateTimeFormat('en-CA', {timeZone:q.range.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
      for (const row of active) {
        const amount = Number(row.amount_minor), key = `${row.type}:${row.category}`;
        const category = categories.get(key) || {type:row.type,category:row.category,amountMinor:0,count:0};
        category.amountMinor += amount; category.count++; categories.set(key,category);
        const date=dayFormatter.format(new Date(row.occurred_at));
        const day=days.get(date)||{localDate:date,incomeMinor:0,expenseMinor:0};day[row.type==='income'?'incomeMinor':'expenseMinor']+=amount;days.set(date,day);
      }
      const daily=[...days.values()].map(row=>({...row,balanceMinor:row.incomeMinor-row.expenseMinor}));
      if (![...Object.values(page.summary),...[...categories.values()].map(r=>r.amountMinor),...daily.flatMap(r=>[r.incomeMinor,r.expenseMinor,r.balanceMinor])].every(Number.isSafeInteger)) fail('FINANCE_AMOUNT_OVERFLOW');
      let snapshot=null;
      if(report){
        const local=localParts(new Date(q.range.startAt),q.range.timezone);
        const start=`${local.year}-${local.month}-${local.day}`, end=localParts(new Date(Date.parse(q.range.endAt)-1),q.range.timezone);
        const label=`${start} 至 ${end.year}-${end.month}-${end.day}`;
        const entries=active.map((row,index)=>({...reportEntry(row,index,q.range.timezone),subtype:this.readSubtype(row)}));
        snapshot=assertMonthlyFinanceReportSnapshot({rangeReport:true,accountingNote:'沿用现金流口径，含借还款；结余不是账户余额。已删除账目不计入。',schemaVersion:1,reportType:'monthly_finance',title:`AI分身-${label}收支报表`,timezone:q.range.timezone,period:{year:Number(local.year),month:Number(local.month),label,startAt:q.range.startAt,endAt:q.range.endAt},currency:'CNY',totals:page.summary,categorySummaries:{income:[...categories.values()].filter(r=>r.type==='income').map(({category,amountMinor})=>({category,amountMinor})),expense:[...categories.values()].filter(r=>r.type==='expense').map(({category,amountMinor})=>({category,amountMinor}))},dailySummaries:daily,entries,entryCount:entries.length,generatedAt:this.clock().toISOString()});
      }
      const result={...page,totalCount:rows.length,categories:[...categories.values()].sort((a,b)=>b.amountMinor-a.amountMinor),daily,accounts:this.listAccounts({ownerId:q.ownerId}),snapshot,accountingBasis:'cash_flow_including_loans',timezone:q.range.timezone};
      this.database.exec('COMMIT');return result;
    }catch(error){try{this.database.exec('ROLLBACK');}catch{}throw error;}
  }

  exportForOwner(ownerId) {
    return this.database.prepare(`
      SELECT * FROM finance_entries
      WHERE owner_id = ?
      ORDER BY occurred_at ASC, created_at ASC, rowid ASC
    `).all(required(ownerId, 'OWNER_REQUIRED')).map((row) => this.toPublicRow(row));
  }

  summarizeAllForOwner(ownerId) {
    const row = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'income' AND status = 'active' THEN amount_minor ELSE 0 END), 0) AS income_minor,
        COALESCE(SUM(CASE WHEN type = 'expense' AND status = 'active' THEN amount_minor ELSE 0 END), 0) AS expense_minor
      FROM finance_entries WHERE owner_id = ?
    `).get(required(ownerId, 'OWNER_REQUIRED'));
    const incomeMinor = Number(row.income_minor);
    const expenseMinor = Number(row.expense_minor);
    return { incomeMinor, expenseMinor, balanceMinor: incomeMinor - expenseMinor };
  }

  deleteAllForOwner(ownerId) {
    return Number(this.database.prepare(
      'DELETE FROM finance_entries WHERE owner_id = ?'
    ).run(required(ownerId, 'OWNER_REQUIRED')).changes);
  }

  #mutateEntryLifecycle({
    ownerId,
    id,
    expectedVersion,
    clientRequestId,
    mutationRequestId,
    mutationType,
    requestOperation = mutationType,
    requestPayload = {},
    buildChanges
  }) {
    this.requireF201();
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const entryId = required(id, 'ID_REQUIRED');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      fail('FINANCE_EXPECTED_VERSION_REQUIRED');
    }
    const requestId = required(
      mutationRequestId ?? clientRequestId,
      'MUTATION_REQUEST_ID_REQUIRED'
    );
    const fingerprint = requestFingerprint({
      operation: requestOperation,
      targetEntryId: entryId,
      expectedVersion,
      payload: requestPayload
    });

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existingRequest = this.database.prepare(`
        SELECT * FROM finance_mutation_requests
        WHERE owner_id = ? AND client_request_id = ?
      `).get(owner, requestId);
      if (existingRequest) {
        if (
          existingRequest.mutation_type !== mutationType
          || existingRequest.target_entry_id !== entryId
          || existingRequest.request_fingerprint !== fingerprint
        ) {
          fail('FINANCE_IDEMPOTENCY_CONFLICT');
        }
        if (existingRequest.status !== 'committed' || !existingRequest.result_json) {
          fail('FINANCE_MUTATION_REQUEST_INCOMPLETE');
        }
        let replay;
        try {
          replay = JSON.parse(existingRequest.result_json);
        } catch {
          fail('FINANCE_MUTATION_REQUEST_CORRUPT');
        }
        if (!replay?.entry) fail('FINANCE_MUTATION_REQUEST_CORRUPT');
        this.database.exec('COMMIT');
        return replay.entry;
      }
      const existingCreate = this.database.prepare(`
        SELECT id FROM finance_entries WHERE owner_id = ? AND client_request_id = ?
      `).get(owner, requestId);
      if (existingCreate || batchRequestRows(this.database, owner, requestId).length > 0) {
        fail('FINANCE_IDEMPOTENCY_CONFLICT');
      }
      const current = this.database.prepare(`
        SELECT * FROM finance_entries WHERE id = ? AND owner_id = ?
      `).get(entryId, owner);
      if (!current) {
        this.database.exec('COMMIT');
        return null;
      }
      if (Number(current.version) !== expectedVersion) fail('FINANCE_VERSION_CONFLICT');

      const before = entrySnapshot(current);
      const now = this.clock().toISOString();
      const mutationRequest = this.database.prepare(`
        INSERT INTO finance_mutation_requests (
          owner_id, client_request_id, mutation_type, target_entry_id,
          request_fingerprint, status, result_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
      `).run(owner, requestId, mutationType, entryId, fingerprint, now);
      if (Number(mutationRequest.changes) !== 1) fail('FINANCE_MUTATION_REQUEST_NOT_COMMITTED');
      const businessChanges = buildChanges(before, now);
      const changed = Object.entries(businessChanges)
        .some(([field, value]) => !Object.is(before[field], value));
      if (!changed) {
        const unchanged = this.toPublicRow(current);
        const completed = this.database.prepare(`
          UPDATE finance_mutation_requests
          SET status = 'committed', result_json = ?, completed_at = ?
          WHERE owner_id = ? AND client_request_id = ? AND status = 'pending'
        `).run(JSON.stringify({ entry: unchanged }), now, owner, requestId);
        if (Number(completed.changes) !== 1) fail('FINANCE_MUTATION_REQUEST_NOT_COMPLETED');
        this.database.exec('COMMIT');
        return unchanged;
      }

      const candidate = {
        ...before,
        ...businessChanges,
        version: before.version + 1,
        updatedAt: now
      };
      const result = this.database.prepare(`
        UPDATE finance_entries SET
          amount_minor = ?, category = ?, note = ?, occurred_at = ?, status = ?, deleted_at = ?,
          archived_at = ?, version = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND version = ?
      `).run(
        candidate.amountMinor,
        candidate.category,
        candidate.note,
        candidate.occurredAt,
        candidate.status,
        candidate.deletedAt,
        candidate.archivedAt,
        candidate.version,
        candidate.updatedAt,
        entryId,
        owner,
        expectedVersion
      );
      if (Number(result.changes) !== 1) fail('FINANCE_VERSION_CONFLICT');

      const committed = this.database.prepare(`
        SELECT * FROM finance_entries WHERE id = ? AND owner_id = ?
      `).get(entryId, owner);
      if (!committed) fail('FINANCE_MUTATION_NOT_VISIBLE');
      const after = entrySnapshot(committed);
      const revisionId = this.revisionId();
      const revision = this.database.prepare(`
        INSERT INTO finance_revisions (
          id, owner_id, entry_id, entry_version, mutation_type, before_json,
          after_json, client_request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        owner,
        entryId,
        after.version,
        mutationType,
        JSON.stringify({ entry: before }),
        JSON.stringify({ entry: after, changes: changedFields(before, after) }),
        requestId,
        now
      );
      if (Number(revision.changes) !== 1) fail('FINANCE_REVISION_NOT_COMMITTED');
      const publicResult = this.toPublicRow(committed);
      const completed = this.database.prepare(`
        UPDATE finance_mutation_requests
        SET status = 'committed', result_json = ?, completed_at = ?
        WHERE owner_id = ? AND client_request_id = ? AND status = 'pending'
      `).run(JSON.stringify({ entry: publicResult }), now, owner, requestId);
      if (Number(completed.changes) !== 1) fail('FINANCE_MUTATION_REQUEST_NOT_COMPLETED');
      this.database.exec('COMMIT');
      return publicResult;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  update({ ownerId, id, patch = {}, expectedVersion, clientRequestId, mutationRequestId }) {
    if (this.f201Enabled) {
      return this.#mutateEntryLifecycle({
        ownerId,
        id,
        expectedVersion,
        clientRequestId,
        mutationRequestId,
        mutationType: 'update',
        requestPayload: normalizedUpdatePatch(patch),
        buildChanges: (current) => {
          if (current.status !== 'active') fail('FINANCE_ENTRY_NOT_ACTIVE');
          const amountMinor = patch.amountMinor === undefined ? current.amountMinor : Number(patch.amountMinor);
          const category = patch.category === undefined ? current.category : String(patch.category);
          if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) fail('AMOUNT_INVALID');
          if (!isAllowedCategory(current.type, category)) fail('CATEGORY_INVALID');
          const note = patch.note === undefined ? current.note : String(patch.note || '').trim() || null;
          const occurredAt = patch.occurredAt === undefined ? current.occurredAt : String(patch.occurredAt);
          if (!Number.isFinite(Date.parse(occurredAt))) fail('OCCURRED_AT_INVALID');
          return { amountMinor, category, note, occurredAt };
        }
      });
    }
    const current = this.get({ ownerId, id });
    if (!current) return null;
    const amountMinor = patch.amountMinor === undefined ? current.amountMinor : Number(patch.amountMinor);
    const category = patch.category === undefined ? current.category : String(patch.category);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('AMOUNT_INVALID');
    if (!isAllowedCategory(current.type, category)) throw new Error('CATEGORY_INVALID');
    const note = patch.note === undefined ? current.note : String(patch.note || '').trim() || null;
    const occurredAt = patch.occurredAt === undefined ? current.occurredAt : String(patch.occurredAt);
    if (!Number.isFinite(Date.parse(occurredAt))) throw new Error('OCCURRED_AT_INVALID');
    const updatedAt = this.clock().toISOString();
    this.database.prepare(`
      UPDATE finance_entries SET amount_minor = ?, category = ?, note = ?, occurred_at = ?, updated_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'active'
    `).run(amountMinor, category, note, occurredAt, updatedAt, id, ownerId);
    return this.get({ ownerId, id });
  }

  softDelete({ ownerId, id, expectedVersion, clientRequestId, mutationRequestId }) {
    if (this.f201Enabled) {
      return this.#mutateEntryLifecycle({
        ownerId,
        id,
        expectedVersion,
        clientRequestId,
        mutationRequestId,
        mutationType: 'delete',
        buildChanges: (current, now) => current.status === 'deleted'
          ? { status: current.status, deletedAt: current.deletedAt }
          : { status: 'deleted', deletedAt: now }
      });
    }
    const now = this.clock().toISOString();
    const result = this.database.prepare(`
      UPDATE finance_entries SET status = 'deleted', deleted_at = ?, updated_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'active'
    `).run(now, now, required(id, 'ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED'));
    return Number(result.changes) === 1;
  }

  restore({ ownerId, id, expectedVersion, clientRequestId, mutationRequestId }) {
    return this.#mutateEntryLifecycle({
      ownerId,
      id,
      expectedVersion,
      clientRequestId,
      mutationRequestId,
      mutationType: 'restore',
      buildChanges: (current) => current.status === 'deleted'
        ? { status: 'active', deletedAt: null }
        : { status: current.status, deletedAt: current.deletedAt }
    });
  }

  archive({ ownerId, id, expectedVersion, clientRequestId, mutationRequestId }) {
    return this.#mutateEntryLifecycle({
      ownerId,
      id,
      expectedVersion,
      clientRequestId,
      mutationRequestId,
      mutationType: 'archive',
      buildChanges: (current, now) => {
        if (current.status !== 'active') fail('FINANCE_ENTRY_NOT_ACTIVE');
        return { archivedAt: current.archivedAt || now };
      }
    });
  }

  unarchive({ ownerId, id, expectedVersion, clientRequestId, mutationRequestId }) {
    return this.#mutateEntryLifecycle({
      ownerId,
      id,
      expectedVersion,
      clientRequestId,
      mutationRequestId,
      mutationType: 'archive',
      requestOperation: 'unarchive',
      buildChanges: (current) => {
        if (current.status !== 'active') fail('FINANCE_ENTRY_NOT_ACTIVE');
        return { archivedAt: null };
      }
    });
  }

  archiveAccount({ ownerId, id } = {}) {
    this.requireF201();
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const accountId = required(id, 'ACCOUNT_ID_REQUIRED');
    if (accountId === historicalAccountId(owner)) fail('FINANCE_HISTORICAL_ACCOUNT_READ_ONLY');
    const now = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare(`
        SELECT * FROM finance_accounts WHERE id = ? AND owner_id = ?
      `).get(accountId, owner);
      if (!current) {
        this.database.exec('COMMIT');
        return null;
      }
      if (current.status === 'archived') {
        this.database.exec('COMMIT');
        return publicAccount(current);
      }
      const result = this.database.prepare(`
        UPDATE finance_accounts
        SET status = 'archived', archived_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND status = 'active'
      `).run(now, now, accountId, owner);
      if (Number(result.changes) !== 1) fail('FINANCE_ACCOUNT_ARCHIVE_NOT_COMMITTED');
      const committed = this.database.prepare(`
        SELECT * FROM finance_accounts WHERE id = ? AND owner_id = ?
      `).get(accountId, owner);
      this.database.exec('COMMIT');
      return publicAccount(committed);
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  unarchiveAccount({ ownerId, id } = {}) {
    this.requireF201();
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const accountId = required(id, 'ACCOUNT_ID_REQUIRED');
    if (accountId === historicalAccountId(owner)) fail('FINANCE_HISTORICAL_ACCOUNT_READ_ONLY');
    const now = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare(`
        SELECT * FROM finance_accounts WHERE id = ? AND owner_id = ?
      `).get(accountId, owner);
      if (!current) {
        this.database.exec('COMMIT');
        return null;
      }
      if (current.status === 'active') {
        this.database.exec('COMMIT');
        return publicAccount(current);
      }
      if (Number(current.is_system) === 1 && this.findDefaultAccount(owner)) {
        fail('FINANCE_DEFAULT_ACCOUNT_AMBIGUOUS');
      }
      const result = this.database.prepare(`
        UPDATE finance_accounts
        SET status = 'active', archived_at = NULL, updated_at = ?
        WHERE id = ? AND owner_id = ? AND status = 'archived'
      `).run(now, accountId, owner);
      if (Number(result.changes) !== 1) fail('FINANCE_ACCOUNT_UNARCHIVE_NOT_COMMITTED');
      const committed = this.database.prepare(`
        SELECT * FROM finance_accounts WHERE id = ? AND owner_id = ?
      `).get(accountId, owner);
      this.database.exec('COMMIT');
      return publicAccount(committed);
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  query(plan, { ownerId } = {}) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const validation = validateFinanceQueryPlan(plan);
    if (!validation.ok || plan.action !== 'query') {
      const error = new Error('FINANCE_QUERY_PLAN_INVALID');
      error.code = 'FINANCE_QUERY_PLAN_INVALID';
      error.details = validation.errors;
      throw error;
    }

    const clauses = [
      'owner_id = ?',
      "status = 'active'",
      'deleted_at IS NULL',
      'occurred_at >= ?',
      'occurred_at < ?'
    ];
    const values = [owner, plan.start_at, plan.end_at];
    const requestedMetrics = [...plan.metrics];
    const inheritedMetrics = requestedMetrics.includes('entries') ? plan.inherited_context?.previous_metrics || [] : [];
    const typeMetrics = requestedMetrics.filter((metric) => ['expense', 'income'].includes(metric));
    const inheritedTypeMetrics = inheritedMetrics.filter((metric) => ['expense', 'income'].includes(metric));
    const type = typeMetrics.length === 1 && requestedMetrics.length === 1
      ? typeMetrics[0]
      : inheritedTypeMetrics.length === 1 ? inheritedTypeMetrics[0] : null;
    if (type) {
      clauses.push('type = ?');
      values.push(type);
    }
    if (plan.category) {
      clauses.push('category = ?');
      values.push(plan.category);
    }
    if (plan.merchant_or_counterparty) {
      clauses.push('(merchant = ? OR counterparty = ?)');
      values.push(plan.merchant_or_counterparty, plan.merchant_or_counterparty);
    }
    if (plan.keyword) {
      const escaped = String(plan.keyword).replace(/[\\%_]/g, '\\$&');
      clauses.push("(note LIKE ? ESCAPE '\\' OR merchant LIKE ? ESCAPE '\\' OR counterparty LIKE ? ESCAPE '\\')");
      values.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    const where = clauses.join(' AND ');
    const totals = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END), 0) AS income_minor,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense_minor
      FROM finance_entries WHERE ${where}
    `).get(...values);
    const categories = this.database.prepare(`
      SELECT type, category, SUM(amount_minor) AS amount_minor
      FROM finance_entries WHERE ${where}
      GROUP BY type, category
    `).all(...values).map((row) => ({ type: row.type, category: row.category, amountMinor: Number(row.amount_minor) }))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'income' ? -1 : 1;
        return categoriesForType(left.type).indexOf(left.category) - categoriesForType(right.type).indexOf(right.category);
      });
    const safeLimit = Math.max(1, Math.min(500, Number(plan.limit) || 100));
    const entries = this.database.prepare(`
      SELECT * FROM finance_entries WHERE ${where}
      ORDER BY occurred_at DESC, created_at DESC, rowid DESC LIMIT ?
    `).all(...values, safeLimit).map((row) => this.toPublicRow(row));
    const incomeMinor = Number(totals.income_minor);
    const expenseMinor = Number(totals.expense_minor);
    const balanceMinor = incomeMinor - expenseMinor;
    const valueMinor = requestedMetrics.length === 1 && requestedMetrics[0] === 'income' ? incomeMinor
      : requestedMetrics.length === 1 && requestedMetrics[0] === 'expense' ? expenseMinor
        : requestedMetrics.length === 1 && requestedMetrics[0] === 'net' ? balanceMinor : null;
    return { incomeMinor, expenseMinor, balanceMinor, valueMinor, requestedMetrics, categories, entries };
  }

  buildMonthlyReportSnapshot({ ownerId, timezone = this.timezone, now = this.clock() } = {}) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const instant = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(instant.getTime())) throw new Error('FINANCE_REPORT_NOW_INVALID');
    const plan = buildFinanceQueryPlan({
      metrics: ['income', 'expense'],
      periodExpression: '本月',
      timezone,
      now: instant,
      text: '本月收支情况'
    });
    if (plan.action !== 'query') throw new Error('FINANCE_REPORT_RANGE_INVALID');

    this.database.exec('BEGIN');
    try {
      const authoritative = this.query(plan, { ownerId: owner });
      const rows = this.database.prepare(`
        SELECT * FROM finance_entries
        WHERE owner_id = ? AND status = 'active' AND deleted_at IS NULL
          AND occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at ASC, created_at ASC, rowid ASC
      `).all(owner, plan.start_at, plan.end_at);
      const entries = rows.map((row, index) => reportEntry(row, index, timezone));
      const localNow = localParts(instant, timezone);
      const dailyByDate = new Map();
      for (const entry of entries) {
        const daily = dailyByDate.get(entry.localDate) || { localDate: entry.localDate, incomeMinor: 0, expenseMinor: 0 };
        daily[entry.type === 'income' ? 'incomeMinor' : 'expenseMinor'] += entry.amountMinor;
        dailyByDate.set(entry.localDate, daily);
      }
      const dailySummaries = [...dailyByDate.values()].sort((left, right) => left.localDate.localeCompare(right.localDate))
        .map((row) => ({ ...row, balanceMinor: row.incomeMinor - row.expenseMinor }));
      const snapshot = {
        schemaVersion: 1,
        reportType: 'monthly_finance',
        title: `AI分身-${Number(localNow.year)}年${Number(localNow.month)}月收支报表`,
        timezone,
        period: {
          year: Number(localNow.year),
          month: Number(localNow.month),
          label: `${Number(localNow.year)}年${Number(localNow.month)}月`,
          startAt: plan.start_at,
          endAt: plan.end_at
        },
        currency: 'CNY',
        totals: {
          incomeMinor: authoritative.incomeMinor,
          expenseMinor: authoritative.expenseMinor,
          balanceMinor: authoritative.balanceMinor
        },
        categorySummaries: {
          income: authoritative.categories.filter((row) => row.type === 'income').map(({ category, amountMinor }) => ({ category, amountMinor })),
          expense: authoritative.categories.filter((row) => row.type === 'expense').map(({ category, amountMinor }) => ({ category, amountMinor }))
        },
        dailySummaries,
        entries,
        entryCount: entries.length,
        generatedAt: instant.toISOString()
      };
      assertMonthlyFinanceReportSnapshot(snapshot);
      this.database.exec('COMMIT');
      return snapshot;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  summarize({ ownerId, period = 'month', now = this.clock(), type = null, category = null, dateKey = null } = {}) {
    const metrics = type ? [type]
      : category ? [categoriesForType('income').includes(category) ? 'income' : 'expense']
        : ['income', 'expense'];
    const periodExpression = dateKey
      ? `${Number(dateKey.slice(0, 4))}年${Number(dateKey.slice(5, 7))}月${Number(dateKey.slice(8, 10))}日`
      : period === 'today' ? '今天'
        : period === 'week' ? '本周' : '本月';
    const plan = buildFinanceQueryPlan({ metrics, periodExpression, timezone: this.timezone, now, text: periodExpression });
    if (plan.action !== 'query') throw new Error('FINANCE_QUERY_PLAN_INVALID');
    plan.category = category || null;
    plan.limit = 500;
    return this.query(plan, { ownerId });
  }
}
