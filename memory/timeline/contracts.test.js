import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TimelineAuditAction,
  TimelineEventStatus,
  TimelineGranularity,
  TimelineQueryPreset,
  TimelineTimeBasis,
  TimelineVisibility,
  createTimelineEvent,
  createTimelinePeriod,
  createTimelineSegment,
  normalizeTimelineQuery,
  validateTimelineContext,
  validateTimelineEvent,
  validateTimelinePeriod,
  validateTimelineSegment
} from './index.js';
import { fakeTimelineContext } from './testing/fixtures.js';

for (const field of [
  'authenticatedUserId', 'actorType', 'actorId', 'requestId', 'correlationId',
  'timestamp', 'timezone', 'locale', 'purpose', 'policyVersion', 'metadata'
]) {
  test(`TimelineContext requires ${field}`, () => {
    const context = fakeTimelineContext();
    delete context[field];
    assert.equal(validateTimelineContext(context).valid, false);
  });
}

for (const field of ['authenticatedUserId', 'actorId', 'requestId', 'correlationId', 'timezone', 'locale', 'purpose', 'policyVersion']) {
  test(`TimelineContext rejects empty ${field}`, () => {
    assert.equal(validateTimelineContext(fakeTimelineContext({ [field]: '' })).valid, false);
  });
}

test('TimelineContext rejects a frontend userId field', () => {
  assert.equal(validateTimelineContext(fakeTimelineContext({ userId: 'fake-user-b' })).valid, false);
});

test('TimelineContext rejects unknown fields', () => {
  assert.equal(validateTimelineContext(fakeTimelineContext({ databasePath: '/tmp/fake.sqlite' })).valid, false);
});

test('TimelineContext rejects secret metadata', () => {
  const result = validateTimelineContext(fakeTimelineContext({ metadata: { accessToken: 'fake-only' } }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === 'SECRET_FORBIDDEN'), true);
});

test('TimelineContext rejects invalid timestamp', () => {
  assert.equal(validateTimelineContext(fakeTimelineContext({ timestamp: 'later' })).valid, false);
});

test('TimelineContext rejects invalid actor type', () => {
  assert.equal(validateTimelineContext(fakeTimelineContext({ actorType: 'root' })).valid, false);
});

test('TimelineContext accepts a complete trusted context', () => {
  assert.equal(validateTimelineContext(fakeTimelineContext()).valid, true);
});

for (const value of ['year', 'quarter', 'month', 'week', 'day']) {
  test(`TimelineGranularity exposes ${value}`, () => {
    assert.equal(Object.values(TimelineGranularity).includes(value), true);
  });
}

for (const value of ['all', 'today', 'yesterday', 'this_year', 'last_year']) {
  test(`TimelineQueryPreset exposes ${value}`, () => {
    assert.equal(Object.values(TimelineQueryPreset).includes(value), true);
  });
}

for (const value of ['current', 'historical', 'conflict']) {
  test(`TimelineEventStatus exposes ${value}`, () => {
    assert.equal(Object.values(TimelineEventStatus).includes(value), true);
  });
}

for (const value of ['visible', 'hidden_sensitive']) {
  test(`TimelineVisibility exposes ${value}`, () => {
    assert.equal(Object.values(TimelineVisibility).includes(value), true);
  });
}

for (const value of ['effective_time', 'estimated_capture_time']) {
  test(`TimelineTimeBasis exposes ${value}`, () => {
    assert.equal(Object.values(TimelineTimeBasis).includes(value), true);
  });
}

for (const value of [
  'timeline_built', 'timeline_queried', 'timeline_merged', 'timeline_sensitive_hidden',
  'timeline_conflict_marked', 'timeline_rendered', 'timeline_failed'
]) {
  test(`TimelineAuditAction exposes ${value}`, () => {
    assert.equal(Object.values(TimelineAuditAction).includes(value), true);
  });
}

test('normalizeTimelineQuery provides safe defaults', () => {
  const query = normalizeTimelineQuery();
  assert.deepEqual(query, {
    preset: 'all', from: null, to: null, memoryTypes: [], subject: null,
    predicate: null, normalizedValue: null, tags: [], memoryIds: [], periodId: null,
    includeHistorical: false, includeSensitive: false, granularity: 'month', limit: 200
  });
  assert.equal(Object.isFrozen(query), true);
});

test('normalizeTimelineQuery caps the result limit', () => {
  assert.equal(normalizeTimelineQuery({ limit: 9000 }).limit, 500);
});

test('normalizeTimelineQuery keeps only supported memory types', () => {
  assert.deepEqual(normalizeTimelineQuery({ memoryTypes: ['goal', 'unknown'] }).memoryTypes, ['goal']);
});

test('normalizeTimelineQuery rejects invalid date ranges', () => {
  assert.throws(() => normalizeTimelineQuery({ from: 'later' }), /TIMELINE_INVALID_QUERY/);
});

test('normalizeTimelineQuery rejects reversed date ranges', () => {
  assert.throws(() => normalizeTimelineQuery({ from: '2026-07-02T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }), /TIMELINE_INVALID_QUERY/);
});

test('normalizeTimelineQuery rejects unsupported presets', () => {
  assert.throws(() => normalizeTimelineQuery({ preset: 'forever' }), /TIMELINE_INVALID_QUERY/);
});

test('normalizeTimelineQuery rejects unsupported granularity', () => {
  assert.throws(() => normalizeTimelineQuery({ granularity: 'century' }), /TIMELINE_INVALID_QUERY/);
});

const baseEvent = {
  id: 'timeline-event-fake-1',
  userId: 'fake-user-a',
  memoryIds: ['fake-memory-1'],
  title: '偏好',
  summary: '虚构咖啡偏好',
  type: 'preference',
  beginTime: '2026-07-01T08:00:00.000Z',
  endTime: null,
  status: 'current',
  confidence: 0.9,
  importance: 0.7,
  visibility: 'visible',
  sourceCount: 1,
  version: 1,
  metadata: { derived: true, timeBasis: 'effective_time', estimated: false }
};

for (const field of Object.keys(baseEvent)) {
  test(`TimelineEvent requires ${field}`, () => {
    const candidate = structuredClone(baseEvent);
    delete candidate[field];
    assert.equal(validateTimelineEvent(candidate, { trustedUserId: 'fake-user-a' }).valid, false);
  });
}

test('TimelineEvent enforces user ownership', () => {
  assert.equal(validateTimelineEvent(baseEvent, { trustedUserId: 'fake-user-b' }).valid, false);
});

test('TimelineEvent requires at least one source memory', () => {
  assert.equal(validateTimelineEvent({ ...baseEvent, memoryIds: [] }, { trustedUserId: 'fake-user-a' }).valid, false);
});

test('TimelineEvent rejects duplicate source memory ids', () => {
  assert.equal(validateTimelineEvent({ ...baseEvent, memoryIds: ['x', 'x'] }, { trustedUserId: 'fake-user-a' }).valid, false);
});

test('TimelineEvent rejects an invalid time range', () => {
  assert.equal(validateTimelineEvent({ ...baseEvent, endTime: '2026-06-01T00:00:00.000Z' }, { trustedUserId: 'fake-user-a' }).valid, false);
});

test('TimelineEvent rejects confidence outside zero to one', () => {
  assert.equal(validateTimelineEvent({ ...baseEvent, confidence: 1.1 }, { trustedUserId: 'fake-user-a' }).valid, false);
});

test('TimelineEvent rejects importance outside zero to one', () => {
  assert.equal(validateTimelineEvent({ ...baseEvent, importance: -0.1 }, { trustedUserId: 'fake-user-a' }).valid, false);
});

test('TimelineEvent rejects version below one', () => {
  assert.equal(validateTimelineEvent({ ...baseEvent, version: 0 }, { trustedUserId: 'fake-user-a' }).valid, false);
});

test('TimelineEvent rejects metadata secrets', () => {
  assert.equal(validateTimelineEvent({ ...baseEvent, metadata: { apiKey: 'fake-only' } }, { trustedUserId: 'fake-user-a' }).valid, false);
});

test('createTimelineEvent returns an immutable valid event', () => {
  const event = createTimelineEvent(baseEvent, { trustedUserId: 'fake-user-a' });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.metadata), true);
  assert.equal(validateTimelineEvent(event, { trustedUserId: 'fake-user-a' }).valid, true);
});

const basePeriod = {
  id: 'timeline-period-fake-1', userId: 'fake-user-a', memoryIds: ['fake-memory-1'],
  title: '虚构创业阶段', beginTime: '2025-01-01T00:00:00.000Z', endTime: null,
  status: 'current', visibility: 'visible', version: 1,
  metadata: { derived: true, explicitlyDeclared: true }
};

for (const field of Object.keys(basePeriod)) {
  test(`TimelinePeriod requires ${field}`, () => {
    const candidate = structuredClone(basePeriod);
    delete candidate[field];
    assert.equal(validateTimelinePeriod(candidate, { trustedUserId: 'fake-user-a' }).valid, false);
  });
}

test('TimelinePeriod cannot be created without explicit Memory support', () => {
  assert.throws(() => createTimelinePeriod({ ...basePeriod, metadata: { derived: true } }, { trustedUserId: 'fake-user-a' }), /TIMELINE_INVALID_PERIOD/);
});

test('createTimelinePeriod returns immutable data', () => {
  assert.equal(Object.isFrozen(createTimelinePeriod(basePeriod, { trustedUserId: 'fake-user-a' })), true);
});

const baseSegment = {
  id: 'timeline-segment-2026-07', granularity: 'month', label: '2026-07',
  beginTime: '2026-07-01T00:00:00.000Z', endTime: '2026-08-01T00:00:00.000Z',
  events: [baseEvent], periods: [], count: 1, metadata: { timezone: 'Asia/Shanghai' }
};

for (const field of Object.keys(baseSegment)) {
  test(`TimelineSegment requires ${field}`, () => {
    const candidate = structuredClone(baseSegment);
    delete candidate[field];
    assert.equal(validateTimelineSegment(candidate).valid, false);
  });
}

test('TimelineSegment count must equal event count', () => {
  assert.equal(validateTimelineSegment({ ...baseSegment, count: 2 }).valid, false);
});

test('createTimelineSegment returns immutable nested data', () => {
  const segment = createTimelineSegment(baseSegment);
  assert.equal(Object.isFrozen(segment), true);
  assert.equal(Object.isFrozen(segment.events), true);
  assert.equal(Object.isFrozen(segment.events[0]), true);
});
