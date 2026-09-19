import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticMemoryPlanner } from './semanticMemoryPlanner.js';
import { evaluateSemanticMemoryContract } from './semanticMemoryContract.js';

const text = '请记录我妈妈是阴历7月16日生日';

function validPlan() {
  return {
    intent: 'memory_candidate',
    subject: { entity_type: 'person', relation_to_owner: 'mother', normalized_reference: '妈妈', resolved_entity_hint: null },
    predicate: 'birthday', value: { year: null, month: 7, day: 16 },
    qualifiers: {
      calendar_type: 'lunar', year: null, month: 7, day: 16, lunar_leap_month: 'unknown',
      temporal_scope: 'stable', recurrence: 'yearly', degree: 'normal', cardinality: 'single',
      negation: false, uncertainty: false
    },
    confidence: 0.98,
    source_spans: [{ text, start: 0, end: text.length }],
    ambiguity_reasons: [], requires_confirmation: false,
    inherited_context: { previous_entity: null, previous_predicate: null, previously_returned_values: [] }
  };
}

test('planner allows only one structured repair and returns the valid second plan', async () => {
  const calls = [];
  const aiService = { async run(request) {
    calls.push(request);
    return { ok: true, content: calls.length === 1 ? '{"intent":"memory_candidate"}' : JSON.stringify(validPlan()) };
  } };
  const planner = createSemanticMemoryPlanner({ aiService });
  const result = await planner.plan({ message: text, contextPack: { recent_messages: [] } });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
});

test('planner repairs a memory query whose structurally present predicate is null', async () => {
  const queryText = '我女儿最喜欢什么？';
  const queryPlan = {
    ...validPlan(),
    intent: 'memory_query',
    predicate: 'favorite_food',
    value: null,
    source_spans: [{ text: queryText, start: 0, end: queryText.length }]
  };
  const calls = [];
  const aiService = { async run(request) {
    calls.push(request);
    return {
      ok: true,
      content: JSON.stringify(calls.length === 1 ? { ...queryPlan, predicate: null } : queryPlan)
    };
  } };

  const result = await createSemanticMemoryPlanner({ aiService }).plan({
    message: queryText,
    contextPack: { recent_messages: [] }
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.predicate, 'favorite_food');
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
});

test('planner repairs an explicit preference negation misclassified as correction', async () => {
  const negationText = '不是苹果，她不喜欢苹果';
  const negationPlan = {
    ...validPlan(),
    intent: 'memory_negation',
    subject: { ...validPlan().subject, relation_to_owner: 'daughter', normalized_reference: '女儿' },
    predicate: 'likes_food',
    value: ['苹果'],
    qualifiers: { ...validPlan().qualifiers, cardinality: 'multiple', negation: true },
    source_spans: [{ text: negationText, start: 0, end: negationText.length }],
    inherited_context: {
      previous_entity: 'daughter', previous_predicate: 'likes_food', previously_returned_values: []
    }
  };
  const calls = [];
  const result = await createSemanticMemoryPlanner({ aiService: { async run() {
    calls.push(true);
    return {
      ok: true,
      content: JSON.stringify(calls.length === 1
        ? { ...negationPlan, intent: 'memory_correction', qualifiers: { ...negationPlan.qualifiers, negation: false } }
        : negationPlan)
    };
  } } }).plan({
    message: negationText,
    contextPack: { inherited_context: negationPlan.inherited_context }
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.intent, 'memory_negation');
  assert.equal(result.plan.qualifiers.negation, true);
  assert.equal(result.attempts, 2);
});

test('planner repair makes current negation outrank an inherited favorite predicate', async () => {
  const negationText = '不是苹果，她不喜欢苹果';
  const inherited = {
    previous_entity: 'daughter', previous_predicate: 'favorite_food', previously_returned_values: []
  };
  const wrongPlan = {
    ...validPlan(),
    intent: 'memory_correction',
    subject: { ...validPlan().subject, relation_to_owner: 'daughter', normalized_reference: '女儿' },
    predicate: 'likes_food',
    value: ['苹果'],
    qualifiers: { ...validPlan().qualifiers, cardinality: 'multiple', negation: true },
    source_spans: [{ text: negationText, start: 0, end: negationText.length }],
    inherited_context: inherited
  };
  const correctedPlan = {
    ...wrongPlan,
    intent: 'memory_negation'
  };
  const calls = [];
  const result = await createSemanticMemoryPlanner({ aiService: { async run(request) {
    calls.push(request);
    const repair = request.messages.at(-1)?.content || '';
    const currentTextWins = repair.includes('当前用户原文优先于继承上下文');
    const correctionForbidden = repair.includes('不得继续输出memory_correction');
    const ordinaryLikePredicateRequired = repair.includes('必须使用likes_谓词');
    return {
      ok: true,
      content: JSON.stringify(calls.length === 1 || !currentTextWins || !correctionForbidden || !ordinaryLikePredicateRequired
        ? { ...wrongPlan, predicate: 'favorite_food' }
        : correctedPlan)
    };
  } } }).plan({
    message: negationText,
    contextPack: { inherited_context: inherited }
  });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.plan.intent, 'memory_negation');
  assert.equal(result.attempts, 2);
});

test('planner uses its single retry to recheck a valid but ambiguous model result', async () => {
  const ambiguous = {
    ...validPlan(),
    intent: 'ambiguous',
    confidence: 0.7,
    ambiguity_reasons: ['model_requested_unnecessary_confirmation'],
    requires_confirmation: true
  };
  const calls = [];
  const aiService = { async run(request) {
    calls.push(request);
    return { ok: true, content: JSON.stringify(calls.length === 1 ? ambiguous : validPlan()) };
  } };

  const result = await createSemanticMemoryPlanner({ aiService }).plan({ message: text, contextPack: { recent_messages: [] } });
  assert.equal(result.ok, true);
  assert.equal(result.plan.intent, 'memory_candidate');
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /结构合法但语义被标为需要确认/);
});

test('planner remains fail closed when the ambiguity review still requires confirmation', async () => {
  const ambiguous = {
    ...validPlan(),
    intent: 'ambiguous',
    confidence: 0.7,
    ambiguity_reasons: ['subject_not_explicit'],
    requires_confirmation: true
  };
  let calls = 0;
  const result = await createSemanticMemoryPlanner({ aiService: { async run() {
    calls += 1;
    return { ok: true, content: JSON.stringify(ambiguous) };
  } } }).plan({ message: text, contextPack: { recent_messages: [] } });
  assert.equal(result.ok, true);
  assert.equal(result.plan.intent, 'ambiguous');
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('planner repair gives the provider exact enum and source-span constraints seen in real output', async () => {
  const invalidPlan = {
    ...validPlan(),
    predicate: '生日',
    qualifiers: {
      ...validPlan().qualifiers, year: 'unknown', degree: null, cardinality: null,
      temporal_scope: null, uncertainty: 'false'
    },
    inherited_context: { ...validPlan().inherited_context, previously_returned_values: null },
    source_spans: [
      { text: '我妈妈', start: 1, end: 4 },
      { text: '阴历7月16日', start: 7, end: 14 }
    ]
  };
  const calls = [];
  const aiService = { async run(request) {
    calls.push(request);
    if (calls.length === 1) return { ok: true, content: JSON.stringify(invalidPlan) };
    const repair = request.messages.at(-1)?.content || '';
    const hasExactEnums = repair.includes('degree=normal') && repair.includes('cardinality=single');
    const hasNullYearRule = repair.includes('year=null');
    const hasStrictTypes = repair.includes('uncertainty=false') && repair.includes('previously_returned_values=[]');
    const hasTemporalScope = repair.includes('temporal_scope=stable');
    const hasCanonicalPredicate = repair.includes('predicate=birthday');
    const hasExactSpanRule = repair.includes(`source_spans=[{\"text\":${JSON.stringify(text)},\"start\":0,\"end\":${text.length}}]`);
    return { ok: true, content: JSON.stringify(
      hasExactEnums && hasNullYearRule && hasStrictTypes && hasTemporalScope && hasCanonicalPredicate && hasExactSpanRule
        ? validPlan() : invalidPlan
    ) };
  } };

  const result = await createSemanticMemoryPlanner({ aiService }).plan({ message: text, contextPack: { recent_messages: [] } });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.attempts, 2);
});

test('planner failure and a third response can never authorize a write', async () => {
  let calls = 0;
  const planner = createSemanticMemoryPlanner({ aiService: { async run() { calls += 1; return { ok: true, content: '{}' }; } } });
  const result = await planner.plan({ message: text, contextPack: { recent_messages: [] } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SEMANTIC_PLAN_INVALID');
  assert.equal(calls, 2);
});

test('contract creates a lunar birthday structured value without an SQLite schema migration', () => {
  const result = evaluateSemanticMemoryContract({ plan: validPlan(), existingRecords: [] });
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.predicate, 'birthday');
  assert.deepEqual(result.structuredValue, {
    date: '2000-07-16', calendarType: 'lunar', year: null, month: 7, day: 16,
    lunarLeapMonth: 'unknown', recurrence: 'yearly'
  });
});

test('contract maps preference sets to MERGE, corrections to SUPERSEDE and ambiguous input to ASK', () => {
  const likes = { ...validPlan(), predicate: 'likes_food', value: ['草莓'], qualifiers: { ...validPlan().qualifiers, cardinality: 'multiple' } };
  assert.equal(evaluateSemanticMemoryContract({ plan: likes, existingRecords: [{ structuredValue: { value: '苹果', values: ['苹果'] } }] }).decision, 'MERGE');
  assert.equal(evaluateSemanticMemoryContract({ plan: { ...validPlan(), intent: 'memory_correction' }, existingRecords: [{}] }).decision, 'SUPERSEDE');
  assert.equal(evaluateSemanticMemoryContract({ plan: {
    ...validPlan(), intent: 'ambiguous', requires_confirmation: true, ambiguity_reasons: ['missing_day']
  }, existingRecords: [] }).decision, 'ASK');
});

test('contract rejects prohibited secrets and asks before any high-sensitivity write', () => {
  const preference = {
    ...validPlan(), predicate: 'likes_food', value: ['测试值'],
    qualifiers: { ...validPlan().qualifiers, cardinality: 'multiple' }
  };
  const prohibited = evaluateSemanticMemoryContract({
    plan: preference, existingRecords: [], sourceText: '请记住我的密码是测试值'
  });
  assert.equal(prohibited.decision, 'REJECT');
  assert.ok(prohibited.reasonCodes.includes('prohibited_secret'));
  const sensitive = evaluateSemanticMemoryContract({
    plan: preference, existingRecords: [], sourceText: '请记住我的健康诊断是测试值'
  });
  assert.equal(sensitive.decision, 'ASK');
  assert.ok(sensitive.reasonCodes.includes('sensitive_information'));
});

test('all canonical favorite predicates remain separate single-value preferences', () => {
  const favorite = {
    ...validPlan(), predicate: 'favorite_activity', value: ['游泳'],
    qualifiers: { ...validPlan().qualifiers, cardinality: 'single', degree: 'favorite' }
  };
  const result = evaluateSemanticMemoryContract({ plan: favorite, existingRecords: [] });
  assert.equal(result.predicate, 'favorite_preference_statement');
  assert.deepEqual(result.structuredValue, { value: '游泳' });
});
