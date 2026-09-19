import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { localDateTimeToUtc } from '../../core/trust/dateRangeResolver.js';
import { handleFinanceApi } from './httpApi.js';
import { validateFinanceQueryPlan } from './queryPlan.js';
import { createFinanceRuntime } from './runtime.js';

const OWNER_A = 'finance-query-owner-a';
const OWNER_B = 'finance-query-owner-b';
const TIMEZONE = 'Asia/Shanghai';
const NOW = new Date('2026-07-22T04:00:00.000Z'); // 12:00 Asia/Shanghai

function harness() {
  const database = new DatabaseSync(':memory:');
  const runtime = createFinanceRuntime({
    database,
    applyMigrations: true,
    timezone: TIMEZONE,
    clock: () => new Date(NOW)
  });
  return { ...runtime, close: () => runtime.close() };
}

function createEntry(h, { ownerId = OWNER_A, type, amountMinor, localDate, category, id }) {
  return h.repository.create({
    ownerId,
    type,
    amountMinor,
    currency: 'CNY',
    occurredAt: localDateTimeToUtc(localDate, TIMEZONE, '12:00:00').toISOString(),
    timezone: TIMEZONE,
    category,
    sourceMessageId: `source-${id}`,
    clientRequestId: `request-${id}`,
    note: `fixture-${id}`
  });
}

function seedKnownDataset(h) {
  createEntry(h, { type: 'expense', amountMinor: 12000, localDate: '2026-07-20', category: '其他', id: 'before-expense' });
  createEntry(h, { type: 'income', amountMinor: 50000, localDate: '2026-07-20', category: '其他收入', id: 'before-income' });
  createEntry(h, { type: 'expense', amountMinor: 3000, localDate: '2026-07-21', category: '餐饮', id: 'yesterday-food' });
  createEntry(h, { type: 'expense', amountMinor: 2050, localDate: '2026-07-21', category: '交通', id: 'yesterday-travel' });
  createEntry(h, { type: 'income', amountMinor: 10000, localDate: '2026-07-21', category: '其他收入', id: 'yesterday-income' });
  createEntry(h, { type: 'expense', amountMinor: 6800, localDate: '2026-07-22', category: '其他', id: 'today-expense' });
  createEntry(h, { type: 'expense', amountMinor: 9000, localDate: '2026-06-15', category: '居家', id: 'last-month-expense' });
  const deleted = createEntry(h, { type: 'expense', amountMinor: 99999, localDate: '2026-07-21', category: '购物', id: 'deleted' });
  h.repository.softDelete({ ownerId: OWNER_A, id: deleted.id });
  createEntry(h, { ownerId: OWNER_B, type: 'expense', amountMinor: 777700, localDate: '2026-07-21', category: '其他', id: 'other-owner' });
}

async function say(h, message, clientRequestId, { ownerId = OWNER_A, conversationId = 'conversation-a' } = {}) {
  return h.service.processUserMessage({
    ownerId,
    conversationId,
    sourceMessageId: `message-${clientRequestId}`,
    clientRequestId,
    message
  });
}

const QUERY_CASES = [
  ['昨天花了多少钱？', ['expense'], 'yesterday'],
  ['我昨天一共花了多少钱？', ['expense'], 'yesterday'],
  ['那我前天花了多少钱？', ['expense'], 'day_before_yesterday'],
  ['我这个月花了多少钱？', ['expense'], 'this_month'],
  ['昨天支出多少？', ['expense'], 'yesterday'],
  ['前天收入多少？', ['income'], 'day_before_yesterday'],
  ['本月收入多少？', ['income'], 'this_month'],
  ['本月支出多少？', ['expense'], 'this_month'],
  ['本月结余多少？', ['net'], 'this_month'],
  ['本月收支情况？', ['income', 'expense'], 'this_month'],
  ['上个月花了多少？', ['expense'], 'last_month'],
  ['最近7天花了多少？', ['expense'], 'last_7_days'],
  ['7月20日花了多少？', ['expense'], 'explicit_day'],
  ['7月20日至7月22日花了多少？', ['expense'], 'explicit_range'],
  ['本月餐饮花了多少？', ['expense'], 'this_month'],
  ['昨天有哪几笔账？', ['entries'], 'yesterday']
];

test('RED: clear finance questions produce a structured Finance Query Plan and never enter amount clarification', async (t) => {
  const h = harness();
  t.after(() => h.close());
  seedKnownDataset(h);
  for (const [index, [message, metrics, period]] of QUERY_CASES.entries()) {
    const result = await say(h, message, `query-${index}`);
    assert.equal(result.action, 'query', message);
    assert.notEqual(result.content, '金额是多少？', message);
    assert.equal(result.plan.action, 'query', message);
    assert.deepEqual(result.plan.metrics, metrics, message);
    assert.equal(result.plan.period_type, period, message);
    assert.equal(result.plan.timezone, TIMEZONE, message);
    assert.equal(result.plan.requires_confirmation, false, message);
    assert.ok(result.plan.start_at && result.plan.end_at, message);
    assert.equal(result.plan.owner_id, undefined, message);
  }
});

test('RED: combined finance questions preserve every requested metric and deterministic net', async (t) => {
  const h = harness();
  t.after(() => h.close());
  seedKnownDataset(h);
  const cases = [
    ['本月收入和支出分别是多少', ['income', 'expense']],
    ['本月收入、支出和结余分别是多少', ['income', 'expense', 'net']],
    ['昨天收入和支出分别是多少', ['income', 'expense']],
    ['本周收支情况', ['income', 'expense']],
    ['最近7天收支情况', ['income', 'expense']]
  ];
  for (const [index, [message, metrics]] of cases.entries()) {
    const result = await say(h, message, `combined-${index}`);
    assert.equal(result.action, 'query', message);
    assert.deepEqual(result.plan.metrics, metrics, message);
    assert.deepEqual(result.data.requestedMetrics, metrics, message);
    assert.ok(result.content.includes('收入'), message);
    assert.ok(result.content.includes('支出'), message);
    if (metrics.includes('net')) assert.ok(result.content.includes('结余'), message);
  }
});

test('RED: combined answers keep zero-valued metrics and inherit trusted period and metrics context', async (t) => {
  const h = harness();
  t.after(() => h.close());
  createEntry(h, { type: 'expense', amountMinor: 6800, localDate: '2026-07-22', category: '其他', id: 'zero-income-expense' });
  const zero = await say(h, '本月收入和支出分别是多少', 'zero-combined');
  assert.deepEqual(zero.plan.metrics, ['income', 'expense']);
  assert.match(zero.content, /收入0元/);
  assert.match(zero.content, /支出68元/);
  assert.match(zero.content, /结余-68元/);

  const expense = await say(h, '本月支出多少', 'context-expense', { conversationId: 'context-a' });
  assert.deepEqual(expense.plan.metrics, ['expense']);
  const income = await say(h, '收入呢', 'context-income', { conversationId: 'context-a' });
  assert.deepEqual(income.plan.metrics, ['income']);
  assert.equal(income.plan.period_type, 'this_month');

  const firstIncome = await say(h, '本月收入多少', 'context-first-income', { conversationId: 'context-b' });
  assert.deepEqual(firstIncome.plan.metrics, ['income']);
  const both = await say(h, '收入和支出都说一下', 'context-both', { conversationId: 'context-b' });
  assert.deepEqual(both.plan.metrics, ['income', 'expense']);
  assert.equal(both.plan.period_type, 'this_month');
});

test('RED: calendar periods remain different from rolling-day periods', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const week = await say(h, '本周收支情况', 'range-week', { conversationId: 'range-week' });
  const sevenDays = await say(h, '最近7天收支情况', 'range-seven', { conversationId: 'range-seven' });
  const month = await say(h, '本月收入和支出分别是多少', 'range-month', { conversationId: 'range-month' });
  const thirtyDays = await say(h, '最近30天收入和支出分别是多少', 'range-thirty', { conversationId: 'range-thirty' });
  assert.equal(week.plan.period_type, 'this_week');
  assert.equal(sevenDays.plan.period_type, 'last_7_days');
  assert.notEqual(week.plan.start_at, sevenDays.plan.start_at);
  assert.equal(month.plan.period_type, 'this_month');
  assert.equal(thirtyDays.plan.period_type, 'last_30_days');
  assert.notEqual(month.plan.start_at, thirtyDays.plan.start_at);
});

test('RED: transaction statements and questions with the same finance words remain strictly separated', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const cases = [
    ['昨天花了30元', 'create'],
    ['昨天花了多少？', 'query'],
    ['前天收到500元', 'create'],
    ['前天收入多少？', 'query'],
    ['本月1日交房租3000元', 'create'],
    ['本月房租花了多少？', 'query']
  ];
  for (const [index, [message, action]] of cases.entries()) {
    const result = await say(h, message, `distinguish-${index}`);
    assert.equal(result.action, action, message);
  }
  assert.equal(h.repository.list({ ownerId: OWNER_A }).length, 3);
});

test('RED: deterministic half-open ranges honor Asia/Shanghai across day month year and leap-year boundaries', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const cases = [
    ['昨天花了多少？', '2026-07-20T16:00:00.000Z', '2026-07-21T16:00:00.000Z'],
    ['前天花了多少？', '2026-07-19T16:00:00.000Z', '2026-07-20T16:00:00.000Z'],
    ['本月花了多少？', '2026-06-30T16:00:00.000Z', '2026-07-31T16:00:00.000Z'],
    ['上个月花了多少？', '2026-05-31T16:00:00.000Z', '2026-06-30T16:00:00.000Z']
  ];
  for (const [index, [message, startAt, endAt]] of cases.entries()) {
    const result = await say(h, message, `range-${index}`);
    assert.ok(result.plan, `${message} must expose a query plan`);
    assert.equal(result.plan.start_at, startAt, message);
    assert.equal(result.plan.end_at, endAt, message);
  }

  const leap = createFinanceRuntime({ database: new DatabaseSync(':memory:'), applyMigrations: true, timezone: TIMEZONE, clock: () => new Date('2024-03-01T04:00:00.000Z') });
  t.after(() => leap.close());
  const leapYesterday = await leap.service.processUserMessage({ ownerId: OWNER_A, conversationId: 'leap', message: '昨天花了多少？', clientRequestId: 'leap', sourceMessageId: 'leap' });
  assert.ok(leapYesterday.plan, 'leap-year query must expose a plan');
  assert.equal(leapYesterday.plan.start_at, '2024-02-28T16:00:00.000Z');
  assert.equal(leapYesterday.plan.end_at, '2024-02-29T16:00:00.000Z');

  const yearEnd = createFinanceRuntime({ database: new DatabaseSync(':memory:'), applyMigrations: true, timezone: TIMEZONE, clock: () => new Date('2027-01-01T04:00:00.000Z') });
  t.after(() => yearEnd.close());
  const yearYesterday = await yearEnd.service.processUserMessage({ ownerId: OWNER_A, conversationId: 'year', message: '昨天花了多少？', clientRequestId: 'year', sourceMessageId: 'year' });
  assert.ok(yearYesterday.plan, 'year-end query must expose a plan');
  assert.equal(yearYesterday.plan.start_at, '2026-12-30T16:00:00.000Z');
  assert.equal(yearYesterday.plan.end_at, '2026-12-31T16:00:00.000Z');
});

test('RED: known three-day two-month dataset is exact to the minor unit and excludes soft-deleted and other-owner rows', async (t) => {
  const h = harness();
  t.after(() => h.close());
  seedKnownDataset(h);
  const cases = [
    ['前天花了多少？', 12000],
    ['前天收入多少？', 50000],
    ['昨天花了多少？', 5050],
    ['昨天收入多少？', 10000],
    ['今天花了多少？', 6800],
    ['本月支出多少？', 23850],
    ['本月收入多少？', 60000],
    ['本月结余多少？', 36150],
    ['上个月花了多少？', 9000],
    ['最近7天花了多少？', 23850]
  ];
  for (const [index, [message, expectedMinor]] of cases.entries()) {
    const result = await say(h, message, `known-${index}`);
    assert.ok(result.data, `${message} must return deterministic repository data`);
    assert.equal(result.data.valueMinor, expectedMinor, message);
  }
});

test('RED: follow-up queries inherit only the current owner and conversation finance context', async (t) => {
  const h = harness();
  t.after(() => h.close());
  seedKnownDataset(h);
  const first = await say(h, '昨天花了多少？', 'follow-first');
  assert.ok(first.data, 'initial query must return deterministic data');
  assert.equal(first.data.valueMinor, 5050);
  const income = await say(h, '那收入呢？', 'follow-income');
  assert.deepEqual(income.plan.metrics, ['income']);
  assert.equal(income.plan.period_type, 'yesterday');
  assert.equal(income.data.valueMinor, 10000);
  const before = await say(h, '那前天呢？', 'follow-before');
  assert.deepEqual(before.plan.metrics, ['income']);
  assert.equal(before.plan.period_type, 'day_before_yesterday');
  assert.equal(before.data.valueMinor, 50000);
  const month = await say(h, '这个月呢？', 'follow-month');
  assert.deepEqual(month.plan.metrics, ['income']);
  assert.equal(month.plan.period_type, 'this_month');
  const entries = await say(h, '分别有哪些？', 'follow-entries');
  assert.deepEqual(entries.plan.metrics, ['entries']);
  assert.equal(entries.plan.period_type, 'this_month');
  assert.deepEqual(entries.plan.inherited_context.previous_metrics, ['income']);

  const otherConversation = await say(h, '那前天呢？', 'other-conversation', { conversationId: 'conversation-b' });
  assert.equal(otherConversation.handled, false);
  assert.equal(otherConversation.data, undefined);
  const otherOwner = await say(h, '那前天呢？', 'other-owner', { ownerId: OWNER_B });
  assert.equal(otherOwner.handled, false);
  assert.equal(otherOwner.data, undefined);
});

test('RED: Repository range query, Chat result and Finance API overview share exactly the same deterministic totals', async (t) => {
  const h = harness();
  t.after(() => h.close());
  seedKnownDataset(h);
  const chat = await say(h, '本月收支情况？', 'consistency-chat');
  assert.equal(typeof h.repository.query, 'function', 'Repository must expose the shared range query');
  const repository = h.repository.query(chat.plan, { ownerId: OWNER_A });
  let response;
  await handleFinanceApi({
    req: { method: 'GET' }, res: {}, url: new URL('http://localhost/api/finance/overview'),
    user: { id: OWNER_A }, runtime: h, readJson: async () => ({}),
    sendJson: (_res, status, body) => { response = { status, body }; }
  });
  const sql = h.database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END), 0) AS income_minor,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense_minor
    FROM finance_entries
    WHERE owner_id = ? AND status = 'active' AND deleted_at IS NULL
      AND occurred_at >= ? AND occurred_at < ?
  `).get(OWNER_A, chat.plan.start_at, chat.plan.end_at);
  assert.equal(chat.data.incomeMinor, repository.incomeMinor);
  assert.equal(chat.data.expenseMinor, repository.expenseMinor);
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.incomeMinor, repository.incomeMinor);
  assert.equal(response.body.summary.expenseMinor, repository.expenseMinor);
  assert.equal(repository.incomeMinor, sql.income_minor);
  assert.equal(repository.expenseMinor, sql.expense_minor);
  assert.equal(repository.balanceMinor, sql.income_minor - sql.expense_minor);
});

test('RED: database failure fails closed instead of reporting zero or asking for a transaction amount', async (t) => {
  const h = harness();
  t.after(() => h.close());
  h.repository.query = () => { throw new Error('simulated database failure'); };
  const result = await say(h, '昨天花了多少？', 'query-failure');
  assert.equal(result.action, 'error');
  assert.equal(result.content, '暂时无法读取账本，请稍后再试。');
});

test('RED: progressive income confirmation keeps the committed entry and classifies the same row later', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const created = await say(h, '收入100', 'progressive-create');
  assert.equal(created.content, '已记录。这笔是什么收入来源？');
  assert.equal(h.repository.list({ ownerId: OWNER_A }).length, 1);
  assert.equal(h.repository.list({ ownerId: OWNER_A })[0].category, '其他收入');
  const classified = await say(h, '刚才那100是客户回款', 'progressive-classify');
  assert.equal(classified.action, 'classify');
  assert.equal(classified.content, '已修改');
  assert.equal(h.repository.list({ ownerId: OWNER_A }).length, 1);
  assert.equal(h.repository.list({ ownerId: OWNER_A })[0].category, '客户回款');
});

test('Finance Query Contract rejects invalid ranges, invalid timezone and any model-supplied owner', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const valid = (await say(h, '昨天花了多少？', 'contract-valid')).plan;
  assert.equal(validateFinanceQueryPlan(valid).ok, true);
  assert.deepEqual(validateFinanceQueryPlan({ ...valid, start_at: valid.end_at }).errors, ['range_invalid']);
  assert.deepEqual(validateFinanceQueryPlan({ ...valid, timezone: 'Not/A_Timezone' }).errors, ['timezone_invalid']);
  assert.deepEqual(validateFinanceQueryPlan({ ...valid, owner_id: OWNER_B }).errors, ['owner_forbidden']);
  assert.deepEqual(validateFinanceQueryPlan({ ...valid, category: '模型自创分类' }).errors, ['category_invalid']);
  assert.deepEqual(validateFinanceQueryPlan({ ...valid, invented_field: true }).errors, ['unknown_fields']);
  assert.throws(() => h.repository.query({ ...valid, owner_id: OWNER_B }, { ownerId: OWNER_A }), /FINANCE_QUERY_PLAN_INVALID/);
});

test('local 23:59:59 and 00:00:00 fall on opposite Asia/Shanghai half-open day boundaries even when the VPS clock is UTC', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const exact = (id, occurredAt, amountMinor) => h.repository.create({
    ownerId: OWNER_A, type: 'expense', amountMinor, currency: 'CNY', occurredAt,
    timezone: TIMEZONE, category: '其他', sourceMessageId: `source-${id}`,
    clientRequestId: `request-${id}`, note: id
  });
  exact('before-midnight', '2026-07-20T15:59:59.999Z', 1111); // Jul 20 23:59:59.999
  exact('at-midnight', '2026-07-20T16:00:00.000Z', 2222); // Jul 21 00:00:00.000
  exact('end-exclusive', '2026-07-21T16:00:00.000Z', 4444); // Jul 22 00:00:00.000
  const yesterday = await say(h, '昨天花了多少？', 'boundary-yesterday');
  assert.equal(yesterday.data.valueMinor, 2222);
  assert.equal(yesterday.data.entries.length, 1);
  const previousDay = await say(h, '7月20日花了多少？', 'boundary-explicit');
  assert.equal(previousDay.data.valueMinor, 1111);
});
