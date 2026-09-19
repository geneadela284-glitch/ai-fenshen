import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TimelineBuilder,
  TimelineFilter,
  TimelineRenderer,
  normalizeTimelineQuery
} from './index.js';
import { fakeLifeEvent, fakeTimelineMemory } from './testing/fixtures.js';

const context = { timestamp: '2026-07-15T08:00:00.000Z', timezone: 'Asia/Shanghai' };
const builder = new TimelineBuilder();
const filter = new TimelineFilter();
const renderer = new TimelineRenderer();

function built(records, options = {}) {
  return builder.build(records, { userId: 'fake-user-a', includeHistorical: true, ...options });
}

test('TimelineFilter today uses the user timezone', () => {
  const data = built([
    fakeLifeEvent('fake-yesterday', { effectiveFrom: '2026-07-14T15:59:59.000Z' }),
    fakeLifeEvent('fake-today', { effectiveFrom: '2026-07-14T16:00:00.000Z' }),
    fakeLifeEvent('fake-tomorrow', { effectiveFrom: '2026-07-15T16:00:00.000Z' })
  ]);
  const result = filter.apply(data, normalizeTimelineQuery({ preset: 'today' }), context);
  assert.deepEqual(result.events.map((event) => event.memoryIds[0]), ['fake-today']);
});

test('TimelineFilter yesterday uses the user timezone', () => {
  const data = built([
    fakeLifeEvent('fake-two-days-ago', { effectiveFrom: '2026-07-13T15:59:59.000Z' }),
    fakeLifeEvent('fake-yesterday', { effectiveFrom: '2026-07-13T16:00:00.000Z' }),
    fakeLifeEvent('fake-today', { effectiveFrom: '2026-07-14T16:00:00.000Z' })
  ]);
  assert.deepEqual(filter.apply(data, normalizeTimelineQuery({ preset: 'yesterday' }), context).events.map((event) => event.memoryIds[0]), ['fake-yesterday']);
});

test('TimelineFilter this year uses local year boundaries', () => {
  const data = built([
    fakeLifeEvent('fake-last-year', { effectiveFrom: '2025-12-31T15:59:59.000Z' }),
    fakeLifeEvent('fake-this-year', { effectiveFrom: '2025-12-31T16:00:00.000Z' })
  ]);
  assert.deepEqual(filter.apply(data, normalizeTimelineQuery({ preset: 'this_year' }), context).events.map((event) => event.memoryIds[0]), ['fake-this-year']);
});

test('TimelineFilter last year uses local year boundaries', () => {
  const data = built([
    fakeLifeEvent('fake-2024', { effectiveFrom: '2024-12-31T15:59:59.000Z' }),
    fakeLifeEvent('fake-2025', { effectiveFrom: '2024-12-31T16:00:00.000Z' }),
    fakeLifeEvent('fake-2026', { effectiveFrom: '2025-12-31T16:00:00.000Z' })
  ]);
  assert.deepEqual(filter.apply(data, normalizeTimelineQuery({ preset: 'last_year' }), context).events.map((event) => event.memoryIds[0]), ['fake-2025']);
});

test('TimelineFilter supports an explicit UTC range', () => {
  const data = built([
    fakeLifeEvent('fake-before', { effectiveFrom: '2026-06-30T23:59:59.000Z' }),
    fakeLifeEvent('fake-in-range', { effectiveFrom: '2026-07-01T00:00:00.000Z' }),
    fakeLifeEvent('fake-after', { effectiveFrom: '2026-08-01T00:00:00.000Z' })
  ]);
  const query = normalizeTimelineQuery({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });
  assert.deepEqual(filter.apply(data, query, context).events.map((event) => event.memoryIds[0]), ['fake-in-range']);
});

for (const [field, value, expected] of [
  ['memoryTypes', ['goal'], 'fake-goal'],
  ['subject', 'fake-project', 'fake-subject'],
  ['predicate', 'lives_in', 'fake-predicate'],
  ['normalizedValue', '虚构地点', 'fake-location'],
  ['tags', ['fictional', 'milestone'], 'fake-tags'],
  ['memoryIds', ['fake-memory-id'], 'fake-memory-id']
]) {
  test(`TimelineFilter supports ${field}`, () => {
    const data = built([
      fakeTimelineMemory('fake-goal', { memoryType: 'goal' }),
      fakeTimelineMemory('fake-subject', { subject: 'fake-project' }),
      fakeTimelineMemory('fake-predicate', { predicate: 'lives_in' }),
      fakeTimelineMemory('fake-location', { normalizedValue: '虚构地点', value: '虚构地点' }),
      fakeTimelineMemory('fake-tags', { tags: ['fictional', 'milestone'] }),
      fakeTimelineMemory('fake-memory-id')
    ]);
    assert.deepEqual(filter.apply(data, normalizeTimelineQuery({ [field]: value }), context).events.map((event) => event.memoryIds[0]), [expected]);
  });
}

test('TimelineFilter supports a declared life Period', () => {
  const data = built([
    fakeTimelineMemory('fake-period-member', { metadata: { timeline: { period: { id: 'fake-stage', title: '虚构阶段' } } } }),
    fakeTimelineMemory('fake-no-period')
  ]);
  const result = filter.apply(data, normalizeTimelineQuery({ periodId: 'fake-stage' }), context);
  assert.deepEqual(result.events.map((event) => event.memoryIds[0]), ['fake-period-member']);
  assert.equal(result.periods[0].id, 'fake-stage');
});

test('TimelineFilter does not leave an unsupported Period after its Memory is filtered out', () => {
  const data = built([fakeTimelineMemory('fake-old-period', {
    effectiveFrom: '2025-01-01T00:00:00.000Z',
    metadata: { timeline: { period: { id: 'fake-old-stage', title: '虚构旧阶段' } } }
  })]);
  const result = filter.apply(data, normalizeTimelineQuery({ preset: 'this_year' }), context);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.periods, []);
});

test('TimelineFilter excludes historical events by default', () => {
  const data = built([
    fakeTimelineMemory('fake-current'),
    fakeTimelineMemory('fake-historical', { status: 'superseded', supersededById: 'fake-current' })
  ]);
  assert.deepEqual(filter.apply(data, normalizeTimelineQuery(), context).events.map((event) => event.memoryIds[0]), ['fake-current']);
});

test('TimelineFilter returns historical events when explicitly requested', () => {
  const data = built([fakeTimelineMemory('fake-historical', { status: 'superseded', supersededById: 'fake-current' })]);
  assert.equal(filter.apply(data, normalizeTimelineQuery({ includeHistorical: true }), context).events.length, 1);
});

test('TimelineFilter keeps only a hidden marker for sensitive Memory', () => {
  const data = built([fakeTimelineMemory('fake-sensitive-filter', { sensitivity: 'high', value: '虚构隐私正文' })]);
  const event = filter.apply(data, normalizeTimelineQuery(), context).events[0];
  assert.equal(event.visibility, 'hidden_sensitive');
  assert.equal(JSON.stringify(event).includes('虚构隐私正文'), false);
});

test('TimelineFilter applies a deterministic limit after sorting', () => {
  const data = built([
    fakeTimelineMemory('fake-c', { effectiveFrom: '2026-07-03T00:00:00.000Z' }),
    fakeTimelineMemory('fake-a', { effectiveFrom: '2026-07-01T00:00:00.000Z' }),
    fakeTimelineMemory('fake-b', { effectiveFrom: '2026-07-02T00:00:00.000Z' })
  ]);
  assert.deepEqual(filter.apply(data, normalizeTimelineQuery({ limit: 2 }), context).events.map((event) => event.memoryIds[0]), ['fake-a', 'fake-b']);
});

for (const [granularity, expectedLabel] of [
  ['year', '2026'], ['quarter', '2026-Q3'], ['month', '2026-07'], ['week', '2026-W29'], ['day', '2026-07-15']
]) {
  test(`TimelineRenderer groups events by ${granularity}`, () => {
    const data = built([fakeLifeEvent(`fake-${granularity}`, { effectiveFrom: '2026-07-15T08:00:00.000Z' })]);
    const result = renderer.render(data, { granularity, timezone: 'Asia/Shanghai' });
    assert.equal(result.segments[0].granularity, granularity);
    assert.equal(result.segments[0].label, expectedLabel);
    assert.equal(result.segments[0].count, 1);
  });
}

test('TimelineRenderer creates separate stable segments', () => {
  const data = built([
    fakeLifeEvent('fake-june', { effectiveFrom: '2026-06-01T00:00:00.000Z' }),
    fakeLifeEvent('fake-july', { effectiveFrom: '2026-07-01T00:00:00.000Z' })
  ]);
  const result = renderer.render(data, { granularity: 'month', timezone: 'Asia/Shanghai' });
  assert.deepEqual(result.segments.map((segment) => segment.label), ['2026-06', '2026-07']);
});

test('TimelineRenderer attaches explicit Periods to their beginning segment', () => {
  const data = built([fakeTimelineMemory('fake-period-render', {
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    metadata: { timeline: { period: { id: 'fake-stage-render', title: '虚构阶段' } } }
  })]);
  const result = renderer.render(data, { granularity: 'month', timezone: 'Asia/Shanghai' });
  assert.equal(result.segments[0].periods[0].id, 'fake-stage-render');
});

test('TimelineRenderer returns immutable serializable data', () => {
  const data = built([fakeLifeEvent('fake-render-immutable')]);
  const result = renderer.render(data, { granularity: 'month', timezone: 'Asia/Shanghai' });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.segments[0]), true);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('TimelineRenderer returns an empty data view for no events', () => {
  const result = renderer.render({ events: [], periods: [] }, { granularity: 'month', timezone: 'Asia/Shanghai' });
  assert.deepEqual(result.segments, []);
  assert.equal(result.eventCount, 0);
});
