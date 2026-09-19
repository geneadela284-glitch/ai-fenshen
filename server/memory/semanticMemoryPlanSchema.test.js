import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSemanticMemoryPlan } from './semanticMemoryPlanSchema.js';

function plan(overrides = {}) {
  const text = overrides.text || '请记录我妈妈是阴历7月16日生日';
  return {
    text,
    value: {
      intent: 'memory_candidate',
      subject: {
        entity_type: 'person', relation_to_owner: 'mother', normalized_reference: '妈妈', resolved_entity_hint: null
      },
      predicate: 'birthday',
      value: { year: null, month: 7, day: 16 },
      qualifiers: {
        calendar_type: 'lunar', year: null, month: 7, day: 16,
        lunar_leap_month: 'unknown', temporal_scope: 'stable', recurrence: 'yearly',
        degree: 'normal', cardinality: 'single', negation: false, uncertainty: false
      },
      confidence: 0.97,
      source_spans: [{ text: '我妈妈是阴历7月16日生日', start: 3, end: text.length }],
      ambiguity_reasons: [], requires_confirmation: false,
      inherited_context: { previous_entity: null, previous_predicate: null, previously_returned_values: [] },
      ...overrides.value
    }
  };
}

test('accepts a strict ownerless lunar birthday plan with an exact source span', () => {
  const input = plan();
  const result = validateSemanticMemoryPlan(input.value, { text: input.text });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(Object.hasOwn(input.value, 'owner_id'), false);
});

test('rejects missing, unknown, contradictory, low-confidence and ungrounded model fields', () => {
  const missing = plan();
  delete missing.value.subject;
  assert.equal(validateSemanticMemoryPlan(missing.value, { text: missing.text }).valid, false);
  const unknown = plan({ value: { owner_id: 'model-owner' } });
  assert.equal(validateSemanticMemoryPlan(unknown.value, { text: unknown.text }).valid, false);
  const contradiction = plan({ value: { qualifiers: { ...plan().value.qualifiers, calendar_type: 'gregorian', lunar_leap_month: true } } });
  assert.equal(validateSemanticMemoryPlan(contradiction.value, { text: contradiction.text }).valid, false);
  const low = plan({ value: { confidence: 0.4 } });
  assert.equal(validateSemanticMemoryPlan(low.value, { text: low.text }).valid, false);
  const ungrounded = plan({ value: { source_spans: [{ text: '不存在', start: 0, end: 3 }] } });
  assert.equal(validateSemanticMemoryPlan(ungrounded.value, { text: ungrounded.text }).valid, false);
  const localizedPredicate = plan({ value: { predicate: '生日' } });
  const localizedResult = validateSemanticMemoryPlan(localizedPredicate.value, { text: localizedPredicate.text });
  assert.equal(localizedResult.valid, false);
  assert.ok(localizedResult.errors.includes('predicate:unsupported'));
});

test('ambiguous plans require one confirmation reason and can never authorize a write', () => {
  const input = plan({ value: {
    intent: 'ambiguous', confidence: 0.8, requires_confirmation: true,
    ambiguity_reasons: ['missing_day'], value: null,
    qualifiers: { ...plan().value.qualifiers, day: null, uncertainty: true }
  } });
  assert.equal(validateSemanticMemoryPlan(input.value, { text: input.text }).valid, true);
});

test('rejects favorite predicate inherited into an explicit ordinary-like negation', () => {
  const text = '不是苹果，她不喜欢苹果';
  const base = plan();
  const input = plan({ text, value: {
    intent: 'memory_negation',
    subject: { ...base.value.subject, relation_to_owner: 'daughter', normalized_reference: '女儿' },
    predicate: 'favorite_food',
    value: ['苹果'],
    qualifiers: { ...base.value.qualifiers, cardinality: 'multiple', negation: true },
    source_spans: [{ text, start: 0, end: text.length }],
    inherited_context: {
      previous_entity: 'daughter', previous_predicate: 'favorite_food', previously_returned_values: []
    }
  } });
  const result = validateSemanticMemoryPlan(input.value, { text });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('predicate:explicit_negation_degree_conflict'));
});
