import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyFinanceF201Migration } from './financeF201Migration.js';
import { applyFinanceMigrations } from './migrations.js';

const FIXED_TIME = '2026-08-02T02:00:00.000Z';

function createV1Harness(prefix = 'aiwc-finance-f201-') {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  const databasePath = path.join(directory, 'finance.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  applyFinanceMigrations(database);
  return {
    directory,
    databasePath,
    database,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function insertHistoricalEntry(database, overrides = {}) {
  const row = {
    id: 'fin_history_001',
    ownerId: 'owner-history',
    type: 'expense',
    amountMinor: 12800,
    currency: 'CNY',
    occurredAt: '2026-07-01T04:30:00.000Z',
    timezone: 'Asia/Shanghai',
    category: '餐饮',
    merchant: '历史商户',
    counterparty: null,
    note: '不可改写的历史记录',
    sourceMessageId: 'msg-history-001',
    clientRequestId: 'req-history-001',
    status: 'active',
    createdAt: '2026-07-01T04:31:00.000Z',
    updatedAt: '2026-07-01T04:31:00.000Z',
    deletedAt: null,
    ...overrides
  };
  database.prepare(`
    INSERT INTO finance_entries (
      id, owner_id, type, amount_minor, currency, occurred_at, timezone, category,
      merchant, counterparty, note, source_message_id, client_request_id, status,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.ownerId, row.type, row.amountMinor, row.currency, row.occurredAt,
    row.timezone, row.category, row.merchant, row.counterparty, row.note,
    row.sourceMessageId, row.clientRequestId, row.status, row.createdAt,
    row.updatedAt, row.deletedAt
  );
}

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function columnNames(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test('F2.0-1 migration extends V1 schema without rewriting historical ledger facts', () => {
  const h = createV1Harness();
  try {
    h.database.exec("CREATE TABLE unrelated_task2_guard (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO unrelated_task2_guard VALUES ('keep', 'unchanged');");
    insertHistoricalEntry(h.database);
    const historicalBefore = plainRows(h.database.prepare(`
      SELECT id, owner_id, type, amount_minor, currency, occurred_at, timezone,
        category, merchant, counterparty, note, source_message_id,
        client_request_id, status, created_at, updated_at, deleted_at
      FROM finance_entries ORDER BY id
    `).all());

    const result = applyFinanceF201Migration(h.database, {
      clock: () => new Date(FIXED_TIME)
    });

    assert.deepEqual(result, { version: 2, applied: true });
    const tables = h.database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'finance_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [
      'finance_accounts',
      'finance_entries',
      'finance_mutation_requests',
      'finance_revisions',
      'finance_schema_versions'
    ]);

    const entryColumns = plainRows(h.database.prepare('PRAGMA table_info(finance_entries)').all());
    assert.deepEqual(entryColumns.slice(-3).map(({ name, notnull, dflt_value }) => ({ name, notnull, dflt_value })), [
      { name: 'account_id', notnull: 0, dflt_value: null },
      { name: 'version', notnull: 1, dflt_value: '1' },
      { name: 'archived_at', notnull: 0, dflt_value: null }
    ]);
    assert.deepEqual(columnNames(h.database, 'finance_accounts'), [
      'id', 'owner_id', 'name', 'account_type', 'currency', 'status', 'is_system',
      'created_at', 'updated_at', 'archived_at'
    ]);
    assert.deepEqual(columnNames(h.database, 'finance_revisions'), [
      'id', 'owner_id', 'entry_id', 'entry_version', 'mutation_type', 'before_json',
      'after_json', 'client_request_id', 'created_at'
    ]);
    assert.deepEqual(columnNames(h.database, 'finance_mutation_requests'), [
      'owner_id', 'client_request_id', 'mutation_type', 'target_entry_id',
      'request_fingerprint', 'status', 'result_json', 'created_at', 'completed_at'
    ]);

    const namedIndexes = h.database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'index' AND name LIKE 'idx_finance_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(namedIndexes, [
      'idx_finance_accounts_owner_status',
      'idx_finance_mutation_requests_entry',
      'idx_finance_owner_occurred',
      'idx_finance_owner_status_category',
      'idx_finance_revisions_owner_entry'
    ]);

    const historicalAfter = plainRows(h.database.prepare(`
      SELECT id, owner_id, type, amount_minor, currency, occurred_at, timezone,
        category, merchant, counterparty, note, source_message_id,
        client_request_id, status, created_at, updated_at, deleted_at
      FROM finance_entries ORDER BY id
    `).all());
    assert.deepEqual(historicalAfter, historicalBefore);
    assert.deepEqual(
      plainRows(h.database.prepare('SELECT id, account_id, version, archived_at FROM finance_entries').all()),
      [{ id: 'fin_history_001', account_id: null, version: 1, archived_at: null }]
    );
    assert.equal(h.database.prepare('SELECT COUNT(*) AS count FROM finance_accounts').get().count, 0);
    assert.equal(h.database.prepare('SELECT COUNT(*) AS count FROM finance_revisions').get().count, 0);
    assert.equal(h.database.prepare('SELECT COUNT(*) AS count FROM finance_mutation_requests').get().count, 0);
    const versions = plainRows(
      h.database.prepare('SELECT version, applied_at FROM finance_schema_versions ORDER BY version').all()
    );
    assert.deepEqual(versions.map((row) => row.version), [1, 2]);
    assert.equal(typeof versions[0].applied_at, 'string');
    assert.equal(versions[1].applied_at, FIXED_TIME);
    assert.deepEqual(
      plainRows(h.database.prepare('SELECT * FROM unrelated_task2_guard').all()),
      [{ id: 'keep', value: 'unchanged' }]
    );
  } finally {
    h.close();
  }
});

test('F2.0-1 migration is idempotent and verifies the same V2 schema on rerun', () => {
  const h = createV1Harness('aiwc-finance-f201-idempotent-');
  try {
    insertHistoricalEntry(h.database);
    const first = applyFinanceF201Migration(h.database, {
      clock: () => new Date(FIXED_TIME)
    });
    const schemaAfterFirst = plainRows(h.database.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name LIKE 'finance_%' OR name LIKE 'idx_finance_%' OR name = 'uq_finance_owner_client_request'
      ORDER BY type, name
    `).all());
    const entryAfterFirst = plainRows(h.database.prepare('SELECT * FROM finance_entries ORDER BY id').all());

    const second = applyFinanceF201Migration(h.database, {
      clock: () => new Date('2026-08-02T03:00:00.000Z')
    });

    assert.deepEqual(first, { version: 2, applied: true });
    assert.deepEqual(second, { version: 2, applied: false });
    assert.deepEqual(plainRows(h.database.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name LIKE 'finance_%' OR name LIKE 'idx_finance_%' OR name = 'uq_finance_owner_client_request'
      ORDER BY type, name
    `).all()), schemaAfterFirst);
    assert.deepEqual(plainRows(h.database.prepare('SELECT * FROM finance_entries ORDER BY id').all()), entryAfterFirst);
    assert.deepEqual(
      plainRows(h.database.prepare('SELECT version, applied_at FROM finance_schema_versions ORDER BY version').all()),
      [
        { version: 1, applied_at: h.database.prepare('SELECT applied_at FROM finance_schema_versions WHERE version = 1').get().applied_at },
        { version: 2, applied_at: FIXED_TIME }
      ]
    );
  } finally {
    h.close();
  }
});

test('F2.0-1 migration rolls back every additive change when a statement fails mid-transaction', () => {
  const h = createV1Harness('aiwc-finance-f201-rollback-');
  try {
    insertHistoricalEntry(h.database);
    const originalColumns = columnNames(h.database, 'finance_entries');
    const originalEntry = plainRows(h.database.prepare('SELECT * FROM finance_entries').all());
    h.database.exec('CREATE TABLE finance_revisions (sentinel TEXT NOT NULL)');

    assert.throws(
      () => applyFinanceF201Migration(h.database, {
        clock: () => new Date(FIXED_TIME)
      }),
      /finance_revisions already exists/
    );

    assert.deepEqual(columnNames(h.database, 'finance_entries'), originalColumns);
    assert.deepEqual(plainRows(h.database.prepare('SELECT * FROM finance_entries').all()), originalEntry);
    assert.equal(
      h.database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'finance_accounts'").get().count,
      0
    );
    assert.equal(
      h.database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'idx_finance_accounts_owner_status'").get().count,
      0
    );
    assert.deepEqual(
      h.database.prepare('SELECT version FROM finance_schema_versions ORDER BY version').all().map((row) => row.version),
      [1]
    );
    assert.deepEqual(columnNames(h.database, 'finance_revisions'), ['sentinel']);
  } finally {
    h.close();
  }
});

test('F2.0-1 migration fails closed when the V2 marker and physical schema drift', () => {
  const markerOnly = createV1Harness('aiwc-finance-f201-marker-drift-');
  try {
    markerOnly.database.prepare(`
      INSERT INTO finance_schema_versions (version, applied_at) VALUES (2, ?)
    `).run(FIXED_TIME);
    assert.throws(
      () => applyFinanceF201Migration(markerOnly.database),
      (error) => error?.code === 'FINANCE_F2_0_1_MIGRATION_DRIFT'
    );
    assert.deepEqual(columnNames(markerOnly.database, 'finance_entries').slice(-3), [
      'created_at', 'updated_at', 'deleted_at'
    ]);
  } finally {
    markerOnly.close();
  }

  const missingIndex = createV1Harness('aiwc-finance-f201-index-drift-');
  try {
    applyFinanceF201Migration(missingIndex.database, {
      clock: () => new Date(FIXED_TIME)
    });
    missingIndex.database.exec('DROP INDEX idx_finance_revisions_owner_entry');
    assert.throws(
      () => applyFinanceF201Migration(missingIndex.database),
      (error) => error?.code === 'FINANCE_F2_0_1_MIGRATION_DRIFT'
    );
    assert.equal(
      missingIndex.database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'idx_finance_revisions_owner_entry'").get().count,
      0
    );
    assert.deepEqual(
      missingIndex.database.prepare('SELECT version FROM finance_schema_versions ORDER BY version').all().map((row) => row.version),
      [1, 2]
    );
  } finally {
    missingIndex.close();
  }
});

test('F2.0-1 migration requires a complete V1 ledger and never bootstraps an empty database', () => {
  const emptyDirectory = mkdtempSync(path.join(tmpdir(), 'aiwc-finance-f201-empty-'));
  const emptyDatabase = new DatabaseSync(path.join(emptyDirectory, 'finance.sqlite'));
  try {
    assert.throws(
      () => applyFinanceF201Migration(emptyDatabase),
      (error) => error?.code === 'FINANCE_F2_0_1_BASE_SCHEMA_REQUIRED'
    );
    assert.equal(
      emptyDatabase.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'finance_%'").get().count,
      0
    );
  } finally {
    emptyDatabase.close();
    rmSync(emptyDirectory, { recursive: true, force: true });
  }

  const incompleteDirectory = mkdtempSync(path.join(tmpdir(), 'aiwc-finance-f201-incomplete-'));
  const incompleteDatabase = new DatabaseSync(path.join(incompleteDirectory, 'finance.sqlite'));
  try {
    incompleteDatabase.exec(`
      CREATE TABLE finance_schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO finance_schema_versions VALUES (1, '${FIXED_TIME}');
      CREATE TABLE finance_entries (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
    `);
    assert.throws(
      () => applyFinanceF201Migration(incompleteDatabase),
      (error) => error?.code === 'FINANCE_F2_0_1_BASE_SCHEMA_INVALID'
    );
    assert.deepEqual(columnNames(incompleteDatabase, 'finance_entries'), ['id', 'owner_id']);
    assert.equal(
      incompleteDatabase.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'finance_accounts'").get().count,
      0
    );
  } finally {
    incompleteDatabase.close();
    rmSync(incompleteDirectory, { recursive: true, force: true });
  }
});
