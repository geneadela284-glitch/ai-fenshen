import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { localDateKey } from '../finance/time.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { categoriesForType } from '../finance/constants.js';
import { evaluateFinanceToolPlan } from '../finance/financeToolContract.js';
import { createAssistantSemanticPlanner } from './assistantSemanticPlanner.js';
import { adaptUnifiedPlanToFinance } from './domainPlanAdapters.js';
import { validateProviderPlanCandidate } from './providerPlanCandidateSchema.js';
import { canonicalizeUnifiedProviderPlan } from './unifiedProviderPlanCanonicalizer.js';

const NOW = new Date('2026-07-27T04:00:00.000Z');
const OWNER = 'unified-boundary-owner';
const CONVERSATION = 'unified-boundary-conversation';

function rawFinancePlan({
  direction = 'expense',
  amount,
  category = null,
  date = '2026-07-27'
}) {
  return {
    domain: 'finance',
    intent: `${direction}_record`,
    action: 'create',
    entity: { type: 'transaction', reference: null, relation_to_owner: 'owner' },
    relation_to_owner: 'owner',
    predicate: direction === 'income' ? 'received' : 'spent',
    value: { amount, currency: 'CNY' },
    qualifiers: { category, date },
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: ['predicate', 'value.amount', 'value.currency', 'qualifiers.category'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.95,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function rawOrdinaryPlan() {
  return {
    domain: 'ordinary_chat',
    intent: 'identity_question',
    action: 'respond_to_inquiry',
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
    confidence: 0.95,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function rawMemoryPlan() {
  return {
    domain: 'memory',
    intent: 'state_fact',
    action: 'add',
    entity: { type: 'person', reference: '女儿', relation_to_owner: 'daughter' },
    relation_to_owner: 'daughter',
    predicate: 'birth_date',
    value: '2012-06-08',
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: ['entity', 'relation_to_owner', 'predicate', 'value'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.95,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function rawMemoryQueryWithUnboundPlaceholder() {
  return {
    ...rawMemoryPlan(),
    intent: 'query',
    action: 'retrieve',
    entity: { type: 'person', reference: 'daughter', relation_to_owner: 'child' },
    relation_to_owner: 'child',
    value: 'unknown',
    qualifiers: {},
    explicit_fields: [
      'entity.type',
      'entity.reference',
      'entity.relation_to_owner',
      'predicate'
    ],
    inherited_fields: []
  };
}

function rawAmbiguousPlan() {
  return {
    domain: 'ambiguous',
    intent: 'ambiguous',
    action: 'ambiguous',
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
    ambiguity_reasons: ['target_missing'],
    confidence: 0.3,
    requires_confirmation: true,
    source_spans: [],
    source_message_id: null
  };
}

function rawCalendarDaysUntilPlan() {
  return {
    domain: 'tool',
    intent: 'query',
    action: 'days_until',
    entity: { type: 'person', reference: 'mother', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: '2027-08-17',
    qualifiers: {
      calendar_type: 'lunar',
      month: 7,
      day: 16,
      lunar_leap_month: false
    },
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar',
      target_calendar: 'gregorian',
      target_year_reference: 'next_occurrence',
      occurrence: 'next_occurrence'
    },
    required_evidence: [{
      entity_relation: 'mother',
      predicate: 'birthday',
      required_qualifiers: ['calendar_type', 'month', 'day', 'lunar_leap_month']
    }],
    explicit_fields: ['action'],
    inherited_fields: ['entity', 'predicate', 'qualifiers'],
    ambiguity_reasons: [],
    confidence: 0.95,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function canonicalize(raw, message) {
  const validated = validateProviderPlanCandidate(raw);
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  const canonical = canonicalizeUnifiedProviderPlan(validated.value, {
    ownerId: OWNER,
    conversationId: CONVERSATION,
    trustedContext: null,
    message,
    timezone: 'Asia/Shanghai',
    now: NOW
  });
  assert.equal(canonical.ok, true, `${canonical.code}:${JSON.stringify(canonical.errors || [])}`);
  return canonical.plan;
}

function financeContract(raw, message) {
  const plan = canonicalize(raw, message);
  const adapted = adaptUnifiedPlanToFinance(plan, { message });
  assert.equal(adapted.ok, true, adapted.code);
  return {
    canonical: plan,
    adapted: adapted.plan,
    contract: evaluateFinanceToolPlan(adapted.plan, {
      message,
      timezone: 'Asia/Shanghai',
      now: NOW,
      trustedContext: null,
      ownerId: OWNER
    })
  };
}

test('RED: Provider leaf labels are non-critical Finance categories and never block clear writes', async (t) => {
  const cases = [
    ['今天打车花了18元', 18, '打车'],
    ['上午买菜花了28块', 28, '买菜'],
    ['昨晚加油花了300元', 300, '加油'],
    ['刚刚坐地铁花了6元', 6, '地铁']
  ];
  for (const [message, amount, category] of cases) {
    await t.test(message, () => {
      const result = financeContract(rawFinancePlan({ amount, category }), message);
      assert.equal(result.contract.decision, 'ACCEPT', JSON.stringify(result.contract.errors));
      assert.equal(result.adapted.category, null, 'non-canonical Provider label must become uncategorized');
      assert.equal(result.contract.plan.amount_minor, amount * 100);
      assert.equal(result.contract.plan.type, 'expense');
    });
  }
});

test('RED: canonical, missing, and income categories preserve strict Finance execution', () => {
  const income = rawFinancePlan({
    direction: 'income',
    amount: 5000,
    category: '工资'
  });
  income.entity.relation_to_owner = 'unknown';
  income.relation_to_owner = 'owner';
  const cases = [
    ['今天吃饭花了86元', rawFinancePlan({ amount: 86, category: '餐饮' }), 'expense', 8600, '餐饮'],
    ['今天花了18元', rawFinancePlan({ amount: 18, category: null }), 'expense', 1800, null],
    ['今天收到工资5000元', income, 'income', 500000, '工资']
  ];
  for (const [message, raw, direction, amountMinor, category] of cases) {
    const result = financeContract(raw, message);
    assert.equal(result.contract.decision, 'ACCEPT', `${message}:${JSON.stringify(result.contract.errors)}`);
    assert.equal(result.contract.plan.type, direction);
    assert.equal(result.contract.plan.amount_minor, amountMinor);
    assert.equal(result.adapted.category, category);
  }
});

test('RED: source-grounded relative date outranks a conflicting Provider occurrence expression', () => {
  const message = '昨晚加油花了300元';
  const raw = rawFinancePlan({
    amount: 300,
    category: null,
    date: '2026-07-27'
  });
  raw.qualifiers.relative_day_offset = -1;
  raw.arguments = { occurred_expression: '今天' };
  const result = financeContract(raw, message);
  assert.equal(result.contract.decision, 'ACCEPT', JSON.stringify(result.contract.errors));
  assert.equal(
    localDateKey(new Date(result.contract.plan.occurred_at), 'Asia/Shanghai'),
    '2026-07-26'
  );
});

test('RED: accepted Finance request is database-backed and idempotent by client request id', async (t) => {
  const finance = createFinanceRuntime({
    database: new DatabaseSync(':memory:'),
    applyMigrations: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  t.after(() => finance.close());
  const message = '今天花了18元';
  const result = financeContract(rawFinancePlan({ amount: 18, category: null }), message);
  assert.equal(result.contract.decision, 'ACCEPT', JSON.stringify(result.contract.errors));
  const input = {
    ownerId: OWNER,
    conversationId: CONVERSATION,
    message,
    clientRequestId: 'same-finance-request',
    sourceMessageId: 'source-finance-request',
    plan: result.contract.plan
  };
  const first = await finance.service.processUserMessage(input);
  const second = await finance.service.processUserMessage(input);
  const rows = finance.repository.list({ ownerId: OWNER });
  assert.equal(first.content, '已记录');
  assert.equal(second.content, '已记录');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountMinor, 1800);
  assert.ok(categoriesForType('expense').includes(rows[0].category));
});

test('RED: ordinary chat, Memory, and true ambiguity retain distinct Canonical contracts', () => {
  const ordinary = canonicalize(rawOrdinaryPlan(), '你是谁？');
  assert.equal(ordinary.domain, 'ordinary_chat');
  assert.equal(ordinary.action, 'ordinary_chat');

  const memory = canonicalize(rawMemoryPlan(), '我女儿出生于2012年6月8日');
  assert.equal(memory.domain, 'memory');
  assert.equal(memory.intent, 'create_fact');
  assert.equal(memory.action, 'memory.capture');
  assert.deepEqual(
    Object.fromEntries(['year', 'month', 'day'].map((field) => [field, memory.canonical_value[field]])),
    { year: 2012, month: 6, day: 8 }
  );

  const ambiguous = canonicalize(rawAmbiguousPlan(), '帮我处理一下');
  assert.equal(ambiguous.domain, 'ambiguous');
  assert.equal(ambiguous.intent, 'ambiguous');
  assert.equal(ambiguous.action, 'ambiguous');
  assert.deepEqual(ambiguous.ambiguity_reasons, ['target_missing']);
});

test('RED: unbound Provider placeholder cannot become a Memory fact value', () => {
  const memory = canonicalize(
    rawMemoryQueryWithUnboundPlaceholder(),
    '我女儿什么时候出生？'
  );
  assert.equal(memory.domain, 'memory');
  assert.equal(memory.intent, 'query_fact');
  assert.equal(memory.action, 'memory.query');
  assert.equal(memory.canonical_value, null);
  assert.equal(memory.relation_to_owner, 'daughter');
});

test('RED: Provider-computed Tool result is discarded before deterministic Calendar execution', () => {
  const calendar = canonicalize(
    rawCalendarDaysUntilPlan(),
    '离下一次生日还有多少天'
  );
  assert.equal(calendar.domain, 'tool');
  assert.equal(calendar.action, 'calendar.days_until');
  assert.equal(calendar.tool, 'calendar.convert');
  assert.equal(calendar.canonical_value, null);
  assert.equal(calendar.canonical_arguments.occurrence, 'next_occurrence');
});

test('RED: Provider semantic planning receives server-bound time context without sentence rules', async () => {
  let request;
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run(value) {
        request = value;
        return { ok: true, content: JSON.stringify(rawOrdinaryPlan()) };
      }
    }
  });
  const planned = await planner.plan({
    message: '昨晚加油花了300元',
    sourceMessageId: 'runtime-time-context',
    contextPack: {},
    timezone: 'Asia/Shanghai',
    now: NOW
  });
  assert.equal(planned.ok, true, JSON.stringify(planned.errors || []));
  const payload = JSON.parse(request.messages[1].content);
  assert.deepEqual(payload.context.runtime_context, {
    timezone: 'Asia/Shanghai',
    current_time: '2026-07-27T04:00:00.000Z',
    local_date: '2026-07-27'
  });
});
