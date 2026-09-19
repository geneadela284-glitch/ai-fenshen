import assert from 'node:assert/strict';
import test from 'node:test';

import { bindAssistantSemanticEvidence } from './assistantSemanticEvidenceBinder.js';
import { validateAssistantSemanticPlan } from './assistantSemanticPlanSchema.js';
import {
  adaptUnifiedPlanToFinance,
  adaptUnifiedPlanToMemory,
  adaptUnifiedPlanToTool
} from './domainPlanAdapters.js';
import { UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1 } from './fixtures/unifiedAssistantSemanticEvaluationV1.js';
import { canonicalizeUnifiedProviderPlan } from './unifiedProviderPlanCanonicalizer.js';

test('cross-domain Unified Semantic evaluation validates canonical plans without production sentence rules', () => {
  assert.ok(UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1.length >= 16);
  for (const [index, entry] of UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1.entries()) {
    const validated = validateAssistantSemanticPlan(entry.plan);
    assert.equal(validated.valid, true, `case ${index}: ${entry.input}: ${validated.errors.join(',')}`);
    const bound = bindAssistantSemanticEvidence(validated.value, {
      message: entry.input,
      sourceMessageId: `source-${index}`,
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      trustedContext: {
        owner_id: 'owner-a',
        conversation_id: 'conversation-a',
        values: {
          'entity.relation_to_owner': 'mother',
          relation_to_owner: 'mother',
          predicate: 'birthday',
          tool: 'calendar.convert'
        }
      }
    });
    assert.equal(bound.ok, true, `case ${index}: evidence`);
    assert.equal(Object.hasOwn(bound.plan, 'owner_id'), false);
    assert.deepEqual(bound.plan.source_spans, [{
      text: entry.input,
      start: 0,
      end: entry.input.length
    }]);

    const adapted = entry.plan.domain === 'memory'
      ? adaptUnifiedPlanToMemory(bound.plan, { message: entry.input })
      : entry.plan.domain === 'finance'
        ? adaptUnifiedPlanToFinance(bound.plan, { message: entry.input })
        : adaptUnifiedPlanToTool(bound.plan, { sourceMessageId: `source-${index}` });
    assert.equal(adapted.ok, true, `case ${index}: adapter`);
  }
});

test('unseen paraphrases produce the same canonical domain semantics as the approved black-box cases', () => {
  const [birthDate, birthday, , , , , , income] = UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1;
  const unseenBirthDate = UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1.at(-3);
  const unseenBirthday = UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1.at(-2);
  const unseenIncome = UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1.at(-1);
  const signature = (plan) => {
    const canonicalized = canonicalizeUnifiedProviderPlan(plan, {
      ownerId: 'owner-a',
      conversationId: 'conversation-a'
    });
    assert.equal(canonicalized.ok, true);
    return {
      domain: canonicalized.plan.domain,
      action: canonicalized.plan.action,
      relation: canonicalized.plan.relation_to_owner,
      predicate: canonicalized.plan.predicate,
      value: canonicalized.plan.canonical_value
    };
  };
  assert.deepEqual(signature(unseenBirthDate.plan), signature(birthDate.plan));
  assert.deepEqual(signature(unseenBirthday.plan), signature(birthday.plan));
  assert.deepEqual(
    { ...signature(unseenIncome.plan), value: { direction: unseenIncome.plan.value.direction } },
    { ...signature(income.plan), value: { direction: income.plan.value.direction } }
  );
});
