import assert from 'node:assert/strict';
import test from 'node:test';

import { deterministicGroundedAnswer } from './groundedMemoryResponder.js';
import { buildMemoryEvidenceBundle } from './memoryEvidenceBundle.js';
import { evaluateSemanticMemoryContract } from './semanticMemoryContract.js';
import { safeVisibleMemoryAnswer } from '../conversation/conversationService.js';

function record({ predicate, structuredValue, memoryId = 'memory-legacy-1' }) {
  return {
    memoryId,
    ownerUserId: 'owner-a',
    subjectEntityId: 'entity-family-1',
    predicate,
    structuredValue,
    confidence: 0.98,
    source: { type: 'conversation_message', id: 'message-source-1' },
    version: 1,
    status: 'confirmed',
    supersededById: null,
    metadata: { sourceMessageId: 'message-source-1' }
  };
}

function plan({
  intent = 'memory_candidate',
  relation = 'mother',
  predicate = 'birthday',
  value = null,
  qualifierOverrides = {},
  inherited = {}
} = {}) {
  return {
    intent,
    subject: {
      entity_type: 'person',
      relation_to_owner: relation,
      normalized_reference: relation,
      resolved_entity_hint: null
    },
    predicate,
    value,
    qualifiers: {
      calendar_type: 'unknown',
      year: null,
      month: null,
      day: null,
      lunar_leap_month: 'unknown',
      temporal_scope: 'stable',
      recurrence: 'unknown',
      degree: 'normal',
      cardinality: 'single',
      negation: false,
      uncertainty: false,
      ...qualifierOverrides
    },
    confidence: 0.98,
    source_spans: [],
    ambiguity_reasons: [],
    requires_confirmation: false,
    inherited_context: {
      previous_entity: inherited.previous_entity || null,
      previous_predicate: inherited.previous_predicate || null,
      previously_returned_values: inherited.previously_returned_values || []
    }
  };
}

test('legacy date-only birthday is rendered without undefined or null', () => {
  const bundle = buildMemoryEvidenceBundle({
    ownerId: 'owner-a',
    records: [record({ predicate: 'birthday', structuredValue: { date: '2000-07-16' } })]
  });

  const answer = deterministicGroundedAnswer(bundle, '妈妈');

  assert.equal(answer, '你妈妈是7月16日生日。');
  assert.doesNotMatch(answer, /undefined|null/);
});

test('an explicit lunar qualifier enriches the existing date-only birthday instead of asking', () => {
  const existing = record({ predicate: 'birthday', structuredValue: { date: '2000-07-16' } });
  const result = evaluateSemanticMemoryContract({
    plan: plan({
      value: { year: null, month: 7, day: 16 },
      qualifierOverrides: { calendar_type: 'lunar', month: 7, day: 16, recurrence: 'yearly' },
      inherited: { previous_entity: 'mother', previous_predicate: 'birthday' }
    }),
    existingRecords: [existing],
    sourceText: '她是农历7月16生日'
  });

  assert.equal(result.decision, 'UPDATE');
  assert.equal(result.operation, 'enrich');
  assert.equal(result.structuredValue.calendarType, 'lunar');
  assert.equal(result.structuredValue.month, 7);
  assert.equal(result.structuredValue.day, 16);
});

test('a qualifier-only correction enriches the current birthday without creating a conflicting date', () => {
  const existing = record({ predicate: 'birthday', structuredValue: { date: '2000-07-16' } });
  const result = evaluateSemanticMemoryContract({
    plan: plan({
      intent: 'memory_correction',
      value: null,
      qualifierOverrides: { calendar_type: 'lunar' },
      inherited: { previous_entity: 'mother', previous_predicate: 'birthday' }
    }),
    existingRecords: [existing],
    sourceText: '刚才那个日期是农历的'
  });

  assert.equal(result.decision, 'UPDATE');
  assert.equal(result.operation, 'enrich');
  assert.equal(result.structuredValue.date, '2000-07-16');
  assert.equal(result.structuredValue.calendarType, 'lunar');
});

test('an incomplete preliminary correction preserves its canonical predicate for existing-record lookup', () => {
  const result = evaluateSemanticMemoryContract({
    plan: plan({
      intent: 'memory_correction',
      value: null,
      qualifierOverrides: { calendar_type: 'lunar' },
      inherited: { previous_entity: 'mother', previous_predicate: 'birthday' }
    }),
    existingRecords: [],
    sourceText: '刚才那个日期是农历的'
  });

  assert.equal(result.decision, 'ASK');
  assert.equal(result.predicate, 'birthday');
  assert.deepEqual(result.reasonCodes, ['value_incomplete']);
});

test('legacy compound preference values are atomized and deterministically deduplicated before display', () => {
  const bundle = buildMemoryEvidenceBundle({
    ownerId: 'owner-a',
    records: [record({
      predicate: 'preference_statement',
      structuredValue: {
        value: '水果是苹果、苹果和草莓',
        values: ['水果是苹果', '苹果和草莓']
      }
    })]
  });

  assert.deepEqual(bundle.evidence[0].value.items, ['苹果', '草莓']);
  assert.equal(deterministicGroundedAnswer(bundle, '女儿'), '你女儿喜欢苹果和草莓。');
});

test('a semantically identical complex favorite is an idempotent no-op, not a generic ASK', () => {
  const existing = record({
    predicate: 'favorite_preference_statement',
    structuredValue: { value: '我煮的沸腾鱼' }
  });
  const result = evaluateSemanticMemoryContract({
    plan: plan({
      relation: 'daughter',
      predicate: 'favorite_food',
      value: '我煮的沸腾鱼',
      qualifierOverrides: { degree: 'favorite', cardinality: 'single' },
      inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food' }
    }),
    existingRecords: [existing],
    sourceText: '还有她最喜欢吃我煮的沸腾鱼。'
  });

  assert.equal(result.decision, 'NO_OP');
  assert.equal(result.operation, 'duplicate');
});

test('the final user-visible safety gate fails closed on placeholders and internal fields', () => {
  assert.equal(safeVisibleMemoryAnswer('你妈妈是undefined月undefined日生日。'), '我目前还不知道。');
  assert.equal(safeVisibleMemoryAnswer('owner_id=owner-a'), '我目前还不知道。');
  assert.equal(safeVisibleMemoryAnswer('你妈妈是农历七月十六生日。'), '你妈妈是农历七月十六生日。');
});
