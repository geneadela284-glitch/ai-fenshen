import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyFinanceF201Migration } from './financeF201Migration.js';
import { handleFinanceApi } from './httpApi.js';
import { applyFinanceMigrations } from './migrations.js';
import { FinanceRepository } from './repository.js';

const NOW = new Date('2026-07-22T04:00:00.000Z');
const TIMEZONE = 'Asia/Shanghai';
const CURSOR_SECRET = 'finance-history-query-test-secret-32-bytes';

function createV2Database() {
  const database = new DatabaseSync(':memory:');
  applyFinanceMigrations(database);
  applyFinanceF201Migration(database, { clock: () => new Date(NOW) });
  return database;
}

function repository(database) {
  return new FinanceRepository({
    database,
    f201Enabled: true,
    timezone: TIMEZONE,
    clock: () => new Date(NOW),
    cursorSecret: CURSOR_SECRET
  });
}

function insertEntry(database, {
  id,
  ownerId = 'owner-a',
  type = 'expense',
  amountMinor = 100,
  occurredAt = '2026-07-22T03:00:00.000Z',
  createdAt = occurredAt,
  category = type === 'income' ? '工资' : '餐饮',
  merchant = null,
  note = null,
  state = 'active'
}) {
  const deletedAt = state === 'deleted' ? createdAt : null;
  const archivedAt = state === 'archived' ? createdAt : null;
  const storedStatus = state === 'deleted' ? 'deleted' : 'active';
  database.prepare(`
    INSERT INTO finance_entries (
      id, owner_id, type, amount_minor, currency, occurred_at, timezone, category,
      merchant, counterparty, note, source_message_id, client_request_id, status,
      created_at, updated_at, deleted_at, account_id, version, archived_at
    ) VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
  `).run(
    id,
    ownerId,
    type,
    amountMinor,
    occurredAt,
    TIMEZONE,
    category,
    merchant,
    note,
    `source-${id}`,
    `request-${id}`,
    storedStatus,
    createdAt,
    createdAt,
    deletedAt,
    archivedAt
  );
}

test('F2.0-1 history query resolves named and explicit half-open ranges in the user IANA timezone', () => {
  const database = createV2Database();
  try {
    const repo = repository(database);
    const cases = [
      ['today', '2026-07-21T16:00:00.000Z', '2026-07-22T16:00:00.000Z'],
      ['yesterday', '2026-07-20T16:00:00.000Z', '2026-07-21T16:00:00.000Z'],
      ['this_week', '2026-07-19T16:00:00.000Z', '2026-07-26T16:00:00.000Z'],
      ['this_month', '2026-06-30T16:00:00.000Z', '2026-07-31T16:00:00.000Z'],
      ['last_year', '2024-12-31T16:00:00.000Z', '2025-12-31T16:00:00.000Z']
    ];
    for (const [period, startAt, endAt] of cases) {
      const result = repo.queryHistory({ ownerId: 'owner-a', period, timezone: TIMEZONE, now: NOW });
      assert.deepEqual(result.range, { startAt, endAt, timezone: TIMEZONE, interval: '[startAt,endAt)' });
    }

    const explicit = repo.queryHistory({
      ownerId: 'owner-a',
      period: 'custom',
      timezone: TIMEZONE,
      startAt: '2026-07-01T00:00:00+08:00',
      endAt: '2026-08-01T00:00:00+08:00'
    });
    assert.deepEqual(explicit.range, {
      startAt: '2026-06-30T16:00:00.000Z',
      endAt: '2026-07-31T16:00:00.000Z',
      timezone: TIMEZONE,
      interval: '[startAt,endAt)'
    });

    insertEntry(database, { id: 'at-start', occurredAt: cases[0][1] });
    insertEntry(database, { id: 'before-end', occurredAt: '2026-07-22T15:59:59.999Z' });
    insertEntry(database, { id: 'at-end', occurredAt: cases[0][2] });
    assert.deepEqual(
      repo.queryHistory({ ownerId: 'owner-a', period: 'today', timezone: TIMEZONE, now: NOW }).entries.map((entry) => entry.id),
      ['before-end', 'at-start']
    );

    const dst = repo.queryHistory({
      ownerId: 'owner-a', period: 'today', timezone: 'America/New_York', now: new Date('2026-03-08T16:00:00.000Z')
    });
    assert.deepEqual(dst.range, {
      startAt: '2026-03-08T05:00:00.000Z',
      endAt: '2026-03-09T04:00:00.000Z',
      timezone: 'America/New_York',
      interval: '[startAt,endAt)'
    });
  } finally {
    database.close();
  }
});

test('F2.0-1 history pagination uses fixed ordering, defaults to 20, caps at 100, and never repeats an id', () => {
  const database = createV2Database();
  try {
    const repo = repository(database);
    for (let index = 0; index < 105; index += 1) {
      insertEntry(database, {
        id: `entry-${String(index).padStart(3, '0')}`,
        occurredAt: '2026-07-20T04:00:00.000Z',
        createdAt: '2026-07-20T05:00:00.000Z'
      });
    }

    const ids = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = repo.queryHistory({ ownerId: 'owner-a', period: 'all_time', cursor });
      pages += 1;
      assert.equal(page.entries.length <= 20, true);
      ids.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
      assert.equal(page.hasMore, Boolean(cursor));
    } while (cursor);

    assert.equal(pages, 6);
    assert.equal(ids.length, 105);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[0], 'entry-104');
    assert.equal(ids.at(-1), 'entry-000');

    const capped = repo.queryHistory({ ownerId: 'owner-a', period: 'all_time', limit: 500 });
    assert.equal(capped.entries.length, 100);
    assert.equal(capped.hasMore, true);
    assert.equal(typeof capped.nextCursor, 'string');
  } finally {
    database.close();
  }
});

test('F2.0-1 cursor is opaque, owner-bound, query-bound, and fails closed when tampered', () => {
  const database = createV2Database();
  try {
    const repo = repository(database);
    for (let index = 0; index < 3; index += 1) {
      insertEntry(database, { id: `expense-${index}`, type: 'expense', category: '餐饮' });
      insertEntry(database, { id: `income-${index}`, type: 'income', category: '工资' });
    }
    const first = repo.queryHistory({
      ownerId: 'owner-a', period: 'all_time', types: ['expense'], statuses: ['active'], limit: 2
    });
    assert.equal(typeof first.nextCursor, 'string');
    assert.doesNotMatch(first.nextCursor, /owner-a|expense|occurredAt|createdAt/);

    assert.throws(
      () => repo.queryHistory({
        ownerId: 'owner-b', period: 'all_time', types: ['expense'], statuses: ['active'], limit: 2,
        cursor: first.nextCursor
      }),
      (error) => error.code === 'FINANCE_HISTORY_CURSOR_SCOPE_MISMATCH'
    );
    assert.throws(
      () => repo.queryHistory({
        ownerId: 'owner-a', period: 'all_time', types: ['income'], statuses: ['active'], limit: 2,
        cursor: first.nextCursor
      }),
      (error) => error.code === 'FINANCE_HISTORY_CURSOR_QUERY_MISMATCH'
    );
    assert.throws(
      () => repo.queryHistory({
        ownerId: 'owner-a', period: 'all_time', types: ['expense'], statuses: ['active'], limit: 2,
        cursor: `${first.nextCursor.slice(0, -1)}x`
      }),
      (error) => error.code === 'FINANCE_HISTORY_CURSOR_INVALID'
    );
  } finally {
    database.close();
  }
});

test('F2.0-1 history filters type, multiple categories, merchant or note keyword, and logical status without counting deleted rows', () => {
  const database = createV2Database();
  try {
    const repo = repository(database);
    insertEntry(database, {
      id: 'active-income', type: 'income', amountMinor: 500000, category: '工资', merchant: '甲方公司', note: '七月工资'
    });
    insertEntry(database, {
      id: 'active-coffee', type: 'expense', amountMinor: 1800, category: '餐饮', merchant: '星空咖啡', note: '客户会面'
    });
    insertEntry(database, {
      id: 'archived-taxi', type: 'expense', amountMinor: 3200, category: '交通', merchant: '滴滴', note: '机场', state: 'archived'
    });
    insertEntry(database, {
      id: 'deleted-meal', type: 'expense', amountMinor: 9900, category: '餐饮', merchant: '旧餐厅', note: '应排除', state: 'deleted'
    });
    insertEntry(database, {
      id: 'other-owner', ownerId: 'owner-b', type: 'expense', amountMinor: 999999, category: '餐饮', merchant: '星空咖啡'
    });

    const expenses = repo.queryHistory({
      ownerId: 'owner-a', period: 'all_time', types: ['expense'], categories: ['餐饮', '交通']
    });
    assert.deepEqual(expenses.entries.map((entry) => [entry.id, entry.status]), [
      ['archived-taxi', 'archived'],
      ['active-coffee', 'active']
    ]);
    assert.deepEqual(expenses.summary, { incomeMinor: 0, expenseMinor: 5000, balanceMinor: -5000 });

    const merchant = repo.queryHistory({ ownerId: 'owner-a', period: 'all_time', keyword: '星空咖啡' });
    const note = repo.queryHistory({ ownerId: 'owner-a', period: 'all_time', keyword: '客户会面' });
    assert.deepEqual(merchant.entries.map((entry) => entry.id), ['active-coffee']);
    assert.deepEqual(note.entries.map((entry) => entry.id), ['active-coffee']);

    const deleted = repo.queryHistory({ ownerId: 'owner-a', period: 'all_time', statuses: ['deleted'] });
    assert.deepEqual(deleted.entries.map((entry) => entry.id), ['deleted-meal']);
    assert.deepEqual(deleted.summary, { incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 });
  } finally {
    database.close();
  }
});

test('F2.0-1 entries API takes ownerId only from authenticated context and returns cursor metadata', async () => {
  const database = createV2Database();
  try {
    const repo = repository(database);
    insertEntry(database, { id: 'owner-a-entry', ownerId: 'owner-a' });
    insertEntry(database, { id: 'owner-b-entry', ownerId: 'owner-b' });
    let response = null;

    const handled = await handleFinanceApi({
      req: { method: 'GET' },
      res: {},
      url: new URL('http://localhost/api/finance/entries?period=all_time&ownerId=owner-b&limit=20'),
      user: { id: 'owner-a' },
      runtime: { repository: repo, timezone: TIMEZONE, clock: () => new Date(NOW) },
      readJson: async () => ({}),
      sendJson: (_res, status, body) => { response = { status, body }; }
    });

    assert.equal(handled, true);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.entries.map((entry) => entry.id), ['owner-a-entry']);
    assert.equal(response.body.nextCursor, null);
    assert.equal(response.body.hasMore, false);
    assert.deepEqual(response.body.summary, { incomeMinor: 0, expenseMinor: 100, balanceMinor: -100 });
  } finally {
    database.close();
  }
});

test('F2.0-1 history query stays owner-isolated with 50,000 rows and completes within the isolated performance budget', (t) => {
  const database = createV2Database();
  try {
    const statement = database.prepare(`
      INSERT INTO finance_entries (
        id, owner_id, type, amount_minor, currency, occurred_at, timezone, category,
        merchant, counterparty, note, source_message_id, client_request_id, status,
        created_at, updated_at, deleted_at, account_id, version, archived_at
      ) VALUES (?, ?, ?, 100, 'CNY', ?, ?, ?, ?, NULL, ?, ?, ?, 'active', ?, ?, NULL, NULL, 1, NULL)
    `);
    database.exec('BEGIN');
    for (let index = 0; index < 50_000; index += 1) {
      const type = index % 5 === 0 ? 'income' : 'expense';
      const category = type === 'income' ? '工资' : index % 2 === 0 ? '餐饮' : '交通';
      const instant = new Date(Date.UTC(2026, 6, (index % 28) + 1, index % 24, index % 60)).toISOString();
      const id = `perf-${String(index).padStart(5, '0')}`;
      statement.run(id, 'owner-perf', type, instant, TIMEZONE, category, `perf-merchant-${index % 10}`, `perf-note-${index}`, `source-${id}`, `request-${id}`, instant, instant);
    }
    for (let index = 0; index < 100; index += 1) {
      const instant = `2026-07-22T03:${String(index % 60).padStart(2, '0')}:00.000Z`;
      const id = `other-${String(index).padStart(3, '0')}`;
      statement.run(id, 'owner-other', 'expense', instant, TIMEZONE, '餐饮', 'perf-merchant-other', 'perf-note-other', `source-${id}`, `request-${id}`, instant, instant);
    }
    database.exec('COMMIT');

    const repo = repository(database);
    const startedAt = performance.now();
    const result = repo.queryHistory({
      ownerId: 'owner-perf',
      period: 'this_month',
      timezone: TIMEZONE,
      now: NOW,
      types: ['expense'],
      categories: ['餐饮', '交通'],
      keyword: 'perf',
      limit: 100
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(result.entries.length, 100);
    assert.equal(result.entries.every((entry) => entry.id.startsWith('perf-')), true);
    assert.equal(result.entries.some((entry) => entry.id.startsWith('other-')), false);
    assert.equal(elapsedMs < 1000, true, `isolated 50k query took ${elapsedMs.toFixed(2)}ms`);
    t.diagnostic(`isolated_50k_query_ms=${elapsedMs.toFixed(2)}`);
  } finally {
    database.close();
  }
});
