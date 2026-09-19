import assert from 'node:assert/strict';
import test from 'node:test';

import { MemorySensitivity, MemoryStatus, MemoryType } from '../kernel/index.js';
import { TimelineBuilder } from '../timeline/index.js';
import { fakeTimelineContext, fakeTimelineMemory } from '../timeline/testing/fixtures.js';
import * as intelligence from './index.js';

const NOW = '2026-07-16T00:00:00.000Z';

function memory(id, date, overrides = {}) {
  return fakeTimelineMemory(id, {
    memoryType: MemoryType.HABIT_ROUTINE,
    predicate: 'does_exercise',
    value: `虚构运动记录-${id}`,
    normalizedValue: 'exercise',
    effectiveFrom: date,
    createdAt: date,
    updatedAt: date,
    ...overrides
  });
}

function source(records) {
  return { ok: true, ...new TimelineBuilder().build(records, { userId: 'fake-user-a', includeHistorical: true }) };
}

const repeated = [
  memory('exercise-1', '2026-05-01T00:00:00.000Z'),
  memory('exercise-2', '2026-06-01T00:00:00.000Z'),
  memory('exercise-3', '2026-07-01T00:00:00.000Z')
];

function service() {
  let sequence = 0;
  return new intelligence.LifeIntelligenceService({ clock: () => new Date(NOW), idFactory: () => `audit-${++sequence}` });
}

test('InsightPolicy allows a normal evidence-backed pattern', () => {
  const pattern = new intelligence.LifePatternEngine().detect(new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), source(repeated)))[0];
  assert.equal(new intelligence.InsightPolicy().evaluateArtifact(pattern).allowed, true);
});

for (const predicate of ['personality_profile', 'psychological_state', 'mental_diagnosis', 'future_prediction']) {
  test(`InsightPolicy blocks forbidden interpretation ${predicate}`, () => {
    assert.equal(new intelligence.InsightPolicy().evaluateArtifact({ predicate }).allowed, false);
  });
}

for (const predicate of ['health_diagnosis', 'medical_advice', 'financial_advice', 'investment_advice']) {
  test(`InsightPolicy blocks autonomous suggestion for ${predicate}`, () => {
    assert.equal(new intelligence.InsightPolicy().allowsSuggestion({ metadata: { sourcePredicate: predicate } }).allowed, false);
  });
}

test('InsightBuilder creates an evidence-backed pattern insight', () => {
  const pattern = new intelligence.LifePatternEngine().detect(new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), source(repeated)))[0];
  const value = new intelligence.InsightBuilder({ clock: () => new Date(NOW) }).fromPattern(pattern);
  assert.equal(value.patternIds[0], pattern.id);
  assert.equal(value.memoryIds.length, 3);
});

test('InsightBuilder describes observations without diagnosis', () => {
  const pattern = new intelligence.LifePatternEngine().detect(new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), source(repeated)))[0];
  const value = new intelligence.InsightBuilder({ clock: () => new Date(NOW) }).fromPattern(pattern);
  assert.equal(/诊断|人格|预测/.test(value.summary), false);
});

test('InsightBuilder creates a trend insight without predicting the future', () => {
  const records = [
    memory('old-goal', '2026-01-01T00:00:00.000Z', { memoryType: MemoryType.GOAL, predicate: 'has_goal', normalizedValue: 'a', status: MemoryStatus.SUPERSEDED, supersededById: 'new-goal' }),
    memory('new-goal', '2026-07-01T00:00:00.000Z', { memoryType: MemoryType.GOAL, predicate: 'has_goal', normalizedValue: 'b', supersedesId: 'old-goal' })
  ];
  const trend = new intelligence.LifeTrendEngine().detect(new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), source(records)))[0];
  const value = new intelligence.InsightBuilder({ clock: () => new Date(NOW) }).fromTrend(trend);
  assert.equal(value.trendIds[0], trend.id);
  assert.equal(value.summary.includes('未来'), false);
});

test('InsightBuilder creates a stage insight only from an explicit stage', () => {
  const records = [memory('stage-memory', '2026-01-01T00:00:00.000Z', { metadata: { timeline: { period: { id: 'period-startup', title: '虚构创业阶段' } } } })];
  const context = new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), source(records));
  const stage = new intelligence.LifeStageEngine().identify(context)[0];
  assert.equal(new intelligence.InsightBuilder({ clock: () => new Date(NOW) }).fromStage(stage).stageIds[0], stage.id);
});

test('InsightBuilder creates an optional user-owned suggestion', () => {
  const pattern = new intelligence.LifePatternEngine().detect(new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), source(repeated)))[0];
  const builder = new intelligence.InsightBuilder({ clock: () => new Date(NOW) });
  const suggestion = builder.suggestionFor(builder.fromPattern(pattern));
  assert.equal(suggestion.decisionOwner, 'user');
  assert.equal(suggestion.status, 'optional');
});

test('LifeInsightEngine builds insights from patterns', () => {
  const context = new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), source(repeated));
  const patterns = new intelligence.LifePatternEngine().detect(context);
  assert.equal(new intelligence.LifeInsightEngine({ clock: () => new Date(NOW) }).build({ patterns, trends: [], stages: [] }).length, 1);
});

test('LifeInsightEngine returns no invented insight without artifacts', () => {
  assert.deepEqual(new intelligence.LifeInsightEngine({ clock: () => new Date(NOW) }).build({ patterns: [], trends: [], stages: [] }), []);
});

test('LifeInsightEngine creates suggestions only after policy approval', () => {
  const context = new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), source(repeated));
  const patterns = new intelligence.LifePatternEngine().detect(context);
  const engine = new intelligence.LifeInsightEngine({ clock: () => new Date(NOW) });
  const insights = engine.build({ patterns, trends: [], stages: [] });
  assert.equal(engine.suggest(insights).length, 1);
});

test('LifeIntelligenceService returns Pattern, Insight and Suggestion', () => {
  const result = service().analyze(fakeTimelineContext(), source(repeated));
  assert.equal(result.patterns.length, 1);
  assert.equal(result.insights.length, 1);
  assert.equal(result.suggestions.length, 1);
});

test('LifeIntelligenceService returns an honest empty result', () => {
  const result = service().analyze(fakeTimelineContext(), source([]));
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, 'LIFE_INTELLIGENCE_EMPTY');
  assert.equal(result.insights.length, 0);
});

test('LifeIntelligenceService fails closed for invalid context', () => {
  const result = service().analyze({ ...fakeTimelineContext(), authenticatedUserId: '' }, source(repeated));
  assert.equal(result.ok, false);
});

test('LifeIntelligenceService fails closed for cross-user Timeline data', () => {
  const timeline = source(repeated);
  timeline.events = timeline.events.map((event) => ({ ...event, userId: 'fake-user-b' }));
  assert.equal(service().analyze(fakeTimelineContext(), timeline).ok, false);
});

test('LifeIntelligenceService does not modify Timeline input', () => {
  const timeline = source(repeated);
  const before = structuredClone(timeline);
  service().analyze(fakeTimelineContext(), timeline);
  assert.deepEqual(timeline, before);
});

test('LifeIntelligenceService does not expose a Memory mutation method', () => {
  const value = service();
  for (const method of ['create', 'update', 'delete', 'supersede', 'writeMemory']) assert.equal(method in value, false);
});

test('LifeIntelligenceService does not require a Repository or Provider', () => {
  assert.doesNotThrow(() => new intelligence.LifeIntelligenceService());
});

test('LifeIntelligenceService filters sensitive evidence before insight generation', () => {
  const records = [...repeated, memory('sensitive', '2026-07-02T00:00:00.000Z', { sensitivity: MemorySensitivity.HIGH })];
  const result = service().analyze(fakeTimelineContext(), source(records));
  assert.equal(JSON.stringify(result).includes('虚构运动记录-sensitive'), false);
  assert.equal(result.filtered.some((item) => item.reasonCode === 'LIFE_INTELLIGENCE_SENSITIVE_FILTERED'), true);
});

test('LifeIntelligenceService defers conflict rather than deciding it', () => {
  const records = repeated.map((item, index) => ({ ...item, conflictGroupId: index < 2 ? 'fake-conflict' : null }));
  const result = service().analyze(fakeTimelineContext(), source(records));
  assert.equal(result.auditEvents.some((event) => event.action === 'life_conflict_deferred'), true);
});

test('LifeIntelligenceService filters estimated time before pattern detection', () => {
  const records = repeated.map((item) => ({ ...item, metadata: { timeline: { captureTimeOnly: true } } }));
  assert.equal(service().analyze(fakeTimelineContext(), source(records)).patterns.length, 0);
});

test('LifeIntelligenceService returns immutable results', () => {
  const result = service().analyze(fakeTimelineContext(), source(repeated));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.insights), true);
});

test('InsightAudit records source references but not summaries', () => {
  const instance = service();
  instance.analyze(fakeTimelineContext(), source(repeated));
  const output = JSON.stringify(instance.listAuditEvents(fakeTimelineContext()));
  assert.equal(output.includes('虚构运动记录'), false);
  assert.equal(output.includes('exercise-1'), true);
});

test('InsightAudit is isolated by user', () => {
  const instance = service();
  instance.analyze(fakeTimelineContext(), source(repeated));
  const other = fakeTimelineContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' });
  assert.equal(instance.listAuditEvents(other).length, 0);
});

test('InsightAudit records analysis completion', () => {
  const instance = service();
  instance.analyze(fakeTimelineContext(), source(repeated));
  assert.equal(instance.listAuditEvents(fakeTimelineContext()).some((event) => event.action === 'life_intelligence_completed'), true);
});

test('InsightAudit records safe failure without raw input', () => {
  const instance = service();
  instance.analyze({ ...fakeTimelineContext(), authenticatedUserId: '' }, source(repeated));
  assert.equal(instance.listAuditEvents(fakeTimelineContext()).some((event) => event.action === 'life_intelligence_failed'), false);
});
