import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createFinanceRuntime } from '../finance/runtime.js';
import { createConversationRuntime } from './runtime.js';

function harness() {
  const finance = createFinanceRuntime({ database: new DatabaseSync(':memory:'), applyMigrations: true, timezone: 'Asia/Shanghai' });
  const memory = {
    calls: [],
    isMemoryQuery: () => false,
    async processUserMessage(input) { this.calls.push(input); return { kind: 'none', outcome: 'ignored' }; }
  };
  const provider = {
    calls: [],
    async stream(request, { onDelta }) {
      this.calls.push(request);
      await onDelta('模型回复');
      return { ok: true, content: '模型回复' };
    }
  };
  const conversation = createConversationRuntime({
    database: new DatabaseSync(':memory:'), aiService: provider, applyMigrations: true,
    memoryPolicy: 'protected_acceptance', memoryIntegration: memory,
    financeIntegration: finance.service
  });
  return { finance, memory, provider, conversation, close() { conversation.close(); finance.close(); } };
}

async function exchange(h, message, clientRequestId, conversationId = null) {
  const prepared = h.conversation.service.prepare({ ownerId: 'session-owner', conversationId, message, clientRequestId });
  const deltas = [];
  const result = await h.conversation.service.execute(prepared, { onDelta: (delta) => deltas.push(delta) });
  return { prepared, result, deltas };
}

test('clear accounting is sealed as 已记录 before Provider and Memory', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const { prepared, result, deltas } = await exchange(h, '午餐花了30元', 'finance-create');
  assert.equal(result.content, '已记录');
  assert.deepEqual(deltas, ['已记录']);
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.memory.calls.length, 0);
  assert.equal(h.finance.repository.list({ ownerId: 'session-owner' }).length, 1);
  assert.equal(h.finance.repository.list({ ownerId: 'session-owner' })[0].sourceMessageId, prepared.userMessage.id);
});
test('deterministic finance query bypasses Provider while a non-finance message retains the existing chain', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await exchange(h, '早餐18元', 'finance-breakfast');
  const query = await exchange(h, '今天花了多少？', 'finance-query');
  assert.match(query.result.content, /18元/);
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.memory.calls.length, 0);
  const ordinary = await exchange(h, '帮我写一句问候', 'ordinary-message');
  assert.equal(ordinary.result.content, '模型回复');
  assert.equal(h.provider.calls.length, 1);
  assert.equal(h.memory.calls.length, 1);
});

test('finance persistence failure returns the safe failure text and never claims 已记录', async (t) => {
  const h = harness();
  t.after(() => h.close());
  h.finance.repository.create = () => { throw new Error('private sqlite path'); };
  const { result } = await exchange(h, '晚餐40元', 'finance-failure');
  assert.equal(result.content, '这笔账暂时没有记录成功，请重试。');
  assert.doesNotMatch(result.content, /已记录/);
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.memory.calls.length, 0);
});

test('relative-date finance queries and follow-ups stay deterministic inside the owner-bound conversation', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const createdExpense = await exchange(h, '昨天午餐30元', 'yesterday-expense');
  const conversationId = createdExpense.prepared.conversation.id;
  await exchange(h, '昨天收到退款100元', 'yesterday-income', conversationId);
  const expense = await exchange(h, '我昨天一共花了多少钱？', 'yesterday-query', conversationId);
  const income = await exchange(h, '那收入呢？', 'income-follow-up', conversationId);
  assert.match(expense.result.content, /昨天共支出30元/);
  assert.match(income.result.content, /昨天共收入100元/);
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.memory.calls.length, 0);
});
