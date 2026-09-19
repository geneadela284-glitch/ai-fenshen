import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { FinanceRepository } from './repository.js';
import { createFinanceRuntime } from './runtime.js';

const NOW = new Date('2026-07-22T04:00:00.000Z');
const TIMEZONE = 'Asia/Shanghai';

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function createV2Fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE finance_schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO finance_schema_versions (version, applied_at) VALUES
      (1, '2026-07-01T00:00:00.000Z'),
      (2, '2026-07-22T04:00:00.000Z');

    CREATE TABLE finance_accounts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (
        account_type IN ('historical', 'cash', 'bank', 'credit', 'wallet', 'other')
      ),
      currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX idx_finance_accounts_owner_status
      ON finance_accounts(owner_id, status, created_at, id);

    CREATE TABLE finance_entries (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
      occurred_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      category TEXT NOT NULL,
      merchant TEXT,
      counterparty TEXT,
      note TEXT,
      source_message_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      account_id TEXT REFERENCES finance_accounts(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      archived_at TEXT
    );
    CREATE UNIQUE INDEX uq_finance_owner_client_request
      ON finance_entries(owner_id, client_request_id);
    CREATE INDEX idx_finance_owner_occurred
      ON finance_entries(owner_id, occurred_at DESC);
    CREATE INDEX idx_finance_owner_status_category
      ON finance_entries(owner_id, status, category);

    CREATE TABLE finance_revisions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      entry_version INTEGER NOT NULL CHECK (entry_version >= 2),
      mutation_type TEXT NOT NULL CHECK (
        mutation_type IN ('update', 'delete', 'restore', 'archive')
      ),
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(entry_id, entry_version),
      FOREIGN KEY(entry_id) REFERENCES finance_entries(id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_finance_revisions_owner_entry
      ON finance_revisions(owner_id, entry_id, entry_version DESC);

    CREATE TABLE finance_mutation_requests (
      owner_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK (
        mutation_type IN ('update', 'delete', 'restore', 'archive')
      ),
      target_entry_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'failed')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY(owner_id, client_request_id),
      FOREIGN KEY(target_entry_id) REFERENCES finance_entries(id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_finance_mutation_requests_entry
      ON finance_mutation_requests(owner_id, target_entry_id, created_at);
  `);
  return database;
}

function insertHistoricalEntry(database, {
  id,
  ownerId,
  type,
  amountMinor,
  category,
  occurredAt = NOW.toISOString()
}) {
  database.prepare(`
    INSERT INTO finance_entries (
      id, owner_id, type, amount_minor, currency, occurred_at, timezone, category,
      merchant, counterparty, note, source_message_id, client_request_id, status,
      created_at, updated_at, deleted_at, account_id, version, archived_at
    ) VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, NULL, NULL, ?, ?, ?, 'active', ?, ?, NULL, NULL, 1, NULL)
  `).run(
    id,
    ownerId,
    type,
    amountMinor,
    occurredAt,
    TIMEZONE,
    category,
    `历史-${id}`,
    `source-${id}`,
    `request-${id}`,
    NOW.toISOString(),
    NOW.toISOString()
  );
}

function repository(database, { f201Enabled = true } = {}) {
  let entrySequence = 0;
  let accountSequence = 0;
  return new FinanceRepository({
    database,
    f201Enabled,
    timezone: TIMEZONE,
    clock: () => new Date(NOW),
    id: () => `new-entry-${++entrySequence}`,
    accountId: () => `default-account-${++accountSequence}`
  });
}

function createEntry(repo, {
  ownerId,
  clientRequestId,
  amountMinor = 2500,
  type = 'expense',
  category = '餐饮',
  accountId
}) {
  return repo.create({
    ownerId,
    type,
    amountMinor,
    currency: 'CNY',
    occurredAt: NOW.toISOString(),
    timezone: TIMEZONE,
    category,
    note: '新账',
    sourceMessageId: `source-${clientRequestId}`,
    clientRequestId,
    accountId
  });
}

test('F2.0-1 maps account_id null reads to owner-scoped virtual historical accounts without changing stored rows', () => {
  const database = createV2Fixture();
  try {
    insertHistoricalEntry(database, {
      id: 'history-a-expense', ownerId: 'owner-a', type: 'expense', amountMinor: 1800, category: '餐饮'
    });
    insertHistoricalEntry(database, {
      id: 'history-b-income', ownerId: 'owner-b', type: 'income', amountMinor: 500000, category: '工资'
    });
    const before = database.prepare('SELECT * FROM finance_entries ORDER BY id').all();
    const repo = repository(database);

    const accountsA = repo.listAccounts({ ownerId: 'owner-a' });
    const accountsB = repo.listAccounts({ ownerId: 'owner-b' });
    const historyA = accountsA.find((account) => account.accountType === 'historical');
    const historyB = accountsB.find((account) => account.accountType === 'historical');

    assert.deepEqual(historyA, {
      id: historyA.id,
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
    });
    assert.notEqual(historyA.id, historyB.id);
    assert.equal(repo.getAccount({ ownerId: 'owner-b', id: historyA.id }), null);
    assert.equal(repo.list({ ownerId: 'owner-a' })[0].accountId, historyA.id);
    assert.equal(repo.get({ ownerId: 'owner-a', id: 'history-a-expense' }).accountId, historyA.id);
    assert.equal(repo.exportForOwner('owner-a')[0].accountId, historyA.id);
    assert.equal(repo.summarize({ ownerId: 'owner-a', period: 'month', now: NOW }).entries[0].accountId, historyA.id);
    assert.equal(repo.list({ ownerId: 'owner-b' })[0].accountId, historyB.id);
    assert.deepEqual(database.prepare('SELECT * FROM finance_entries ORDER BY id').all(), before);
    assert.deepEqual(
      plainRows(database.prepare('SELECT id, account_id FROM finance_entries ORDER BY id').all()),
      [
        { id: 'history-a-expense', account_id: null },
        { id: 'history-b-income', account_id: null }
      ]
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM finance_accounts').get().count, 0);
  } finally {
    database.close();
  }
});

test('F2.0-1 writes every new entry to one owner-scoped system default account, never the historical account', () => {
  const database = createV2Fixture();
  try {
    insertHistoricalEntry(database, {
      id: 'history-a', ownerId: 'owner-a', type: 'expense', amountMinor: 1800, category: '餐饮'
    });
    const repo = repository(database);
    const historyA = repo.listAccounts({ ownerId: 'owner-a' })[0];

    const firstA = createEntry(repo, {
      ownerId: 'owner-a', clientRequestId: 'new-a-1', accountId: historyA.id
    });
    const secondA = createEntry(repo, { ownerId: 'owner-a', clientRequestId: 'new-a-2' });
    const firstB = createEntry(repo, { ownerId: 'owner-b', clientRequestId: 'new-b-1' });
    const [batchA, batchB] = repo.createMany([
      {
        ownerId: 'owner-a', type: 'expense', amountMinor: 3000, currency: 'CNY',
        occurredAt: NOW.toISOString(), timezone: TIMEZONE, category: '交通', note: '批量-A',
        sourceMessageId: 'source-batch-a', clientRequestId: 'batch-a', accountId: historyA.id
      },
      {
        ownerId: 'owner-b', type: 'income', amountMinor: 8000, currency: 'CNY',
        occurredAt: NOW.toISOString(), timezone: TIMEZONE, category: '其他收入', note: '批量-B',
        sourceMessageId: 'source-batch-b', clientRequestId: 'batch-b'
      }
    ]);

    assert.notEqual(firstA.accountId, historyA.id);
    assert.equal(firstA.accountId, secondA.accountId);
    assert.notEqual(firstA.accountId, firstB.accountId);
    assert.equal(batchA.accountId, firstA.accountId);
    assert.equal(batchB.accountId, firstB.accountId);
    assert.deepEqual(
      plainRows(database.prepare(`
        SELECT owner_id, name, account_type, status, is_system
        FROM finance_accounts ORDER BY owner_id
      `).all()),
      [
        { owner_id: 'owner-a', name: '默认账户', account_type: 'cash', status: 'active', is_system: 1 },
        { owner_id: 'owner-b', name: '默认账户', account_type: 'cash', status: 'active', is_system: 1 }
      ]
    );
    assert.equal(database.prepare('SELECT account_id FROM finance_entries WHERE id = ?').get('history-a').account_id, null);
    assert.equal(database.prepare('SELECT account_id FROM finance_entries WHERE id = ?').get(firstA.id).account_id, firstA.accountId);
    assert.equal(repo.listAccounts({ ownerId: 'owner-a' }).find((account) => account.id === firstA.accountId).acceptsNewEntries, true);
    assert.equal(repo.listAccounts({ ownerId: 'owner-b' }).some((account) => account.id === firstA.accountId), false);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(plainRows(database.prepare('PRAGMA foreign_key_check').all()), []);
  } finally {
    database.close();
  }
});

test('F2.0-1 keeps owner totals and legacy monthly report amounts unchanged for historical rows', () => {
  const database = createV2Fixture();
  try {
    insertHistoricalEntry(database, {
      id: 'history-income', ownerId: 'owner-a', type: 'income', amountMinor: 500000, category: '工资',
      occurredAt: '2026-07-10T04:00:00.000Z'
    });
    insertHistoricalEntry(database, {
      id: 'history-expense', ownerId: 'owner-a', type: 'expense', amountMinor: 6800, category: '购物',
      occurredAt: '2026-07-20T04:00:00.000Z'
    });
    insertHistoricalEntry(database, {
      id: 'other-owner', ownerId: 'owner-b', type: 'expense', amountMinor: 999900, category: '其他',
      occurredAt: '2026-07-20T04:00:00.000Z'
    });
    const legacyRepository = repository(database, { f201Enabled: false });
    const before = legacyRepository.buildMonthlyReportSnapshot({ ownerId: 'owner-a', timezone: TIMEZONE, now: NOW });
    const f201Repository = repository(database, { f201Enabled: true });
    const after = f201Repository.buildMonthlyReportSnapshot({ ownerId: 'owner-a', timezone: TIMEZONE, now: NOW });

    assert.deepEqual(before.totals, { incomeMinor: 500000, expenseMinor: 6800, balanceMinor: 493200 });
    assert.deepEqual(after.totals, before.totals);
    assert.deepEqual(after.categorySummaries, before.categorySummaries);
    assert.deepEqual(after.dailySummaries, before.dailySummaries);
    assert.deepEqual(after.entries, before.entries);
    assert.equal(after.entryCount, before.entryCount);
    assert.deepEqual(f201Repository.summarizeAllForOwner('owner-a'), before.totals);
  } finally {
    database.close();
  }
});

test('Finance F2.0-1 disabled preserves Generation 154 Repository shape and null account writes', () => {
  const database = createV2Fixture();
  try {
    const repo = repository(database, { f201Enabled: false });
    const entry = createEntry(repo, { ownerId: 'owner-a', clientRequestId: 'generation-154-write' });

    assert.equal(Object.hasOwn(entry, 'accountId'), false);
    assert.equal(database.prepare('SELECT account_id FROM finance_entries WHERE id = ?').get(entry.id).account_id, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM finance_accounts').get().count, 0);
    assert.equal(typeof repo.listAccounts, 'function');
    assert.throws(() => repo.listAccounts({ ownerId: 'owner-a' }), /FINANCE_F2_0_1_NOT_ENABLED/);
  } finally {
    database.close();
  }
});

test('Finance runtime forwards the enabled F2.0-1 contract to Repository without automatic Migration', () => {
  const database = createV2Fixture();
  const runtime = createFinanceRuntime({
    database,
    f201Enabled: true,
    applyMigrations: false,
    timezone: TIMEZONE,
    clock: () => new Date(NOW)
  });
  try {
    const entry = createEntry(runtime.repository, {
      ownerId: 'owner-runtime', clientRequestId: 'runtime-default-account'
    });
    assert.match(entry.accountId, /^fin_account_/);
    assert.equal(
      database.prepare('SELECT account_id FROM finance_entries WHERE id = ?').get(entry.id).account_id,
      entry.accountId
    );
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM finance_schema_versions').get().version, 2);
  } finally {
    runtime.close();
    database.close();
  }
});
