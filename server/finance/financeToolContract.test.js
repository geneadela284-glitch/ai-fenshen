import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateFinanceToolPlan } from './financeToolContract.js';

const NOW = new Date('2026-07-22T04:00:00.000Z');

function plan(overrides = {}) {
  const message = overrides.message || '本月收入和支出分别是多少';
  return {
    domain: 'finance',
    action: 'query',
    metrics: ['income', 'expense'],
    period_type: 'this_month',
    period_expression: '本月',
    category: null,
    counterparty: null,
    keyword: null,
    transaction_candidate: { direction: null, amount_text: null, occurred_expression: null },
    entry_reference: null,
    changes: {},
    inherited_context: { previous_action: null, previous_metrics: [], previous_period_type: null },
    confidence: 0.99,
    source_spans: [{ text: message, start: 0, end: message.length }],
    requires_confirmation: false,
    ...overrides.value
  };
}

function createPlan(overrides = {}) {
  const message = overrides.message || '今天早餐花了30元';
  return plan({ message, value: {
    action: 'create', metrics: ['expense'], period_type: 'today', period_expression: '今天',
    category: '餐饮', keyword: '早餐',
    transaction_candidate: { direction: 'expense', amount_text: '30元', occurred_expression: '今天' },
    source_spans: [{ text: message, start: 0, end: message.length }],
    ...overrides.value
  } });
}

test('Finance Contract accepts ownerless multi-metric plans and resolves time deterministically', () => {
  const currentMonth = evaluateFinanceToolPlan(plan(), { message: '本月收入和支出分别是多少', timezone: 'Asia/Shanghai', now: NOW });
  assert.equal(currentMonth.decision, 'ACCEPT');
  assert.deepEqual(currentMonth.plan.metrics, ['income', 'expense']);
  assert.equal(currentMonth.plan.start_at, '2026-06-30T16:00:00.000Z');
  assert.equal(currentMonth.plan.end_at, '2026-07-31T16:00:00.000Z');
  assert.equal(currentMonth.plan.owner_id, undefined);

  const week = evaluateFinanceToolPlan(plan({ message: '本周收支情况', value: {
    period_type: 'this_week', period_expression: '本周',
    source_spans: [{ text: '本周收支情况', start: 0, end: 6 }]
  } }), { message: '本周收支情况', timezone: 'Asia/Shanghai', now: NOW });
  const rolling = evaluateFinanceToolPlan(plan({ message: '最近7天收支情况', value: {
    period_type: 'last_7_days', period_expression: '最近7天',
    source_spans: [{ text: '最近7天收支情况', start: 0, end: 9 }]
  } }), { message: '最近7天收支情况', timezone: 'Asia/Shanghai', now: NOW });
  assert.notEqual(week.plan.start_at, rolling.plan.start_at);
  assert.equal(week.plan.period_type, 'this_week');
  assert.equal(rolling.plan.period_type, 'last_7_days');
});

test('Finance Contract rejects model owner fields and inherits only trusted period or metrics', () => {
  const ownerInjection = evaluateFinanceToolPlan({ ...plan(), owner_id: 'model-owner' }, {
    message: '本月收入和支出分别是多少', timezone: 'Asia/Shanghai', now: NOW
  });
  assert.equal(ownerInjection.decision, 'REJECT');

  const followUpMessage = '收入呢';
  const followUp = evaluateFinanceToolPlan(plan({ message: followUpMessage, value: {
    metrics: ['income'], period_type: null, period_expression: null,
    inherited_context: { previous_action: 'query', previous_metrics: ['expense'], previous_period_type: 'this_month' },
    source_spans: [{ text: followUpMessage, start: 0, end: followUpMessage.length }]
  } }), {
    message: followUpMessage, timezone: 'Asia/Shanghai', now: NOW,
    trustedContext: { previous_action: 'query', previous_metrics: ['expense'], previous_period_type: 'this_month' }
  });
  assert.equal(followUp.decision, 'ACCEPT');
  assert.deepEqual(followUp.plan.metrics, ['income']);
  assert.equal(followUp.plan.period_type, 'this_month');
});

test('RED: current-message explicit period overrides missing or stale Provider and continuation periods', () => {
  const trustedContext = {
    previous_action: 'query', previous_metrics: ['income', 'expense'], previous_period_type: 'last_week'
  };
  for (const providerPeriod of [null, 'last_week']) {
    const message = '上个月呢？';
    const result = evaluateFinanceToolPlan(plan({ message, value: {
      period_type: providerPeriod,
      period_expression: providerPeriod === null ? null : '上周',
      inherited_context: trustedContext,
      source_spans: [{ text: message, start: 0, end: message.length }]
    } }), { message, timezone: 'Asia/Shanghai', now: NOW, trustedContext });

    assert.equal(result.decision, 'ACCEPT', `provider period ${providerPeriod}`);
    assert.equal(result.plan.period_type, 'last_month', `provider period ${providerPeriod}`);
    assert.equal(result.plan.label, '上月', `provider period ${providerPeriod}`);
    assert.equal(result.plan.start_at, '2026-05-31T16:00:00.000Z');
    assert.equal(result.plan.end_at, '2026-06-30T16:00:00.000Z');
  }
});

test('RED: continuation inherits period only when the current message has no explicit period', () => {
  const trustedContext = {
    previous_action: 'query', previous_metrics: ['expense'], previous_period_type: 'this_month'
  };
  const message = '收入呢';
  const result = evaluateFinanceToolPlan(plan({ message, value: {
    metrics: ['income'], period_type: null, period_expression: null,
    inherited_context: trustedContext,
    source_spans: [{ text: message, start: 0, end: message.length }]
  } }), { message, timezone: 'Asia/Shanghai', now: NOW, trustedContext });

  assert.equal(result.decision, 'ACCEPT');
  assert.deepEqual(result.plan.metrics, ['income']);
  assert.equal(result.plan.period_type, 'this_month');
  assert.equal(result.plan.label, '本月');
});

test('RED: deterministic Create completeness overrides Provider confirmation advice', () => {
  for (const requiresConfirmation of [false, true]) {
    const result = evaluateFinanceToolPlan(createPlan({ value: { requires_confirmation: requiresConfirmation } }), {
      message: '今天早餐花了30元', timezone: 'Asia/Shanghai', now: NOW, ownerId: 'session-owner'
    });
    assert.equal(result.decision, 'ACCEPT');
    assert.equal(result.plan.type, 'expense');
    assert.equal(result.plan.amount_minor, 3000);
    assert.equal(result.plan.currency, 'CNY');
    assert.equal(result.plan.owner_id, undefined);
  }
});

test('RED: deterministic Create Contract asks only for missing or conflicting critical fields', () => {
  const cases = [
    ['missing amount', '今天早餐花了一点钱', createPlan({ message: '今天早餐花了一点钱', value: {
      transaction_candidate: { direction: 'expense', amount_text: null, occurred_expression: '今天' }
    } }), 'create_amount_required'],
    ['missing direction', '今天记账30元', createPlan({ message: '今天记账30元', value: {
      transaction_candidate: { direction: null, amount_text: '30元', occurred_expression: '今天' }
    } }), 'create_direction_required'],
    ['direction conflict without explicit user direction', '今天记账30元', createPlan({ message: '今天记账30元', value: {
      metrics: ['income'],
      transaction_candidate: { direction: 'expense', amount_text: '30元', occurred_expression: '今天' }
    } }), 'create_critical_field_conflict'],
    ['ambiguous date', '今天早餐花了30元', createPlan({ value: {
      transaction_candidate: { direction: 'expense', amount_text: '30元', occurred_expression: '本月' }
    } }), 'create_date_ambiguous']
  ];
  for (const [name, message, value, reasonCode] of cases) {
    const result = evaluateFinanceToolPlan(value, {
      message, timezone: 'Asia/Shanghai', now: NOW, ownerId: 'session-owner'
    });
    assert.equal(result.decision, 'ASK', name);
    assert.equal(result.reasonCode, reasonCode, name);
  }
});

test('RED: Create date contract defaults absent dates and rejects only invalid or conflicting date expressions', () => {
  const cases = [
    ['早餐花了30元', '早餐', 'ACCEPT', null, '2026-07-22'],
    ['今天早餐花了30元', '今天早餐', 'ACCEPT', null, '2026-07-22'],
    ['昨天早餐花了30元', '昨天早餐', 'ACCEPT', null, '2026-07-21'],
    ['7月20日早餐花了30元', '7月20日早餐', 'ACCEPT', null, '2026-07-20'],
    ['2月30日早餐花了30元', '2月30日早餐', 'ASK', 'create_date_ambiguous', null],
    ['昨天和今天早餐花了30元', '昨天和今天早餐', 'ASK', 'create_date_ambiguous', null]
  ];

  for (const [message, occurredExpression, decision, reasonCode, localDate] of cases) {
    const result = evaluateFinanceToolPlan(createPlan({ message, value: {
      transaction_candidate: { direction: 'expense', amount_text: '30元', occurred_expression: occurredExpression },
      source_spans: [{ text: message, start: 0, end: message.length }]
    } }), { message, timezone: 'Asia/Shanghai', now: NOW, ownerId: 'session-owner' });

    assert.equal(result.decision, decision, message);
    if (reasonCode) assert.equal(result.reasonCode, reasonCode, message);
    if (localDate) {
      const actual = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(result.plan.occurred_at));
      assert.equal(actual, localDate, message);
    }
  }
});

test('RED: unknown category is non-critical and authenticated Session owner remains server-side', () => {
  const result = evaluateFinanceToolPlan(createPlan({ value: {
    category: null,
    requires_confirmation: true
  } }), {
    message: '今天早餐花了30元', timezone: 'Asia/Shanghai', now: NOW, ownerId: 'session-owner'
  });
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.plan.category, null);
  assert.equal(result.plan.owner_id, undefined);

  const missingSession = evaluateFinanceToolPlan(createPlan(), {
    message: '今天早餐花了30元', timezone: 'Asia/Shanghai', now: NOW
  });
  assert.equal(missingSession.decision, 'REJECT');
  assert.deepEqual(missingSession.errors, ['authenticated_owner_required']);
});
