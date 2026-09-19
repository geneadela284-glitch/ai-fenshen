import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProviderPlanCandidate } from './providerPlanCandidateSchema.js';
import { canonicalizeUnifiedProviderPlan } from './unifiedProviderPlanCanonicalizer.js';
import {
  BASE_CANONICAL_CONTEXT,
  UNIFIED_PROVIDER_CANONICALIZATION_EVALUATION_V1 as evaluation
} from './fixtures/unifiedProviderCanonicalizationEvaluationV1.js';

function canonicalize(plan, context = BASE_CANONICAL_CONTEXT, scope = {}) {
  const validated = validateProviderPlanCandidate(structuredClone(plan));
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  return canonicalizeUnifiedProviderPlan(validated.value, {
    ownerId: scope.ownerId || 'owner-a',
    conversationId: scope.conversationId || 'conversation-a',
    trustedContext: context
  });
}

test('Shadow: ten canonicalization contract cases are deterministic and execute no domain side effects', () => {
  let repositoryCalls = 0;
  let toolCalls = 0;

  const stringDate = canonicalize(evaluation.dateString);
  const objectDate = canonicalize(evaluation.dateObject);
  assert.equal(stringDate.ok, true);
  assert.deepEqual(stringDate.plan.canonical_value, objectDate.plan.canonical_value);

  const yearless = canonicalize(evaluation.yearlessDate);
  assert.deepEqual(yearless.plan.canonical_value, {
    type: 'date_without_year',
    month: 6,
    day: 8
  });

  const enrich = canonicalize(evaluation.enrichCalendar);
  assert.equal(enrich.plan.action, 'memory.update');
  assert.equal(enrich.plan.relation_to_owner, 'mother');
  assert.equal(enrich.plan.predicate, 'birthday');
  assert.equal(enrich.plan.qualifiers.calendar_type, 'lunar');

  const nextYear = canonicalize(evaluation.nextYear);
  assert.equal(nextYear.plan.action, 'calendar.convert');
  assert.equal(nextYear.plan.canonical_arguments.source_calendar, 'lunar');
  assert.equal(nextYear.plan.canonical_arguments.target_year_reference, 'next_year');

  const daysUntil = canonicalize(evaluation.daysUntil);
  assert.equal(daysUntil.plan.action, 'calendar.days_until');
  assert.equal(daysUntil.plan.relation_to_owner, 'mother');
  assert.equal(daysUntil.plan.predicate, 'birthday');
  assert.equal(daysUntil.plan.required_evidence[0].entity_relation, 'mother');

  const explicitEntity = canonicalize(evaluation.explicitEntity);
  assert.equal(explicitEntity.plan.relation_to_owner, 'father');
  assert.deepEqual(explicitEntity.plan.required_evidence, []);

  const explicitTask = canonicalize(evaluation.explicitFinanceTask);
  assert.equal(explicitTask.plan.domain, 'finance');
  assert.equal(explicitTask.plan.action, 'finance.query');
  assert.equal(Object.hasOwn(explicitTask.plan.canonical_arguments, 'source_calendar'), false);
  assert.equal(explicitTask.plan.tool, null);

  const wrongConversation = canonicalize(evaluation.nextYear, BASE_CANONICAL_CONTEXT, {
    conversationId: 'conversation-b'
  });
  assert.equal(wrongConversation.ok, false);
  assert.equal(wrongConversation.code, 'CANONICAL_CONTEXT_SCOPE_MISMATCH');

  const wrongOwner = canonicalize(evaluation.nextYear, BASE_CANONICAL_CONTEXT, {
    ownerId: 'owner-b'
  });
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.code, 'CANONICAL_CONTEXT_SCOPE_MISMATCH');

  assert.equal(repositoryCalls, 0);
  assert.equal(toolCalls, 0);
});
