import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAssistantAgentOrchestrator } from '../agent/assistantAgentOrchestrator.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { createConversationRuntime } from './runtime.js';

const NOW = new Date('2026-07-31T00:00:00.000Z');
const OWNER = 'finance-domain-owner';
const OTHER_OWNER = 'finance-domain-other-owner';

function rawOrdinaryPlan() {
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

function rawFinancePlan(message = '早餐14元') {
  const amount = Number(message.match(/\d+(?:\.\d+)?/)?.[0] || 14);
  const direction = message.includes('收入') ? 'income' : 'expense';
  return {
    domain: 'finance',
    intent: 'create',
    action: 'create',
    entity: { type: 'transaction', reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: direction === 'income' ? 'received' : 'spent',
    value: { amount, currency: 'CNY' },
    qualifiers: {
      category: direction === 'income' ? '其他收入' : message.includes('打车') ? '交通' : '餐饮',
      relative_day_offset: message.includes('昨天') ? -1 : 0
    },
    tool: null,
    arguments: { metrics: [direction] },
    required_evidence: [],
    explicit_fields: ['predicate', 'value.amount', 'value.currency', 'qualifiers.category'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.99,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function rawToolPlan() {
  return {
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'tasks.create',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    tool: 'tasks.create',
    arguments: { title: '错误工具计划', relative_day_offset: 0 },
    required_evidence: [],
    explicit_fields: ['tool', 'arguments.title'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.99,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function planned(plan) {
  return { ok: true, plan };
}

function isSuccessAcknowledgement(content) {
  return /^(?:已记录(?:[。]|$)|记录成功(?:[。]|$))/.test(String(content || '').trim());
}

function createHarness({
  plans = [planned(rawFinancePlan())],
  financeHandler = null,
  providerContent = '记录成功',
  toolRegistry = null
} = {}) {
  const financeDatabase = new DatabaseSync(':memory:');
  const conversationDatabase = new DatabaseSync(':memory:');
  const finance = createFinanceRuntime({
    database: financeDatabase,
    applyMigrations: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const plannerCalls = [];
  let planIndex = 0;
  const semanticPlanner = {
    async plan(input) {
      plannerCalls.push(structuredClone(input));
      const selected = plans[Math.min(planIndex++, plans.length - 1)];
      return typeof selected === 'function'
        ? selected(input)
        : structuredClone(selected);
    }
  };
  let financeHandlerCalls = 0;
  const financeService = {
    isFinanceCandidate: finance.service.isFinanceCandidate.bind(finance.service),
    trustedContext: finance.service.trustedContext.bind(finance.service),
    async processUserMessage(input) {
      financeHandlerCalls += 1;
      if (financeHandler) return financeHandler(input, finance);
      return finance.service.processUserMessage(input);
    }
  };
  const assistantAgent = createAssistantAgentOrchestrator({
    semanticPlanner,
    financeService,
    toolRegistry,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const provider = {
    calls: [],
    async stream(request, { onDelta }) {
      this.calls.push(request);
      await onDelta(providerContent);
      return { ok: true, content: providerContent };
    }
  };
  const conversation = createConversationRuntime({
    database: conversationDatabase,
    aiService: provider,
    applyMigrations: true,
    assistantAgent
  });
  return {
    finance,
    financeDatabase,
    conversation,
    conversationDatabase,
    assistantAgent,
    plannerCalls,
    provider,
    get financeHandlerCalls() {
      return financeHandlerCalls;
    },
    close() {
      conversation.close();
      finance.close();
      conversationDatabase.close();
      financeDatabase.close();
    }
  };
}

async function exchange(harness, {
  ownerId = OWNER,
  conversationId = null,
  message = '早餐14元',
  clientRequestId = 'finance-domain-request'
} = {}) {
  const prepared = harness.conversation.service.prepare({
    ownerId,
    conversationId,
    message,
    clientRequestId
  });
  const deltas = [];
  const result = await harness.conversation.service.execute(prepared, {
    onDelta: (delta) => deltas.push(delta)
  });
  const persisted = harness.conversation.messages.findByClientRequestId(
    prepared.conversation.id,
    ownerId,
    clientRequestId
  );
  return { prepared, result, deltas, persisted };
}

test('RED: Finance Domain plus ordinary_chat Plans fail closed without generic success or ledger acknowledgement', async (t) => {
  const h = createHarness({
    plans: [planned(rawOrdinaryPlan()), planned(rawOrdinaryPlan())]
  });
  t.after(() => h.close());

  const outcome = await exchange(h);

  assert.deepEqual({
    plannerCalls: h.plannerCalls.length,
    routeDomains: h.plannerCalls.map((call) => call.routeDomain),
    constrainedDomain: h.plannerCalls[1]?.contextPack?.domain_contract?.required_domain || null,
    financeHandlerCalls: h.financeHandlerCalls,
    genericProviderCalls: h.provider.calls.length,
    deterministicAction: outcome.result.deterministicAction || null,
    returnedSuccessText: isSuccessAcknowledgement(outcome.result.content),
    persistedSuccessMessage:
      outcome.persisted.assistant?.status === 'completed' &&
      isSuccessAcknowledgement(outcome.persisted.assistant.content),
    ownerRows: h.finance.repository.list({ ownerId: OWNER }).length,
    otherOwnerRows: h.finance.repository.list({ ownerId: OTHER_OWNER }).length
  }, {
    plannerCalls: 2,
    routeDomains: ['finance', 'finance'],
    constrainedDomain: 'finance',
    financeHandlerCalls: 0,
    genericProviderCalls: 0,
    deterministicAction: 'error',
    returnedSuccessText: false,
    persistedSuccessMessage: false,
    ownerRows: 0,
    otherOwnerRows: 0
  });
});

test('RED: Finance Domain replans ordinary_chat once and commits a Finance Plan before success', async (t) => {
  const h = createHarness({
    plans: [planned(rawOrdinaryPlan()), planned(rawFinancePlan('早餐14元'))]
  });
  t.after(() => h.close());

  const outcome = await exchange(h);
  const rows = h.finance.repository.list({ ownerId: OWNER });

  assert.deepEqual({
    plannerCalls: h.plannerCalls.length,
    constrainedDomain: h.plannerCalls[1]?.contextPack?.domain_contract?.required_domain || null,
    originalMessagePreserved: h.plannerCalls.every((call) => call.message === '早餐14元'),
    originalOwnerPreserved: h.plannerCalls.every((call) => call.ownerId === OWNER),
    financeHandlerCalls: h.financeHandlerCalls,
    genericProviderCalls: h.provider.calls.length,
    resultContent: outcome.result.content,
    persistedStatus: outcome.persisted.assistant?.status,
    rowCount: rows.length,
    amountMinor: rows[0]?.amountMinor || null
  }, {
    plannerCalls: 2,
    constrainedDomain: 'finance',
    originalMessagePreserved: true,
    originalOwnerPreserved: true,
    financeHandlerCalls: 1,
    genericProviderCalls: 0,
    resultContent: '已记录',
    persistedStatus: 'completed',
    rowCount: 1,
    amountMinor: 1400
  });
});

test('RED: Finance Domain plus an empty Plan replans once and never falls through to ordinary chat', async (t) => {
  const h = createHarness({
    plans: [planned(null), planned(rawFinancePlan('早餐14元'))]
  });
  t.after(() => h.close());

  const outcome = await exchange(h);

  assert.equal(h.plannerCalls.length, 2);
  assert.equal(h.plannerCalls[1].contextPack.domain_contract.required_domain, 'finance');
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.financeHandlerCalls, 1);
  assert.equal(outcome.result.content, '已记录');
  assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 1);
});

test('RED: Finance Domain plus a non-Finance tool Plan replans once and cannot execute the wrong tool', async (t) => {
  let toolCalls = 0;
  const h = createHarness({
    plans: [planned(rawToolPlan()), planned(rawOrdinaryPlan())],
    toolRegistry: {
      async invoke() {
        toolCalls += 1;
        return {
          decision: 'ACCEPT',
          result: {
            ok: true,
            safe_user_message: '错误工具已执行',
            data: { task: { id: 'wrong-task' } }
          }
        };
      }
    }
  });
  t.after(() => h.close());

  const result = await h.assistantAgent.processUserMessage({
    ownerId: OWNER,
    conversationId: 'finance-domain-conversation',
    sourceMessageId: 'finance-domain-message',
    clientRequestId: 'finance-domain-tool-mismatch',
    message: '早餐14元',
    conversationMessages: []
  });

  assert.deepEqual({
    plannerCalls: h.plannerCalls.length,
    constrainedDomain: h.plannerCalls[1]?.contextPack?.domain_contract?.required_domain || null,
    toolCalls,
    domain: result.domain,
    action: result.action,
    code: result.code
  }, {
    plannerCalls: 2,
    constrainedDomain: 'finance',
    toolCalls: 0,
    domain: 'finance',
    action: 'error',
    code: 'FINANCE_PLAN_DOMAIN_MISMATCH'
  });
});

test('RED: Finance handler exceptions fail closed and cannot be converted into generic chat success', async (t) => {
  const h = createHarness({
    plans: [planned(rawFinancePlan('早餐14元'))],
    financeHandler: async () => {
      throw Object.assign(new Error('isolated handler failure'), {
        code: 'FINANCE_HANDLER_TEST_FAILURE'
      });
    }
  });
  t.after(() => h.close());

  const outcome = await exchange(h, { clientRequestId: 'finance-handler-failure' });

  assert.equal(h.financeHandlerCalls, 1);
  assert.equal(h.provider.calls.length, 0);
  assert.equal(outcome.result.deterministicAction, 'error');
  assert.equal(isSuccessAcknowledgement(outcome.result.content), false);
  assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 0);
});

test('Finance transaction rollback and Repository empty results never produce success acknowledgement', async (t) => {
  const rollback = createHarness({
    plans: [planned(rawFinancePlan('早餐14元'))],
    financeHandler: async (input, finance) => {
      const original = finance.repository.create;
      finance.repository.create = () => {
        finance.database.exec('BEGIN IMMEDIATE');
        finance.database.exec('ROLLBACK');
        throw new Error('isolated rollback');
      };
      try {
        return await finance.service.processUserMessage(input);
      } finally {
        finance.repository.create = original;
      }
    }
  });
  const empty = createHarness({
    plans: [planned(rawFinancePlan('早餐14元'))],
    financeHandler: async (input, finance) => {
      const original = finance.repository.create;
      finance.repository.create = () => null;
      try {
        return await finance.service.processUserMessage(input);
      } finally {
        finance.repository.create = original;
      }
    }
  });
  t.after(() => rollback.close());
  t.after(() => empty.close());

  const rolledBack = await exchange(rollback, { clientRequestId: 'finance-rollback' });
  const emptyResult = await exchange(empty, { clientRequestId: 'finance-empty-result' });

  for (const [harness, outcome] of [[rollback, rolledBack], [empty, emptyResult]]) {
    assert.equal(harness.provider.calls.length, 0);
    assert.equal(outcome.result.deterministicAction, 'error');
    assert.equal(isSuccessAcknowledgement(outcome.result.content), false);
    assert.equal(harness.finance.repository.list({ ownerId: OWNER }).length, 0);
  }
});

test('Finance owner isolation and client request idempotency preserve one committed row per owner', async (t) => {
  const h = createHarness({
    plans: [planned(rawFinancePlan('早餐14元'))]
  });
  t.after(() => h.close());

  const first = await exchange(h, { clientRequestId: 'same-finance-request' });
  const duplicate = await exchange(h, {
    conversationId: first.prepared.conversation.id,
    clientRequestId: 'same-finance-request'
  });
  await exchange(h, {
    ownerId: OTHER_OWNER,
    clientRequestId: 'same-finance-request'
  });
  const ownerRows = h.finance.repository.list({ ownerId: OWNER });
  const otherOwnerRows = h.finance.repository.list({ ownerId: OTHER_OWNER });

  assert.equal(first.result.content, '已记录');
  assert.equal(duplicate.result.deduplicated, true);
  assert.equal(ownerRows.length, 1);
  assert.equal(otherOwnerRows.length, 1);
  assert.equal(h.finance.repository.get({ ownerId: OWNER, id: otherOwnerRows[0].id }), null);
  assert.equal(h.finance.repository.get({ ownerId: OTHER_OWNER, id: ownerRows[0].id }), null);
  assert.equal(h.provider.calls.length, 0);
});

test('Finance Domain preserves an Access or Quota refusal as its real error category', async (t) => {
  for (const code of ['ACCOUNT_USAGE_LIMIT_REACHED', 'ACCOUNT_REQUEST_RATE_LIMITED']) {
    const h = createHarness({
      plans: [{ ok: false, code }]
    });
    t.after(() => h.close());

    await assert.rejects(
      h.assistantAgent.processUserMessage({
        ownerId: OWNER,
        conversationId: `finance-${code}`,
        sourceMessageId: `message-${code}`,
        clientRequestId: `request-${code}`,
        message: '早餐14元',
        conversationMessages: []
      }),
      { code }
    );
    assert.equal(h.financeHandlerCalls, 0);
    assert.equal(h.provider.calls.length, 0);
    assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 0);
  }
});
