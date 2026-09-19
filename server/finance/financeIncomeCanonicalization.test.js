import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAssistantAgentOrchestrator } from '../agent/assistantAgentOrchestrator.js';
import { createFinanceRuntime } from './runtime.js';

const NOW = new Date('2026-07-31T04:00:00.000Z');
const OWNER_A = 'income-owner-a';
const OWNER_B = 'income-owner-b';

function providerPlan({ direction = null, amountText = null } = {}) {
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
        direction,
        amount_text: amountText,
        occurred_expression: null
      }
    },
    required_evidence: [],
    explicit_fields: direction ? ['action', 'arguments.transaction_candidate.direction'] : ['action'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.99,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function harness(planForMessage = () => providerPlan()) {
  const finance = createFinanceRuntime({
    database: new DatabaseSync(':memory:'),
    applyMigrations: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const agent = createAssistantAgentOrchestrator({
    semanticPlanner: {
      async plan({ message }) {
        return { ok: true, plan: structuredClone(planForMessage(message)) };
      }
    },
    financeService: finance.service,
    timezone: 'Asia/Shanghai',
    clock: finance.clock
  });
  return { finance, agent };
}

async function ask(agent, message, requestId, {
  ownerId = OWNER_A,
  conversationId = 'income-conversation'
} = {}) {
  return agent.processUserMessage({
    ownerId,
    conversationId,
    message,
    clientRequestId: requestId,
    sourceMessageId: `source-${requestId}`,
    conversationMessages: []
  });
}

const explicitIncomeCases = [
  ['compact income', '记一笔收入500元', 50000, 'income'],
  ['spaced income smoke regression', '记一笔收入 500 元', 50000, 'income'],
  ['unitless income', '收入500', 50000, 'income'],
  ['salary income', '收到工资5000元', 500000, 'income'],
  ['bonus income', '今天收到奖金800元', 80000, 'income'],
  ['decimal credited income', '昨天入账1200.50元', 120050, 'income'],
  ['repayment income', '别人还我200元', 20000, 'income'],
  ['refund credited income', '退款到账99元', 9900, 'income']
];

const explicitExpenseCases = [
  ['breakfast expense', '早餐14元', 1400, 'expense'],
  ['lunch expense', '午饭花了28元', 2800, 'expense'],
  ['decimal taxi expense', '昨天打车36.5元', 3650, 'expense'],
  ['shopping expense', '买东西花了500元', 50000, 'expense']
];

test('Finance Canonical recovers one explicit income amount from the authenticated message when Provider amount_text is absent', async (t) => {
  for (const [name, message, amountMinor, type] of explicitIncomeCases) {
    await t.test(name, async () => {
      const { finance, agent } = harness(() => providerPlan({
        direction: message.startsWith('记一笔收入') ? 'income' : null,
        amountText: name === 'compact income' ? '收入' : null
      }));
      try {
        let repositoryCalls = 0;
        const create = finance.repository.create.bind(finance.repository);
        finance.repository.create = (input) => {
          repositoryCalls += 1;
          return create(input);
        };

        const result = await ask(agent, message, `income-${name}`);
        const ownerEntries = finance.repository.list({ ownerId: OWNER_A });
        const otherOwnerEntries = finance.repository.list({ ownerId: OWNER_B });

        assert.equal(result.action, 'create');
        assert.doesNotMatch(result.content, /金额是多少/);
        assert.equal(repositoryCalls, 1);
        assert.equal(ownerEntries.length, 1);
        assert.equal(ownerEntries[0].amountMinor, amountMinor);
        assert.equal(ownerEntries[0].type, type);
        assert.equal(otherOwnerEntries.length, 0);
      } finally {
        finance.close();
      }
    });
  }
});

test('Finance Canonical keeps established expense expressions working when Provider amount_text is absent', async (t) => {
  for (const [name, message, amountMinor, type] of explicitExpenseCases) {
    await t.test(name, async () => {
      const { finance, agent } = harness(() => providerPlan());
      try {
        const result = await ask(agent, message, `expense-${name}`);
        const [entry] = finance.repository.list({ ownerId: OWNER_A });
        assert.equal(result.action, 'create');
        assert.doesNotMatch(result.content, /金额是多少/);
        assert.equal(entry.amountMinor, amountMinor);
        assert.equal(entry.type, type);
      } finally {
        finance.close();
      }
    });
  }
});

test('Finance Canonical clarifies only genuinely missing, invalid, or ambiguous create fields without writes', async (t) => {
  const cases = [
    ['missing income amount', '记一笔收入', /金额是多少/],
    ['missing received amount', '收到一笔钱', /金额是多少/],
    ['missing direction', '记账500元', /收入还是支出/],
    ['negative amount', '收入负500元', /金额/],
    ['zero amount', '收入0元', /金额/],
    ['amount beyond safe minor-unit range', '收入90071992547410元', /金额/],
    ['two amounts', '收入500元，其中工资400元', /冲突|确认|金额/]
  ];

  for (const [name, message, expectedQuestion] of cases) {
    await t.test(name, async () => {
      const direction = /收入|收到/.test(message) ? 'income' : null;
      const { finance, agent } = harness(() => providerPlan({ direction }));
      try {
        const result = await ask(agent, message, `clarify-${name}`);
        assert.equal(result.action, 'clarify');
        assert.match(result.content, expectedQuestion);
        assert.doesNotMatch(result.content, /已记录|记录成功/);
        assert.equal(finance.repository.list({ ownerId: OWNER_A }).length, 0);
      } finally {
        finance.close();
      }
    });
  }
});

test('Finance Canonical preserves owner-scoped idempotency for an explicit income request', async () => {
  const { finance, agent } = harness(() => providerPlan({ direction: 'income' }));
  try {
    const first = await ask(agent, '记一笔收入 500 元', 'same-income-request');
    const retry = await ask(agent, '记一笔收入 500 元', 'same-income-request', {
      conversationId: 'retry-conversation'
    });
    assert.equal(first.action, 'create');
    assert.equal(retry.action, 'create');
    assert.equal(finance.repository.list({ ownerId: OWNER_A }).length, 1);
    assert.equal(finance.repository.list({ ownerId: OWNER_B }).length, 0);
  } finally {
    finance.close();
  }
});

test('Finance Canonical never acknowledges an income write failure', async () => {
  const { finance, agent } = harness(() => providerPlan({ direction: 'income' }));
  try {
    finance.repository.create = () => {
      const error = new Error('simulated rollback');
      error.code = 'FINANCE_WRITE_FAILED';
      throw error;
    };
    const result = await ask(agent, '记一笔收入 500 元', 'income-write-failure');
    assert.equal(result.action, 'error');
    assert.equal(result.code, 'FINANCE_WRITE_FAILED');
    assert.doesNotMatch(result.content, /^(?:已记录|记录成功)/);
    assert.equal(finance.repository.list({ ownerId: OWNER_A }).length, 0);
  } finally {
    finance.close();
  }
});
