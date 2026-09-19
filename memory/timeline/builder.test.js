import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TimelineBuilder,
  TimelineEventStatus,
  TimelineMerge,
  TimelineTimeBasis,
  TimelineVisibility
} from './index.js';
import { fakeLifeEvent, fakeTimelineMemory } from './testing/fixtures.js';

const builder = new TimelineBuilder();

for (const memoryType of [
  'fact', 'relationship', 'preference', 'goal', 'life_event', 'habit_routine',
  'constraint', 'commitment', 'decision', 'context', 'sensitive_memory'
]) {
  test(`TimelineBuilder derives ${memoryType} without changing its type`, () => {
    const record = fakeTimelineMemory(`fake-${memoryType}`, { memoryType });
    const result = builder.build([record], { userId: 'fake-user-a' });
    assert.equal(result.events[0].type, memoryType);
    assert.deepEqual(result.events[0].memoryIds, [record.id]);
  });
}

test('TimelineBuilder never mutates the source Memory', () => {
  const record = fakeTimelineMemory('fake-immutable');
  const before = structuredClone(record);
  builder.build([record], { userId: 'fake-user-a' });
  assert.deepEqual(record, before);
});

test('TimelineBuilder uses effective time as the occurrence time', () => {
  const event = builder.build([fakeTimelineMemory('fake-time', {
    effectiveFrom: '2025-03-02T01:02:03.000Z', effectiveTo: '2025-04-02T01:02:03.000Z'
  })], { userId: 'fake-user-a' }).events[0];
  assert.equal(event.beginTime, '2025-03-02T01:02:03.000Z');
  assert.equal(event.endTime, '2025-04-02T01:02:03.000Z');
  assert.equal(event.metadata.timeBasis, TimelineTimeBasis.EFFECTIVE);
  assert.equal(event.metadata.estimated, false);
});

test('TimelineBuilder uses Capture time only when explicitly marked capture-only', () => {
  const event = builder.build([fakeTimelineMemory('fake-estimated', {
    effectiveFrom: '2025-03-02T01:02:03.000Z',
    createdAt: '2026-01-02T03:04:05.000Z',
    metadata: { timeline: { captureTimeOnly: true } }
  })], { userId: 'fake-user-a' }).events[0];
  assert.equal(event.beginTime, '2026-01-02T03:04:05.000Z');
  assert.equal(event.metadata.timeBasis, TimelineTimeBasis.ESTIMATED_CAPTURE);
  assert.equal(event.metadata.estimated, true);
});

test('TimelineBuilder does not parse a natural-language date from Memory text', () => {
  const event = builder.build([fakeTimelineMemory('fake-no-date-guess', {
    value: '虚构内容：去年春天发生', normalizedValue: '虚构内容：去年春天发生',
    effectiveFrom: '2026-07-01T08:00:00.000Z'
  })], { userId: 'fake-user-a' }).events[0];
  assert.equal(event.beginTime, '2026-07-01T08:00:00.000Z');
});

test('TimelineBuilder hides high-sensitivity content by default', () => {
  const event = builder.build([fakeTimelineMemory('fake-sensitive', {
    sensitivity: 'high', value: '虚构健康正文', normalizedValue: '虚构健康正文'
  })], { userId: 'fake-user-a' }).events[0];
  assert.equal(event.visibility, TimelineVisibility.HIDDEN_SENSITIVE);
  assert.equal(event.title, '敏感人生事件');
  assert.equal(event.summary, '存在一条敏感人生事件，正文已隐藏。');
  assert.equal(JSON.stringify(event).includes('虚构健康正文'), false);
});

test('TimelineBuilder never expands high-sensitivity text through options', () => {
  const event = builder.build([fakeTimelineMemory('fake-sensitive-option', {
    sensitivity: 'high', value: '虚构敏感正文', normalizedValue: '虚构敏感正文'
  })], { userId: 'fake-user-a', includeSensitive: true }).events[0];
  assert.equal(event.visibility, TimelineVisibility.HIDDEN_SENSITIVE);
  assert.equal(JSON.stringify(event).includes('虚构敏感正文'), false);
});

test('TimelineBuilder excludes restricted Memory', () => {
  const result = builder.build([fakeTimelineMemory('fake-restricted', { sensitivity: 'restricted' })], { userId: 'fake-user-a' });
  assert.equal(result.events.length, 0);
  assert.equal(result.excluded[0].reasonCode, 'TIMELINE_PROHIBITED_EXCLUDED');
});

test('TimelineBuilder fail-closes a secret-shaped value even when sensitivity is misclassified', () => {
  const result = builder.build([fakeTimelineMemory('fake-misclassified-secret', {
    sensitivity: 'low', value: 'sk-fakeonly000000000000000000000000', normalizedValue: 'sk-fakeonly000000000000000000000000'
  })], { userId: 'fake-user-a' });
  assert.equal(result.events.length, 0);
  assert.equal(result.excluded[0].reasonCode, 'TIMELINE_PROHIBITED_EXCLUDED');
});

for (const [status, expected] of [
  ['confirmed', TimelineEventStatus.CURRENT],
  ['superseded', TimelineEventStatus.HISTORICAL],
  ['expired', TimelineEventStatus.HISTORICAL],
  ['archived', TimelineEventStatus.HISTORICAL],
  ['disputed', TimelineEventStatus.CONFLICT]
]) {
  test(`TimelineBuilder maps Memory status ${status} to ${expected}`, () => {
    const record = fakeTimelineMemory(`fake-status-${status}`, {
      status,
      ...(status === 'superseded' ? { supersededById: 'fake-newer' } : {})
    });
    assert.equal(builder.build([record], { userId: 'fake-user-a', includeHistorical: true }).events[0].status, expected);
  });
}

for (const status of ['candidate', 'pending_confirmation', 'deleted']) {
  test(`TimelineBuilder excludes ${status} Memory`, () => {
    const result = builder.build([fakeTimelineMemory(`fake-excluded-${status}`, {
      status,
      confirmationStatus: status === 'deleted' ? 'user_confirmed' : 'pending'
    })], { userId: 'fake-user-a', includeHistorical: true });
    assert.equal(result.events.length, 0);
  });
}

test('TimelineBuilder excludes unconfirmed Memory', () => {
  const result = builder.build([fakeTimelineMemory('fake-unconfirmed', {
    status: 'archived', confirmationStatus: 'user_rejected'
  })], { userId: 'fake-user-a', includeHistorical: true });
  assert.equal(result.events.length, 0);
});

test('TimelineBuilder excludes Memory Candidate type even if its status is confirmed', () => {
  const result = builder.build([fakeTimelineMemory('fake-confirmed-candidate-type', {
    memoryType: 'memory_candidate'
  })], { userId: 'fake-user-a' });
  assert.equal(result.events.length, 0);
  assert.equal(result.excluded[0].reasonCode, 'TIMELINE_CANDIDATE_EXCLUDED');
});

test('TimelineBuilder excludes invalid source records', () => {
  const result = builder.build([fakeTimelineMemory('fake-invalid-source', { source: { type: 'user_confirmed', id: '' } })], { userId: 'fake-user-a' });
  assert.equal(result.events.length, 0);
  assert.equal(result.excluded[0].reasonCode, 'TIMELINE_INVALID_MEMORY');
});

test('TimelineBuilder excludes a record owned by another user', () => {
  const result = builder.build([fakeTimelineMemory('fake-user-b-record', { userId: 'fake-user-b' })], { userId: 'fake-user-a' });
  assert.equal(result.events.length, 0);
  assert.equal(result.excluded[0].reasonCode, 'TIMELINE_USER_SCOPE_EXCLUDED');
});

test('TimelineBuilder marks all members of a conflict group without deciding truth', () => {
  const records = [
    fakeTimelineMemory('fake-conflict-a', { conflictGroupId: 'fake-conflict-1', normalizedValue: 'a' }),
    fakeTimelineMemory('fake-conflict-b', { conflictGroupId: 'fake-conflict-1', normalizedValue: 'b' })
  ];
  const result = builder.build(records, { userId: 'fake-user-a' });
  assert.equal(result.events.every((event) => event.status === TimelineEventStatus.CONFLICT), true);
  assert.equal(result.conflicts[0].resolution, 'governance_required');
  assert.deepEqual(result.conflicts[0].memoryIds, ['fake-conflict-a', 'fake-conflict-b']);
});

test('TimelineBuilder creates a Period only from explicit Memory metadata', () => {
  const record = fakeTimelineMemory('fake-period', {
    memoryType: 'goal',
    metadata: { timeline: { period: { id: 'fake-period-startup', title: '虚构创业阶段' } } }
  });
  const result = builder.build([record], { userId: 'fake-user-a' });
  assert.equal(result.periods.length, 1);
  assert.equal(result.periods[0].title, '虚构创业阶段');
  assert.deepEqual(result.periods[0].memoryIds, [record.id]);
});

test('TimelineBuilder hides a high-sensitivity Period title', () => {
  const result = builder.build([fakeTimelineMemory('fake-sensitive-period', {
    sensitivity: 'high', value: '虚构高敏感阶段正文',
    metadata: { timeline: { period: { id: 'fake-sensitive-stage', title: '虚构高敏感阶段标题' } } }
  })], { userId: 'fake-user-a' });
  assert.equal(result.periods[0].title, '敏感人生阶段');
  assert.equal(JSON.stringify(result.periods[0]).includes('虚构高敏感阶段标题'), false);
});

test('TimelineBuilder does not infer a Period from words in Memory text', () => {
  const result = builder.build([fakeTimelineMemory('fake-no-period', {
    value: '虚构创业阶段经历', normalizedValue: '虚构创业阶段经历'
  })], { userId: 'fake-user-a' });
  assert.equal(result.periods.length, 0);
});

test('TimelineBuilder sorts by occurrence time and then stable id', () => {
  const result = builder.build([
    fakeTimelineMemory('fake-late-b', { effectiveFrom: '2026-07-02T00:00:00.000Z' }),
    fakeTimelineMemory('fake-early', { effectiveFrom: '2026-07-01T00:00:00.000Z' }),
    fakeTimelineMemory('fake-late-a', { effectiveFrom: '2026-07-02T00:00:00.000Z' })
  ], { userId: 'fake-user-a' });
  assert.deepEqual(result.events.map((event) => event.memoryIds[0]), ['fake-early', 'fake-late-a', 'fake-late-b']);
});

test('TimelineMerge combines exact technical duplicates without modifying Memory', () => {
  const merge = new TimelineMerge();
  const events = builder.build([
    fakeTimelineMemory('fake-duplicate-a', { normalizedValue: 'same', value: 'same' }),
    fakeTimelineMemory('fake-duplicate-b', { normalizedValue: 'same', value: 'same' })
  ], { userId: 'fake-user-a' }).events;
  const result = merge.merge(events);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].memoryIds, ['fake-duplicate-a', 'fake-duplicate-b']);
  assert.equal(result.events[0].sourceCount, 2);
  assert.equal(result.merges[0].reasonCode, 'TIMELINE_EXACT_DUPLICATE_MERGE');
});

test('TimelineMerge counts unique sources rather than duplicate rows', () => {
  const merge = new TimelineMerge();
  const events = builder.build([
    fakeTimelineMemory('fake-same-source-a', { value: 'same', normalizedValue: 'same', source: { type: 'user_confirmed', id: 'fake-shared-source' } }),
    fakeTimelineMemory('fake-same-source-b', { value: 'same', normalizedValue: 'same', source: { type: 'user_confirmed', id: 'fake-shared-source' } })
  ], { userId: 'fake-user-a' }).events;
  assert.equal(merge.merge(events).events[0].sourceCount, 1);
});

test('TimelineMerge preserves all explicit Period references', () => {
  const merge = new TimelineMerge();
  const events = builder.build([
    fakeTimelineMemory('fake-period-merge-a', {
      value: 'same', normalizedValue: 'same',
      metadata: { timeline: { period: { id: 'fake-period-a', title: '虚构阶段 A' } } }
    }),
    fakeTimelineMemory('fake-period-merge-b', {
      value: 'same', normalizedValue: 'same',
      metadata: { timeline: { period: { id: 'fake-period-b', title: '虚构阶段 B' } } }
    })
  ], { userId: 'fake-user-a' }).events;
  assert.deepEqual(merge.merge(events).events[0].metadata.periodIds, ['fake-period-a', 'fake-period-b']);
});

test('TimelineMerge preserves similar Life Events at different occurrence times', () => {
  const merge = new TimelineMerge();
  const events = builder.build([
    fakeLifeEvent('fake-trip-2025', { normalizedValue: '虚构旅行', value: '虚构旅行', effectiveFrom: '2025-01-01T00:00:00.000Z' }),
    fakeLifeEvent('fake-trip-2026', { normalizedValue: '虚构旅行', value: '虚构旅行', effectiveFrom: '2026-01-01T00:00:00.000Z' })
  ], { userId: 'fake-user-a' }).events;
  assert.equal(merge.merge(events).events.length, 2);
});

test('TimelineMerge does not merge conflicting events', () => {
  const merge = new TimelineMerge();
  const events = builder.build([
    fakeTimelineMemory('fake-conflict-merge-a', { conflictGroupId: 'fake-cg', normalizedValue: 'a' }),
    fakeTimelineMemory('fake-conflict-merge-b', { conflictGroupId: 'fake-cg', normalizedValue: 'b' })
  ], { userId: 'fake-user-a' }).events;
  assert.equal(merge.merge(events).events.length, 2);
});
