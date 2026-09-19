import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRecallIntent, MemoryRecallPlanner, MemoryType } from './index.js';
import { fakeRecallContext } from './testing/fixtures.js';

const planner = new MemoryRecallPlanner();

async function plan(text, intent, context = fakeRecallContext(), options = {}) {
  return planner.build(context, { text }, { intent, reasonCode: `RECALL_TEST_${intent}` }, options);
}

const TYPE_CASES = [
  [MemoryRecallIntent.PERSONAL_PREFERENCE, [MemoryType.PREFERENCE]],
  [MemoryRecallIntent.PERSONAL_FACT, [MemoryType.FACT]],
  [MemoryRecallIntent.RELATIONSHIP_CONTEXT, [MemoryType.RELATIONSHIP]],
  [MemoryRecallIntent.GOAL_CONTEXT, [MemoryType.GOAL]],
  [MemoryRecallIntent.HABIT_OR_ROUTINE, [MemoryType.HABIT_ROUTINE]],
  [MemoryRecallIntent.PRIOR_DECISION, [MemoryType.DECISION]],
  [MemoryRecallIntent.LIFE_EVENT_CONTEXT, [MemoryType.LIFE_EVENT]],
  [MemoryRecallIntent.COMMITMENT_OR_CONSTRAINT, [MemoryType.COMMITMENT, MemoryType.CONSTRAINT]]
];

for (const [intent, memoryTypes] of TYPE_CASES) {
  test(`RecallPlan maps ${intent} to approved Memory types`, async () => {
    assert.deepEqual((await plan('虚构请求', intent)).memoryTypes, memoryTypes);
  });
}

test('RecallPlan ownership always comes from trusted context', async () => {
  const result = await planner.build(fakeRecallContext(), { text: '按我的偏好推荐', userId: 'fake-user-b' }, { intent: MemoryRecallIntent.PERSONAL_PREFERENCE, reasonCode: 'RECALL_TEST' });
  assert.equal(result.userId, 'fake-user-a');
});

test('no-memory plan performs zero repository work', async () => {
  assert.equal((await plan('天气', MemoryRecallIntent.NO_MEMORY_NEEDED)).limit, 0);
});

test('historical intent explicitly enables historical records', async () => {
  assert.equal((await plan('以前住哪里', MemoryRecallIntent.HISTORICAL_CONTEXT)).includeHistorical, true);
});

test('normal intent excludes historical records', async () => {
  assert.equal((await plan('偏好', MemoryRecallIntent.PERSONAL_PREFERENCE)).includeHistorical, false);
});

test('RecallPlan never enables unconfirmed Candidates', async () => {
  assert.equal((await plan('偏好', MemoryRecallIntent.PERSONAL_PREFERENCE, fakeRecallContext(), { includeCandidates: true })).includeCandidates, false);
});

test('RecallPlan applies effectiveAt from trusted context timestamp', async () => {
  assert.equal((await plan('偏好', MemoryRecallIntent.PERSONAL_PREFERENCE)).effectiveAt, fakeRecallContext().timestamp);
});

test('RecallPlan clamps query limit to fifty', async () => {
  assert.equal((await plan('偏好', MemoryRecallIntent.PERSONAL_PREFERENCE, fakeRecallContext(), { limit: 999 })).limit, 50);
});

test('ordinary caller cannot raise sensitivity above context allowance', async () => {
  assert.equal((await plan('健康', MemoryRecallIntent.SENSITIVE_CONTEXT, fakeRecallContext(), { sensitivityMax: 'high' })).sensitivityMax, 'low');
});

test('approved sensitive purpose may plan high-sensitivity existence recall', async () => {
  const context = fakeRecallContext({ purpose: 'sensitive_assistance', sensitivityAllowance: 'high', metadata: { sensitiveAccessApproved: true } });
  assert.equal((await plan('健康', MemoryRecallIntent.SENSITIVE_CONTEXT, context)).sensitivityMax, 'high');
});

test('high allowance without approved purpose is capped', async () => {
  const context = fakeRecallContext({ sensitivityAllowance: 'high' });
  assert.notEqual((await plan('健康', MemoryRecallIntent.SENSITIVE_CONTEXT, context)).sensitivityMax, 'high');
});

test('RecallPlan budget is clamped to policy ceilings', async () => {
  const result = await plan('偏好', MemoryRecallIntent.PERSONAL_PREFERENCE, fakeRecallContext({ contextBudget: { maxItems: 999, maxCharacters: 999999, maxEstimatedTokens: 999999, maxSensitiveItems: 999, perTypeLimit: 999, reserveForCurrentTask: 0, reserveForSystemInstructions: 0 } }));
  assert.equal(result.budget.maxItems, 20);
  assert.equal(result.budget.maxEstimatedTokens, 3000);
});

test('RecallPlan uses a stable deterministic sort', async () => {
  assert.equal((await plan('偏好', MemoryRecallIntent.PERSONAL_PREFERENCE)).sort, 'updatedAt:desc');
});

test('RecallPlan output is deeply frozen', async () => {
  const result = await plan('偏好', MemoryRecallIntent.PERSONAL_PREFERENCE);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rankingWeights), true);
});
