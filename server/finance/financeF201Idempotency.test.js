import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyFinanceF201Migration } from './financeF201Migration.js';
import { applyFinanceMigrations } from './migrations.js';
import { FinanceRepository } from './repository.js';
import { FinanceService } from './service.js';

const NOW = new Date('2026-08-02T06:00:00.000Z');

function fixture(database = new DatabaseSync(':memory:')) {
  applyFinanceMigrations(database);
  applyFinanceF201Migration(database, { clock: () => new Date(NOW) });
  let entrySequence = 0;
  let accountSequence = 0;
  let revisionSequence = 0;
  return {
    database,
    repository: new FinanceRepository({
      database,
      f201Enabled: true,
      clock: () => new Date(NOW),
      id: () => `entry-${++entrySequence}`,
      accountId: () => `account-${++accountSequence}`,
      revisionId: () => `revision-${++revisionSequence}`
    })
  };
}

function expense({ ownerId = 'owner-a', mutationRequestId, amountMinor = 1800, note = '早餐' } = {}) {
  return {
    ownerId,
    mutationRequestId,
    type: 'expense',
    amountMinor,
    currency: 'CNY',
    occurredAt: NOW.toISOString(),
    timezone: 'Asia/Shanghai',
    category: '餐饮',
    note,
    sourceMessageId: `source-${mutationRequestId}`
  };
}

function batchExpense({ amountMinor, note, sourceMessageId }) {
  return {
    ownerId: 'owner-a',
    type: 'expense',
    amountMinor,
    currency: 'CNY',
    occurredAt: NOW.toISOString(),
    timezone: 'Asia/Shanghai',
    category: '餐饮',
    note,
    sourceMessageId
  };
}

test('F2.0-1 create replays one result for the same mutation request and preserves legitimate repeated spending', () => {
  const { database, repository } = fixture();
  try {
    const input = expense({ mutationRequestId: 'create-breakfast-1' });
    const results = Array.from({ length: 10 }, () => repository.create(input));

    assert.equal(new Set(results.map((entry) => entry.id)).size, 1);
    assert.equal(repository.list({ ownerId: 'owner-a', includeDeleted: true }).length, 1);
    assert.throws(
      () => repository.create({ ...input, amountMinor: 1900 }),
      (error) => error.code === 'FINANCE_IDEMPOTENCY_CONFLICT'
    );

    const legitimateRepeat = repository.create(expense({
      mutationRequestId: 'create-breakfast-2',
      amountMinor: 1800
    }));
    assert.notEqual(legitimateRepeat.id, results[0].id);
    assert.equal(repository.list({ ownerId: 'owner-a', includeDeleted: true }).length, 2);
  } finally {
    database.close();
  }
});

test('F2.0-1 update replays the first result and creates exactly one Revision', () => {
  const { database, repository } = fixture();
  try {
    const created = repository.create(expense({ mutationRequestId: 'create-before-update' }));
    const request = {
      ownerId: 'owner-a',
      id: created.id,
      expectedVersion: 1,
      mutationRequestId: 'update-breakfast-1',
      patch: { amountMinor: 2200, category: '餐饮', note: '早餐和咖啡' }
    };
    const results = Array.from({ length: 10 }, () => repository.update(request));

    assert.deepEqual(results, Array.from({ length: 10 }, () => results[0]));
    assert.equal(results[0].version, 2);
    assert.equal(results[0].amountMinor, 2200);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM finance_revisions').get().count, 1);
    const mutation = database.prepare(`
      SELECT owner_id, client_request_id, mutation_type, target_entry_id,
        request_fingerprint, status, result_json
      FROM finance_mutation_requests
    `).get();
    assert.equal(mutation.owner_id, 'owner-a');
    assert.equal(mutation.client_request_id, 'update-breakfast-1');
    assert.equal(mutation.mutation_type, 'update');
    assert.equal(mutation.target_entry_id, created.id);
    assert.match(mutation.request_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(mutation.status, 'committed');
    assert.deepEqual(JSON.parse(mutation.result_json).entry, results[0]);

    assert.throws(
      () => repository.update({ ...request, patch: { amountMinor: 9900 } }),
      (error) => error.code === 'FINANCE_IDEMPOTENCY_CONFLICT'
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM finance_revisions').get().count, 1);
  } finally {
    database.close();
  }
});

test('F2.0-1 batch create replays one atomic result set and rejects changed batch payloads', () => {
  const { database, repository } = fixture();
  try {
    const inputs = [
      batchExpense({ amountMinor: 1800, note: '早餐', sourceMessageId: 'batch-source-1' }),
      batchExpense({ amountMinor: 3200, note: '午餐', sourceMessageId: 'batch-source-2' })
    ];
    const request = { ownerId: 'owner-a', mutationRequestId: 'batch-meals-1' };
    const results = Array.from({ length: 10 }, () => repository.createMany(inputs, request));

    assert.deepEqual(results, Array.from({ length: 10 }, () => results[0]));
    assert.equal(results[0].length, 2);
    assert.equal(repository.list({ ownerId: 'owner-a', includeDeleted: true }).length, 2);
    assert.throws(
      () => repository.createMany([
        inputs[0],
        { ...inputs[1], amountMinor: 9900 }
      ], request),
      (error) => error.code === 'FINANCE_IDEMPOTENCY_CONFLICT'
    );
    assert.equal(repository.list({ ownerId: 'owner-a', includeDeleted: true }).length, 2);
  } finally {
    database.close();
  }
});

test('F2.0-1 delete restore archive and unarchive retries execute each transition once', () => {
  const { database, repository } = fixture();
  try {
    const created = repository.create(expense({ mutationRequestId: 'create-lifecycle-entry' }));
    const transitions = [
      ['archive', 1, 'archive-entry-1', 2, (entry) => assert.equal(entry.archivedAt, NOW.toISOString())],
      ['unarchive', 2, 'unarchive-entry-1', 3, (entry) => assert.equal(entry.archivedAt, null)],
      ['softDelete', 3, 'delete-entry-1', 4, (entry) => assert.equal(entry.status, 'deleted')],
      ['restore', 4, 'restore-entry-1', 5, (entry) => assert.equal(entry.status, 'active')]
    ];

    for (const [method, expectedVersion, mutationRequestId, resultVersion, verify] of transitions) {
      const request = { ownerId: 'owner-a', id: created.id, expectedVersion, mutationRequestId };
      const results = Array.from({ length: 10 }, () => repository[method](request));
      assert.deepEqual(results, Array.from({ length: 10 }, () => results[0]));
      assert.equal(results[0].version, resultVersion);
      verify(results[0]);
    }

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM finance_revisions').get().count, 4);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM finance_mutation_requests').get().count, 4);
  } finally {
    database.close();
  }
});

test('F2.0-1 mutation request identity is owner-scoped', () => {
  const { database, repository } = fixture();
  try {
    const requestId = 'shared-safe-request';
    const entryA = repository.create(expense({ ownerId: 'owner-a', mutationRequestId: requestId }));
    const entryB = repository.create(expense({ ownerId: 'owner-b', mutationRequestId: requestId }));
    assert.notEqual(entryA.id, entryB.id);

    const updatedA = repository.update({
      ownerId: 'owner-a', id: entryA.id, expectedVersion: 1,
      mutationRequestId: 'shared-safe-update', patch: { amountMinor: 2100 }
    });
    const updatedB = repository.update({
      ownerId: 'owner-b', id: entryB.id, expectedVersion: 1,
      mutationRequestId: 'shared-safe-update', patch: { amountMinor: 2300 }
    });
    assert.equal(updatedA.amountMinor, 2100);
    assert.equal(updatedB.amountMinor, 2300);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM finance_mutation_requests
      WHERE client_request_id = 'shared-safe-update'
    `).get().count, 2);
  } finally {
    database.close();
  }
});

test('F2.0-1 committed mutation replays safely after a simulated network disconnect and SQLite reopen', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'finance-f201-idempotency-'));
  const databasePath = path.join(directory, 'finance.sqlite');
  let firstDatabase;
  let reopenedDatabase;
  try {
    firstDatabase = new DatabaseSync(databasePath);
    const first = fixture(firstDatabase);
    const created = first.repository.create(expense({ mutationRequestId: 'network-create-1' }));
    const request = {
      ownerId: 'owner-a', id: created.id, expectedVersion: 1,
      mutationRequestId: 'network-update-1', patch: { amountMinor: 2600 }
    };
    const committedBeforeDisconnect = first.repository.update(request);
    firstDatabase.close();
    firstDatabase = null;

    reopenedDatabase = new DatabaseSync(databasePath);
    reopenedDatabase.exec('PRAGMA foreign_keys = ON');
    const reopened = new FinanceRepository({
      database: reopenedDatabase,
      f201Enabled: true,
      clock: () => new Date(NOW)
    });
    const replay = reopened.update(request);

    assert.deepEqual(replay, committedBeforeDisconnect);
    assert.equal(reopenedDatabase.prepare('SELECT COUNT(*) AS count FROM finance_revisions').get().count, 1);
    assert.equal(reopenedDatabase.prepare('SELECT COUNT(*) AS count FROM finance_mutation_requests').get().count, 1);
    assert.equal(reopened.list({ ownerId: 'owner-a', includeDeleted: true }).length, 1);
  } finally {
    try { firstDatabase?.close(); } catch {}
    try { reopenedDatabase?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('F2.0-1 FinanceService binds the whole batch to one mutation request', () => {
  const { database, repository } = fixture();
  try {
    const service = new FinanceService({ repository, clock: () => new Date(NOW) });
    const command = (amountMinor) => ({
      type: 'expense',
      amount_minor: amountMinor,
      currency: 'CNY',
      occurred_at: NOW.toISOString(),
      timezone: 'Asia/Shanghai',
      category: '餐饮'
    });
    const base = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      message: '早餐18元，午餐32元',
      clientRequestId: 'service-batch-1',
      sourceMessageId: 'service-batch-source'
    };
    service.processBatchCreate({
      ...base,
      plan: {
        action: 'create_batch',
        commands: [command(1800), command(3200)],
        source_texts: ['早餐18元', '午餐32元']
      }
    });

    assert.throws(
      () => service.processBatchCreate({
        ...base,
        plan: {
          action: 'create_batch',
          commands: [command(1800), command(3200), command(2600)],
          source_texts: ['早餐18元', '午餐32元', '晚餐26元']
        }
      }),
      (error) => error.code === 'FINANCE_IDEMPOTENCY_CONFLICT'
    );
    assert.equal(repository.list({ ownerId: 'owner-a', includeDeleted: true }).length, 2);
  } finally {
    database.close();
  }
});

test('F2.0-1 one owner cannot reuse a mutation request ID across operation kinds', () => {
  const { database, repository } = fixture();
  try {
    const created = repository.create(expense({ mutationRequestId: 'cross-kind-create' }));
    assert.throws(
      () => repository.update({
        ownerId: 'owner-a', id: created.id, expectedVersion: 1,
        mutationRequestId: 'cross-kind-create', patch: { amountMinor: 2400 }
      }),
      (error) => error.code === 'FINANCE_IDEMPOTENCY_CONFLICT'
    );

    repository.createMany([
      batchExpense({ amountMinor: 2000, note: '午餐', sourceMessageId: 'cross-batch-1' }),
      batchExpense({ amountMinor: 3000, note: '晚餐', sourceMessageId: 'cross-batch-2' })
    ], { ownerId: 'owner-a', mutationRequestId: 'cross-kind-batch' });
    assert.throws(
      () => repository.archive({
        ownerId: 'owner-a', id: created.id, expectedVersion: 1,
        mutationRequestId: 'cross-kind-batch'
      }),
      (error) => error.code === 'FINANCE_IDEMPOTENCY_CONFLICT'
    );

    repository.archive({
      ownerId: 'owner-a', id: created.id, expectedVersion: 1,
      mutationRequestId: 'cross-kind-lifecycle'
    });
    assert.throws(
      () => repository.create(expense({ mutationRequestId: 'cross-kind-lifecycle' })),
      (error) => error.code === 'FINANCE_IDEMPOTENCY_CONFLICT'
    );
  } finally {
    database.close();
  }
});
