import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deterministicGroundedAnswer } from './groundedMemoryResponder.js';
import { createProtectedMemoryRuntime } from './protectedMemoryRuntime.js';

const ACTION_ID = 'M11_SEMANTIC_MEMORY_ORCHESTRATOR_V1';

function authorization(databasePath, originalPath) {
  return {
    scope: 'local-m9-2-acceptance', environment: 'local-m9-2-acceptance',
    database_kind: 'isolated_acceptance_memory', database_path: databasePath,
    owner_source: 'authenticated_session',
    allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
    original_memory_database: { path: originalPath, access: 'read_only' },
    cross_owner_access: 'denied', migration_allowed: false, bulk_import_allowed: false,
    active_action_ids: [ACTION_ID]
  };
}

function qualifiers(overrides = {}) {
  return {
    calendar_type: 'unknown', year: null, month: null, day: null,
    lunar_leap_month: 'unknown', temporal_scope: 'stable', recurrence: 'unknown',
    degree: 'normal', cardinality: 'single', negation: false, uncertainty: false,
    ...overrides
  };
}

function plan(message, { intent = 'memory_candidate', relation = 'mother', predicate = 'birthday',
  value = null, qualifierOverrides = {}, inherited = {} } = {}) {
  return {
    intent,
    subject: { entity_type: 'person', relation_to_owner: relation, normalized_reference: relation, resolved_entity_hint: null },
    predicate,
    value,
    qualifiers: qualifiers(qualifierOverrides),
    confidence: 0.98,
    source_spans: [{ text: message, start: 0, end: message.length }],
    ambiguity_reasons: [], requires_confirmation: false,
    inherited_context: {
      previous_entity: inherited.previous_entity || null,
      previous_predicate: inherited.previous_predicate || null,
      previously_returned_values: inherited.previously_returned_values || []
    }
  };
}

function semanticPlans() {
  const values = new Map();
  const put = (message, options) => values.set(message, plan(message, options));
  put('请记录我妈妈是阴历7月16日生日', {
    value: { year: null, month: 7, day: 16 },
    qualifierOverrides: { calendar_type: 'lunar', month: 7, day: 16, recurrence: 'yearly' }
  });
  put('我妈妈什么时候生日？', { intent: 'memory_query', value: null });
  put('我妈妈7月16日生日', {
    value: { year: null, month: 7, day: 16 }, qualifierOverrides: { month: 7, day: 16, recurrence: 'yearly' }
  });
  put('刚才那个日期是阴历的', {
    intent: 'memory_correction', value: null,
    qualifierOverrides: { calendar_type: 'lunar' },
    inherited: { previous_entity: 'mother', previous_predicate: 'birthday' }
  });
  put('我说错了，我妈妈是农历7月17日生日', {
    intent: 'memory_correction', value: { year: null, month: 7, day: 17 },
    qualifierOverrides: { calendar_type: 'lunar', month: 7, day: 17, recurrence: 'yearly' }
  });
  put('我女儿喜欢苹果', {
    relation: 'daughter', predicate: 'likes_food', value: ['苹果'],
    qualifierOverrides: { cardinality: 'multiple' }
  });
  put('她也喜欢草莓', {
    relation: 'daughter', predicate: 'likes_food', value: ['草莓'],
    qualifierOverrides: { cardinality: 'multiple' }, inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food' }
  });
  put('她喜欢什么？', {
    intent: 'memory_query', relation: 'daughter', predicate: 'likes_food',
    inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food' }
  });
  put('我女儿喜欢什么？', {
    intent: 'memory_query', relation: 'daughter', predicate: 'likes_food'
  });
  put('还有呢', {
    intent: 'memory_query', relation: 'daughter', predicate: 'likes_food',
    inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food', previously_returned_values: ['苹果', '草莓'] }
  });
  put('还有呢？', {
    intent: 'memory_query', relation: 'daughter', predicate: 'likes_food',
    inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food', previously_returned_values: [] }
  });
  put('还喜欢什么？', {
    intent: 'memory_query', relation: 'daughter', predicate: 'likes_food', value: null,
    inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food', previously_returned_values: [] }
  });
  put('我爸爸什么时候生日？', { intent: 'memory_query', relation: 'father', predicate: 'birthday' });
  put('不是苹果，她不喜欢苹果', {
    intent: 'memory_negation', relation: 'daughter', predicate: 'likes_food', value: ['苹果'],
    qualifierOverrides: { cardinality: 'multiple', negation: true },
    inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food' }
  });
  put('她最喜欢草莓', {
    relation: 'daughter', predicate: 'favorite_food', value: '草莓',
    qualifierOverrides: { degree: 'favorite', cardinality: 'single' },
    inherited: { previous_entity: 'daughter' }
  });
  put('她最喜欢什么？', {
    intent: 'memory_query', relation: 'daughter', predicate: 'favorite_food',
    inherited: { previous_entity: 'daughter' }
  });
  put('删除我妈妈的生日记录', { intent: 'memory_delete', relation: 'mother', predicate: 'birthday' });
  put('今年妈妈生日对应公历哪一天？', {
    intent: 'memory_query', relation: 'mother', predicate: 'birthday',
    qualifierOverrides: { calendar_type: 'gregorian', temporal_scope: 'this_year' }
  });
  return values;
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-semantic-memory-'));
  const databasePath = path.join(root, 'memory.sqlite');
  const originalPath = path.join(root, 'original.sqlite');
  fs.writeFileSync(originalPath, 'protected');
  const plans = semanticPlans();
  const plannerCalls = [];
  const responderCalls = [];
  let tick = 0;
  const open = () => createProtectedMemoryRuntime({
    databasePath, repositoryRoot: process.cwd(),
    authorization: authorization(databasePath, originalPath), scope: 'local-m9-2-acceptance', actionId: ACTION_ID,
    now: () => new Date(Date.UTC(2026, 6, 20, 1, 0, tick++)).toISOString(),
    semanticPlanner: {
      async plan(input) {
        plannerCalls.push(structuredClone(input));
        const value = plans.get(input.message);
        return value ? { ok: true, plan: structuredClone(value), attempts: 1, source: 'model' }
          : { ok: false, code: 'SEMANTIC_PLAN_INVALID', attempts: 2 };
      }
    },
    groundedResponder: {
      async respond({ bundle, subjectLabel }) {
        responderCalls.push(structuredClone({ bundle, subjectLabel }));
        return { answer: deterministicGroundedAnswer(bundle, subjectLabel), source: 'provider_covered' };
      }
    }
  });
  let runtime = open();
  return {
    get runtime() { return runtime; }, plannerCalls, responderCalls,
    restart() { runtime.close(); runtime = open(); },
    close() { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
  };
}

function message(runtime, text, overrides = {}) {
  return runtime.processUserMessage({
    ownerId: 'owner-a', conversationId: 'conversation-a', message: text,
    clientRequestId: overrides.clientRequestId || `client:${text}:${overrides.sequence || 0}`,
    sourceMessageId: overrides.sourceMessageId || `message:${text}:${overrides.sequence || 0}`,
    conversationMessages: overrides.conversationMessages || [], captureEligible: true,
    ...overrides
  });
}

test('model-first plan commits and recalls a lunar birthday across conversation and restart with source evidence', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const saved = await message(h.runtime, '请记录我妈妈是阴历7月16日生日', { sourceMessageId: 'message-lunar-save' });
  assert.equal(saved.outcome, 'memory_written');
  const current = h.runtime.inspectOwner('owner-a').currentMemories[0];
  assert.equal(current.structuredValue.calendarType, 'lunar');
  assert.equal(current.structuredValue.month, 7);
  assert.equal(current.structuredValue.day, 16);
  assert.equal(current.metadata.sourceMessageId, 'message-lunar-save');

  let recalled = await message(h.runtime, '我妈妈什么时候生日？', { conversationId: 'new-conversation' });
  assert.equal(recalled.safeAnswer.safeUserMessage, '你妈妈是农历七月十六生日。');
  assert.equal(recalled.evidenceBundle.evidence[0].source_message_id, 'message-lunar-save');
  h.restart();
  recalled = await message(h.runtime, '我妈妈什么时候生日？', { conversationId: 'after-restart' });
  assert.equal(recalled.safeAnswer.safeUserMessage, '你妈妈是农历七月十六生日。');
  assert.ok(h.plannerCalls.length >= 3);
  assert.ok(h.responderCalls.length >= 2);
});

test('semantic qualifier correction updates an existing birthday and explicit correction preserves history', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await message(h.runtime, '我妈妈7月16日生日', { sourceMessageId: 'message-unknown-calendar' });
  const qualifier = await message(h.runtime, '刚才那个日期是阴历的', { sourceMessageId: 'message-lunar-qualifier' });
  assert.equal(qualifier.outcome, 'memory_corrected');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories[0].structuredValue.calendarType, 'lunar');
  const corrected = await message(h.runtime, '我说错了，我妈妈是农历7月17日生日', { sourceMessageId: 'message-date-correction' });
  assert.equal(corrected.outcome, 'memory_corrected');
  const all = h.runtime.inspectOwner('owner-a').allMemories.filter((item) => item.predicate === 'birthday');
  assert.ok(all.some((item) => item.status !== 'confirmed'));
  assert.equal(all.find((item) => item.status === 'confirmed').structuredValue.day, 17);
});

test('multi-value likes merge, ten exhausted follow-ups never invent, unknown and cross-owner stay sealed', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await message(h.runtime, '我女儿喜欢苹果');
  await message(h.runtime, '她也喜欢草莓');
  const continuationCall = h.plannerCalls.find((item) => item.message === '她也喜欢草莓');
  assert.deepEqual(continuationCall.contextPack.inherited_context, {
    previous_entity: 'daughter',
    previous_predicate: 'likes_food',
    previously_returned_values: []
  });
  const likes = await message(h.runtime, '她喜欢什么？');
  assert.equal(likes.safeAnswer.safeUserMessage, '你女儿喜欢苹果和草莓。');
  for (let index = 0; index < 10; index += 1) {
    const more = await message(h.runtime, '还有呢', { sequence: index });
    assert.equal(more.safeAnswer.safeUserMessage, '我目前只记录到这些，没有更多已确认的信息。');
    assert.doesNotMatch(JSON.stringify(more), /蓝莓|橙子|西瓜/);
  }
  const unknown = await message(h.runtime, '我爸爸什么时候生日？');
  assert.equal(unknown.safeAnswer.safeUserMessage, '我目前还不知道。');
  const other = await message(h.runtime, '我妈妈什么时候生日？', { ownerId: 'owner-b', conversationId: 'other-owner' });
  assert.equal(other.safeAnswer.safeUserMessage, '我目前还不知道。');
});

test('follow-up exhaustion uses server continuation when the model drops returned values', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await message(h.runtime, '我女儿喜欢苹果');
  await message(h.runtime, '她也喜欢草莓');
  const first = await message(h.runtime, '她喜欢什么？');
  assert.equal(first.safeAnswer.safeUserMessage, '你女儿喜欢苹果和草莓。');

  const exhausted = await message(h.runtime, '还有呢？');
  assert.equal(exhausted.safeAnswer.safeUserMessage, '我目前只记录到这些，没有更多已确认的信息。');
  assert.equal(exhausted.trustedContext.grounded, false);

  const misclassified = await message(h.runtime, '还喜欢什么？');
  assert.equal(misclassified.safeAnswer.safeUserMessage, '我目前只记录到这些，没有更多已确认的信息。');
  assert.equal(misclassified.trustedContext.grounded, false);
});

test('invalid planner output never falls through to regex capture or a false success', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await message(h.runtime, '请永久记住这个模糊事实');
  assert.equal(result.kind, 'clarification');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 0);
});

test('a planner failure stays fail closed and never invokes the legacy read parser', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await message(h.runtime, '她最喜欢草莓');
  const recalled = await message(h.runtime, '我女儿最喜欢什么？', { conversationId: 'fallback-query' });
  assert.equal(recalled.kind, 'clarification');
  assert.equal(recalled.outcome, 'semantic_plan_failed');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 1);
});

test('a valid Agent query reaches the requested predicate without a legacy parser override', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await message(h.runtime, '我女儿喜欢苹果');
  await message(h.runtime, '她也喜欢草莓');
  await message(h.runtime, '她最喜欢草莓');
  const recalled = await message(h.runtime, '我女儿喜欢什么？', { conversationId: 'predicate-conflict-query' });
  assert.equal(recalled.safeAnswer.safeUserMessage, '你女儿喜欢苹果和草莓。');
  assert.equal(recalled.evidenceBundle.evidence.every((item) => item.predicate === 'preference_statement'), true);
});

test('negation, favorite and explicit delete use deterministic lifecycle without collapsing predicates', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await message(h.runtime, '我女儿喜欢苹果');
  await message(h.runtime, '她也喜欢草莓');
  const negated = await message(h.runtime, '不是苹果，她不喜欢苹果');
  assert.equal(negated.outcome, 'memory_corrected');
  const remaining = await message(h.runtime, '她喜欢什么？');
  assert.equal(remaining.safeAnswer.safeUserMessage, '你女儿喜欢草莓。');

  await message(h.runtime, '她最喜欢草莓');
  const favorite = await message(h.runtime, '她最喜欢什么？');
  assert.equal(favorite.safeAnswer.safeUserMessage, '你女儿最喜欢草莓。');
  const current = h.runtime.inspectOwner('owner-a').currentMemories;
  assert.equal(current.filter((item) => item.predicate === 'preference_statement').length, 1);
  assert.equal(current.filter((item) => item.predicate === 'favorite_preference_statement').length, 1);

  await message(h.runtime, '请记录我妈妈是阴历7月16日生日');
  const deleted = await message(h.runtime, '删除我妈妈的生日记录');
  assert.equal(deleted.outcome, 'deleted');
  const absent = await message(h.runtime, '我妈妈什么时候生日？');
  assert.equal(absent.safeAnswer.safeUserMessage, '我目前还不知道。');
});

test('a lunar-to-Gregorian question never lets the model guess without a deterministic converter', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await message(h.runtime, '请记录我妈妈是阴历7月16日生日');
  const result = await message(h.runtime, '今年妈妈生日对应公历哪一天？');
  assert.equal(result.safeAnswer.safeUserMessage, '我目前还不能可靠换算农历生日对应的公历日期。');
});
