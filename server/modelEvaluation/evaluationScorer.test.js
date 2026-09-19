import test from 'node:test';
import assert from 'node:assert/strict';

import { EVALUATION_CASES } from './evaluationCases.js';
import {
  buildMachineResult,
  scoreCachedEvaluation
} from './evaluationScorer.js';
import { renderEvaluationReport } from './evaluationReport.js';

function rawPlan(overrides = {}) {
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
    explicit_fields: ['domain', 'intent', 'action'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.95,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null,
    ...overrides
  };
}

function record(caseId, plan, {
  latency = 100,
  assistantText = null,
  inputTokens = 10,
  outputTokens = 20
} = {}) {
  return {
    evaluation_version: 'model-evaluation-m12-b1-v1',
    mode: 'formal',
    provider_id: 'deepseek',
    model_id: 'deepseek-v4-flash',
    case_id: caseId,
    attempt: 1,
    call_index: 1,
    http_success: true,
    http_status: 200,
    latency_ms: latency,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    },
    content: JSON.stringify({ plan, assistant_text: assistantText }),
    error_type: null,
    error_code: null
  };
}

test('deterministic scorer validates JSON, Canonical schema, Finance amounts, Calendar output, and ambiguity', async () => {
  const selected = ['A01', 'C01', 'E02', 'B06']
    .map((id) => EVALUATION_CASES.find((entry) => entry.id === id));
  const records = [
    record('A01', rawPlan(), { latency: 100, assistantText: '我是AI秘书，可以帮你处理工作与生活中的事务。' }),
    record('C01', rawPlan({
      domain: 'finance',
      intent: 'create',
      action: 'create',
      value: { amount: '18', direction: 'expense' },
      qualifiers: { relative_day_offset: 0, category: '交通' },
      arguments: {
        transaction_candidate: {
          direction: 'expense',
          amount_text: '18',
          occurred_expression: '今天'
        },
        metrics: ['expense']
      },
      explicit_fields: ['domain', 'intent', 'action', 'value.amount', 'arguments.transaction_candidate.direction']
    }), { latency: 200 }),
    record('E02', rawPlan({
      domain: 'tool',
      intent: 'days_until',
      action: 'days_until',
      entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
      relation_to_owner: 'mother',
      predicate: 'birthday',
      tool: 'calendar.convert',
      arguments: {
        source_calendar: 'gregorian',
        target_calendar: 'gregorian',
        target_year_reference: 'next_occurrence',
        occurrence: 'next_occurrence'
      },
      required_evidence: [{
        entity_relation: 'mother',
        predicate: 'birthday',
        required_qualifiers: ['calendar_type', 'month', 'day']
      }],
      explicit_fields: ['domain', 'intent', 'action'],
      inherited_fields: ['relation_to_owner', 'predicate']
    }), { latency: 300 }),
    record('B06', rawPlan({
      domain: 'ambiguous',
      intent: 'ambiguous',
      action: 'ambiguous',
      ambiguity_reasons: ['缺少具体安排对象和动作'],
      confidence: 0.4,
      requires_confirmation: true
    }), { latency: 400, assistantText: '你希望我安排什么事项？' })
  ];

  const scored = await scoreCachedEvaluation(records, {
    cases: selected,
    pricingByModel: {}
  });
  assert.equal(scored.case_scores.length, 4);
  assert.ok(scored.case_scores.every(({ success }) => success));
  assert.deepEqual(
    scored.case_scores.find(({ case_id: caseId }) => caseId === 'C01').deterministic.finance,
    { direction: 'expense', amount_minor: 1800, local_date: '2026-07-27' }
  );
  assert.deepEqual(
    scored.case_scores.find(({ case_id: caseId }) => caseId === 'E02').deterministic.calendar,
    { date: '2027-05-20', remaining_days: 297 }
  );

  const result = buildMachineResult(scored);
  const metrics = result.providers[0].metrics;
  assert.equal(metrics.http_success_rate, 1);
  assert.equal(metrics.average_latency_ms, 250);
  assert.equal(metrics.p50_latency_ms, 200);
  assert.equal(metrics.p95_latency_ms, 400);
  assert.equal(metrics.strict_json_parse_rate, 1);
  assert.equal(metrics.canonical_schema_pass_rate, 1);
  assert.equal(metrics.finance_success_rate, 1);
  assert.equal(metrics.calendar_plan_success_rate, 1);
  assert.equal(metrics.calendar_success_rate, null);
  assert.equal(metrics.true_ambiguity_accuracy, 1);
  assert.equal(metrics.ordinary_chat_not_wrongly_clarified_rate, 1);
  assert.equal(metrics.input_tokens, 40);
  assert.equal(metrics.output_tokens, 80);
  assert.equal(metrics.estimated_cost, null);
});

test('scoring failure is recomputed from cache without invoking a Provider', async () => {
  const selected = [EVALUATION_CASES.find(({ id }) => id === 'F01')];
  const scored = await scoreCachedEvaluation([
    { ...record('F01', rawPlan()), content: 'not-json' }
  ], {
    cases: selected,
    pricingByModel: {},
    invoke: () => { throw new Error('Provider must not be called during replay'); }
  });
  assert.equal(scored.case_scores[0].json_parse_success, false);
  assert.equal(scored.case_scores[0].success, false);
  assert.deepEqual(scored.error_distribution, { strict_json_invalid: 1 });
});

test('ordinary-chat manual review remains visible when the response text is valid but Raw Plan schema fails', async () => {
  const selected = [EVALUATION_CASES.find(({ id }) => id === 'A01')];
  const malformedPlan = { domain: 'ordinary_chat', action: 'ordinary_chat' };
  const scored = await scoreCachedEvaluation([
    {
      ...record('A01', rawPlan(), { assistantText: '我是AI秘书。' }),
      provider_id: 'kimi',
      model_id: 'moonshot-v1-8k',
      content: JSON.stringify({ plan: malformedPlan, assistant_text: '我是AI秘书。' })
    }
  ], {
    cases: selected,
    pricingByModel: {},
    manualReviews: {
      'kimi:A01': { status: 'pass', notes: '身份与中文表达符合人工复核项。' }
    }
  });
  assert.equal(scored.case_scores[0].raw_schema_success, false);
  assert.deepEqual(scored.case_scores[0].manual_review, {
    criteria: ['identity_ai_secretary', 'natural_chinese'],
    status: 'pass',
    notes: '身份与中文表达符合人工复核项。'
  });
});

test('Markdown report includes provider comparison, errors, cost caveat, and non-executable routing draft', async () => {
  const selected = [EVALUATION_CASES.find(({ id }) => id === 'A01')];
  const scored = await scoreCachedEvaluation([
    record('A01', rawPlan(), { assistantText: '我是AI秘书。' })
  ], { cases: selected, pricingByModel: {} });
  const report = renderEvaluationReport(buildMachineResult(scored));
  assert.match(report, /# Model Evaluation Baseline M12-B1 V1/);
  assert.match(report, /Provider 对比表/);
  assert.match(report, /错误类型统计/);
  assert.match(report, /价格不可用/);
  assert.match(report, /路由建议草案（不实现）/);
  assert.match(report, /人工复核/);
});

test('Markdown report distinguishes planner conformance from production domain execution', async () => {
  const selected = [EVALUATION_CASES.find(({ id }) => id === 'D01')];
  const scored = await scoreCachedEvaluation([
    record('D01', rawPlan({
      domain: 'memory',
      intent: 'create',
      action: 'create',
      entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
      relation_to_owner: 'mother',
      predicate: 'birthday',
      value: { month: 5, day: 20 },
      qualifiers: { calendar_type: 'gregorian', month: 5, day: 20 }
    }))
  ], { cases: selected, pricingByModel: {} });

  const report = renderEvaluationReport(buildMachineResult(scored));
  assert.match(report, /Memory Plan/);
  assert.match(report, /Memory Domain=N\/A/);
  assert.match(report, /未经过生产 Memory 执行链/);
});

test('routing draft excludes schema-incompatible backups and fails closed when core domains have no passing evidence', () => {
  const provider = (providerId, modelId, overrides = {}) => ({
    provider_id: providerId,
    model_id: modelId,
    call_count: 24,
    case_count: 24,
    successful_cases: 12,
    metrics: {
      http_success_rate: 1,
      average_latency_ms: 1000,
      strict_json_parse_rate: 1,
      canonical_schema_pass_rate: 0.8,
      ordinary_chat_success_rate: 1,
      semantic_success_rate: 0.5,
      finance_success_rate: 0.5,
      memory_success_rate: 0,
      calendar_success_rate: 0,
      stability_success_rate: 1,
      ordinary_chat_not_wrongly_clarified_rate: 1,
      ...overrides
    },
    error_distribution: {},
    manual_review: [{ case_id: 'A01', status: 'pass' }]
  });
  const scored = {
    evaluation_version: 'model-evaluation-m12-b1-v1',
    records: [],
    case_scores: [],
    error_distribution: {},
    providers: [
      provider('deepseek', 'deepseek-v4-flash'),
      provider('qwen', 'qwen-max', { canonical_schema_pass_rate: 0.6 }),
      provider('kimi', 'moonshot-v1-8k', { canonical_schema_pass_rate: 0 }),
      provider('zhipu', 'glm-4.5', {
        http_success_rate: 0,
        strict_json_parse_rate: 0,
        canonical_schema_pass_rate: 0,
        ordinary_chat_success_rate: 0,
        semantic_success_rate: 0,
        finance_success_rate: 0,
        stability_success_rate: 0
      })
    ]
  };

  const routing = buildMachineResult(scored).routing_recommendation;
  assert.equal(routing.first_backup, 'qwen-max');
  assert.equal(routing.second_backup, null);
  assert.equal(routing.evidence_sufficient_for_router_core, false);
  assert.equal(routing.evidence_note, 'core_domain_evidence_insufficient');
});

test('Memory and Calendar domain rates are not reported from planner-only synthetic scoring', async () => {
  const selected = ['D01', 'E02']
    .map((id) => EVALUATION_CASES.find((entry) => entry.id === id));
  const records = [
    record('D01', rawPlan({
      domain: 'memory',
      intent: 'create',
      action: 'create',
      entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
      relation_to_owner: 'mother',
      predicate: 'birthday',
      value: { month: 5, day: 20 },
      qualifiers: { calendar_type: 'gregorian', month: 5, day: 20 },
      explicit_fields: ['relation_to_owner', 'predicate', 'value', 'qualifiers.calendar_type']
    })),
    record('E02', rawPlan({
      domain: 'tool',
      intent: 'days_until',
      action: 'days_until',
      entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
      relation_to_owner: 'mother',
      predicate: 'birthday',
      tool: 'calendar.convert',
      arguments: {
        source_calendar: 'gregorian',
        target_calendar: 'gregorian',
        target_year_reference: 'next_occurrence',
        occurrence: 'next_occurrence'
      },
      required_evidence: [{
        entity_relation: 'mother',
        predicate: 'birthday',
        required_qualifiers: ['calendar_type', 'month', 'day']
      }],
      explicit_fields: ['domain', 'intent', 'action']
    }))
  ];

  const scored = await scoreCachedEvaluation(records, {
    cases: selected,
    pricingByModel: {}
  });
  const metrics = scored.providers[0].metrics;

  assert.equal(metrics.memory_plan_success_rate, 1);
  assert.equal(metrics.calendar_plan_success_rate, 1);
  assert.equal(metrics.memory_success_rate, null);
  assert.equal(metrics.calendar_success_rate, null);
  assert.deepEqual(metrics.domain_execution_evidence, {
    memory: 'not_executed_through_production_chain',
    calendar: 'synthetic_tool_only_without_production_binders'
  });
});
