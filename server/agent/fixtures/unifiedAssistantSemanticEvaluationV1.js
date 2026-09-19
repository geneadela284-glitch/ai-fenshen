function base({
  domain,
  intent,
  action,
  relation = null,
  predicate = null,
  value = null,
  qualifiers = {},
  tool = null,
  arguments: args = {},
  requiredEvidence = [],
  explicit = [],
  inherited = []
}) {
  return {
    domain,
    intent,
    action,
    entity: {
      type: relation ? 'person' : null,
      reference: relation,
      relation_to_owner: relation
    },
    relation_to_owner: relation,
    predicate,
    value,
    qualifiers,
    tool,
    arguments: args,
    required_evidence: requiredEvidence,
    explicit_fields: explicit,
    inherited_fields: inherited,
    ambiguity_reasons: [],
    confidence: 0.96,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

const memory = (input, options) => ({ input, plan: base({ domain: 'memory', ...options }) });
const finance = (input, options) => ({ input, plan: base({ domain: 'finance', ...options }) });
const tool = (input, options) => ({ input, plan: base({ domain: 'tool', intent: 'invoke_tool', ...options }) });

export const UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1 = Object.freeze([
  memory('我女儿出生于2012年6月8日', {
    intent: 'create', action: 'insert_fact', relation: 'daughter', predicate: 'birth_date',
    value: { year: 2012, month: 6, day: 8 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    explicit: ['relation_to_owner', 'predicate', 'value.year', 'value.month', 'value.day']
  }),
  memory('我女儿的生日是6月8号', {
    intent: 'state_fact', action: 'add', relation: 'daughter', predicate: 'birthday',
    value: { year: null, month: 6, day: 8 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'yearly' },
    explicit: ['relation_to_owner', 'predicate', 'value.month', 'value.day']
  }),
  memory('刚才说的是农历', {
    intent: 'qualifier_update', action: 'enrich', predicate: null, value: {},
    qualifiers: { calendar_type: 'lunar' },
    explicit: ['qualifiers.calendar_type'],
    inherited: ['entity.relation_to_owner', 'relation_to_owner', 'predicate']
  }),
  memory('她也喜欢草莓', {
    intent: 'preference_fact', action: 'merge', predicate: null, value: ['草莓'],
    qualifiers: { cardinality: 'multiple', degree: 'normal' },
    explicit: ['value'],
    inherited: ['entity.relation_to_owner', 'relation_to_owner', 'predicate']
  }),
  memory('我说错了，她最喜欢芒果', {
    intent: 'correction', action: 'supersede', relation: 'daughter', predicate: 'favorite_food',
    value: '芒果', qualifiers: { cardinality: 'single', degree: 'favorite' },
    arguments: {
      mutation_target: {
        operation: 'correction',
        entity_relation: 'daughter',
        predicate: 'favorite_food'
      }
    },
    requiredEvidence: [{
      entity_relation: 'daughter',
      predicate: 'favorite_food',
      required_qualifiers: []
    }],
    explicit: ['relation_to_owner', 'predicate', 'value']
  }),
  memory('我爸爸什么时候生日', {
    intent: 'fact_query', action: 'query', relation: 'father', predicate: 'birthday',
    qualifiers: {}, explicit: ['relation_to_owner', 'predicate']
  }),
  finance('早餐30', {
    intent: 'ledger_create', action: 'create', predicate: 'ledger_entry',
    value: { direction: 'expense', amount_text: '30' },
    qualifiers: {},
    arguments: {
      metrics: ['expense'],
      transaction_candidate: { direction: 'expense', amount_text: '30', occurred_expression: null }
    },
    explicit: ['action', 'value.direction', 'value.amount_text']
  }),
  finance('收入100', {
    intent: 'ledger_create', action: 'create', predicate: 'ledger_entry',
    value: { direction: 'income', amount_text: '100' },
    qualifiers: {},
    arguments: {
      metrics: ['income'],
      transaction_candidate: { direction: 'income', amount_text: '100', occurred_expression: null }
    },
    explicit: ['action', 'value.direction', 'value.amount_text']
  }),
  finance('昨天花了多少', {
    intent: 'ledger_query', action: 'query', predicate: 'ledger_entry',
    qualifiers: { period_type: 'yesterday', period_expression: '昨天' },
    arguments: { metrics: ['expense'], period_type: 'yesterday', period_expression: '昨天' },
    explicit: ['action', 'arguments.metrics', 'qualifiers.period_type']
  }),
  finance('这个月收入和支出分别是多少', {
    intent: 'ledger_query', action: 'query', predicate: 'ledger_entry',
    qualifiers: { period_type: 'this_month', period_expression: '这个月' },
    arguments: { metrics: ['income', 'expense', 'net'], period_type: 'this_month', period_expression: '这个月' },
    explicit: ['action', 'arguments.metrics', 'qualifiers.period_type']
  }),
  tool('今年对应阳历哪一天', {
    action: 'convert_calendar_date', relation: 'mother', predicate: 'birthday',
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar', target_calendar: 'gregorian',
      target_year_reference: 'this_year', target_year: null, occurrence: 'specified_year'
    },
    requiredEvidence: [{
      entity_relation: 'mother', predicate: 'birthday',
      required_qualifiers: ['calendar_type', 'month', 'day']
    }],
    inherited: ['entity.relation_to_owner', 'relation_to_owner', 'predicate']
  }),
  tool('明年呢', {
    action: 'convert_calendar_date', relation: null, predicate: null,
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar', target_calendar: 'gregorian',
      target_year_reference: 'next_year', target_year: null, occurrence: 'specified_year'
    },
    requiredEvidence: [{
      entity_relation: 'mother', predicate: 'birthday',
      required_qualifiers: ['calendar_type', 'month', 'day']
    }],
    inherited: ['entity.relation_to_owner', 'relation_to_owner', 'predicate', 'tool']
  }),
  tool('离下一次生日还有多少天', {
    action: 'days_until', relation: 'mother', predicate: 'birthday',
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar', target_calendar: 'gregorian',
      target_year_reference: 'next_occurrence', target_year: null, occurrence: 'next_occurrence'
    },
    requiredEvidence: [{
      entity_relation: 'mother', predicate: 'birthday',
      required_qualifiers: ['calendar_type', 'month', 'day']
    }],
    explicit: ['action']
  }),
  memory('女儿是在二〇一二年的六月八日出生的', {
    intent: 'state_fact', action: 'add', relation: 'daughter', predicate: 'birth_date',
    value: { year: 2012, month: 6, day: 8 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    explicit: ['relation_to_owner', 'predicate', 'value.year', 'value.month', 'value.day']
  }),
  memory('孩子每年六月初八过生日，历法还没说', {
    intent: 'state_fact', action: 'add', relation: 'daughter', predicate: 'birthday',
    value: { year: null, month: 6, day: 8 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'yearly' },
    explicit: ['relation_to_owner', 'predicate', 'value.month', 'value.day']
  }),
  finance('把今天收到的一百块记作收入', {
    intent: 'ledger_create', action: 'create', predicate: 'ledger_entry',
    value: { direction: 'income', amount_text: '一百块' },
    qualifiers: {},
    arguments: {
      metrics: ['income'],
      transaction_candidate: { direction: 'income', amount_text: '一百块', occurred_expression: '今天' }
    },
    explicit: ['action', 'value.direction', 'value.amount_text']
  })
]);
