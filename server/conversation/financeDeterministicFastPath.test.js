import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAssistantAgentOrchestrator } from '../agent/assistantAgentOrchestrator.js';
import { classifyFinanceType } from '../finance/service.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { localDateKey } from '../finance/time.js';
import { createConversationRuntime } from './runtime.js';

const OWNER = 'deterministic-fast-path-owner';
const NOW = new Date('2026-07-31T04:00:00.000Z');

const SIMPLE_RECORDS = [
  ['早餐14元', 1400, 'expense'],
  ['午饭花了28元', 2800, 'expense'],
  ['昨天打车36.5元', 3650, 'expense'],
  ['买东西花了500元', 50000, 'expense'],
  ['记一笔收入500元', 50000, 'income'],
  ['收到工资5000元', 500000, 'income'],
  ['今天收到奖金800元', 80000, 'income'],
  ['昨天入账1200.50元', 120050, 'income'],
  ['别人还我200元', 20000, 'income'],
  ['退款到账99元', 9900, 'income']
];

const UNKNOWN_CATEGORY_RECORDS = [
  ['过路费17元', 1700, 'expense', '交通'],
  ['高速费17元', 1700, 'expense', '交通'],
  ['路桥费17元', 1700, 'expense', '交通'],
  ['服务费30元', 3000, 'expense', '其他'],
  ['手续费5元', 500, 'expense', '其他'],
  ['门票80元', 8000, 'expense', '其他'],
  ['修理东西花了120元', 12000, 'expense', '其他'],
  ['买了个东西45元', 4500, 'expense', '其他'],
  ['昨天支出66元', 6600, 'expense', '其他'],
  ['花了88元', 8800, 'expense', '其他'],
  ['收入500元', 50000, 'income', '其他收入'],
  ['收到300元', 30000, 'income', '其他收入'],
  ['昨天进账600元', 60000, 'income', '其他收入'],
  ['有人转给我200元', 20000, 'income', '其他收入'],
  ['收到一笔退款99元', 9900, 'income', '退款']
];

function providerPlan(message) {
  return {
    domain: 'finance',
    intent: 'create',
    action: 'create',
    entity: { type: 'transaction', reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: 'ledger_entry',
    value: null,
    qualifiers: {},
    tool: null,
    arguments: {
      transaction_candidate: {
        direction: classifyFinanceType(message),
        amount_text: null,
        occurred_expression: null
      }
    },
    required_evidence: [],
    explicit_fields: ['action'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.99,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function ordinaryPlan() {
  return {
    domain: 'ordinary_chat',
    intent: 'ordinary_chat',
    action: 'ordinary_chat',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: [],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.99,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function harness(planForMessage = providerPlan) {
  const finance = createFinanceRuntime({
    database: new DatabaseSync(':memory:'),
    applyMigrations: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const semanticPlanner = {
    calls: [],
    async plan({ message }) {
      this.calls.push(message);
      return { ok: true, plan: planForMessage(message) };
    }
  };
  const ordinaryProvider = {
    calls: [],
    async stream(request, { onDelta }) {
      this.calls.push(request);
      await onDelta('普通聊天回复');
      return { ok: true, content: '普通聊天回复' };
    }
  };
  const memory = {
    calls: [],
    isMemoryQuery: () => false,
    async processUserMessage(input) {
      this.calls.push(input);
      return { kind: 'none', outcome: 'ignored' };
    }
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
  return {
    finance,
    semanticPlanner,
    ordinaryProvider,
    memory,
    assistantAgent,
    conversation,
    close() {
      conversation.close();
      finance.close();
    }
  };
}

async function exchange(harnessValue, message, requestId) {
  const prepared = harnessValue.conversation.service.prepare({
    ownerId: OWNER,
    message,
    clientRequestId: requestId
  });
  const result = await harnessValue.conversation.service.execute(prepared);
  return { prepared, result };
}

test('explicit Finance records use the deterministic fast path for twenty consecutive rounds', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const exchanges = [];
  for (let round = 0; round < 20; round += 1) {
    for (const [message] of SIMPLE_RECORDS) {
      exchanges.push(await exchange(h, message, `fast-path-${round}-${exchanges.length}`));
    }
  }

  assert.equal(h.semanticPlanner.calls.length, 0,
    `expected zero semantic Provider plans, got ${h.semanticPlanner.calls.length}`);
  assert.equal(h.ordinaryProvider.calls.length, 0);
  assert.equal(h.memory.calls.length, 0);
  assert.equal(exchanges.length, SIMPLE_RECORDS.length * 20);
  for (const { result } of exchanges) {
    assert.equal(result.status, 'completed');
    assert.match(result.content, /已记录/);
  }

  const entries = h.finance.repository.list({ ownerId: OWNER, limit: 1_000 });
  assert.equal(entries.length, SIMPLE_RECORDS.length * 20);
  assert.equal(h.finance.repository.list({ ownerId: 'other-owner' }).length, 0);
  for (const [, amountMinor, type] of SIMPLE_RECORDS) {
    assert.equal(entries.filter((entry) => entry.amountMinor === amountMinor && entry.type === type).length, 20);
  }
});

test('clear direction and amount use the deterministic fast path even when category is unknown', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const exchanges = [];
  for (let round = 0; round < 20; round += 1) {
    for (const [message] of UNKNOWN_CATEGORY_RECORDS) {
      exchanges.push(await exchange(h, message, `default-category-${round}-${exchanges.length}`));
    }
  }

  assert.equal(h.semanticPlanner.calls.length, 0,
    `expected zero semantic Provider plans, got ${h.semanticPlanner.calls.length}`);
  assert.equal(h.ordinaryProvider.calls.length, 0);
  assert.equal(h.memory.calls.length, 0);
  assert.equal(exchanges.length, UNKNOWN_CATEGORY_RECORDS.length * 20);
  for (const { result } of exchanges) {
    assert.equal(result.status, 'completed');
    assert.match(result.content, /已记录/);
  }

  const entries = h.finance.repository.list({ ownerId: OWNER, limit: 1_000 });
  assert.equal(entries.length, UNKNOWN_CATEGORY_RECORDS.length * 20);
  assert.equal(h.finance.repository.list({ ownerId: 'other-owner' }).length, 0);
  for (const [message, amountMinor, type, category] of UNKNOWN_CATEGORY_RECORDS) {
    assert.equal(entries.filter((entry) => (
      entry.note === message && entry.amountMinor === amountMinor && entry.type === type && entry.category === category
    )).length, 20);
  }
  assert.equal(entries.filter((entry) => localDateKey(new Date(entry.occurredAt), 'Asia/Shanghai') === '2026-07-30').length, 40);
});

test('deterministic Finance write failures stay errors without Provider fallback', async (t) => {
  const h = harness();
  t.after(() => h.close());
  h.finance.repository.create = () => {
    const error = new Error('simulated rollback');
    error.code = 'FINANCE_WRITE_FAILED';
    throw error;
  };

  const { result } = await exchange(h, '早餐14元', 'fast-path-write-failure-red');
  assert.equal(h.semanticPlanner.calls.length, 0);
  assert.equal(h.ordinaryProvider.calls.length, 0);
  assert.equal(result.status, 'error');
  assert.doesNotMatch(result.content, /^(?:已记录|记录成功)$/);
});

test('Finance fast path leaves genuinely incomplete records on the constrained model clarification path', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const { result } = await exchange(h, '记一笔收入', 'fast-path-missing-amount');
  assert.equal(result.status, 'completed');
  assert.match(result.content, /金额是多少/);
  assert.equal(h.semanticPlanner.calls.length, 1);
  assert.equal(h.ordinaryProvider.calls.length, 0);
  assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 0);
});

test('ordinary chat keeps its existing Provider path and is not classified as a Finance fast-path write', async (t) => {
  const h = harness((message) => message === '帮我写一句问候' ? ordinaryPlan() : providerPlan(message));
  t.after(() => h.close());

  const { result } = await exchange(h, '帮我写一句问候', 'fast-path-ordinary-chat');
  assert.equal(result.status, 'completed');
  assert.equal(result.content, '普通聊天回复');
  assert.equal(h.semanticPlanner.calls.length, 1);
  assert.equal(h.ordinaryProvider.calls.length, 1);
  assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 0);
});

test('mixed multi-entry Finance requests use one deterministic batch fast path', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const message = '早餐14元，过路费17元，收入500元。';
  const { result } = await exchange(h, message, 'fast-path-mixed-batch-red');

  assert.equal(h.semanticPlanner.calls.length, 0,
    `expected zero semantic Provider plans, got ${h.semanticPlanner.calls.length}`);
  assert.equal(h.ordinaryProvider.calls.length, 0);
  assert.equal(result.status, 'completed');
  assert.match(result.content, /已记录/);

  const entries = h.finance.repository.list({ ownerId: OWNER, limit: 100 });
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => ({
    amountMinor: entry.amountMinor,
    type: entry.type,
    category: entry.category,
    note: entry.note
  })).sort((a, b) => a.amountMinor - b.amountMinor), [
    { amountMinor: 1400, type: 'expense', category: '餐饮', note: '早餐14元' },
    { amountMinor: 1700, type: 'expense', category: '交通', note: '过路费17元' },
    { amountMinor: 50000, type: 'income', category: '其他收入', note: '收入500元' }
  ].sort((a, b) => a.amountMinor - b.amountMinor));
  assert.equal(h.finance.repository.list({ ownerId: 'other-owner' }).length, 0);
});

test('mixed multi-entry fast path rolls back every entry when the batch write fails', async (t) => {
  const h = harness();
  t.after(() => h.close());
  h.finance.repository.createMany = () => {
    const error = new Error('simulated batch rollback');
    error.code = 'FINANCE_WRITE_FAILED';
    throw error;
  };

  const { result } = await exchange(h, '早餐14元，过路费17元，收入500元。', 'fast-path-mixed-batch-rollback');
  assert.equal(h.semanticPlanner.calls.length, 0);
  assert.equal(h.ordinaryProvider.calls.length, 0);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'FINANCE_WRITE_FAILED');
  assert.doesNotMatch(result.content, /已记录/);
  assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 0);
});

test('separate same-direction clauses remain deterministic and preserve owner isolation', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const { result } = await exchange(h, '早餐14元，午饭28元。', 'fast-path-expense-batch');
  assert.equal(result.status, 'completed');
  assert.match(result.content, /已记录2笔/);
  assert.equal(h.semanticPlanner.calls.length, 0);
  assert.equal(h.ordinaryProvider.calls.length, 0);
  assert.deepEqual(h.finance.repository.list({ ownerId: OWNER, limit: 10 }).map((entry) => entry.amountMinor).sort((a, b) => a - b), [1400, 2800]);
  assert.equal(h.finance.repository.list({ ownerId: 'other-owner' }).length, 0);
});

test('batch retries are owner-scoped and idempotent without duplicate rows', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const message = '早餐14元，过路费17元，收入500元。';
  const input = {
    ownerId: OWNER,
    conversationId: 'batch-idempotency-one',
    message,
    clientRequestId: 'fast-path-batch-idempotent',
    sourceMessageId: 'batch-source-message',
    conversationMessages: []
  };
  const first = await h.assistantAgent.processUserMessage(input);
  const retry = await h.assistantAgent.processUserMessage({ ...input, conversationId: 'batch-idempotency-two' });
  assert.equal(first.action, 'create_batch');
  assert.equal(retry.action, 'create_batch');
  assert.equal(h.finance.repository.list({ ownerId: OWNER, limit: 100 }).length, 3);
  assert.equal(h.finance.repository.list({ ownerId: 'other-owner' }).length, 0);
});
