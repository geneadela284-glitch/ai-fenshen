import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFinanceRuntime } from './runtime.js';

const NOW = new Date('2026-07-20T04:00:00.000Z'); // 12:00 Asia/Shanghai

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-finance-'));
  const runtime = createFinanceRuntime({
    databasePath: path.join(directory, 'finance.sqlite'),
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW),
    applyMigrations: true
  });
  return {
    ...runtime,
    close() {
      runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function say(h, message, clientRequestId, ownerId = 'owner-a', extra = {}) {
  return h.service.processUserMessage({
    ownerId,
    conversationId: extra.conversationId || 'conversation-a',
    sourceMessageId: extra.sourceMessageId || `message-${clientRequestId}`,
    clientRequestId,
    message
  });
}

test('expense 18 yuan is stored as 1800 integer minor units in CNY', async () => {
  const h = harness();
  try {
    const result = await say(h, '早餐花了18元', 'expense-18');
    const [entry] = h.repository.list({ ownerId: 'owner-a' });
    assert.equal(result.content, '已记录');
    assert.equal(entry.type, 'expense');
    assert.equal(entry.amountMinor, 1800);
    assert.equal(Number.isInteger(entry.amountMinor), true);
    assert.equal(entry.currency, 'CNY');
    assert.equal(entry.category, '餐饮');
  } finally { h.close(); }
});

test('decimal 32.5 yuan is stored exactly as 3250 minor units', async () => {
  const h = harness();
  try {
    await say(h, '今天打车32.5元', 'taxi-325');
    assert.equal(h.repository.list({ ownerId: 'owner-a' })[0].amountMinor, 3250);
  } finally { h.close(); }
});

test('income 5000 yuan is stored with income direction and allowlisted category', async () => {
  const h = harness();
  try {
    await say(h, '收到工资5000元', 'salary-5000');
    const [entry] = h.repository.list({ ownerId: 'owner-a' });
    assert.equal(entry.type, 'income');
    assert.equal(entry.amountMinor, 500000);
    assert.equal(entry.category, '工资');
  } finally { h.close(); }
});

test('default time uses server clock and explicit yesterday uses account timezone', async () => {
  const h = harness();
  try {
    await say(h, '早餐18元', 'time-default');
    await say(h, '昨天客户转给我3000元', 'time-yesterday');
    const entries = h.repository.list({ ownerId: 'owner-a', limit: 10 });
    assert.equal(entries.find((item) => item.clientRequestId === 'time-default').occurredAt, NOW.toISOString());
    assert.match(entries.find((item) => item.clientRequestId === 'time-yesterday').occurredAt, /^2026-07-19T/);
    assert.equal(entries[0].timezone, 'Asia/Shanghai');
  } finally { h.close(); }
});

test('ambiguous amount and ambiguous direction fail closed without writes and ask one necessary question', async () => {
  const h = harness();
  try {
    const amount = await say(h, '今天花了一点钱', 'ambiguous-amount');
    const direction = await say(h, '记50元', 'ambiguous-direction');
    const missing = await say(h, '客户款到了', 'missing-income-amount');
    assert.equal(amount.content, '金额是多少？');
    assert.equal(direction.content, '这是收入还是支出？');
    assert.equal(missing.content, '金额是多少？');
    assert.equal(h.repository.list({ ownerId: 'owner-a' }).length, 0);
  } finally { h.close(); }
});

test('owner plus clientRequestId is idempotent across retries and conversations', async () => {
  const h = harness();
  try {
    await say(h, '午餐30元', 'same-request');
    await say(h, '午餐30元', 'same-request');
    await say(h, '午餐30元', 'same-request', 'owner-a', { conversationId: 'conversation-new' });
    assert.equal(h.repository.list({ ownerId: 'owner-a' }).length, 1);
  } finally { h.close(); }
});

test('write failure never claims success', async () => {
  const h = harness();
  try {
    const original = h.repository.create.bind(h.repository);
    h.repository.create = () => { throw new Error('simulated sqlite failure'); };
    const result = await say(h, '午餐30元', 'write-failure');
    assert.equal(result.content, '这笔账暂时没有记录成功，请重试。');
    h.repository.create = original;
  } finally { h.close(); }
});

test('natural language modifies amount and category with exact acknowledgement', async () => {
  const h = harness();
  try {
    await say(h, '刚才午餐30元', 'create-lunch');
    const amount = await say(h, '刚才午餐不是30元，是35元', 'edit-lunch');
    const category = await say(h, '把刚才午餐分类改成购物', 'edit-category');
    const [entry] = h.repository.list({ ownerId: 'owner-a' });
    assert.equal(amount.content, '已修改');
    assert.equal(category.content, '已修改');
    assert.equal(entry.amountMinor, 3500);
    assert.equal(entry.category, '购物');
  } finally { h.close(); }
});

test('natural language delete and undo use soft delete', async () => {
  const h = harness();
  try {
    await say(h, '早餐18元', 'create-breakfast');
    const removed = await say(h, '删除刚才的早餐', 'delete-breakfast');
    assert.equal(removed.content, '已删除');
    assert.equal(h.repository.list({ ownerId: 'owner-a' }).length, 0);
    assert.equal(h.repository.list({ ownerId: 'owner-a', includeDeleted: true })[0].status, 'deleted');

    await say(h, '打车20元', 'create-taxi');
    const undone = await say(h, '撤销上一笔支出', 'undo-expense');
    assert.equal(undone.content, '已删除');
    assert.equal(h.repository.list({ ownerId: 'owner-a' }).length, 0);
  } finally { h.close(); }
});

test('multiple edit candidates ask for confirmation instead of guessing', async () => {
  const h = harness();
  try {
    await say(h, '午餐30元', 'meal-one');
    await say(h, '晚餐40元', 'meal-two');
    const result = await say(h, '把餐饮改成35元', 'ambiguous-edit');
    assert.equal(result.action, 'clarify');
    assert.match(result.content, /请确认/);
    assert.equal(h.repository.list({ ownerId: 'owner-a' }).map((item) => item.amountMinor).sort()[0], 3000);
  } finally { h.close(); }
});

test('today week month category totals and balance are repository-calculated and exclude deleted rows', async () => {
  const h = harness();
  try {
    await say(h, '早餐18元', 'sum-breakfast');
    await say(h, '打车32.5元', 'sum-taxi');
    await say(h, '收到客户款3000元', 'sum-income');
    await say(h, '昨天午餐20元', 'sum-yesterday');
    await say(h, '删除刚才的早餐', 'sum-delete');

    const todayExpense = h.repository.summarize({ ownerId: 'owner-a', period: 'today', now: NOW, type: 'expense' });
    const weekExpense = h.repository.summarize({ ownerId: 'owner-a', period: 'week', now: NOW, type: 'expense' });
    const month = h.repository.summarize({ ownerId: 'owner-a', period: 'month', now: NOW });
    const food = h.repository.summarize({ ownerId: 'owner-a', period: 'month', now: NOW, category: '餐饮' });
    assert.equal(todayExpense.expenseMinor, 3250);
    assert.equal(weekExpense.expenseMinor, 3250);
    assert.equal(month.incomeMinor, 300000);
    assert.equal(month.expenseMinor, 5250);
    assert.equal(month.balanceMinor, 294750);
    assert.equal(food.expenseMinor, 2000);
  } finally { h.close(); }
});

test('deterministic chat queries return today and month results without provider math', async () => {
  const h = harness();
  try {
    await say(h, '午餐30元', 'query-lunch');
    await say(h, '打车50元', 'query-taxi');
    await say(h, '收到工资5000元', 'query-salary');
    const today = await say(h, '今天花了多少？', 'query-today');
    const month = await say(h, '本月收支情况', 'query-month');
    assert.equal(today.content, '今天共支出80元：\n餐饮30元，交通50元。');
    assert.match(month.content, /收入5000元/);
    assert.match(month.content, /支出80元/);
    assert.match(month.content, /结余4920元/);
    assert.match(month.content, /需要我根据这份收支情况给你一些建议吗？$/);
  } finally { h.close(); }
});

test('recent ten and date queries are deterministic', async () => {
  const h = harness();
  try {
    for (let index = 1; index <= 12; index += 1) await say(h, `午餐${index}元`, `recent-${index}`);
    const recent = await say(h, '最近十笔账', 'query-recent');
    const date = await say(h, '7月20日账目', 'query-date');
    assert.equal(recent.data.entries.length, 10);
    assert.equal(date.data.entries.length, 12);
  } finally { h.close(); }
});

test('owner isolation hides reads modifications and deletes as nonexistent', async () => {
  const h = harness();
  try {
    await say(h, '早餐18元', 'owner-a-entry');
    const entry = h.repository.list({ ownerId: 'owner-a' })[0];
    assert.equal(h.repository.get({ ownerId: 'owner-b', id: entry.id }), null);
    assert.equal(h.repository.update({ ownerId: 'owner-b', id: entry.id, patch: { amountMinor: 1 } }), null);
    assert.equal(h.repository.softDelete({ ownerId: 'owner-b', id: entry.id }), false);
    assert.equal(h.repository.list({ ownerId: 'owner-b' }).length, 0);
    assert.equal(h.repository.get({ ownerId: 'owner-a', id: entry.id }).amountMinor, 1800);
  } finally { h.close(); }
});

test('ledger survives conversation changes and never invokes Memory OS', async () => {
  const h = harness();
  try {
    await say(h, '早餐18元', 'conversation-one', 'owner-a', { conversationId: 'conversation-one' });
    const query = await say(h, '今天花了多少？', 'conversation-two', 'owner-a', { conversationId: 'conversation-two' });
    assert.match(query.content, /18元/);
    assert.equal(h.repository.list({ ownerId: 'owner-a' })[0].sourceMessageId, 'message-conversation-one');
    assert.equal(Object.hasOwn(h, 'memoryRuntime'), false);
  } finally { h.close(); }
});

test('Finance schema is additive, versioned and passes SQLite integrity_check', () => {
  const h = harness();
  try {
    const columns = h.database.prepare('PRAGMA table_info(finance_entries)').all().map((item) => item.name);
    for (const name of ['id', 'owner_id', 'type', 'amount_minor', 'currency', 'occurred_at', 'timezone', 'category', 'source_message_id', 'client_request_id', 'status', 'deleted_at']) assert.ok(columns.includes(name));
    assert.equal(h.database.prepare('SELECT version FROM finance_schema_versions').get().version, 1);
    assert.equal(h.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { h.close(); }
});

test('unknown category falls back without dropping a clear transaction', async () => {
  const h = harness();
  try {
    await say(h, '今天花了12元', 'fallback-expense');
    await say(h, '今天收到88元', 'fallback-income');
    const entries = h.repository.list({ ownerId: 'owner-a' });
    assert.equal(entries.find((item) => item.type === 'expense').category, '其他');
    assert.equal(entries.find((item) => item.type === 'income').category, '其他收入');
  } finally { h.close(); }
});

test('repository rejects floating minor units, zero and cross-type categories', async () => {
  const h = harness();
  try {
    await say(h, '早餐18元', 'validation-entry');
    const entry = h.repository.list({ ownerId: 'owner-a' })[0];
    assert.throws(() => h.repository.update({ ownerId: 'owner-a', id: entry.id, patch: { amountMinor: 18.5 } }), /AMOUNT_INVALID/);
    assert.throws(() => h.repository.update({ ownerId: 'owner-a', id: entry.id, patch: { amountMinor: 0 } }), /AMOUNT_INVALID/);
    assert.throws(() => h.repository.update({ ownerId: 'owner-a', id: entry.id, patch: { category: '工资' } }), /CATEGORY_INVALID/);
  } finally { h.close(); }
});
