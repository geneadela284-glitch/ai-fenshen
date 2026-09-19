import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyFinanceF201Migration } from './financeF201Migration.js';
import { applyFinanceMigrations } from './migrations.js';
import { FinanceRepository } from './repository.js';

const NOW = new Date('2026-08-02T04:00:00.000Z');
const TIMEZONE = 'Asia/Shanghai';
const SNAPSHOT_FIELDS = [
  'id', 'ownerId', 'type', 'amountMinor', 'currency', 'occurredAt', 'timezone',
  'category', 'merchant', 'counterparty', 'note', 'sourceMessageId',
  'clientRequestId', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'accountId',
  'version', 'archivedAt'
].sort();

function fixture() {
  const database = new DatabaseSync(':memory:');
  applyFinanceMigrations(database);
  applyFinanceF201Migration(database, { clock: () => new Date(NOW) });
  let entrySequence = 0;
  let accountSequence = 0;
  let revisionSequence = 0;
  const repository = new FinanceRepository({
    database,
    f201Enabled: true,
    timezone: TIMEZONE,
    clock: () => new Date(NOW),
    id: () => `entry-${++entrySequence}`,
    accountId: () => `account-${++accountSequence}`,
    revisionId: () => `revision-${++revisionSequence}`
  });
  return { database, repository };
}

function createExpense(repository, clientRequestId = 'create-expense', amountMinor = 2500) {
  return repository.create({
    ownerId: 'owner-a',
    type: 'expense',
    amountMinor,
    currency: 'CNY',
    occurredAt: NOW.toISOString(),
    timezone: TIMEZONE,
    category: '餐饮',
    note: '午餐',
    sourceMessageId: `source-${clientRequestId}`,
    clientRequestId
  });
}

function revisions(database) {
  return database.prepare(`
    SELECT id, owner_id, entry_id, entry_version, mutation_type, before_json,
      after_json, client_request_id, created_at
    FROM finance_revisions ORDER BY entry_version ASC
  `).all().map((row) => ({
    ...row,
    before_json: JSON.parse(row.before_json),
    after_json: JSON.parse(row.after_json)
  }));
}

test('F2.0-1 effective update uses expectedVersion and records one complete Revision with field differences', () => {
  const { database, repository } = fixture();
  try {
    const created = createExpense(repository);
    assert.equal(created.version, 1);

    const updated = repository.update({
      ownerId: 'owner-a',
      id: created.id,
      expectedVersion: 1,
      clientRequestId: 'update-expense',
      patch: { amountMinor: 3200, category: '交通', note: '打车' }
    });

    assert.equal(updated.version, 2);
    assert.equal(updated.amountMinor, 3200);
    assert.equal(updated.category, '交通');
    assert.equal(updated.note, '打车');
    const [revision] = revisions(database);
    assert.equal(revision.entry_version, 2);
    assert.equal(revision.mutation_type, 'update');
    assert.equal(revision.client_request_id, 'update-expense');
    assert.equal(revision.before_json.entry.id, created.id);
    assert.equal(revision.before_json.entry.amountMinor, 2500);
    assert.equal(revision.before_json.entry.version, 1);
    assert.equal(revision.after_json.entry.amountMinor, 3200);
    assert.equal(revision.after_json.entry.version, 2);
    assert.deepEqual(Object.keys(revision.before_json.entry).sort(), SNAPSHOT_FIELDS);
    assert.deepEqual(Object.keys(revision.after_json.entry).sort(), SNAPSHOT_FIELDS);
    assert.deepEqual(revision.after_json.changes, {
      amountMinor: { before: 2500, after: 3200 },
      category: { before: '餐饮', after: '交通' },
      note: { before: '午餐', after: '打车' },
      version: { before: 1, after: 2 }
    });
  } finally {
    database.close();
  }
});

test('F2.0-1 no-op update leaves version unchanged and creates no Revision', () => {
  const { database, repository } = fixture();
  try {
    const created = createExpense(repository);
    const unchanged = repository.update({
      ownerId: 'owner-a',
      id: created.id,
      expectedVersion: 1,
      clientRequestId: 'no-op-update',
      patch: { amountMinor: 2500, category: '餐饮', note: '午餐' }
    });

    assert.equal(unchanged.version, 1);
    assert.equal(revisions(database).length, 0);
  } finally {
    database.close();
  }
});

test('F2.0-1 failed and stale updates roll back without orphan Revisions or lost updates', () => {
  const { database, repository } = fixture();
  try {
    const created = createExpense(repository);
    assert.throws(
      () => repository.update({
        ownerId: 'owner-a', id: created.id,
        clientRequestId: 'missing-version', patch: { amountMinor: 2800 }
      }),
      (error) => error.code === 'FINANCE_EXPECTED_VERSION_REQUIRED'
    );
    assert.equal(revisions(database).length, 0);
    const first = repository.update({
      ownerId: 'owner-a', id: created.id, expectedVersion: 1,
      clientRequestId: 'first-writer', patch: { amountMinor: 3000 }
    });
    assert.equal(first.version, 2);
    assert.throws(
      () => repository.update({
        ownerId: 'owner-a', id: created.id, expectedVersion: 1,
        clientRequestId: 'stale-writer', patch: { amountMinor: 9900 }
      }),
      (error) => error.code === 'FINANCE_VERSION_CONFLICT'
    );
    assert.equal(repository.get({ ownerId: 'owner-a', id: created.id }).amountMinor, 3000);
    assert.equal(revisions(database).length, 1);

    database.exec(`
      CREATE TRIGGER fail_finance_entry_update
      BEFORE UPDATE ON finance_entries
      BEGIN
        SELECT RAISE(ABORT, 'simulated update failure');
      END;
    `);
    assert.throws(
      () => repository.update({
        ownerId: 'owner-a', id: created.id, expectedVersion: 2,
        clientRequestId: 'failed-writer', patch: { amountMinor: 3600 }
      }),
      /simulated update failure/
    );
    assert.equal(repository.get({ ownerId: 'owner-a', id: created.id }).amountMinor, 3000);
    assert.equal(revisions(database).length, 1);

    database.exec('DROP TRIGGER fail_finance_entry_update');
    database.exec(`
      CREATE TRIGGER fail_finance_revision_insert
      BEFORE INSERT ON finance_revisions
      BEGIN
        SELECT RAISE(ABORT, 'simulated revision failure');
      END;
    `);
    assert.throws(
      () => repository.update({
        ownerId: 'owner-a', id: created.id, expectedVersion: 2,
        clientRequestId: 'revision-failed-writer', patch: { amountMinor: 4200 }
      }),
      /simulated revision failure/
    );
    const rolledBack = repository.get({ ownerId: 'owner-a', id: created.id });
    assert.equal(rolledBack.amountMinor, 3000);
    assert.equal(rolledBack.version, 2);
    assert.equal(revisions(database).length, 1);
  } finally {
    database.close();
  }
});

test('F2.0-1 delete exits statistics, restore re-enters statistics, and archived state survives delete and restore', () => {
  const { database, repository } = fixture();
  try {
    const created = createExpense(repository, 'lifecycle-expense', 4800);
    assert.deepEqual(repository.summarizeAllForOwner('owner-a'), {
      incomeMinor: 0, expenseMinor: 4800, balanceMinor: -4800
    });

    const archived = repository.archive({
      ownerId: 'owner-a', id: created.id, expectedVersion: 1, clientRequestId: 'archive-expense'
    });
    assert.equal(archived.version, 2);
    assert.equal(archived.archivedAt, NOW.toISOString());
    assert.equal(repository.summarizeAllForOwner('owner-a').expenseMinor, 4800);

    const deleted = repository.softDelete({
      ownerId: 'owner-a', id: created.id, expectedVersion: 2, clientRequestId: 'delete-expense'
    });
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.version, 3);
    assert.equal(deleted.archivedAt, archived.archivedAt);
    assert.equal(repository.summarizeAllForOwner('owner-a').expenseMinor, 0);
    const unchangedDelete = repository.softDelete({
      ownerId: 'owner-a', id: created.id, expectedVersion: 3, clientRequestId: 'repeat-delete-expense'
    });
    assert.equal(unchangedDelete.version, 3);
    assert.equal(revisions(database).length, 2);

    const restored = repository.restore({
      ownerId: 'owner-a', id: created.id, expectedVersion: 3, clientRequestId: 'restore-expense'
    });
    assert.equal(restored.status, 'active');
    assert.equal(restored.version, 4);
    assert.equal(restored.archivedAt, archived.archivedAt);
    assert.equal(repository.summarizeAllForOwner('owner-a').expenseMinor, 4800);
    assert.equal(repository.queryHistory({
      ownerId: 'owner-a', period: 'all_time', statuses: ['archived']
    }).entries[0].id, created.id);
    const unchangedArchive = repository.archive({
      ownerId: 'owner-a', id: created.id, expectedVersion: 4, clientRequestId: 'repeat-archive-expense'
    });
    assert.equal(unchangedArchive.version, 4);
    assert.equal(revisions(database).length, 3);

    const active = repository.unarchive({
      ownerId: 'owner-a', id: created.id, expectedVersion: 4, clientRequestId: 'unarchive-expense'
    });
    assert.equal(active.version, 5);
    assert.equal(active.archivedAt, null);
    assert.equal(repository.summarizeAllForOwner('owner-a').expenseMinor, 4800);
    assert.deepEqual(revisions(database).map((revision) => revision.mutation_type), [
      'archive', 'delete', 'restore', 'archive'
    ]);
  } finally {
    database.close();
  }
});

test('F2.0-1 minimal account archive rules protect the virtual ledger and avoid two active system defaults', () => {
  const { database, repository } = fixture();
  try {
    const created = createExpense(repository);
    const accounts = repository.listAccounts({ ownerId: 'owner-a' });
    const historical = accounts.find((account) => account.virtual);
    const originalDefault = accounts.find((account) => account.id === created.accountId);

    assert.throws(
      () => repository.archiveAccount({ ownerId: 'owner-a', id: historical.id }),
      (error) => error.code === 'FINANCE_HISTORICAL_ACCOUNT_READ_ONLY'
    );
    const archived = repository.archiveAccount({ ownerId: 'owner-a', id: originalDefault.id });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.acceptsNewEntries, false);
    assert.equal(repository.summarizeAllForOwner('owner-a').expenseMinor, 2500);

    const next = createExpense(repository, 'after-account-archive');
    assert.notEqual(next.accountId, originalDefault.id);
    assert.throws(
      () => repository.unarchiveAccount({ ownerId: 'owner-a', id: originalDefault.id }),
      (error) => error.code === 'FINANCE_DEFAULT_ACCOUNT_AMBIGUOUS'
    );
    assert.equal(repository.getAccount({ ownerId: 'owner-a', id: originalDefault.id }).status, 'archived');
  } finally {
    database.close();
  }
});
