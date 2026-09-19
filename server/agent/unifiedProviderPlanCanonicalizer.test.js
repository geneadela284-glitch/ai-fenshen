import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptUnifiedPlanToFinance } from './domainPlanAdapters.js';
import { evaluateFinanceToolPlan } from '../finance/financeToolContract.js';

async function subject() {
  return import('./unifiedProviderPlanCanonicalizer.js').catch(() => null);
}

function candidate(overrides = {}) {
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
    explicit_fields: ['relation_to_owner', 'predicate', 'value'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.95,
    requires_confirmation: true,
    source_spans: [],
    source_message_id: 'source-1',
    ...overrides
  };
}

function trusted(overrides = {}) {
  return {
    owner: 'owner-a',
    conversation: 'conversation-a',
    active_entity: {
      type: 'person',
      reference: '妈妈',
      relation_to_owner: 'mother'
    },
    active_predicate: 'birthday',
    active_domain: 'tool',
    active_action: 'calendar.convert',
    active_tool: 'calendar.convert',
    active_arguments: {
      source_calendar: 'lunar',
      target_calendar: 'gregorian',
      target_year_reference: 'this_year',
      target_year: null,
      occurrence: 'specified_year'
    },
    required_evidence: [{
      entity_relation: 'mother',
      predicate: 'birthday',
      required_qualifiers: ['calendar_type', 'month', 'day']
    }],
    last_tool_result: null,
    ...overrides
  };
}

function ordinaryCandidate(action) {
  return candidate({
    domain: 'ordinary_chat',
    intent: 'provider_advisory_intent',
    action,
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: 'provider advisory content',
    qualifiers: {},
    explicit_fields: [],
    requires_confirmation: false
  });
}

test('RED: a valid ordinary-chat domain deterministically selects the existing ordinary-chat contract', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  for (const rawAction of [
    'respond_to_greeting',
    'respond_to_inquiry',
    'provider_advisory_action'
  ]) {
    const result = api.canonicalizeUnifiedProviderPlan(ordinaryCandidate(rawAction), {
      ownerId: 'owner-a',
      conversationId: 'conversation-a'
    });
    assert.equal(result.ok, true, rawAction);
    assert.equal(result.plan.domain, 'ordinary_chat');
    assert.equal(result.plan.intent, 'ordinary_chat');
    assert.equal(result.plan.action, 'ordinary_chat');
    assert.equal(result.audit.raw_action, rawAction);
  }
});

test('RED: ordinary-chat projection discards domain-inapplicable entity metadata before strict Canonical validation', async () => {
  const api = await subject();
  const result = api.canonicalizeUnifiedProviderPlan(ordinaryCandidate('respond_to_inquiry'), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(result.plan.entity, {
    type: null,
    reference: null,
    relation_to_owner: null
  });
  assert.equal(result.plan.relation_to_owner, null);
  assert.equal(result.plan.predicate, null);
  assert.equal(result.plan.canonical_value, null);
  assert.deepEqual(result.plan.qualifiers, {});
  assert.deepEqual(result.plan.canonical_arguments, {});
});

test('RED: a structurally non-ambiguous response selects ordinary chat while real ambiguity stays fail-closed', async () => {
  const api = await subject();
  const mislabeled = api.canonicalizeUnifiedProviderPlan(ordinaryCandidate('respond_to_inquiry'), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(mislabeled.ok, true);

  const structurallyOrdinary = api.canonicalizeUnifiedProviderPlan(candidate({
    domain: 'ambiguous',
    intent: 'greeting',
    action: 'respond',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    arguments: {},
    required_evidence: [],
    explicit_fields: [],
    inherited_fields: [],
    ambiguity_reasons: [],
    requires_confirmation: false,
    confidence: 1
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(structurallyOrdinary.ok, true, structurallyOrdinary.code);
  assert.equal(structurallyOrdinary.plan.domain, 'ordinary_chat');
  assert.equal(structurallyOrdinary.plan.action, 'ordinary_chat');

  const trulyAmbiguous = api.canonicalizeUnifiedProviderPlan(candidate({
    domain: 'ambiguous',
    intent: 'ambiguous',
    action: 'ambiguous',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    arguments: {},
    required_evidence: [],
    explicit_fields: [],
    inherited_fields: [],
    ambiguity_reasons: ['target_missing'],
    requires_confirmation: true,
    confidence: 0.2
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(trulyAmbiguous.ok, true, trulyAmbiguous.code);
  assert.equal(trulyAmbiguous.plan.domain, 'ambiguous');
  assert.equal(trulyAmbiguous.plan.action, 'ambiguous');
});

test('RED: finance operation and canonical arguments derive from structural semantics, not advisory action names', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const cases = [
    {
      message: '餐饮支出30元',
      raw: {
        intent: 'create',
        action: 'record_expense',
        entity: { type: 'expense', reference: null, relation_to_owner: 'self' },
        relation_to_owner: 'self',
        predicate: 'expense',
        value: '30元',
        qualifiers: { category: '餐饮', currency: 'CNY' },
        arguments: { amount: 30, currency: 'CNY', category: '餐饮', description: '餐饮支出' },
        explicit_fields: ['value', 'qualifiers.category']
      },
      expectedAction: 'finance.create',
      expectedMetrics: ['expense'],
      expectedTransaction: { direction: 'expense', amount_text: '30元', occurred_expression: null }
    },
    {
      message: '收到收入100元',
      raw: {
        intent: 'create',
        action: 'create',
        entity: { type: 'transaction', reference: null, relation_to_owner: 'self' },
        relation_to_owner: 'self',
        predicate: 'ledger_entry',
        value: 100,
        qualifiers: { amount: 100, currency: 'CNY', category: null },
        arguments: {},
        explicit_fields: ['value']
      },
      expectedAction: 'finance.create',
      expectedMetrics: ['income'],
      expectedTransaction: { direction: 'income', amount_text: '100', occurred_expression: null }
    },
    {
      message: '这个月收入和支出分别是多少',
      raw: {
        intent: 'query',
        action: 'query',
        entity: { type: 'time_period', reference: 'this_month', relation_to_owner: 'owner' },
        relation_to_owner: 'owner',
        predicate: 'ledger_entry',
        value: null,
        qualifiers: {},
        arguments: {},
        explicit_fields: ['predicate']
      },
      expectedAction: 'finance.query',
      expectedMetrics: ['income', 'expense'],
      expectedPeriod: 'this_month'
    }
  ];

  for (const entry of cases) {
    const canonical = api.canonicalizeUnifiedProviderPlan(candidate({
      domain: 'finance',
      tool: null,
      required_evidence: [],
      inherited_fields: [],
      requires_confirmation: false,
      ...entry.raw
    }), {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      message: entry.message
    });
    assert.equal(canonical.ok, true, `${entry.raw.action}:${canonical.code}`);
    assert.equal(canonical.plan.action, entry.expectedAction);
    assert.deepEqual(canonical.plan.canonical_arguments.metrics, entry.expectedMetrics);
    if (entry.expectedTransaction) {
      assert.deepEqual(canonical.plan.canonical_arguments.transaction_candidate, entry.expectedTransaction);
    }
    if (entry.expectedPeriod) {
      assert.equal(canonical.plan.canonical_arguments.period_type, entry.expectedPeriod);
    }
    const adapted = adaptUnifiedPlanToFinance(canonical.plan, { message: entry.message });
    assert.equal(adapted.ok, true);
    const contract = evaluateFinanceToolPlan(adapted.plan, {
      message: entry.message,
      timezone: 'Asia/Shanghai',
      now: new Date('2026-07-26T05:00:00.000Z'),
      ownerId: 'owner-a'
    });
    assert.equal(contract.decision, 'ACCEPT', `${entry.raw.action}:${JSON.stringify(contract.errors || contract)}`);
  }
});

test('RED: equivalent date representations produce one typed canonical date without retaining raw value', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const fromString = api.canonicalizeUnifiedProviderPlan(candidate(), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  const fromObject = api.canonicalizeUnifiedProviderPlan(candidate({
    value: { year: 2012, month: 6, day: 8 },
    explicit_fields: ['relation_to_owner', 'predicate', 'value.year', 'value.month', 'value.day']
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(fromString.ok, true);
  assert.equal(fromObject.ok, true);
  assert.deepEqual(fromString.plan.canonical_value, {
    type: 'date', year: 2012, month: 6, day: 8
  });
  assert.deepEqual(fromObject.plan.canonical_value, fromString.plan.canonical_value);
  assert.equal(typeof fromString.audit.raw_value_sha256, 'string');
  assert.equal(JSON.stringify(fromString.audit).includes('2012-06-08'), false);
});

test('RED: complete memory facts derive one canonical intent and action without raw intent or action aliases', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  for (const [rawIntent, rawAction] of [
    ['new_fact', 'insert_fact'],
    ['add', 'create'],
    ['provider_intent_variant_42', 'provider_action_variant_42']
  ]) {
    const result = api.canonicalizeUnifiedProviderPlan(candidate({
      intent: rawIntent,
      action: rawAction
    }), {
      ownerId: 'owner-a',
      conversationId: 'conversation-a'
    });
    assert.equal(result.ok, true, `${rawIntent}:${rawAction}`);
    assert.equal(result.plan.intent, 'create_fact');
    assert.equal(result.plan.action, 'memory.capture');
    assert.equal(result.audit.raw_intent, rawIntent);
    assert.equal(result.audit.raw_action, rawAction);
  }
});

test('RED: broad Provider family relation is canonicalized before the legacy Memory contract', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const result = api.canonicalizeUnifiedProviderPlan(candidate({
    intent: 'new_fact',
    action: 'insert_fact',
    entity: { type: 'person', reference: '女儿', relation_to_owner: 'child' },
    relation_to_owner: 'child'
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    message: '我女儿出生于2012年6月8日'
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.relation_to_owner, 'daughter');
  assert.equal(result.plan.entity.relation_to_owner, 'daughter');
  assert.equal(result.plan.canonical_relation.family_role, 'child');
  assert.equal(result.plan.canonical_relation.gender, 'female');
  assert.equal(result.audit.raw_relation, 'child');
});

test('RED: gender-neutral child remains canonical child and uses one centralized legacy adapter', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const result = api.canonicalizeUnifiedProviderPlan(candidate({
    entity: { type: 'person', reference: '孩子', relation_to_owner: 'child' },
    relation_to_owner: 'child'
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    message: '我的孩子出生于2016年4月5日'
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.canonical_relation.family_role, 'child');
  assert.equal(result.plan.canonical_relation.gender, 'unknown');
  assert.equal(result.plan.relation_to_owner, 'other');
});

test('RED: explicit structured entity evidence conflicts fail closed before Memory adaptation', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const result = api.canonicalizeUnifiedProviderPlan(candidate({
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'child' },
    relation_to_owner: 'child'
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    message: '我妈妈生日是6月8号'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_ENTITY_RELATION_CONFLICT');
});

test('RED: query and correction are derived from structural targets while raw intent remains advisory', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const query = api.canonicalizeUnifiedProviderPlan(candidate({
    intent: 'provider_query_variant',
    action: 'provider_query_variant',
    value: null,
    explicit_fields: ['relation_to_owner', 'predicate'],
    arguments: {
      query_target: {
        entity_relation: 'daughter',
        predicate: 'birth_date'
      }
    }
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(query.ok, true);
  assert.equal(query.plan.intent, 'query_fact');
  assert.equal(query.plan.action, 'memory.query');

  const correction = api.canonicalizeUnifiedProviderPlan(candidate({
    intent: 'provider_mutation_variant',
    action: 'rewrite_fact',
    arguments: {
      mutation_target: {
        operation: 'correction',
        entity_relation: 'daughter',
        predicate: 'birth_date'
      }
    },
    required_evidence: [{
      entity_relation: 'daughter',
      predicate: 'birth_date',
      required_qualifiers: []
    }]
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(correction.ok, true);
  assert.equal(correction.plan.intent, 'update_fact');
  assert.equal(correction.plan.action, 'memory.update');
});

test('RED: explicit structural negation and delete targets select deterministic canonical operations', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const negation = api.canonicalizeUnifiedProviderPlan(candidate({
    intent: 'provider_variant',
    action: 'provider_variant',
    predicate: 'likes_food',
    value: ['苹果'],
    qualifiers: { negation: true },
    arguments: {
      mutation_target: {
        operation: 'negation',
        entity_relation: 'daughter',
        predicate: 'likes_food'
      }
    }
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(negation.ok, true);
  assert.equal(negation.plan.intent, 'negate_fact');
  assert.equal(negation.plan.action, 'memory.negate');

  const deletion = api.canonicalizeUnifiedProviderPlan(candidate({
    intent: 'provider_variant',
    action: 'provider_variant',
    value: null,
    explicit_fields: ['relation_to_owner', 'predicate'],
    arguments: {
      mutation_target: {
        operation: 'delete',
        entity_relation: 'daughter',
        predicate: 'birth_date'
      }
    }
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(deletion.ok, true);
  assert.equal(deletion.plan.intent, 'delete_fact');
  assert.equal(deletion.plan.action, 'memory.delete');
});

test('RED: conflicting query and capture evidence fails closed', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const conflict = api.canonicalizeUnifiedProviderPlan(candidate({
    intent: 'provider_variant',
    action: 'provider_variant',
    arguments: {
      query_target: {
        entity_relation: 'daughter',
        predicate: 'birth_date'
      }
    }
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'CANONICAL_INTENT_CONFLICT');
});

test('RED: an explicitly supplied but missing value cannot become a capture', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const result = api.canonicalizeUnifiedProviderPlan(candidate({
    intent: 'provider_create_variant',
    action: 'insert_fact',
    value: null
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_INTENT_INCOMPLETE');
});

test('RED: yearless dates and generic scalar, list, object, entity and tool arguments are typed deterministically', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const canonicalize = (value, options = {}) => api.canonicalizeAssistantValue(value, options);
  assert.deepEqual(canonicalize({ month: 6, day: 8 }), {
    ok: true, value: { type: 'date_without_year', month: 6, day: 8 }
  });
  assert.deepEqual(canonicalize('芒果'), {
    ok: true, value: { type: 'scalar', scalar_type: 'string', value: '芒果' }
  });
  assert.deepEqual(canonicalize(['苹果', '苹果', '草莓']), {
    ok: true,
    value: {
      type: 'list',
      item_type: 'scalar',
      items: [
        { type: 'scalar', scalar_type: 'string', value: '苹果' },
        { type: 'scalar', scalar_type: 'string', value: '草莓' }
      ]
    }
  });
  assert.equal(canonicalize({ direction: 'income', amount_text: '100' }).value.type, 'object');
  assert.equal(canonicalize({
    type: 'person', reference: '妈妈', relation_to_owner: 'mother'
  }, { expectedType: 'entity_reference' }).value.type, 'entity_reference');
  assert.equal(canonicalize({
    target_year_reference: 'next_year'
  }, { expectedType: 'tool_arguments', tool: 'calendar.convert' }).value.type, 'tool_arguments');
});

test('RED: invalid and conflicting dates fail closed', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  assert.equal(api.canonicalizeAssistantValue('2012-02-30').ok, false);
  const result = api.canonicalizeUnifiedProviderPlan(candidate({
    value: '2012-06-08',
    qualifiers: { year: 2013, month: 6, day: 8, calendar_type: 'unknown' }
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_VALUE_CONFLICT');
});

test('RED: current explicit entity overrides trusted state while omitted entity inherits only in the same owner and conversation', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const explicit = api.canonicalizeUnifiedProviderPlan(candidate(), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    trustedContext: trusted()
  });
  assert.equal(explicit.plan.relation_to_owner, 'daughter');

  const continuationPlan = candidate({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'convert_calendar_date',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar',
      target_calendar: 'gregorian',
      target_year_reference: 'next_year',
      target_year: null,
      occurrence: 'specified_year'
    },
    required_evidence: [{
      source: 'owner_scoped_memory',
      predicates: ['birthday'],
      qualifiers: ['calendar_type', 'month', 'day', 'lunar_leap_month'],
      status: 'confirmed_current'
    }],
    explicit_fields: ['arguments.target_year_reference'],
    inherited_fields: ['entity', 'relation_to_owner', 'predicate', 'tool']
  });
  const inherited = api.canonicalizeUnifiedProviderPlan(continuationPlan, {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    trustedContext: trusted()
  });
  assert.equal(inherited.ok, true);
  assert.equal(inherited.plan.relation_to_owner, 'mother');
  assert.equal(inherited.plan.action, 'calendar.convert');
  assert.equal(inherited.plan.canonical_arguments.target_year_reference, 'next_year');
  assert.deepEqual(inherited.plan.required_evidence, [{
    entity_relation: 'mother',
    predicate: 'birthday',
    required_qualifiers: ['calendar_type', 'month', 'day']
  }]);

  const crossConversation = api.canonicalizeUnifiedProviderPlan(continuationPlan, {
    ownerId: 'owner-a',
    conversationId: 'conversation-b',
    trustedContext: trusted()
  });
  assert.equal(crossConversation.ok, false);
  assert.equal(crossConversation.code, 'CANONICAL_CONTEXT_SCOPE_MISMATCH');

  const crossOwner = api.canonicalizeUnifiedProviderPlan(continuationPlan, {
    ownerId: 'owner-b',
    conversationId: 'conversation-a',
    trustedContext: trusted()
  });
  assert.equal(crossOwner.ok, false);
  assert.equal(crossOwner.code, 'CANONICAL_CONTEXT_SCOPE_MISMATCH');
});

test('RED: structured semantic deltas select calendar days-until while explicit finance task clears old tool context', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const daysUntil = api.canonicalizeUnifiedProviderPlan(candidate({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'days_until',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar',
      target_calendar: 'gregorian',
      target_year_reference: 'next_occurrence',
      target_year: null,
      occurrence: 'next_occurrence'
    },
    required_evidence: [],
    explicit_fields: ['action'],
    inherited_fields: ['entity', 'relation_to_owner', 'predicate', 'tool']
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    trustedContext: trusted()
  });
  assert.equal(daysUntil.ok, true);
  assert.equal(daysUntil.plan.action, 'calendar.days_until');
  assert.equal(daysUntil.plan.relation_to_owner, 'mother');
  assert.equal(daysUntil.plan.required_evidence[0].predicate, 'birthday');

  const finance = api.canonicalizeUnifiedProviderPlan(candidate({
    domain: 'finance',
    intent: 'ledger_query',
    action: 'query',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: 'ledger_entry',
    value: null,
    tool: null,
    arguments: { metrics: ['income', 'expense'], period_type: 'this_month' },
    explicit_fields: ['domain', 'action', 'arguments.metrics', 'arguments.period_type'],
    inherited_fields: []
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    trustedContext: trusted()
  });
  assert.equal(finance.ok, true);
  assert.equal(finance.plan.action, 'finance.query');
  assert.equal(finance.plan.tool, null);
  assert.deepEqual(finance.plan.required_evidence, []);
});

test('RED: requires_confirmation, confidence and source span hints remain advisory', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const result = api.canonicalizeUnifiedProviderPlan(candidate({
    requires_confirmation: true,
    confidence: 0.51,
    source_spans: [{ text: 'wrong', start: 999, end: 1000 }]
  }), {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.action, 'memory.capture');
  assert.equal(result.plan.provider_advisory.requires_confirmation, true);
});

test('RED: trusted context store commits accepted state and never crosses owner or conversation', async () => {
  const api = await subject();
  assert.ok(api, 'Unified Provider Plan Canonicalizer is missing');
  const store = api.createAssistantContextStateStore();
  store.commit({
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    plan: {
      domain: 'calendar',
      action: 'calendar.convert',
      entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
      relation_to_owner: 'mother',
      predicate: 'birthday',
      tool: 'calendar.convert',
      canonical_arguments: { target_year_reference: 'this_year' },
      required_evidence: [{ entity_relation: 'mother', predicate: 'birthday' }]
    },
    toolResult: { target_year: 2026 }
  });
  assert.equal(store.read('owner-a', 'conversation-a').active_entity.relation_to_owner, 'mother');
  assert.equal(store.read('owner-a', 'conversation-b'), null);
  assert.equal(store.read('owner-b', 'conversation-a'), null);
});
