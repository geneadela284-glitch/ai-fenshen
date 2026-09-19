import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAssistantAgentOrchestrator } from '../agent/assistantAgentOrchestrator.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { createConversationRuntime } from './runtime.js';

const OWNER = 'finance-semantic-owner';
const NOW = new Date('2026-08-14T04:00:00.000Z');

function harness() {
  const finance = createFinanceRuntime({
    database: new DatabaseSync(':memory:'),
    applyMigrations: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const semanticPlanner = { calls: [], async plan({ message }) {
    this.calls.push(message);
    return { ok: false, code: 'MUST_NOT_CALL' };
  } };
  const ordinaryProvider = { calls: [], async stream() {
    this.calls.push(true);
    return { ok: true, content: '普通回复' };
  } };
  const memory = {
    calls: [],
    isMemoryQuery: () => false,
    async processUserMessage(input) { this.calls.push(input); return { kind: 'none', outcome: 'ignored' }; }
  };
  const assistantAgent = createAssistantAgentOrchestrator({
    semanticPlanner,
    memoryIntegration: memory,
    financeService: finance.service,
    timezone: 'Asia/Shanghai',
    clock: finance.clock
  });
  const conversation = createConversationRuntime({
    database: new DatabaseSync(':memory:'),
    aiService: ordinaryProvider,
    applyMigrations: true,
    memoryPolicy: 'protected_acceptance',
    memoryIntegration: memory,
    financeIntegration: finance.service,
    assistantAgent
  });
  return { finance, semanticPlanner, ordinaryProvider, memory, assistantAgent, conversation, conversations: new Map(),
    close() { conversation.close(); finance.close(); } };
}

async function exchange(h, message, requestId, conversationId = 'semantic-conversation') {
  const existingConversationId = h.conversations.get(conversationId) || null;
  const prepared = h.conversation.service.prepare({
    ownerId: OWNER, conversationId: existingConversationId, message, clientRequestId: requestId
  });
  h.conversations.set(conversationId, prepared.conversation.id);
  return h.conversation.service.execute(prepared);
}

test('Chinese money Finance expressions use deterministic persistence with zero Providers', async (t) => {
  const h = harness();
  t.after(() => h.close());
  for (const [index, message] of [
    '买菜二十', '早餐三十块', '打车四十元', '买衣服一百', '房租一千', '工资一万'
  ].entries()) {
    const result = await exchange(h, message, `money-${index}`);
    assert.equal(result.status, 'completed', message);
    assert.match(result.content, /已记录/, message);
  }
  assert.equal(h.semanticPlanner.calls.length, 0);
  assert.equal(h.ordinaryProvider.calls.length, 0);
  assert.equal(h.memory.calls.length, 0);
  assert.deepEqual(h.finance.repository.list({ ownerId: OWNER, limit: 20 })
    .map((entry) => [entry.amountMinor, entry.type]), [
      [1000000, 'income'], [100000, 'expense'], [10000, 'expense'],
      [4000, 'expense'], [3000, 'expense'], [2000, 'expense']
    ]);
});

test('required Chinese money and Finance semantic matrix persists exact direction and amount', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const cases = [
    ['借给李伟二十元', 'expense', 'loan_out', 2_000],
    ['借给李伟三十块', 'expense', 'loan_out', 3_000],
    ['借给李伟四十', 'expense', 'loan_out', 4_000],
    ['借给李伟一百元', 'expense', 'loan_out', 10_000],
    ['借给李伟一千块', 'expense', 'loan_out', 100_000],
    ['借给李伟一万元', 'expense', 'loan_out', 1_000_000],
    ['我向李伟借两千', 'income', 'loan_in', 200_000],
    ['李伟还我三千', 'income', 'repayment_in', 300_000],
    ['我还李伟五百', 'expense', 'repayment_out', 50_000],
    ['花了二十块吃早餐', 'expense', null, 2_000],
    ['买菜三十', 'expense', null, 3_000],
    ['打车四十元', 'expense', null, 4_000],
    ['工资一万元', 'income', null, 1_000_000],
    ['收到奖金两千元', 'income', null, 200_000]
  ];
  for (const [index, [message, type, subtype, amountMinor]] of cases.entries()) {
    const result = await exchange(h, message, `matrix-${index}`, `matrix-${index}`);
    assert.equal(result.status, 'completed', message);
    assert.equal(result.content, '已记录', message);
    const entry = h.finance.repository.list({ ownerId: OWNER, limit: 20 })[0];
    assert.equal(entry.type, type, message);
    assert.equal(entry.amountMinor, amountMinor, message);
    assert.equal(entry.subtype || null, subtype, message);
  }
  assert.equal(h.semanticPlanner.calls.length, 0);
  assert.equal(h.ordinaryProvider.calls.length, 0);
});

test('loan and repayment directions are distinct and preserve subtype/counterparty', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const cases = [
    ['借给李伟一千元', 'expense', 'loan_out', '李伟'],
    ['借李伟一千块', 'expense', 'loan_out', '李伟'],
    ['李伟从我这里借了一千', 'expense', 'loan_out', '李伟'],
    ['李伟向我借1000', 'expense', 'loan_out', '李伟'],
    ['我借出去1000给李伟', 'expense', 'loan_out', '李伟'],
    ['我向李伟借一千', 'income', 'loan_in', '李伟'],
    ['李伟借给我一千', 'income', 'loan_in', '李伟'],
    ['李伟还我一千', 'income', 'repayment_in', '李伟'],
    ['我还李伟一千', 'expense', 'repayment_out', '李伟']
  ];
  for (const [index, [message, type, subtype, counterparty]] of cases.entries()) {
    const result = await exchange(h, message, `loan-${index}`, `loan-conversation-${index}`);
    assert.equal(result.status, 'completed', message);
    assert.equal(result.content, '已记录', message);
    assert.equal(result.deterministicAction, 'create', message);
    const entry = h.finance.repository.list({ ownerId: OWNER, limit: 20 })[0];
    assert.equal(entry.type, type, message);
    assert.equal(entry.subtype, subtype, message);
    assert.equal(entry.counterparty, counterparty, message);
    assert.equal(entry.amountMinor, 100000, message);
  }
  assert.equal(h.semanticPlanner.calls.length, 0);
  assert.equal(h.ordinaryProvider.calls.length, 0);
});

test('pending Finance slots merge across amount and date replies without repeating known amount', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const first = await exchange(h, '借给李伟', 'pending-1', 'pending-conversation');
  assert.match(first.content, /金额是多少/);
  // Exercise conversation-history recovery rather than relying only on the
  // in-memory pending map (for example after a process restart).
  h.finance.service.pendingOperations.clear();
  const second = await exchange(h, '一千', 'pending-2', 'pending-conversation');
  assert.match(second.content, /已记录/);
  h.finance.service.lastOperations.clear();
  const third = await exchange(h, '昨天', 'pending-3', 'pending-conversation');
  assert.doesNotMatch(third.content, /金额是多少/);
  const entry = h.finance.repository.list({ ownerId: OWNER, limit: 10 })[0];
  assert.equal(entry.subtype, 'loan_out');
  assert.equal(entry.counterparty, '李伟');
  assert.equal(entry.amountMinor, 100000);
  assert.equal(new Date(entry.occurredAt).toISOString(), '2026-08-13T04:00:00.000Z');
  assert.equal(h.semanticPlanner.calls.length, 0);
  assert.equal(h.ordinaryProvider.calls.length, 0);
});

test('ambiguous 李伟借我 direction asks for confirmation and does not persist', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await exchange(h, '李伟借我一千', 'ambiguous-loan');
  assert.equal(result.status, 'completed');
  assert.match(result.content, /方向|确认|借给你|你借给李伟/);
  assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 0);
  assert.equal(h.semanticPlanner.calls.length, 0);
  assert.equal(h.ordinaryProvider.calls.length, 0);
});

test('creator and Huage identity questions are deterministic', async () => {
  const agent = createAssistantAgentOrchestrator({
    semanticPlanner: { calls: [], async plan() { throw new Error('provider must not run'); } },
    memoryIntegration: { isMemoryQuery: () => false, async processUserMessage() { return { kind: 'none' }; } }
  });
  const creatorQuestions = [
    '你是谁创造出来的', '你是由谁开发出来的', '请问你是谁创造的呀？', '谁把你开发出来的', '你是谁创造的', '谁创造了你', '你的创造者是谁', '你是谁开发的', '谁开发的你',
    '你的开发者是谁', '开发者是谁', '你是谁做的', 'AI分身是谁开发的', 'AI分身是谁创造的',
    'AI分身是谁做的', '谁做的你', '你是谁开发出来的？', '是谁创造了你？'
  ];
  for (const [index, message] of creatorQuestions.entries()) {
    const result = await agent.processUserMessage({ ownerId: OWNER, conversationId: `id-${index}`, message,
      clientRequestId: `id-${index}`, sourceMessageId: `id-${index}`, conversationMessages: [] });
    assert.equal(result.content, '我是由示例维护者创建的。', message);
  }
  const maintainerQuestions = ['维护者是谁', '谁是维护者', '你说的维护者是谁', '你的维护者是谁', '创造你的维护者是谁', '开发你的维护者是谁'];
  for (const [index, message] of maintainerQuestions.entries()) {
    const result = await agent.processUserMessage({ ownerId: OWNER, conversationId: `huage-${index}`, message,
      clientRequestId: `huage-${index}`, sourceMessageId: `huage-${index}`, conversationMessages: [] });
    assert.equal(result.content, '示例维护者，身份信息已脱敏。', message);
  }
});
