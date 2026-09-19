import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAssistantAgentOrchestrator } from './assistantAgentOrchestrator.js';
import { createSemanticFinancePlanner } from '../finance/semanticFinancePlanner.js';
import { createFinanceRuntime } from '../finance/runtime.js';

test('RED: every production message enters one Unified Semantic Planner before a domain adapter', async () => {
  const calls = [];
  const agent = createAssistantAgentOrchestrator({
    semanticPlanner: {
      async plan(input) {
        calls.push(['unified-plan', input.message]);
        return {
          ok: true,
          plan: {
            domain: 'memory',
            intent: 'state_fact',
            action: 'add',
            entity: { type: 'person', reference: '女儿', relation_to_owner: 'daughter' },
            relation_to_owner: 'daughter',
            predicate: 'birth_date',
            value: { year: 2012, month: 6, day: 8 },
            qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
            tool: null,
            arguments: {},
            required_evidence: [],
            explicit_fields: ['entity.relation_to_owner', 'predicate', 'value.year', 'value.month', 'value.day'],
            inherited_fields: [],
            ambiguity_reasons: [],
            confidence: 0.98,
            source_message_id: null
          }
        };
      }
    },
    memoryIntegration: {
      async processSemanticPlan(input, plan) {
        calls.push(['memory-plan', plan.predicate, input.ownerId]);
        return { kind: 'capture', outcome: 'memory_written' };
      },
      async processUserMessage() {
        calls.push(['legacy-memory']);
        return { kind: 'none', outcome: 'ignored' };
      }
    },
    financePlanner: { async plan() { calls.push(['legacy-finance']); return { ok: false }; } },
    assistantToolPlanner: { async plan() { calls.push(['legacy-tool']); return { ok: false }; } }
  });

  const result = await agent.processUserMessage({
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    sourceMessageId: 'message-a',
    clientRequestId: 'request-a',
    message: '我女儿出生于2012年6月8日',
    conversationMessages: []
  });

  assert.equal(result.domain, 'memory');
  assert.equal(result.outcome, 'memory_written');
  assert.deepEqual(calls, [
    ['unified-plan', '我女儿出生于2012年6月8日'],
    ['memory-plan', 'birthday', 'owner-a']
  ]);
});

test('Router policy domain constrains one Finance replan without changing non-Finance routing', async () => {
  const observed = [];
  const agent = createAssistantAgentOrchestrator({
    semanticPlanner: {
      async plan(input) {
        observed.push([
          input.message,
          input.routeDomain,
          input.contextPack?.domain_contract?.required_domain || null
        ]);
        return {
          ok: true,
          plan: {
            domain: 'ordinary_chat', intent: 'ordinary_chat', action: 'ordinary_chat',
            entity: { type: null, reference: null, relation_to_owner: null },
            relation_to_owner: null, predicate: null, value: null, qualifiers: {},
            tool: null, arguments: {}, required_evidence: [], explicit_fields: [],
            inherited_fields: [], ambiguity_reasons: [], confidence: 0.99,
            requires_confirmation: false, source_spans: []
          }
        };
      }
    },
    financeService: {
      isFinanceCandidate(message) { return message === 'finance-signal'; },
      trustedContext() { return null; }
    },
    memoryIntegration: {
      isMemoryCandidate(message) { return message === 'memory-signal'; },
      trustedContext() { return null; }
    }
  });
  const ask = (message) => agent.processUserMessage({
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: `source-${message}`,
    clientRequestId: `request-${message}`, message, conversationMessages: []
  });

  await ask('finance-signal');
  await ask('memory-signal');
  await ask('ordinary-signal');

  assert.deepEqual(observed, [
    ['finance-signal', 'finance', null],
    ['finance-signal', 'finance', 'finance'],
    ['memory-signal', 'memory', null],
    ['ordinary-signal', 'semantic_planner', null]
  ]);
});

test('RED: accepted Unified plans commit trusted context only within the authenticated owner and conversation', async () => {
  const plannerContexts = [];
  const receivedPlans = [];
  const plans = [
    {
      domain: 'memory',
      intent: 'state_fact',
      action: 'add',
      entity: { type: 'person', reference: '家庭成员', relation_to_owner: 'daughter' },
      relation_to_owner: 'daughter',
      predicate: 'birthday',
      value: { month: 6, day: 8 },
      qualifiers: { calendar_type: 'unknown', recurrence: 'yearly' },
      tool: null,
      arguments: {},
      required_evidence: [],
      explicit_fields: ['entity', 'relation_to_owner', 'predicate', 'value'],
      inherited_fields: [],
      ambiguity_reasons: [],
      confidence: 0.98,
      requires_confirmation: false,
      source_spans: []
    },
    {
      domain: 'memory',
      intent: 'memory_query',
      action: 'query',
      entity: { type: null, reference: null, relation_to_owner: null },
      relation_to_owner: null,
      predicate: null,
      value: null,
      qualifiers: {},
      tool: null,
      arguments: {},
      required_evidence: [],
      explicit_fields: [],
      inherited_fields: ['relation_to_owner', 'predicate'],
      ambiguity_reasons: [],
      confidence: 0.95,
      requires_confirmation: false,
      source_spans: []
    }
  ];
  let planIndex = 0;
  const agent = createAssistantAgentOrchestrator({
    semanticPlanner: {
      async plan(input) {
        plannerContexts.push(input.trustedContext);
        return { ok: true, plan: structuredClone(plans[Math.min(planIndex++, plans.length - 1)]) };
      }
    },
    memoryIntegration: {
      async processSemanticPlan(_input, plan) {
        receivedPlans.push(plan);
        return plan.intent === 'memory_candidate'
          ? { kind: 'capture', outcome: 'memory_written' }
          : { kind: 'query', outcome: 'answered', content: '可信查询结果' };
      }
    }
  });
  const ask = (ownerId, conversationId, message, sourceMessageId) => agent.processUserMessage({
    ownerId,
    conversationId,
    sourceMessageId,
    clientRequestId: `request-${sourceMessageId}`,
    message,
    conversationMessages: []
  });

  await ask('owner-a', 'conversation-a', '一条明确家庭事实', 'source-1');
  await ask('owner-a', 'conversation-a', '继续查询该事实', 'source-2');

  assert.equal(plannerContexts[0].active_entity, undefined);
  assert.equal(plannerContexts[1].active_entity.relation_to_owner, 'daughter');
  assert.equal(plannerContexts[1].active_predicate, 'birthday');
  assert.equal(receivedPlans[1].subject.relation_to_owner, 'daughter');
  assert.equal(receivedPlans[1].predicate, 'birthday');

  planIndex = 1;
  await ask('owner-b', 'conversation-a', '继续查询该事实', 'source-3');
  assert.equal(plannerContexts[2].active_entity, undefined);
});

function assistantToolPlan(message = '今年对应公历哪一天？') {
  return {
    domain: 'tool', action: 'convert_calendar_date', tool: 'calendar.convert',
    arguments: { source_calendar: 'lunar', target_calendar: 'gregorian', target_year_reference: 'this_year', occurrence: 'specified_year' },
    required_evidence: [{ entity_relation: 'mother', predicate: 'birthday', required_qualifiers: ['calendar_type', 'month', 'day'] }],
    inherited_context: { previous_entity: 'mother', previous_predicate: 'birthday', previous_tool: null },
    confidence: 0.99, ambiguity: [], requires_confirmation: false, source_message_id: message
  };
}

test('Assistant Agent dispatches a generic audited Tool Plan before Memory response fallback', async () => {
  const calls = [];
  const evidenceBundle = { owner_id: 'owner-a', evidence: [{ evidence_id: 'evidence-1', predicate: 'birthday' }] };
  const agent = createAssistantAgentOrchestrator({
    assistantToolPlanner: { async plan() { return { ok: true, plan: assistantToolPlan() }; } },
    evidenceBinder: async (plan, context) => {
      calls.push(['bind', context.ownerId, context.sourceMessageId]);
      return { ok: true, plan: { ...plan, source_message_id: context.sourceMessageId }, evidenceBundle };
    },
    toolRegistry: {
      async invoke(id, input) {
        calls.push(['tool', id, input.ownerId]);
        return { decision: 'ACCEPT', result: {
          ok: true, tool: id, action: 'convert_calendar_date', evidence_ids: ['evidence-1'],
          data: { gregorian_date: '2026-08-28', target_year: 2026 },
          safe_user_message: '你妈妈是农历七月十六生日，2026年对应的公历日期是8月28日。'
        } };
      }
    },
    memoryIntegration: { async processUserMessage() {
      calls.push(['memory']);
      return { kind: 'query', semanticContext: {
        intent: 'memory_query', relation_to_owner: 'mother', predicate: 'birthday',
        qualifiers: { calendar_type: 'gregorian', temporal_scope: 'this_year' }
      } };
    } }
  });
  const result = await agent.processUserMessage({
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: 'source-a',
    message: '今年对应公历哪一天？', conversationMessages: []
  });
  assert.equal(result.domain, 'tool');
  assert.equal(result.handled, true);
  assert.match(result.content, /2026年.*8月28日/);
  assert.deepEqual(calls, [['memory'], ['bind', 'owner-a', 'source-a'], ['tool', 'calendar.convert', 'owner-a']]);
});

test('Assistant Agent completes Memory capture before considering any Tool Plan', async () => {
  let toolPlans = 0;
  const agent = createAssistantAgentOrchestrator({
    assistantToolPlanner: { async plan() { toolPlans += 1; return { ok: true, plan: assistantToolPlan() }; } },
    memoryIntegration: { async processUserMessage() { return { kind: 'capture', outcome: 'memory_written' }; } }
  });
  const result = await agent.processUserMessage({
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: 'source-a',
    message: '一条个人事实', conversationMessages: []
  });
  assert.equal(result.domain, 'memory');
  assert.equal(result.outcome, 'memory_written');
  assert.equal(toolPlans, 0);
});

test('Assistant Agent does not invoke Calendar without trusted Memory Evidence', async () => {
  let executions = 0;
  const agent = createAssistantAgentOrchestrator({
    assistantToolPlanner: { async plan() { return { ok: true, plan: assistantToolPlan() }; } },
    evidenceBinder: async () => ({ ok: false, code: 'TOOL_EVIDENCE_NOT_FOUND' }),
    toolRegistry: { async invoke() { executions += 1; } }
  });
  const result = await agent.processUserMessage({
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: 'source-a',
    message: '今年对应公历哪一天？', conversationMessages: []
  });
  assert.equal(result.content, '我目前还不知道。');
  assert.equal(executions, 0);
});

test('Assistant Agent leaves an invalid hallucinated Tool Plan on the established Memory path', async () => {
  let memoryCalls = 0;
  const agent = createAssistantAgentOrchestrator({
    assistantToolPlanner: { async plan() { return { ok: false, code: 'ASSISTANT_TOOL_PLAN_INVALID' }; } },
    toolRegistry: { validatePlan() { return { ok: false, errors: ['invalid'] }; } },
    memoryIntegration: { async processUserMessage() { memoryCalls += 1; return { kind: 'query', safeAnswer: { type: 'fact' } }; } }
  });
  const result = await agent.processUserMessage({
    ownerId: 'owner-a', conversationId: 'conversation-a', sourceMessageId: 'source-a',
    message: '我妈什么时候生日？', conversationMessages: []
  });
  assert.equal(result.domain, 'memory');
  assert.equal(memoryCalls, 1);
});

test('Assistant Agent keeps tool continuation owner-and-conversation scoped', async () => {
  const contexts = [];
  const planner = {
    async plan({ contextPack }) {
      contexts.push(contextPack.tool_context || null);
      return { ok: true, plan: assistantToolPlan() };
    }
  };
  const evidenceBundle = { owner_id: 'owner-a', evidence: [{ evidence_id: 'evidence-1', predicate: 'birthday' }] };
  const registry = { async invoke() { return { decision: 'ACCEPT', result: {
    ok: true, tool: 'calendar.convert', action: 'convert_calendar_date', evidence_ids: ['evidence-1'],
    data: { gregorian_date: '2026-08-28', target_year: 2026 }, safe_user_message: '已换算为2026年8月28日。'
  } }; } };
  const agent = createAssistantAgentOrchestrator({
    assistantToolPlanner: planner, toolRegistry: registry,
    evidenceBinder: async (value) => ({ ok: true, plan: value, evidenceBundle })
  });
  const ask = (ownerId, conversationId) => agent.processUserMessage({
    ownerId, conversationId, sourceMessageId: `${ownerId}-${conversationId}`, message: '明年呢？', conversationMessages: []
  });
  await ask('owner-a', 'conversation-a');
  await ask('owner-a', 'conversation-a');
  await ask('owner-a', 'conversation-b');
  await ask('owner-b', 'conversation-a');
  assert.equal(contexts[0], null);
  assert.equal(contexts[1].previous_tool, 'calendar.convert');
  assert.equal(contexts[2], null);
  assert.equal(contexts[3], null);
});

test('Assistant Agent is the single dispatcher for Finance and delegates non-finance to Memory', async () => {
  const calls = [];
  let receivedContext;
  const financePlanner = {
    async plan({ message, contextPack }) {
      receivedContext = contextPack;
      return message.includes('收支')
        ? { ok: true, plan: {
          domain: 'finance', action: 'query', metrics: ['income', 'expense'],
          period_type: 'this_month', period_expression: '本月', category: null,
          counterparty: null, keyword: null,
          transaction_candidate: { direction: null, amount_text: null, occurred_expression: null },
          entry_reference: null, changes: {},
          inherited_context: { previous_action: null, previous_metrics: [], previous_period_type: null },
          confidence: 0.99, source_spans: [{ text: message, start: 0, end: message.length }],
          requires_confirmation: false
        } }
        : { ok: true, plan: { domain: 'ordinary_chat', action: 'ordinary_chat' } };
    }
  };
  const financeService = {
    trustedContext: () => ({ previous_action: 'query', previous_metrics: ['expense'], previous_period_type: 'this_month' }),
    async processUserMessage(input) { calls.push(['finance', input.plan]); return { handled: true, action: 'query', content: '确定性财务结果' }; }
  };
  const memoryIntegration = {
    async processUserMessage(input) { calls.push(['memory', input.message]); return { kind: 'none', outcome: 'ignored' }; },
    isMemoryQuery: () => false
  };
  const agent = createAssistantAgentOrchestrator({ financePlanner, financeService, memoryIntegration });
  const finance = await agent.processUserMessage({ ownerId: 'owner-a', conversationId: 'conversation-a', message: '本月收支情况', conversationMessages: [] });
  assert.equal(finance.domain, 'finance');
  assert.equal(finance.content, '确定性财务结果');
  assert.deepEqual(receivedContext.finance_context, {
    previous_action: 'query', previous_metrics: ['expense'], previous_period_type: 'this_month'
  });
  assert.equal(calls.filter(([domain]) => domain === 'memory').length, 0);
  const ordinary = await agent.processUserMessage({ ownerId: 'owner-a', conversationId: 'conversation-a', message: '你好', conversationMessages: [] });
  assert.equal(ordinary.domain, 'memory');
  assert.equal(calls.filter(([domain]) => domain === 'memory').length, 1);
});

function providerCreateOutput(overrides = {}) {
  const message = '今天早餐花了30元';
  return JSON.stringify({
    domain: 'finance', action: 'create', metrics: ['expense'],
    period_type: 'today', period_expression: '今天', category: '餐饮',
    counterparty: null, keyword: '早餐',
    transaction_candidate: { direction: 'expense', amount_text: '30元', occurred_expression: '今天' },
    entry_reference: null, changes: null,
    inherited_context: { previous_action: null, previous_metrics: null, previous_period_type: null },
    confidence: 0.95,
    source_spans: [{ text: message, start: 0, end: message.length }],
    requires_confirmation: false,
    ...overrides
  });
}

function createHotfixHarness(providerOutput = providerCreateOutput()) {
  const finance = createFinanceRuntime({
    database: new DatabaseSync(':memory:'), applyMigrations: true, timezone: 'Asia/Shanghai',
    clock: () => new Date('2026-07-22T04:00:00.000Z')
  });
  const planner = createSemanticFinancePlanner({ aiService: {
    async run() { return { ok: true, content: providerOutput }; }
  } });
  const agent = createAssistantAgentOrchestrator({ financePlanner: planner, financeService: finance.service,
    timezone: 'Asia/Shanghai', clock: finance.clock });
  return { finance, agent };
}

function providerQueryPlan(message, { metrics = ['income', 'expense'], periodType = null, periodExpression = null } = {}) {
  return {
    domain: 'finance', action: 'query', metrics,
    period_type: periodType, period_expression: periodExpression,
    category: null, counterparty: null, keyword: null,
    transaction_candidate: {}, entry_reference: null, changes: {},
    inherited_context: { previous_action: 'query', previous_metrics: [], previous_period_type: null },
    confidence: 0.99, source_spans: [{ text: message, start: 0, end: message.length }],
    requires_confirmation: false
  };
}

test('Finance continuation gives current explicit period precedence and isolates inherited context', async (t) => {
  const finance = createFinanceRuntime({
    database: new DatabaseSync(':memory:'), applyMigrations: true, timezone: 'Asia/Shanghai',
    clock: () => new Date('2026-07-22T04:00:00.000Z')
  });
  t.after(() => finance.close());
  const plans = new Map([
    ['这周收入和支出分别是多少？', providerQueryPlan('这周收入和支出分别是多少？', { periodType: 'this_week', periodExpression: '这周' })],
    ['那上周呢？', providerQueryPlan('那上周呢？', { periodType: 'last_week', periodExpression: '上周' })],
    // Deliberately stale Provider period: the authenticated current message is authoritative.
    ['上个月呢？', providerQueryPlan('上个月呢？', { periodType: 'last_week', periodExpression: '上周' })],
    ['收入呢？', providerQueryPlan('收入呢？', { metrics: ['income'] })],
    ['这个月呢？', providerQueryPlan('这个月呢？', { metrics: ['income'], periodType: null })],
    ['上个月收入和支出分别是多少？', providerQueryPlan('上个月收入和支出分别是多少？')]
  ]);
  const agent = createAssistantAgentOrchestrator({
    financePlanner: { async plan({ message }) { return { ok: true, plan: structuredClone(plans.get(message)) }; } },
    financeService: finance.service, timezone: 'Asia/Shanghai', clock: finance.clock
  });
  const ask = (message, conversationId = 'conversation-a', ownerId = 'owner-a') => agent.processUserMessage({
    ownerId, conversationId, message, clientRequestId: `${ownerId}-${conversationId}-${message}`,
    sourceMessageId: `source-${ownerId}-${conversationId}-${message}`, conversationMessages: []
  });

  assert.equal((await ask('这周收入和支出分别是多少？')).plan.period_type, 'this_week');
  assert.equal((await ask('那上周呢？')).plan.period_type, 'last_week');
  const lastMonth = await ask('上个月呢？');
  assert.equal(lastMonth.plan.period_type, 'last_month');
  assert.equal(lastMonth.plan.label, '上月');
  assert.deepEqual(lastMonth.plan.metrics, ['income', 'expense']);
  const income = await ask('收入呢？');
  assert.equal(income.plan.period_type, 'last_month');
  assert.deepEqual(income.plan.metrics, ['income']);
  const thisMonth = await ask('这个月呢？');
  assert.equal(thisMonth.plan.period_type, 'this_month');
  assert.deepEqual(thisMonth.plan.metrics, ['income']);

  const direct = await ask('上个月收入和支出分别是多少？', 'new-conversation');
  assert.equal(direct.plan.period_type, 'last_month');
  assert.deepEqual(direct.plan.metrics, ['income', 'expense']);
  assert.equal((await ask('收入呢？', 'unrelated-conversation')).action, 'clarify');
  assert.equal((await ask('收入呢？', 'conversation-a', 'owner-b')).action, 'clarify');
});

test('RED: canonicalized Provider Create Plan reaches Contract and Repository exactly once after SQLite commit', async (t) => {
  const { finance, agent } = createHotfixHarness();
  t.after(() => finance.close());
  let repositoryCalls = 0;
  const create = finance.repository.create.bind(finance.repository);
  finance.repository.create = (input) => { repositoryCalls += 1; return create(input); };

  const result = await agent.processUserMessage({
    ownerId: 'isolated-owner', conversationId: 'isolated-conversation', message: '今天早餐花了30元',
    clientRequestId: 'isolated-request', sourceMessageId: 'isolated-message', conversationMessages: []
  });
  const entries = finance.repository.list({ ownerId: 'isolated-owner' });
  assert.equal(result.content, '已记录');
  assert.equal(repositoryCalls, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amountMinor, 3000);
});

test('RED: canonicalized Provider Create Plan never acknowledges a Repository failure', async (t) => {
  const { finance, agent } = createHotfixHarness();
  t.after(() => finance.close());
  finance.repository.create = () => { throw new Error('isolated commit failure'); };
  const result = await agent.processUserMessage({
    ownerId: 'isolated-owner', conversationId: 'isolated-conversation', message: '今天早餐花了30元',
    clientRequestId: 'isolated-failure', sourceMessageId: 'isolated-failure-message', conversationMessages: []
  });
  assert.equal(result.content, '这笔账暂时没有记录成功，请重试。');
  assert.doesNotMatch(result.content, /已记录/);
  assert.equal(finance.repository.list({ ownerId: 'isolated-owner' }).length, 0);
});

test('RED: empty Create transaction candidate is rejected before Repository and never acknowledged', async (t) => {
  const { finance, agent } = createHotfixHarness(providerCreateOutput({ transaction_candidate: null }));
  t.after(() => finance.close());
  let repositoryCalls = 0;
  finance.repository.create = () => { repositoryCalls += 1; throw new Error('must not run'); };
  const result = await agent.processUserMessage({
    ownerId: 'isolated-owner', conversationId: 'isolated-conversation', message: '今天早餐花了一点钱',
    clientRequestId: 'empty-candidate', sourceMessageId: 'empty-candidate-message', conversationMessages: []
  });
  assert.equal(repositoryCalls, 0);
  assert.doesNotMatch(result.content, /已记录/);
});

test('RED: complete Create ignores Provider confirmation advice and commits exactly once', async (t) => {
  const { finance, agent } = createHotfixHarness(providerCreateOutput({ requires_confirmation: true }));
  t.after(() => finance.close());
  let repositoryCalls = 0;
  const create = finance.repository.create.bind(finance.repository);
  finance.repository.create = (input) => { repositoryCalls += 1; return create(input); };
  const result = await agent.processUserMessage({
    ownerId: 'isolated-owner', conversationId: 'isolated-conversation', message: '今天早餐花了30元',
    clientRequestId: 'confirmation-advice', sourceMessageId: 'confirmation-advice-message', conversationMessages: []
  });
  assert.equal(result.content, '已记录');
  assert.equal(repositoryCalls, 1);
  assert.equal(finance.repository.list({ ownerId: 'isolated-owner' }).length, 1);
});

test('RED: Contract ASK prevents Repository calls and false success acknowledgement', async (t) => {
  const { finance, agent } = createHotfixHarness(providerCreateOutput({
    transaction_candidate: { direction: 'expense', amount_text: null, occurred_expression: '今天' },
    requires_confirmation: false
  }));
  t.after(() => finance.close());
  let repositoryCalls = 0;
  finance.repository.create = () => { repositoryCalls += 1; throw new Error('must not run'); };
  const result = await agent.processUserMessage({
    ownerId: 'isolated-owner', conversationId: 'isolated-conversation', message: '今天早餐花了一点钱',
    clientRequestId: 'missing-amount', sourceMessageId: 'missing-amount-message', conversationMessages: []
  });
  assert.equal(result.action, 'clarify');
  assert.equal(repositoryCalls, 0);
  assert.doesNotMatch(result.content, /已记录/);
});
