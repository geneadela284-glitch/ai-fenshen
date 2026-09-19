import assert from 'node:assert/strict';
import test from 'node:test';

import { MemorySensitivity, MemoryStatus, MemoryType } from '../kernel/index.js';
import { TimelineBuilder } from '../timeline/index.js';
import { fakeTimelineContext, fakeTimelineMemory } from '../timeline/testing/fixtures.js';
import * as intelligence from './index.js';

function record(id, date, overrides = {}) {
  return fakeTimelineMemory(id, {
    memoryType: MemoryType.HABIT_ROUTINE,
    predicate: 'does_reading',
    value: '虚构阅读记录',
    normalizedValue: 'reading',
    effectiveFrom: date,
    createdAt: date,
    updatedAt: date,
    ...overrides
  });
}

function timeline(records, options = {}) {
  return {
    ok: true,
    ...new TimelineBuilder().build(records, { userId: 'fake-user-a', includeHistorical: true }),
    ...options
  };
}

function analyze(records, options = {}) {
  return new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), timeline(records, options));
}

const daily = [
  record('memory-day-1', '2026-07-01T08:00:00.000Z'),
  record('memory-day-2', '2026-07-02T08:00:00.000Z'),
  record('memory-day-3', '2026-07-03T08:00:00.000Z')
];

test('LifeContextAnalyzer rejects an unsuccessful Timeline result', () => {
  const result = new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), { ok: false });
  assert.equal(result.ok, false);
});

test('LifeContextAnalyzer rejects cross-user Timeline events', () => {
  const value = timeline(daily);
  value.events = value.events.map((event) => ({ ...event, userId: 'fake-user-b' }));
  assert.equal(new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), value).ok, false);
});

test('LifeContextAnalyzer rejects a malformed Timeline event', () => {
  const value = timeline(daily);
  value.events = value.events.map((event, index) => index ? event : { ...event, memoryIds: [] });
  assert.equal(new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), value).ok, false);
});

test('LifeContextAnalyzer rejects a malformed Timeline Period', () => {
  const staged = record('invalid-stage', '2026-01-01T00:00:00.000Z', { metadata: { timeline: { period: { id: 'period-invalid', title: '虚构阶段' } } } });
  const value = timeline([staged]);
  value.periods = value.periods.map((period) => ({ ...period, metadata: { ...period.metadata, explicitlyDeclared: false } }));
  assert.equal(new intelligence.LifeContextAnalyzer().analyze(fakeTimelineContext(), value).ok, false);
});

test('LifeContextAnalyzer keeps visible effective-time events', () => {
  assert.equal(analyze(daily).events.length, 3);
});

test('LifeContextAnalyzer filters hidden sensitive events from intelligence', () => {
  const sensitive = record('memory-sensitive', '2026-07-04T08:00:00.000Z', { sensitivity: MemorySensitivity.HIGH });
  const result = analyze([...daily, sensitive]);
  assert.equal(result.events.length, 3);
  assert.equal(result.filtered.some((item) => item.reasonCode === 'LIFE_INTELLIGENCE_SENSITIVE_FILTERED'), true);
});

test('LifeContextAnalyzer defers conflicting events to Governance', () => {
  const conflict = daily.slice(0, 2).map((item) => ({ ...item, conflictGroupId: 'fake-conflict' }));
  const result = analyze([...conflict, daily[2]]);
  assert.equal(result.events.length, 1);
  assert.equal(result.filtered.some((item) => item.reasonCode === 'LIFE_INTELLIGENCE_CONFLICT_DEFERRED'), true);
});

test('LifeContextAnalyzer filters estimated capture-time events', () => {
  const estimated = record('memory-estimated', '2026-07-04T08:00:00.000Z', { metadata: { fixture: true, timeline: { captureTimeOnly: true } } });
  assert.equal(analyze([...daily, estimated]).events.length, 3);
});

test('LifeContextAnalyzer keeps explicit visible Timeline Periods', () => {
  const staged = record('memory-stage', '2026-01-01T00:00:00.000Z', { metadata: { timeline: { period: { id: 'period-startup', title: '虚构创业阶段' } } } });
  assert.equal(analyze([staged]).periods.length, 1);
});

test('LifeContextAnalyzer filters hidden sensitive Timeline Periods', () => {
  const staged = record('memory-sensitive-stage', '2026-01-01T00:00:00.000Z', { sensitivity: MemorySensitivity.HIGH, metadata: { timeline: { period: { id: 'period-private', title: '虚构私密阶段' } } } });
  assert.equal(analyze([staged]).periods.length, 0);
});

test('LifeContextAnalyzer returns immutable data', () => {
  const result = analyze(daily);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.events), true);
});

test('LifePatternEngine detects three repeated behavior observations', () => {
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(daily)).length, 1);
});

test('LifePatternEngine requires three observations', () => {
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(daily.slice(0, 2))).length, 0);
});

test('LifePatternEngine recognizes daily cadence', () => {
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(daily))[0].cadence, 'daily');
});

test('LifePatternEngine recognizes weekly cadence', () => {
  const records = [record('week-1', '2026-06-01T08:00:00.000Z'), record('week-2', '2026-06-08T08:00:00.000Z'), record('week-3', '2026-06-15T08:00:00.000Z')];
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(records))[0].cadence, 'weekly');
});

test('LifePatternEngine recognizes monthly cadence', () => {
  const records = [record('month-1', '2026-04-01T08:00:00.000Z'), record('month-2', '2026-05-01T08:00:00.000Z'), record('month-3', '2026-06-01T08:00:00.000Z')];
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(records))[0].cadence, 'monthly');
});

test('LifePatternEngine labels irregular evidence as repeated', () => {
  const records = [record('repeat-1', '2026-01-01T08:00:00.000Z'), record('repeat-2', '2026-01-03T08:00:00.000Z'), record('repeat-3', '2026-02-20T08:00:00.000Z')];
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(records))[0].cadence, 'repeated');
});

test('LifePatternEngine uses the earliest evidence time', () => {
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(daily))[0].beginTime, daily[0].effectiveFrom);
});

test('LifePatternEngine uses the latest evidence time', () => {
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(daily))[0].endTime, daily[2].effectiveFrom);
});

test('LifePatternEngine preserves all Memory references', () => {
  assert.deepEqual(new intelligence.LifePatternEngine().detect(analyze(daily))[0].memoryIds, daily.map((item) => item.id));
});

test('LifePatternEngine preserves all Timeline Event references', () => {
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(daily))[0].timelineEventIds.length, 3);
});

test('LifePatternEngine averages source confidence', () => {
  const records = daily.map((item, index) => ({ ...item, confidence: [0.6, 0.9, 0.9][index] }));
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(records))[0].confidence, 0.8);
});

test('LifePatternEngine keeps the maximum declared importance', () => {
  const records = daily.map((item, index) => ({ ...item, importance: [0.2, 0.8, 0.5][index] }));
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(records))[0].importance, 0.8);
});

test('LifePatternEngine produces a deterministic id', () => {
  const engine = new intelligence.LifePatternEngine();
  assert.equal(engine.detect(analyze(daily))[0].id, engine.detect(analyze(daily))[0].id);
});

test('LifePatternEngine does not mutate Timeline data', () => {
  const context = analyze(daily);
  const before = structuredClone(context);
  new intelligence.LifePatternEngine().detect(context);
  assert.deepEqual(context, before);
});

for (const memoryType of [MemoryType.LIFE_EVENT, MemoryType.FACT, MemoryType.RELATIONSHIP, MemoryType.PREFERENCE]) {
  test(`LifePatternEngine does not infer behavior from ${memoryType}`, () => {
    const records = daily.map((item) => ({ ...item, memoryType }));
    assert.equal(new intelligence.LifePatternEngine().detect(analyze(records)).length, 0);
  });
}

test('LifePatternEngine separates different predicates', () => {
  const records = [...daily, ...daily.map((item, index) => ({ ...item, id: `other-${index}`, source: { ...item.source, id: `source-other-${index}` }, checksum: `checksum-other-${index}`, predicate: 'does_walking' }))];
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(records)).length, 2);
});

test('LifePatternEngine separates different normalized values', () => {
  const records = daily.map((item, index) => ({ ...item, normalizedValue: index === 2 ? 'writing' : 'reading' }));
  assert.equal(new intelligence.LifePatternEngine().detect(analyze(records)).length, 0);
});

function changedRecords(overrides = {}) {
  return [
    record('goal-old', '2026-01-01T00:00:00.000Z', { memoryType: MemoryType.GOAL, predicate: 'has_goal', normalizedValue: 'goal-a', value: '虚构旧目标', status: MemoryStatus.SUPERSEDED, supersededById: 'goal-new', ...overrides }),
    record('goal-new', '2026-06-01T00:00:00.000Z', { memoryType: MemoryType.GOAL, predicate: 'has_goal', normalizedValue: 'goal-b', value: '虚构新目标', supersedesId: 'goal-old', ...overrides })
  ];
}

test('LifeTrendEngine detects a recorded value change', () => {
  assert.equal(new intelligence.LifeTrendEngine().detect(analyze(changedRecords())).length, 1);
});

test('LifeTrendEngine does not invent a trend from an unchanged value', () => {
  const records = changedRecords().map((item) => ({ ...item, normalizedValue: 'same-goal' }));
  assert.equal(new intelligence.LifeTrendEngine().detect(analyze(records)).length, 0);
});

test('LifeTrendEngine requires two observations', () => {
  assert.equal(new intelligence.LifeTrendEngine().detect(analyze(changedRecords().slice(0, 1))).length, 0);
});

test('LifeTrendEngine reports changed rather than predicting direction', () => {
  assert.equal(new intelligence.LifeTrendEngine().detect(analyze(changedRecords()))[0].direction, 'changed');
});

test('LifeTrendEngine produces a deterministic id', () => {
  const engine = new intelligence.LifeTrendEngine();
  assert.equal(engine.detect(analyze(changedRecords()))[0].id, engine.detect(analyze(changedRecords()))[0].id);
});

test('LifeTrendEngine preserves the time range', () => {
  const value = new intelligence.LifeTrendEngine().detect(analyze(changedRecords()))[0];
  assert.equal(value.beginTime, '2026-01-01T00:00:00.000Z');
  assert.equal(value.endTime, '2026-06-01T00:00:00.000Z');
});

test('LifeTrendEngine preserves source references', () => {
  const value = new intelligence.LifeTrendEngine().detect(analyze(changedRecords()))[0];
  assert.equal(value.memoryIds.length, 2);
  assert.equal(value.timelineEventIds.length, 2);
});

test('LifeTrendEngine uses the minimum source confidence', () => {
  const records = changedRecords().map((item, index) => ({ ...item, confidence: index ? 0.9 : 0.6 }));
  assert.equal(new intelligence.LifeTrendEngine().detect(analyze(records))[0].confidence, 0.6);
});

for (const memoryType of [MemoryType.LIFE_EVENT, MemoryType.CONTEXT, MemoryType.SENSITIVE_MEMORY]) {
  test(`LifeTrendEngine does not infer a trend from ${memoryType}`, () => {
    assert.equal(new intelligence.LifeTrendEngine().detect(analyze(changedRecords({ memoryType }))).length, 0);
  });
}

test('LifeTrendEngine separates subjects', () => {
  const records = changedRecords().map((item, index) => ({ ...item, subject: index ? 'other-subject' : item.subject }));
  assert.equal(new intelligence.LifeTrendEngine().detect(analyze(records)).length, 0);
});

test('LifeTrendEngine separates predicates', () => {
  const records = changedRecords().map((item, index) => ({ ...item, predicate: index ? 'other_goal' : item.predicate }));
  assert.equal(new intelligence.LifeTrendEngine().detect(analyze(records)).length, 0);
});

test('LifeTrendEngine handles more than two recorded values as one explainable trend', () => {
  const records = [...changedRecords(), record('goal-third', '2026-07-01T00:00:00.000Z', { memoryType: MemoryType.GOAL, predicate: 'has_goal', normalizedValue: 'goal-c' })];
  assert.equal(new intelligence.LifeTrendEngine().detect(analyze(records))[0].evidence.length, 3);
});

test('LifeStageEngine identifies an explicit Timeline Period', () => {
  const staged = record('stage-memory', '2026-01-01T00:00:00.000Z', { metadata: { timeline: { period: { id: 'period-startup', title: '虚构创业阶段' } } } });
  assert.equal(new intelligence.LifeStageEngine().identify(analyze([staged])).length, 1);
});

test('LifeStageEngine never invents a stage without a Timeline Period', () => {
  assert.equal(new intelligence.LifeStageEngine().identify(analyze(daily)).length, 0);
});

test('LifeStageEngine preserves the explicit title', () => {
  const staged = record('stage-title', '2026-01-01T00:00:00.000Z', { metadata: { timeline: { period: { id: 'period-family', title: '虚构家庭阶段' } } } });
  assert.equal(new intelligence.LifeStageEngine().identify(analyze([staged]))[0].title, '虚构家庭阶段');
});

test('LifeStageEngine preserves Memory and Period references', () => {
  const staged = record('stage-ref', '2026-01-01T00:00:00.000Z', { metadata: { timeline: { period: { id: 'period-study', title: '虚构学习阶段' } } } });
  const value = new intelligence.LifeStageEngine().identify(analyze([staged]))[0];
  assert.deepEqual(value.memoryIds, ['stage-ref']);
  assert.deepEqual(value.timelinePeriodIds, ['period-study']);
});

test('LifeStageEngine produces a deterministic id', () => {
  const staged = record('stage-id', '2026-01-01T00:00:00.000Z', { metadata: { timeline: { period: { id: 'period-id', title: '虚构阶段' } } } });
  const engine = new intelligence.LifeStageEngine();
  assert.equal(engine.identify(analyze([staged]))[0].id, engine.identify(analyze([staged]))[0].id);
});

test('LifeEvolutionTracker sorts artifacts by recorded time', () => {
  const patterns = new intelligence.LifePatternEngine().detect(analyze(daily));
  const trends = new intelligence.LifeTrendEngine().detect(analyze(changedRecords()));
  const result = new intelligence.LifeEvolutionTracker().track({ patterns, trends, stages: [] });
  assert.deepEqual(result.map((item) => item.kind), ['trend', 'pattern']);
});

test('LifeEvolutionTracker exposes source ids rather than predictions', () => {
  const patterns = new intelligence.LifePatternEngine().detect(analyze(daily));
  const result = new intelligence.LifeEvolutionTracker().track({ patterns, trends: [], stages: [] });
  assert.equal(result[0].sourceId, patterns[0].id);
  assert.equal('prediction' in result[0], false);
});

test('LifeEvolutionTracker returns immutable markers', () => {
  const patterns = new intelligence.LifePatternEngine().detect(analyze(daily));
  assert.equal(Object.isFrozen(new intelligence.LifeEvolutionTracker().track({ patterns, trends: [], stages: [] })), true);
});
