import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticFinancePlanner } from './semanticFinancePlanner.js';
import { evaluateFinanceToolPlan, validateSemanticFinancePlan } from './financeToolContract.js';

function output(message, overrides = {}) {
  return JSON.stringify({
    domain: 'finance', action: 'query', metrics: ['income', 'expense'],
    period_type: 'this_month', period_expression: '本月', category: null,
    counterparty: null, keyword: null,
    transaction_candidate: { direction: null, amount_text: null, occurred_expression: null },
    entry_reference: null, changes: {},
    inherited_context: { previous_action: null, previous_metrics: [], previous_period_type: null },
    confidence: 0.99,
    source_spans: [{ text: message, start: 0, end: message.length }],
    requires_confirmation: false,
    ...overrides
  });
}

function providerCreatePlan(overrides = {}) {
  const message = '今天早餐花了30元';
  return {
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
  };
}

function providerQueryPlan(overrides = {}) {
  const message = '今天花了多少钱';
  return {
    domain: 'finance', action: 'query', metrics: ['expense'],
    period_type: 'today', period_expression: '今天', category: null,
    counterparty: null, keyword: null, transaction_candidate: null,
    entry_reference: null, changes: null,
    inherited_context: { previous_action: null, previous_metrics: null, previous_period_type: null },
    confidence: 0.95,
    source_spans: [{ text: message, start: 0, end: message.length }],
    requires_confirmation: false,
    ...overrides
  };
}

async function planned(value, message = '今天早餐花了30元') {
  return createSemanticFinancePlanner({ aiService: {
    async run() { return { ok: true, content: JSON.stringify(value) }; }
  } }).plan({ message });
}

test('Semantic Finance Planner returns a strict ownerless multi-metric plan with context', async () => {
  const message = '本月收入和支出分别是多少';
  const calls = [];
  const planner = createSemanticFinancePlanner({ aiService: {
    async run(request) { calls.push(request); return { ok: true, content: output(message) }; }
  } });
  const result = await planner.plan({ message, contextPack: { recent_messages: [{ role: 'user', content: '本月支出多少' }] } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.metrics, ['income', 'expense']);
  assert.equal(result.plan.owner_id, undefined);
  assert.match(calls[0].messages[1].content, /recent_messages/);
});

test('Semantic Finance Planner retries invalid structured output once and rejects owner injection', async () => {
  const message = '昨天收入和支出分别是多少';
  let attempts = 0;
  const planner = createSemanticFinancePlanner({ aiService: {
    async run() {
      attempts += 1;
      return attempts === 1
        ? { ok: true, content: '{bad json' }
        : { ok: true, content: output(message, { owner_id: 'model-owner' }) };
    }
  } });
  const result = await planner.plan({ message });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SEMANTIC_FINANCE_PLAN_INVALID');
  assert.equal(attempts, 2);
});

test('RED: Planner canonicalizes only nullable empty Finance Plan containers before Schema validation', async () => {
  const changesOnly = await planned(providerCreatePlan({
    inherited_context: { previous_action: null, previous_metrics: [], previous_period_type: null }
  }));
  assert.equal(changesOnly.ok, true);
  assert.deepEqual(changesOnly.plan.changes, {});

  const metricsOnly = await planned(providerCreatePlan({ changes: {} }));
  assert.equal(metricsOnly.ok, true);
  assert.deepEqual(metricsOnly.plan.inherited_context.previous_metrics, []);

  const both = await planned(providerCreatePlan());
  assert.equal(both.ok, true);
  assert.deepEqual(both.plan.changes, {});
  assert.deepEqual(both.plan.inherited_context.previous_metrics, []);
  assert.equal(validateSemanticFinancePlan(both.plan, { message: '今天早餐花了30元' }).ok, true);
  assert.equal(evaluateFinanceToolPlan(both.plan, {
    message: '今天早餐花了30元', timezone: 'Asia/Shanghai', now: new Date('2026-07-22T04:00:00.000Z'), ownerId: 'session-owner'
  }).decision, 'ACCEPT');
});

test('RED: Planner preserves non-empty containers and rejects invalid types or missing required fields', async () => {
  const nonEmpty = await planned(providerCreatePlan({
    changes: { category: '餐饮' },
    inherited_context: { previous_action: 'query', previous_metrics: ['expense'], previous_period_type: 'today' }
  }));
  assert.equal(nonEmpty.ok, true);
  assert.deepEqual(nonEmpty.plan.changes, { category: '餐饮' });
  assert.deepEqual(nonEmpty.plan.inherited_context.previous_metrics, ['expense']);

  for (const changes of ['invalid', 1, true]) {
    const result = await planned(providerCreatePlan({
      changes, inherited_context: { previous_action: null, previous_metrics: [], previous_period_type: null }
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SEMANTIC_FINANCE_PLAN_INVALID');
  }
  for (const previousMetrics of ['invalid', 1, true]) {
    const result = await planned(providerCreatePlan({
      changes: {}, inherited_context: { previous_action: null, previous_metrics: previousMetrics, previous_period_type: null }
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SEMANTIC_FINANCE_PLAN_INVALID');
  }

  const missing = providerCreatePlan();
  delete missing.changes;
  const missingResult = await planned(missing);
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.errors.join(','), /plan\.changes:required/);
});

test('RED: Query null transaction candidate and all audited empty containers canonicalize before Schema and Contract', async () => {
  const message = '今天花了多少钱';
  const result = await planned(providerQueryPlan({ inherited_context: null }), message);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.transaction_candidate, {});
  assert.deepEqual(result.plan.changes, {});
  assert.deepEqual(result.plan.inherited_context, {
    previous_action: null, previous_metrics: [], previous_period_type: null
  });
  assert.equal(validateSemanticFinancePlan(result.plan, { message }).ok, true);
  assert.equal(evaluateFinanceToolPlan(result.plan, {
    message, timezone: 'Asia/Shanghai', now: new Date('2026-07-22T04:00:00.000Z')
  }).decision, 'ACCEPT');

  const createWithoutMetrics = await planned(providerCreatePlan({ metrics: null }));
  assert.equal(createWithoutMetrics.ok, true);
  assert.deepEqual(createWithoutMetrics.plan.metrics, []);
});

test('Create empty transaction candidate reaches Contract and asks before Repository', async () => {
  const message = '今天早餐花了30元';
  const result = await planned(providerCreatePlan({ transaction_candidate: null }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.transaction_candidate, {});
  assert.equal(validateSemanticFinancePlan(result.plan, { message }).ok, true);
  const contract = evaluateFinanceToolPlan(result.plan, {
    message, timezone: 'Asia/Shanghai', now: new Date('2026-07-22T04:00:00.000Z'), ownerId: 'session-owner'
  });
  assert.equal(contract.decision, 'ASK');
  assert.equal(contract.reasonCode, 'create_direction_required');
});

test('RED: invalid transaction candidate scalar types remain rejected', async () => {
  for (const transactionCandidate of ['invalid', 1, true]) {
    const result = await planned(providerCreatePlan({ transaction_candidate: transactionCandidate }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SEMANTIC_FINANCE_PLAN_INVALID');
    assert.match(result.errors.join(','), /transaction_candidate:invalid_type/);
  }
});

test('RED: Finance Evidence Binder replaces missing, null, or mismatched Provider spans with canonical message evidence', async () => {
  const message = '今天早餐花了30元';
  const variants = [
    { source_spans: [{ text: '早餐花了30元', start: 0, end: 7 }], expectedAudit: 'source_span_mismatch' },
    { source_spans: null, expectedAudit: 'source_spans_missing' },
    { expectedAudit: 'source_spans_missing', removeSpans: true }
  ];

  for (const variant of variants) {
    const value = providerCreatePlan(variant.source_spans === undefined ? {} : { source_spans: variant.source_spans });
    if (variant.removeSpans) delete value.source_spans;
    const result = await planned(value, message);
    assert.equal(result.ok, true, JSON.stringify(variant));
    assert.deepEqual(result.plan.source_spans, [{ text: message, start: 0, end: message.length }]);
    assert.ok(result.evidenceAudit.includes(variant.expectedAudit));
  }
});

test('RED: Finance Evidence Binder rejects a Provider amount that has no equivalent amount in the original message', async () => {
  const result = await planned(providerCreatePlan({
    transaction_candidate: { direction: 'expense', amount_text: '40元', occurred_expression: '今天' }
  }));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SEMANTIC_FINANCE_EVIDENCE_INVALID');
  assert.ok(result.errors.includes('amount_source_mismatch'));
});
