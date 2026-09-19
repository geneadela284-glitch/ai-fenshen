import assert from 'node:assert/strict';
import test from 'node:test';
import * as intelligence from './index.js';

const NOW = '2026-07-16T00:00:00.000Z';
const pattern = {
  id: 'pattern-1', userId: 'fake-user-a', patternType: 'repeated_behavior', subject: 'fake-user-a',
  predicate: 'does_activity', occurrenceCount: 3, beginTime: '2026-05-01T00:00:00.000Z', endTime: NOW,
  cadence: 'monthly', status: 'observed', confidence: 0.9, importance: 0.7,
  memoryIds: ['memory-1', 'memory-2', 'memory-3'], timelineEventIds: ['event-1', 'event-2', 'event-3'],
  evidence: [{ memoryId: 'memory-1', timelineEventId: 'event-1', observedAt: '2026-05-01T00:00:00.000Z' }], metadata: {}
};
const trend = {
  id: 'trend-1', userId: 'fake-user-a', trendType: 'value_change', subject: 'fake-user-a',
  predicate: 'has_goal', beginTime: '2026-01-01T00:00:00.000Z', endTime: NOW,
  direction: 'changed', status: 'observed', confidence: 0.8,
  memoryIds: ['memory-1', 'memory-2'], timelineEventIds: ['event-1', 'event-2'],
  evidence: [{ memoryId: 'memory-1', timelineEventId: 'event-1', observedAt: '2026-01-01T00:00:00.000Z' }], metadata: {}
};
const stage = {
  id: 'stage-1', userId: 'fake-user-a', periodId: 'period-1', title: '虚构创业阶段',
  beginTime: '2026-01-01T00:00:00.000Z', endTime: null, status: 'explicit', confidence: 0.9,
  memoryIds: ['memory-1'], timelinePeriodIds: ['period-1'],
  evidence: [{ memoryId: 'memory-1', timelinePeriodId: 'period-1', observedAt: '2026-01-01T00:00:00.000Z' }], metadata: {}
};
const insight = {
  id: 'insight-1', userId: 'fake-user-a', insightType: 'pattern_summary', title: '已记录的生活规律',
  summary: '已记录 3 次同类活动。', confidence: 0.9, status: 'informational',
  memoryIds: ['memory-1'], timelineEventIds: ['event-1'], patternIds: ['pattern-1'], trendIds: [], stageIds: [],
  evidence: [{ kind: 'pattern', id: 'pattern-1' }], createdAt: NOW, metadata: {}
};
const suggestion = {
  id: 'suggestion-1', userId: 'fake-user-a', suggestionType: 'optional_reflection', title: '可选建议',
  summary: '如果这仍然重要，可以考虑继续记录；决定由你。', decisionOwner: 'user', status: 'optional',
  insightIds: ['insight-1'], memoryIds: ['memory-1'], evidence: [{ kind: 'insight', id: 'insight-1' }], createdAt: NOW, metadata: {}
};

test('Life Intelligence exports immutable contract factories', async () => {
  const module = await import('./index.js').catch(() => ({}));
  assert.equal(typeof module.createLifePattern, 'function');
  assert.equal(typeof module.createLifeTrend, 'function');
  assert.equal(typeof module.createLifeStage, 'function');
  assert.equal(typeof module.createLifeInsight, 'function');
  assert.equal(typeof module.createLifeSuggestion, 'function');
});

const contracts = [
  ['pattern', pattern, 'createLifePattern', 'validateLifePattern'],
  ['trend', trend, 'createLifeTrend', 'validateLifeTrend'],
  ['stage', stage, 'createLifeStage', 'validateLifeStage'],
  ['insight', insight, 'createLifeInsight', 'validateLifeInsight'],
  ['suggestion', suggestion, 'createLifeSuggestion', 'validateLifeSuggestion']
];

for (const [name, value, factoryName, validatorName] of contracts) {
  test(`${name} contract accepts a complete value`, () => {
    assert.equal(intelligence[validatorName](value, { trustedUserId: 'fake-user-a' }).valid, true);
  });
  test(`${name} factory returns an immutable clone`, () => {
    const created = intelligence[factoryName](value, { trustedUserId: 'fake-user-a' });
    assert.notEqual(created, value);
    assert.equal(Object.isFrozen(created), true);
    assert.equal(Object.isFrozen(created.metadata), true);
  });
  test(`${name} contract rejects another owner`, () => {
    const result = intelligence[validatorName](value, { trustedUserId: 'fake-user-b' });
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.code === 'USER_SCOPE_MISMATCH'), true);
  });
  test(`${name} contract rejects unknown fields`, () => {
    assert.equal(intelligence[validatorName]({ ...value, unknown: true }).valid, false);
  });
  test(`${name} contract rejects secret-shaped metadata`, () => {
    const result = intelligence[validatorName]({ ...value, metadata: { accessToken: 'fake-secret-value' } });
    assert.equal(result.valid, false);
  });
  for (const field of Object.keys(value)) {
    test(`${name} contract requires ${field}`, () => {
      const invalid = structuredClone(value);
      delete invalid[field];
      assert.equal(intelligence[validatorName](invalid).valid, false);
    });
  }
}

test('pattern rejects fewer than three occurrences', () => {
  assert.equal(intelligence.validateLifePattern({ ...pattern, occurrenceCount: 2 }).valid, false);
});

test('pattern rejects unsupported cadence', () => {
  assert.equal(intelligence.validateLifePattern({ ...pattern, cadence: 'always' }).valid, false);
});

test('pattern rejects confidence outside zero to one', () => {
  assert.equal(intelligence.validateLifePattern({ ...pattern, confidence: 1.1 }).valid, false);
});

test('pattern requires three distinct Memory references', () => {
  assert.equal(intelligence.validateLifePattern({ ...pattern, memoryIds: ['memory-1'] }).valid, false);
});

test('trend rejects unsupported direction', () => {
  assert.equal(intelligence.validateLifeTrend({ ...trend, direction: 'predicted' }).valid, false);
});

test('trend requires at least two Memory references', () => {
  assert.equal(intelligence.validateLifeTrend({ ...trend, memoryIds: ['memory-1'] }).valid, false);
});

test('stage requires an explicit Timeline Period source', () => {
  assert.equal(intelligence.validateLifeStage({ ...stage, status: 'inferred' }).valid, false);
});

test('stage rejects a missing Timeline Period reference', () => {
  assert.equal(intelligence.validateLifeStage({ ...stage, timelinePeriodIds: [] }).valid, false);
});

test('insight rejects a record with no source artifact', () => {
  const value = { ...insight, patternIds: [], trendIds: [], stageIds: [] };
  assert.equal(intelligence.validateLifeInsight(value).valid, false);
});

test('suggestion requires the user to own the decision', () => {
  assert.equal(intelligence.validateLifeSuggestion({ ...suggestion, decisionOwner: 'system' }).valid, false);
});

test('suggestion rejects imperative autonomous action', () => {
  const value = { ...suggestion, summary: '系统将自动替你执行这个决定。' };
  assert.equal(intelligence.validateLifeSuggestion(value).valid, false);
});
