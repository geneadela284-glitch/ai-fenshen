import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryRecallIntent,
  RecallReasonCode,
  normalizeMemoryContextBudget,
  toRepositoryContext,
  validateMemoryRecallContext,
  validateMemoryRecallPlan
} from './index.js';
import { fakeRecallContext } from './testing/fixtures.js';

test('Recall intent and reason enums are frozen', () => {
  assert.equal(Object.isFrozen(MemoryRecallIntent), true);
  assert.equal(Object.isFrozen(RecallReasonCode), true);
});

for (const field of [
  'authenticatedUserId', 'actorType', 'actorId', 'requestId', 'correlationId',
  'timestamp', 'timezone', 'locale', 'taskType', 'purpose', 'sensitivityAllowance',
  'contextBudget', 'policyVersion', 'metadata'
]) {
  test(`RecallContext requires ${field}`, () => {
    const context = fakeRecallContext();
    delete context[field];
    assert.equal(validateMemoryRecallContext(context).valid, false);
  });
}

test('RecallContext rejects a prohibited metadata key', () => {
  const result = validateMemoryRecallContext(fakeRecallContext({ metadata: { accessToken: 'fake-only' } }));
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'SECRET_FORBIDDEN');
});

test('RecallContext rejects restricted sensitivity allowance', () => {
  assert.equal(validateMemoryRecallContext(fakeRecallContext({ sensitivityAllowance: 'restricted' })).valid, false);
});

test('RecallContext rejects an unlimited budget', () => {
  assert.equal(validateMemoryRecallContext(fakeRecallContext({ contextBudget: { maxItems: Infinity } })).valid, false);
});

test('RecallContext converts to the existing RepositoryContext without extra fields', () => {
  const converted = toRepositoryContext(fakeRecallContext());
  assert.deepEqual(Object.keys(converted).sort(), [
    'actorId', 'actorType', 'authenticatedUserId', 'correlationId', 'metadata',
    'policyVersion', 'requestId', 'timestamp', 'transactionId'
  ].sort());
  assert.equal(converted.authenticatedUserId, 'fake-user-a');
});

test('MemoryContextBudget applies bounded defaults', () => {
  const budget = normalizeMemoryContextBudget({});
  assert.equal(budget.maxItems, 8);
  assert.equal(budget.maxCharacters, 4000);
  assert.equal(budget.maxEstimatedTokens, 1000);
});

test('MemoryContextBudget clamps caller values to policy ceilings', () => {
  const budget = normalizeMemoryContextBudget({ maxItems: 999, maxCharacters: 999999, maxEstimatedTokens: 999999 });
  assert.equal(budget.maxItems, 20);
  assert.equal(budget.maxCharacters, 12000);
  assert.equal(budget.maxEstimatedTokens, 3000);
});

test('RecallPlan requires the trusted userId', () => {
  const plan = { userId: '', intent: 'personal_preference', memoryTypes: ['preference'], includeHistorical: false, includeCandidates: false, sensitivityMax: 'low', limit: 10, sort: 'updatedAt:desc', budget: normalizeMemoryContextBudget({}), rankingWeights: {}, conflictPolicy: 'safe_unresolved', reasonCodes: [] };
  assert.equal(validateMemoryRecallPlan(plan, { trustedUserId: 'fake-user-a' }).valid, false);
});

test('RecallPlan rejects cross-user ownership', () => {
  const plan = { userId: 'fake-user-b', intent: 'personal_preference', memoryTypes: ['preference'], includeHistorical: false, includeCandidates: false, sensitivityMax: 'low', limit: 10, sort: 'updatedAt:desc', budget: normalizeMemoryContextBudget({}), rankingWeights: {}, conflictPolicy: 'safe_unresolved', reasonCodes: [] };
  assert.equal(validateMemoryRecallPlan(plan, { trustedUserId: 'fake-user-a' }).errors[0].code, 'USER_SCOPE_MISMATCH');
});

test('RecallPlan rejects candidate inclusion in normal recall', () => {
  const plan = { userId: 'fake-user-a', intent: 'personal_preference', memoryTypes: ['preference'], includeHistorical: false, includeCandidates: true, sensitivityMax: 'low', limit: 10, sort: 'updatedAt:desc', budget: normalizeMemoryContextBudget({}), rankingWeights: {}, conflictPolicy: 'safe_unresolved', reasonCodes: [] };
  assert.equal(validateMemoryRecallPlan(plan, { trustedUserId: 'fake-user-a' }).valid, false);
});

function validPlan(overrides = {}) {
  return {
    userId: 'fake-user-a',
    intent: 'personal_preference',
    memoryTypes: ['preference'],
    subjects: [],
    predicates: ['prefer'],
    timeRange: null,
    effectiveAt: '2026-07-15T08:00:00.000Z',
    includeHistorical: false,
    includeCandidates: false,
    sensitivityMax: 'low',
    limit: 10,
    sort: 'updatedAt:desc',
    budget: normalizeMemoryContextBudget({}),
    rankingWeights: {},
    conflictPolicy: 'safe_unresolved',
    reasonCodes: [],
    ...overrides
  };
}

for (const [name, overrides] of [
  ['subjects', { subjects: 'fake-user-a' }],
  ['predicates', { predicates: [null] }],
  ['timeRange', { timeRange: 'all' }],
  ['effectiveAt', { effectiveAt: 'not-a-date' }],
  ['sort', { sort: 'random' }],
  ['conflictPolicy', { conflictPolicy: 'auto_overwrite' }]
]) {
  test(`RecallPlan rejects invalid ${name}`, () => {
    assert.equal(validateMemoryRecallPlan(validPlan(overrides), { trustedUserId: 'fake-user-a' }).valid, false);
  });
}

test('RecallPlan accepts the complete bounded contract', () => {
  assert.equal(validateMemoryRecallPlan(validPlan(), { trustedUserId: 'fake-user-a' }).valid, true);
});
