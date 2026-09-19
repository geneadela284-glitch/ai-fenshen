import assert from 'node:assert/strict';
import test from 'node:test';

import { EVALUATION_CASES } from './evaluationCases.js';

function basePlan(overrides = {}) {
  return {
    domain: 'memory',
    intent: 'query',
    action: 'query',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: null,
    qualifiers: {},
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: ['relation_to_owner', 'predicate'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.9,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null,
    ...overrides
  };
}

test('production trace accepts birth_date recall that the M12 literal scorer rejected', async () => {
  const api = await import('./evaluationValidity.js').catch(() => ({}));
  assert.equal(typeof api.traceProductionPlan, 'function');
  const definition = EVALUATION_CASES.find(({ id }) => id === 'D02');
  const trace = await api.traceProductionPlan(basePlan({
    predicate: 'birth_date'
  }), definition);

  assert.equal(trace.first_failure, null);
  assert.equal(trace.classification, 'production_chain_pass');
  assert.equal(trace.layers.domain_adapter.plan.predicate, 'birthday');
  assert.equal(trace.layers.domain_contract.decision, 'ACCEPT');
});

test('production trace exposes a lost Gregorian qualifier as a Canonical normalization gap', async () => {
  const { traceProductionPlan } = await import('./evaluationValidity.js');
  const definition = EVALUATION_CASES.find(({ id }) => id === 'D01');
  const trace = await traceProductionPlan(basePlan({
    intent: 'create',
    action: 'add_fact',
    value: { calendar_type: 'gregorian', month: 5, day: 20 },
    explicit_fields: ['relation_to_owner', 'predicate', 'value']
  }), definition);

  assert.equal(trace.first_failure.layer, 'semantic_expectation');
  assert.equal(trace.first_failure.code, 'calendar_type_not_preserved');
  assert.equal(trace.classification, 'canonical_normalization_missing');
  assert.equal(trace.layers.domain_contract.structuredValue.calendarType, 'unknown');
});

test('production trace rejects invalid Calendar source arguments before deterministic execution', async () => {
  const { traceProductionPlan } = await import('./evaluationValidity.js');
  const definition = EVALUATION_CASES.find(({ id }) => id === 'E02');
  const trace = await traceProductionPlan(basePlan({
    domain: 'tool',
    intent: 'query',
    action: 'calendar.convert',
    value: null,
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'unknown',
      target_calendar: 'gregorian',
      target_year_reference: 'next_occurrence',
      occurrence: 'next_occurrence'
    }
  }), definition);

  assert.equal(trace.first_failure.layer, 'domain_contract');
  assert.equal(trace.first_failure.code, 'CALENDAR_ARGUMENTS_INVALID');
  assert.equal(trace.classification, 'provider_semantic_plan_invalid');
  assert.equal(trace.layers.deterministic_tool.status, 'not_run');
});

test('production trace treats canonical calendar.convert as the Tool convert_calendar_date action', async () => {
  const { traceProductionPlan } = await import('./evaluationValidity.js');
  const definition = EVALUATION_CASES.find(({ id }) => id === 'E03');
  const trace = await traceProductionPlan(basePlan({
    domain: 'tool',
    intent: 'query',
    action: 'calendar.convert',
    value: null,
    qualifiers: { calendar_type: 'lunar', target_year_reference: 'this_year' },
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar',
      target_calendar: 'gregorian',
      target_year_reference: 'this_year',
      occurrence: 'specified_year'
    }
  }), definition);

  assert.equal(trace.first_failure, null);
  assert.equal(trace.classification, 'production_chain_pass');
  assert.equal(trace.layers.deterministic_tool.result.gregorian_date, '2026-08-28');
});

test('production trace rejects a Memory plan when the requested domain is Calendar', async () => {
  const { traceProductionPlan } = await import('./evaluationValidity.js');
  const definition = EVALUATION_CASES.find(({ id }) => id === 'E01');
  const trace = await traceProductionPlan(basePlan({
    intent: 'query',
    action: 'query',
    value: null
  }), definition);

  assert.equal(trace.first_failure.layer, 'semantic_expectation');
  assert.equal(trace.first_failure.code, 'domain_mismatch');
  assert.equal(trace.classification, 'provider_semantic_plan_invalid');
});
