function candidate(overrides = {}) {
  return {
    domain: 'memory',
    intent: 'state_fact',
    action: 'add',
    entity: { type: 'person', reference: 'family-member', relation_to_owner: 'daughter' },
    relation_to_owner: 'daughter',
    predicate: 'birth_date',
    value: { year: 2012, month: 6, day: 8 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: ['domain', 'entity', 'relation_to_owner', 'predicate', 'value'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.97,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null,
    ...overrides
  };
}

export const BASE_CANONICAL_CONTEXT = Object.freeze({
  owner: 'owner-a',
  conversation: 'conversation-a',
  active_entity: {
    type: 'person',
    reference: 'family-member',
    relation_to_owner: 'mother'
  },
  active_predicate: 'birthday',
  active_domain: 'tool',
  active_action: 'calendar.convert',
  active_tool: 'calendar.convert',
  active_arguments: {
    source_calendar: 'lunar',
    target_calendar: 'gregorian',
    target_year_reference: 'this_year'
  },
  required_evidence: [{
    entity_relation: 'mother',
    predicate: 'birthday',
    required_qualifiers: ['calendar_type', 'month', 'day']
  }],
  last_tool_result: null
});
export const UNIFIED_PROVIDER_CANONICALIZATION_EVALUATION_V1 = Object.freeze({
  dateString: candidate({ value: '2012-06-08' }),
  dateObject: candidate({ value: { year: 2012, month: 6, day: 8 } }),
  yearlessDate: candidate({
    predicate: 'birthday',
    value: { year: null, month: 6, day: 8 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'yearly' }
  }),
  enrichCalendar: candidate({
    intent: 'qualifier_update',
    action: 'enrich',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: {},
    qualifiers: { calendar_type: 'lunar' },
    explicit_fields: ['qualifiers.calendar_type'],
    inherited_fields: ['relation_to_owner', 'predicate']
  }),
  nextYear: candidate({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'convert_calendar_date',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    tool: null,
    arguments: { target_year_reference: 'next_year' },
    required_evidence: [],
    explicit_fields: ['arguments.target_year_reference'],
    inherited_fields: ['relation_to_owner', 'predicate', 'tool']
  }),
  daysUntil: candidate({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'days_until',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    tool: null,
    arguments: { occurrence: 'next_occurrence' },
    required_evidence: [],
    explicit_fields: ['action', 'arguments.occurrence'],
    inherited_fields: ['relation_to_owner', 'predicate', 'tool']
  }),
  explicitEntity: candidate({
    intent: 'fact_query',
    action: 'query',
    entity: { type: 'person', reference: 'family-member', relation_to_owner: 'father' },
    relation_to_owner: 'father',
    predicate: 'birthday',
    value: null,
    qualifiers: {},
    explicit_fields: ['entity', 'relation_to_owner', 'predicate'],
    inherited_fields: []
  }),
  explicitFinanceTask: candidate({
    domain: 'finance',
    intent: 'ledger_query',
    action: 'query',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: 'ledger_entry',
    value: null,
    qualifiers: { period_type: 'this_month' },
    tool: null,
    arguments: { metrics: ['income', 'expense', 'net'], period_type: 'this_month' },
    required_evidence: [],
    explicit_fields: ['domain', 'action', 'arguments.metrics', 'arguments.period_type'],
    inherited_fields: []
  })
});
