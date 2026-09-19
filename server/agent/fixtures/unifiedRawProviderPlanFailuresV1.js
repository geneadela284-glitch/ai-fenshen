const BASE_PLAN = Object.freeze({
  domain: 'memory',
  intent: 'new_fact',
  action: 'insert_fact',
  entity: Object.freeze({
    type: 'person',
    reference: '女儿',
    relation_to_owner: 'daughter'
  }),
  relation_to_owner: 'daughter',
  predicate: 'birth_date',
  value: '2012-06-08',
  qualifiers: Object.freeze({
    calendar_type: 'unknown',
    recurrence: 'one_time'
  }),
  tool: null,
  arguments: Object.freeze({}),
  required_evidence: Object.freeze([]),
  explicit_fields: Object.freeze([
    'entity',
    'predicate',
    'value'
  ]),
  inherited_fields: Object.freeze([]),
  ambiguity_reasons: Object.freeze([]),
  confidence: 1,
  requires_confirmation: false,
  source_spans: Object.freeze([]),
  source_message_id: null
});

export function rawProviderPlanFixture(overrides = {}) {
  return {
    ...structuredClone(BASE_PLAN),
    ...structuredClone(overrides)
  };
}

export const RAW_PROVIDER_FAILURE_FIXTURES = Object.freeze({
  confidenceBand: Object.freeze(rawProviderPlanFixture({
    confidence: 'high'
  })),
  missingTopLevelRelation: Object.freeze((() => {
    const plan = rawProviderPlanFixture();
    delete plan.relation_to_owner;
    return plan;
  })()),
  invalidConfidenceObject: Object.freeze(rawProviderPlanFixture({
    confidence: { band: 'high' }
  })),
  explicitEntityGenderErasedByBroadRelation: Object.freeze(rawProviderPlanFixture({
    entity: {
      type: 'person',
      reference: 'daughter',
      relation_to_owner: 'child'
    },
    relation_to_owner: 'child'
  }))
});
