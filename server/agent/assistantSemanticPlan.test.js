import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAssistantSemanticPlanResponse,
  validateAssistantSemanticPlan
} from './assistantSemanticPlanSchema.js';
import { bindAssistantSemanticEvidence } from './assistantSemanticEvidenceBinder.js';
import {
  adaptUnifiedPlanToFinance,
  adaptUnifiedPlanToMemory,
  adaptUnifiedPlanToTool
} from './domainPlanAdapters.js';
import { createAssistantSemanticIngress } from './assistantSemanticIngress.js';
import { createAssistantSemanticPlanner } from './assistantSemanticPlanner.js';
import { validateProviderPlanCandidate } from './providerPlanCandidateSchema.js';
import { validateFormatOnlyProviderPlanRepair } from './providerPlanSchemaRepair.js';
import { canonicalizeUnifiedProviderPlan } from './unifiedProviderPlanCanonicalizer.js';

function memoryPlan(overrides = {}) {
  return {
    domain: 'memory',
    intent: 'state_fact',
    action: 'add',
    entity: { type: 'person', reference: '女儿', relation_to_owner: 'daughter' },
    relation_to_owner: 'daughter',
    predicate: 'birth_date',
    value: { year: 2012, month: 6, day: 8 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: ['entity.relation_to_owner', 'predicate', 'value.year', 'value.month', 'value.day'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.98,
    requires_confirmation: true,
    source_spans: null,
    source_message_id: null,
    ...overrides
  };
}

test('Unified Semantic Plan schema is domain-neutral, ownerless and canonicalizes empty evidence containers', () => {
  const parsed = parseAssistantSemanticPlanResponse(JSON.stringify(memoryPlan()));
  assert.equal(parsed.valid, true, JSON.stringify(parsed.errors));
  assert.deepEqual(parsed.value.source_spans, []);
  assert.equal(Object.hasOwn(parsed.value, 'owner_id'), false);

  const finance = validateAssistantSemanticPlan(memoryPlan({
    domain: 'finance',
    intent: 'create',
    action: 'create',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: 'ledger_entry',
    value: { direction: 'income', amount_text: '100' },
    qualifiers: { period_type: 'today' },
    arguments: { metrics: ['income'] }
  }));
  assert.equal(finance.valid, true, JSON.stringify(finance.errors));

  const tool = validateAssistantSemanticPlan(memoryPlan({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'convert_calendar_date',
    predicate: 'birthday',
    tool: 'calendar.convert',
    arguments: { target_year_reference: 'this_year' }
  }));
  assert.equal(tool.valid, true, JSON.stringify(tool.errors));
});

test('Unified Semantic Plan rejects owner authority, malformed types and unknown fields', () => {
  assert.equal(validateAssistantSemanticPlan({ ...memoryPlan(), owner_id: 'forged' }).valid, false);
  assert.equal(validateAssistantSemanticPlan(memoryPlan({ explicit_fields: 'predicate' })).valid, false);
  assert.equal(validateAssistantSemanticPlan(memoryPlan({ arguments: 'invalid' })).valid, false);
  assert.equal(validateAssistantSemanticPlan({ ...memoryPlan(), test_sentence_switch: true }).valid, false);
});

test('Provider Candidate Schema permits only explicitly inherited tool identity while final plan schema remains strict', () => {
  const inheritedTool = memoryPlan({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'convert_calendar_date',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    tool: null,
    inherited_fields: ['relation_to_owner', 'predicate', 'tool']
  });
  assert.equal(validateProviderPlanCandidate(inheritedTool).valid, true);
  assert.equal(validateAssistantSemanticPlan(inheritedTool).valid, false);
  assert.equal(validateProviderPlanCandidate({
    ...inheritedTool,
    inherited_fields: []
  }).valid, false);
});

test('RED: Provider Candidate Schema normalizes only structurally empty neutral containers', () => {
  const ordinary = validateProviderPlanCandidate(memoryPlan({
    domain: 'ordinary_chat',
    intent: 'greeting',
    action: 'respond',
    entity: {},
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: [],
    tool: null,
    arguments: [],
    required_evidence: null,
    explicit_fields: [],
    inherited_fields: [],
    ambiguity_reasons: [],
    requires_confirmation: false
  }));
  assert.equal(ordinary.valid, true, JSON.stringify(ordinary.errors));
  assert.deepEqual(ordinary.value.entity, {
    type: null,
    reference: null,
    relation_to_owner: null
  });
  assert.deepEqual(ordinary.value.qualifiers, {});
  assert.deepEqual(ordinary.value.arguments, {});
  assert.deepEqual(ordinary.value.required_evidence, []);

  const nonEmptyContainer = validateProviderPlanCandidate(memoryPlan({
    qualifiers: ['must-not-be-dropped']
  }));
  assert.equal(nonEmptyContainer.valid, false);
  assert.deepEqual(nonEmptyContainer.errors, ['qualifiers: expected object']);
});

test('RED: Provider Candidate Schema deterministically projects explicit tool invocations out of a memory continuation', () => {
  const argumentsValue = {
    source_calendar: 'lunar',
    target_calendar: 'gregorian',
    target_year_reference: 'this_year',
    target_year: null,
    occurrence: 'specified_year'
  };
  const stringTool = validateProviderPlanCandidate(memoryPlan({
    domain: 'memory',
    intent: 'query',
    action: 'memory.query',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: null,
    tool: 'calendar.convert',
    arguments: argumentsValue,
    inherited_fields: ['entity', 'relation_to_owner', 'predicate']
  }));
  assert.equal(stringTool.valid, true, JSON.stringify(stringTool.errors));
  assert.equal(stringTool.value.domain, 'tool');
  assert.equal(stringTool.value.action, 'calendar.convert');
  assert.equal(stringTool.value.tool, 'calendar.convert');
  assert.deepEqual(stringTool.value.arguments, argumentsValue);
  const canonical = canonicalizeUnifiedProviderPlan(stringTool.value, {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    message: '今年对应阳历哪一天',
    trustedContext: {
      owner_id: 'owner-a',
      conversation_id: 'conversation-a',
      active_entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
      active_predicate: 'birthday',
      active_domain: 'memory',
      active_arguments: {}
    }
  });
  assert.equal(canonical.ok, true, canonical.code);
  assert.equal(canonical.plan.domain, 'tool');
  assert.equal(canonical.plan.action, 'calendar.convert');
  assert.deepEqual(canonical.plan.required_evidence, [{
    entity_relation: 'mother',
    predicate: 'birthday',
    required_qualifiers: ['calendar_type', 'month', 'day']
  }]);
  const toolPlan = adaptUnifiedPlanToTool(canonical.plan);
  assert.equal(toolPlan.ok, true);
  assert.equal(toolPlan.plan.action, 'convert_calendar_date');
  assert.deepEqual(toolPlan.plan.arguments, argumentsValue);

  const descriptorEnvelope = validateProviderPlanCandidate(memoryPlan({
    domain: 'memory',
    intent: 'query',
    action: 'memory.query',
    value: null,
    tool: {
      id: 'calendar.convert',
      description: 'registered deterministic calendar converter',
      arguments: argumentsValue,
      required_evidence: [{
        source: 'owner_scoped_memory',
        predicates: ['birthday'],
        qualifiers: ['calendar_type', 'month', 'day'],
        status: 'confirmed_current'
      }]
    },
    arguments: argumentsValue,
    required_evidence: [],
    inherited_fields: ['entity', 'relation_to_owner', 'predicate']
  }));
  assert.equal(descriptorEnvelope.valid, true, JSON.stringify(descriptorEnvelope.errors));
  assert.equal(descriptorEnvelope.value.domain, 'tool');
  assert.equal(descriptorEnvelope.value.action, 'calendar.convert');
  assert.equal(descriptorEnvelope.value.tool, 'calendar.convert');
  assert.deepEqual(descriptorEnvelope.value.arguments, argumentsValue);

  const incompleteEnvelope = validateProviderPlanCandidate(memoryPlan({
    tool: { action: 'convert_calendar_date', arguments: argumentsValue }
  }));
  assert.equal(incompleteEnvelope.valid, false);

  const conflictingEnvelope = validateProviderPlanCandidate(memoryPlan({
    tool: {
      id: 'calendar.convert',
      arguments: { ...argumentsValue, target_year_reference: 'next_year' },
      required_evidence: []
    },
    arguments: argumentsValue
  }));
  assert.equal(conflictingEnvelope.valid, false);

  const unknownTool = validateProviderPlanCandidate(memoryPlan({
    tool: 'calendar.unknown',
    arguments: argumentsValue
  }));
  assert.equal(unknownTool.valid, true, JSON.stringify(unknownTool.errors));
  assert.equal(canonicalizeUnifiedProviderPlan(unknownTool.value, {
    ownerId: 'owner-a',
    conversationId: 'conversation-a'
  }).ok, false);
});

test('Evidence Binder binds source identity, drops invalid span hints and gives explicit fields precedence', () => {
  const bound = bindAssistantSemanticEvidence(memoryPlan({
    source_spans: [{ text: 'wrong', start: 99, end: 100 }],
    inherited_fields: ['predicate', 'qualifiers.calendar_type']
  }), {
    message: '我女儿出生于2012年6月8日',
    sourceMessageId: 'message-1',
    ownerId: 'owner-a',
    trustedContext: {
      owner_id: 'owner-a',
      conversation_id: 'conversation-a',
      values: { predicate: 'birthday', 'qualifiers.calendar_type': 'lunar' }
    }
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.plan.source_message_id, 'message-1');
  assert.deepEqual(bound.plan.source_spans, [{ text: '我女儿出生于2012年6月8日', start: 0, end: 15 }]);
  assert.equal(bound.plan.predicate, 'birth_date');
  assert.equal(bound.plan.qualifiers.calendar_type, 'unknown');
  assert.equal(bound.auditReasons.includes('source_span_mismatch'), true);
  assert.equal(Object.hasOwn(bound.plan, 'owner_id'), false);
});

test('Memory adapter treats calendar type as non-critical and maps birth_date to existing birthday storage contract', () => {
  const adapted = adaptUnifiedPlanToMemory(memoryPlan(), { message: '我女儿出生于2012年6月8日' });
  assert.equal(adapted.ok, true);
  assert.equal(adapted.plan.intent, 'memory_candidate');
  assert.equal(adapted.plan.predicate, 'birthday');
  assert.equal(adapted.plan.qualifiers.calendar_type, 'unknown');
  assert.equal(adapted.plan.qualifiers.year, 2012);
  assert.equal(adapted.plan.qualifiers.month, 6);
  assert.equal(adapted.plan.qualifiers.day, 8);
  assert.equal(adapted.plan.qualifiers.recurrence, 'one_time');
  assert.equal(adapted.plan.requires_confirmation, false);
});

test('Domain adapters preserve deterministic Finance and Calendar contracts without owner authority', () => {
  const finance = adaptUnifiedPlanToFinance(memoryPlan({
    domain: 'finance',
    intent: 'create',
    action: 'create',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: 'ledger_entry',
    value: { direction: 'income', amount_text: '100' },
    qualifiers: { period_type: 'today', period_expression: null, category: null },
    arguments: { metrics: ['income'], transaction_candidate: { direction: 'income', amount_text: '100', occurred_expression: null } }
  }), { message: '收入100' });
  assert.equal(finance.ok, true);
  assert.deepEqual(finance.plan.metrics, ['income']);
  assert.equal(finance.plan.transaction_candidate.direction, 'income');

  const tool = adaptUnifiedPlanToTool(memoryPlan({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'convert_calendar_date',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    tool: 'calendar.convert',
    arguments: {
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
    }]
  }), { sourceMessageId: 'source-calendar' });
  assert.equal(tool.ok, true);
  assert.equal(tool.plan.tool, 'calendar.convert');
  assert.equal(tool.plan.source_message_id, 'source-calendar');
});

function routeResult(provider = 'deepseek', model = 'deepseek-v4-flash') {
  return {
    requestId: 'req-plan',
    executionId: 'exec-plan',
    idempotencyKey: 'idem-plan',
    selectedProvider: provider,
    selectedModel: model,
    routeTrace: [{
      requestId: 'req-plan',
      executionId: 'exec-plan',
      attemptId: 'attempt-plan',
      attemptNumber: 1,
      attemptType: 'planning',
      providerId: provider,
      modelId: model,
      domain: 'memory',
      success: true
    }]
  };
}

test('valid DeepSeek Candidate uses exactly one planning call and no schema repair', async () => {
  const calls = [];
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run(request) {
        calls.push(['run', request]);
        return { ok: true, content: JSON.stringify(memoryPlan()), route: routeResult() };
      },
      async repairSchema() {
        calls.push(['repair']);
        throw new Error('must not repair valid output');
      }
    }
  });
  const result = await planner.plan({
    message: '我女儿出生于2012年6月8日',
    sourceMessageId: 'message-1',
    routeDomain: 'memory'
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(calls.map(([type]) => type), ['run']);
});

test('deterministic local envelope repair keeps Provider calls at one', async () => {
  const calls = [];
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run(request) {
        calls.push(['run', request]);
        return {
          ok: true,
          content: JSON.stringify({ plan: memoryPlan() }),
          route: routeResult()
        };
      },
      async repairSchema() {
        calls.push(['repair']);
        throw new Error('local repair must precede Provider repair');
      }
    }
  });
  const result = await planner.plan({
    message: '我女儿出生于2012年6月8日',
    sourceMessageId: 'message-1',
    routeDomain: 'memory'
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.repair, 'local');
  assert.deepEqual(calls.map(([type]) => type), ['run']);
});

test('structural-only failure uses one same-DeepSeek format repair and preserves route identity', async () => {
  const calls = [];
  const raw = JSON.stringify(memoryPlan({
    qualifiers: [{ calendar_type: 'unknown', recurrence: 'one_time' }]
  }));
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run(request) {
        calls.push(['run', request]);
        return { ok: true, content: raw, route: routeResult() };
      },
      async repairSchema(request) {
        calls.push(['repair', request]);
        return {
          ok: true,
          content: JSON.stringify(memoryPlan()),
          route: {
            ...routeResult(),
            routeTrace: [
              routeResult().routeTrace[0],
              {
                requestId: 'req-plan',
                executionId: 'exec-plan',
                attemptId: 'attempt-repair',
                attemptNumber: 2,
                attemptType: 'schema_repair',
                providerId: 'deepseek',
                modelId: 'deepseek-v4-flash',
                domain: 'memory',
                success: true
              }
            ]
          }
        };
      }
    }
  });
  const result = await planner.plan({
    message: '我女儿出生于2012年6月8日',
    sourceMessageId: 'message-1',
    contextPack: { owner_id: 'must-not-leak', recent_messages: [] },
    routeDomain: 'memory'
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(calls.map(([type]) => type), ['run', 'repair']);
  assert.equal(calls[0][1].metadata.routeDomain, 'memory');
  assert.equal(calls[1][1].rawContent, raw);
  assert.equal(calls[1][1].route.requestId, 'req-plan');
  assert.equal(calls[1][1].route.executionId, 'exec-plan');
  assert.equal(result.route.routeTrace[1].attemptType, 'schema_repair');
  assert.equal(JSON.stringify(calls).includes('must-not-leak'), false);
});

test('schema repair that adds a new amount is rejected', async () => {
  const rawPlan = memoryPlan({
    domain: 'finance',
    intent: 'create',
    action: 'create',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: 'ledger_entry',
    value: { direction: 'expense', amount_text: '18' },
    qualifiers: [{ relative_day_offset: 0 }],
    arguments: { metrics: ['expense'] }
  });
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run() {
        return { ok: true, content: JSON.stringify(rawPlan), route: routeResult() };
      },
      async repairSchema() {
        return {
          ok: true,
          content: JSON.stringify({
            ...rawPlan,
            value: { direction: 'expense', amount_text: '86' },
            qualifiers: { relative_day_offset: 0 }
          }),
          route: routeResult()
        };
      }
    }
  });
  const result = await planner.plan({ message: '今天打车花了18元', routeDomain: 'finance' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ASSISTANT_SEMANTIC_REPAIR_SEMANTICS_CHANGED');
  assert.equal(result.attempts, 2);
});

test('format-only repair may duplicate an existing relation into a required field without creating a new fact', () => {
  const original = memoryPlan({
    relation_to_owner: undefined,
    qualifiers: [{ calendar_type: 'unknown', recurrence: 'one_time' }]
  });
  const repaired = memoryPlan({
    relation_to_owner: 'daughter',
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' }
  });
  const result = validateFormatOnlyProviderPlanRepair({
    originalContent: JSON.stringify(original),
    repairedContent: JSON.stringify(repaired)
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('invalid repaired Candidate stops after the second Provider call', async () => {
  const calls = [];
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run() {
        calls.push('run');
        return {
          ok: true,
          content: JSON.stringify(memoryPlan({ qualifiers: [{ calendar_type: 'unknown' }] })),
          route: routeResult()
        };
      },
      async repairSchema() {
        calls.push('repair');
        return { ok: true, content: '{}', route: routeResult() };
      }
    }
  });
  const result = await planner.plan({ message: '我女儿生日是6月8日', routeDomain: 'memory' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ASSISTANT_SEMANTIC_PLAN_INVALID');
  assert.equal(result.attempts, 2);
  assert.deepEqual(calls, ['run', 'repair']);
});

test('true ambiguity never enters schema repair', async () => {
  let repairs = 0;
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run() {
        return {
          ok: true,
          content: JSON.stringify(memoryPlan({
            domain: 'ambiguous',
            intent: 'ambiguous',
            action: 'ambiguous',
            qualifiers: ['invalid-shape'],
            ambiguity_reasons: ['missing target'],
            requires_confirmation: true
          })),
          route: routeResult()
        };
      },
      async repairSchema() { repairs += 1; }
    }
  });
  const result = await planner.plan({ message: '帮我处理一下', routeDomain: 'semantic_planner' });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(repairs, 0);
});

test('Memory evidence insufficiency reaches the evidence boundary without schema repair', async () => {
  let repairs = 0;
  const plan = memoryPlan({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'calendar.next_occurrence',
    predicate: 'birthday',
    value: null,
    tool: 'calendar.next_occurrence',
    qualifiers: {},
    arguments: { occurrence: 'next' },
    required_evidence: [{
      entity_relation: 'mother',
      predicate: 'birthday',
      required_qualifiers: ['calendar_type', 'month', 'day']
    }]
  });
  const ingress = createAssistantSemanticIngress({
    planner: createAssistantSemanticPlanner({
      aiService: {
        async run() {
          return { ok: true, content: JSON.stringify(plan), route: routeResult() };
        },
        async repairSchema() { repairs += 1; }
      }
    }),
    canonicalizer() {
      return { ok: false, code: 'MEMORY_EVIDENCE_NOT_FOUND' };
    }
  });
  const result = await ingress.interpret({
    message: '妈妈下一个生日是哪天',
    ownerId: 'owner-a',
    sourceMessageId: 'source-a'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MEMORY_EVIDENCE_NOT_FOUND');
  assert.equal(repairs, 0);
});

test('Calendar qualifier absence is not repaired or fabricated', async () => {
  let repairs = 0;
  const plan = memoryPlan({
    domain: 'tool',
    intent: 'invoke_tool',
    action: 'calendar.convert',
    predicate: 'birthday',
    value: null,
    qualifiers: {},
    tool: 'calendar.convert',
    arguments: { target_calendar: 'gregorian' },
    required_evidence: []
  });
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run() {
        return { ok: true, content: JSON.stringify(plan), route: routeResult() };
      },
      async repairSchema() { repairs += 1; }
    }
  });
  const result = await planner.plan({ message: '换算一下生日', routeDomain: 'calendar' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.qualifiers, {});
  assert.equal(repairs, 0);
});

test('Finance execution-stage structural failure cannot repair or retry', async () => {
  let repairs = 0;
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run() {
        return {
          ok: true,
          content: JSON.stringify(memoryPlan({ qualifiers: [{ relative_day_offset: 0 }] })),
          route: routeResult()
        };
      },
      async repairSchema() { repairs += 1; }
    }
  });
  const result = await planner.plan({
    message: '今天花了18元',
    routeDomain: 'finance',
    businessExecutionStarted: true,
    businessWriteStarted: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(repairs, 0);
});

test('Qwen result can never enter schema repair', async () => {
  let repairs = 0;
  const planner = createAssistantSemanticPlanner({
    aiService: {
      async run() {
        return {
          ok: true,
          content: JSON.stringify(memoryPlan({ qualifiers: [{ calendar_type: 'unknown' }] })),
          route: routeResult('qwen', 'qwen-max')
        };
      },
      async repairSchema() { repairs += 1; }
    }
  });
  const result = await planner.plan({ message: '我女儿生日是6月8日', routeDomain: 'semantic_planner' });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(repairs, 0);
});

test('RED: Unified Ingress canonicalizes Provider values before deterministic evidence and domain contracts', async () => {
  const ingress = createAssistantSemanticIngress({
    planner: {
      async plan() {
        return {
          ok: true,
          attempts: 1,
          source: 'provider',
          plan: memoryPlan({ value: '2012-06-08' })
        };
      }
    }
  });
  const result = await ingress.interpret({
    message: '一条明确的出生日期事实',
    sourceMessageId: 'message-canonical',
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    trustedContext: {
      owner: 'owner-a',
      conversation: 'conversation-a'
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.canonical_value, {
    type: 'date',
    year: 2012,
    month: 6,
    day: 8
  });
  assert.equal(result.plan.action, 'memory.capture');
  assert.equal(result.canonicalAudit.raw_value_type, 'string');
  assert.equal(Object.hasOwn(result.canonicalAudit, 'raw_value'), false);
});

test('RED: domain adapters consume typed canonical values and canonical actions without bypassing existing contracts', () => {
  const memory = adaptUnifiedPlanToMemory({
    ...memoryPlan(),
    action: 'memory.capture',
    value: undefined,
    canonical_value: { type: 'date', year: 2012, month: 6, day: 8 },
    canonical_arguments: {}
  });
  assert.equal(memory.ok, true);
  assert.deepEqual(memory.plan.value, { year: 2012, month: 6, day: 8 });

  const finance = adaptUnifiedPlanToFinance({
    ...memoryPlan({
      domain: 'finance',
      intent: 'create',
      action: 'finance.create',
      entity: { type: null, reference: null, relation_to_owner: null },
      relation_to_owner: null,
      predicate: 'ledger_entry',
      value: undefined,
      qualifiers: {}
    }),
    canonical_value: {
      type: 'object',
      fields: { direction: 'income', amount_text: '100' }
    },
    canonical_arguments: {
      metrics: ['income'],
      transaction_candidate: { direction: 'income', amount_text: '100', occurred_expression: null }
    }
  }, { message: '一条收入事实' });
  assert.equal(finance.ok, true);
  assert.equal(finance.plan.action, 'create');
  assert.equal(finance.plan.transaction_candidate.amount_text, '100');

  const tool = adaptUnifiedPlanToTool({
    ...memoryPlan({
      domain: 'tool',
      intent: 'invoke_tool',
      action: 'calendar.days_until',
      tool: 'calendar.convert',
      value: null,
      relation_to_owner: 'mother',
      predicate: 'birthday'
    }),
    canonical_value: null,
    canonical_arguments: { occurrence: 'next' }
  });
  assert.equal(tool.ok, true);
  assert.equal(tool.plan.action, 'days_until');
  assert.deepEqual(tool.plan.arguments, { occurrence: 'next' });
});
