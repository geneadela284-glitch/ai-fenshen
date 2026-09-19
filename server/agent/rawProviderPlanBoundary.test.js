import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateProviderPlanCandidate
} from './providerPlanCandidateSchema.js';
import {
  canonicalizeUnifiedProviderPlan
} from './unifiedProviderPlanCanonicalizer.js';
import {
  validateCanonicalAssistantPlan
} from './canonicalAssistantPlanSchema.js';
import {
  RAW_PROVIDER_FAILURE_FIXTURES,
  rawProviderPlanFixture
} from './fixtures/unifiedRawProviderPlanFailuresV1.js';

const context = Object.freeze({
  ownerId: 'owner-a',
  conversationId: 'conversation-a',
  message: '我女儿出生于2012年6月8日'
});

test('RED: Raw Provider Schema accepts a bounded confidence band for canonicalization', () => {
  const validated = validateProviderPlanCandidate(
    structuredClone(RAW_PROVIDER_FAILURE_FIXTURES.confidenceBand)
  );
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));

  const canonical = canonicalizeUnifiedProviderPlan(validated.value, context);
  assert.equal(canonical.ok, true);
  assert.equal(canonical.plan.confidence, 1);
  assert.equal(canonical.plan.provider_advisory.confidence_band, 'high');
});

test('RED: Raw Provider Schema permits omitted top-level relation when structured entity evidence remains', () => {
  const validated = validateProviderPlanCandidate(
    structuredClone(RAW_PROVIDER_FAILURE_FIXTURES.missingTopLevelRelation)
  );
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));

  const canonical = canonicalizeUnifiedProviderPlan(validated.value, context);
  assert.equal(canonical.ok, true);
  assert.equal(canonical.plan.canonical_relation.family_role, 'child');
  assert.equal(canonical.plan.canonical_relation.gender, 'female');
  assert.equal(canonical.plan.relation_to_owner, 'daughter');
});

test('RED: Raw Provider Schema rejects an unbounded confidence object', () => {
  const validated = validateProviderPlanCandidate(
    structuredClone(RAW_PROVIDER_FAILURE_FIXTURES.invalidConfidenceObject)
  );
  assert.equal(validated.valid, false);
  assert.equal(validated.errors.some((error) => error.includes('confidence')), true);
});

test('RED: missing relation without entity evidence remains unresolved rather than guessed', () => {
  const plan = rawProviderPlanFixture({
    entity: {
      type: 'person',
      reference: null,
      relation_to_owner: null
    }
  });
  delete plan.relation_to_owner;
  const validated = validateProviderPlanCandidate(plan);
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  const canonical = canonicalizeUnifiedProviderPlan(validated.value, {
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    message: '请记录一个人的出生日期'
  });
  assert.equal(canonical.ok, false);
  assert.equal(canonical.code, 'CANONICAL_ENTITY_RELATION_UNRESOLVED');
});

test('RED: missing or invalid Provider span hints do not block deterministic evidence rebinding', () => {
  for (const sourceSpans of [
    null,
    [{ text: 'wrong', start: 99, end: 100 }]
  ]) {
    const validated = validateProviderPlanCandidate(rawProviderPlanFixture({
      source_spans: sourceSpans
    }));
    assert.equal(validated.valid, true, JSON.stringify(validated.errors));
    const canonical = canonicalizeUnifiedProviderPlan(validated.value, context);
    assert.equal(canonical.ok, true);
    assert.equal(canonical.plan.action, 'memory.capture');
  }
});

test('Strict Canonical Assistant Plan accepts normalized output and rejects raw instability', () => {
  const canonical = canonicalizeUnifiedProviderPlan(
    structuredClone(RAW_PROVIDER_FAILURE_FIXTURES.confidenceBand),
    context
  );
  assert.equal(canonical.ok, true);
  assert.equal(validateCanonicalAssistantPlan(canonical.plan).valid, true);

  const unstableConfidence = structuredClone(canonical.plan);
  unstableConfidence.confidence = 'high';
  assert.equal(validateCanonicalAssistantPlan(unstableConfidence).valid, false);

  const missingRelation = structuredClone(canonical.plan);
  delete missingRelation.relation_to_owner;
  assert.equal(validateCanonicalAssistantPlan(missingRelation).valid, false);
});

test('RED: Raw-to-Canonical boundary preserves explicit entity gender over broad relation', () => {
  const raw = structuredClone(
    RAW_PROVIDER_FAILURE_FIXTURES.explicitEntityGenderErasedByBroadRelation
  );
  const validated = validateProviderPlanCandidate(raw);
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  const canonical = canonicalizeUnifiedProviderPlan(validated.value, context);
  assert.equal(canonical.ok, true, canonical.code);
  assert.equal(canonical.plan.canonical_relation.family_role, 'child');
  assert.equal(canonical.plan.canonical_relation.gender, 'female');
  assert.equal(canonical.plan.relation_to_owner, 'daughter');
});
