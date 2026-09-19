import assert from 'node:assert/strict';
import test from 'node:test';

test('production canary uses the real Planner repair contract and enforces the upstream call cap', async () => {
  const api = await import('./productionCanary.js').catch(() => ({}));
  assert.equal(typeof api.runProductionPlannerCanary, 'function');

  const calls = [];
  const validPlan = {
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
    source_message_id: null
  };
  const result = await api.runProductionPlannerCanary({
    cases: [{ id: 'D02', message: '我妈妈生日是哪天？', contextPack: {} }],
    providerTarget: { provider_id: 'deepseek', model_id: 'deepseek-v4-flash' },
    maxCalls: 2,
    invoke: async ({ messages }) => {
      calls.push(messages);
      return {
        content: calls.length === 1
          ? JSON.stringify({ ...validPlan, qualifiers: [{ calendar_type: 'unknown' }] })
          : JSON.stringify({ ...validPlan, qualifiers: { calendar_type: 'unknown' } }),
        httpStatus: 200,
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      };
    }
  });

  assert.equal(result.call_count, 2);
  assert.equal(result.exceeded_call_limit, false);
  assert.equal(result.cases[0].ok, true);
  assert.equal(result.cases[0].attempts, 2);
  assert.deepEqual(result.upstream_records[0].usage, {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30
  });
  assert.match(calls[1][0].content, /不得重新解释用户目标/);
  assert.equal(
    JSON.parse(calls[1][1].content).raw_result,
    JSON.stringify({ ...validPlan, qualifiers: [{ calendar_type: 'unknown' }] })
  );
  assert.equal(JSON.stringify(calls[1]).includes('我妈妈生日是哪天'), false);

  const capped = await api.runProductionPlannerCanary({
    cases: [
      { id: 'D02', message: '我妈妈生日是哪天？', contextPack: {} },
      { id: 'E01', message: '妈妈的下一个生日是哪天？', contextPack: {} }
    ],
    providerTarget: { provider_id: 'deepseek', model_id: 'deepseek-v4-flash' },
    maxCalls: 1,
    invoke: async () => ({
      content: JSON.stringify({ ...validPlan, qualifiers: [{ calendar_type: 'unknown' }] }),
      httpStatus: 200,
      usage: null
    })
  });
  assert.equal(capped.call_count, 1);
  assert.equal(capped.exceeded_call_limit, false);
  assert.equal(capped.stopped_at_limit, true);
  assert.equal(capped.cases[1].code, 'PRODUCTION_CANARY_CALL_LIMIT_REACHED');
});
