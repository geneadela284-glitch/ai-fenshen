import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHomeTasksState,
  formatTaskTime,
  reduceHomeTasksState,
  selectHomeBubbleMode,
  toReminderItems
} from './homeTasksState.js';
import * as homeTasksSubject from './homeTasksState.js';

const todayTask = {
  id: 'today-1',
  title: '今日真实事项',
  description: '今日说明',
  scheduledAt: '2026-07-29T01:30:00.000Z',
  timezone: 'Asia/Shanghai',
  status: 'pending',
  completedAt: null
};
const tomorrowTask = {
  ...todayTask,
  id: 'tomorrow-1',
  title: '明日真实事项',
  scheduledAt: '2026-07-30T02:00:00.000Z'
};

test('loading and error never select the no-agenda feature bubble', () => {
  const loading = createHomeTasksState();
  assert.equal(loading.status, 'loading');
  assert.equal(selectHomeBubbleMode(loading), 'none');

  const failed = reduceHomeTasksState(loading, {
    type: 'failed',
    error: '事项暂时无法读取，请稍后重试。'
  });
  assert.equal(failed.status, 'error');
  assert.equal(selectHomeBubbleMode(failed), 'none');
});

test('successful empty data selects feature intro while either day with items selects reminders', () => {
  const empty = reduceHomeTasksState(createHomeTasksState(), {
    type: 'loaded',
    payload: { state: 'empty', today: [], tomorrow: [], range: { timezone: 'Asia/Shanghai' } }
  });
  assert.equal(selectHomeBubbleMode(empty), 'feature-intro');

  const onlyToday = reduceHomeTasksState(empty, {
    type: 'loaded',
    payload: { state: 'ready', today: [todayTask], tomorrow: [], range: { timezone: 'Asia/Shanghai' } }
  });
  assert.equal(selectHomeBubbleMode(onlyToday), 'reminders');

  const onlyTomorrow = reduceHomeTasksState(empty, {
    type: 'loaded',
    payload: { state: 'ready', today: [], tomorrow: [tomorrowTask], range: { timezone: 'Asia/Shanghai' } }
  });
  assert.equal(selectHomeBubbleMode(onlyTomorrow), 'reminders');
});

test('RED: handled feature intro stays hidden while real task reminders remain available', () => {
  const empty = reduceHomeTasksState(createHomeTasksState(), {
    type: 'loaded',
    payload: { state: 'empty', today: [], tomorrow: [] }
  });
  assert.equal(selectHomeBubbleMode(empty, { featureIntroVisible: true }), 'feature-intro');
  assert.equal(selectHomeBubbleMode(empty, { featureIntroVisible: false }), 'none');

  const withTask = reduceHomeTasksState(createHomeTasksState(), {
    type: 'loaded',
    payload: {
      state: 'ready',
      today: [{ id: 'task-1', title: '开会', status: 'pending' }],
      tomorrow: []
    }
  });
  assert.equal(selectHomeBubbleMode(withTask, { featureIntroVisible: false }), 'reminders');
});

test('RED: compact feature intro remains manually reopenable only for successful empty data', () => {
  const empty = reduceHomeTasksState(createHomeTasksState(), {
    type: 'loaded',
    payload: {
      state: 'empty',
      today: [],
      tomorrow: [],
      range: { timezone: 'Asia/Shanghai', today: '2026-07-29', tomorrow: '2026-07-30' }
    }
  });
  assert.equal(
    selectHomeBubbleMode(empty, { featureIntroPresentation: 'compact' }),
    'feature-intro-compact'
  );
  assert.equal(
    selectHomeBubbleMode({ ...empty, status: 'loading' }, { featureIntroPresentation: 'compact' }),
    'none'
  );
  assert.equal(
    selectHomeBubbleMode(empty, { featureIntroPresentation: 'manual' }),
    'feature-intro'
  );
});

test('RED: a completed intro stays hidden while real items still select reminder bubbles', () => {
  const empty = reduceHomeTasksState(createHomeTasksState(), {
    type: 'loaded',
    payload: { state: 'empty', today: [], tomorrow: [] }
  });
  assert.equal(
    selectHomeBubbleMode(empty, { featureIntroPresentation: 'hidden' }),
    'none'
  );
  const withTask = reduceHomeTasksState(empty, {
    type: 'loaded',
    payload: { state: 'ready', today: [todayTask], tomorrow: [] }
  });
  assert.equal(
    selectHomeBubbleMode(withTask, { featureIntroPresentation: 'hidden' }),
    'reminders'
  );
});

test('today and tomorrow remain distinct and task updates replace only the matching item', () => {
  let state = reduceHomeTasksState(createHomeTasksState(), {
    type: 'loaded',
    payload: {
      state: 'ready',
      today: [todayTask],
      tomorrow: [tomorrowTask],
      range: { timezone: 'Asia/Shanghai' }
    }
  });
  state = reduceHomeTasksState(state, {
    type: 'task-updated',
    task: { ...todayTask, status: 'completed', completedAt: '2026-07-29T03:00:00.000Z' }
  });

  assert.equal(state.today[0].status, 'completed');
  assert.equal(state.tomorrow[0].status, 'pending');
  assert.equal(state.today[0].id, 'today-1');
  assert.equal(state.tomorrow[0].id, 'tomorrow-1');
});

test('task times and reminder labels use the task timezone and status', () => {
  assert.equal(formatTaskTime(todayTask), '09:30');
  assert.deepEqual(toReminderItems({ today: [todayTask], tomorrow: [tomorrowTask] }), [
    {
      id: 'today-1',
      time: '09:30',
      title: '今日真实事项',
      note: '今日 · 待完成',
      icon: 'calendar-event'
    },
    {
      id: 'tomorrow-1',
      time: '10:00',
      title: '明日真实事项',
      note: '明日 · 待完成',
      icon: 'calendar-event'
    }
  ]);
});

test('task bubble state is isolated by user date type and task-list signature', () => {
  assert.equal(typeof homeTasksSubject.taskListSignature, 'function');
  assert.equal(typeof homeTasksSubject.taskBubbleStorageKey, 'function');
  assert.equal(typeof homeTasksSubject.createTaskBubbleState, 'function');
  assert.equal(typeof homeTasksSubject.advanceTaskBubbleState, 'function');

  const keyA = homeTasksSubject.taskBubbleStorageKey({
    userId: 'user-a',
    dateKey: '2026-07-30',
    bubbleType: 'today'
  });
  const keyB = homeTasksSubject.taskBubbleStorageKey({
    userId: 'user-b',
    dateKey: '2026-07-30',
    bubbleType: 'today'
  });
  assert.notEqual(keyA, keyB);
  assert.notEqual(
    keyA,
    homeTasksSubject.taskBubbleStorageKey({
      userId: 'user-a',
      dateKey: '2026-07-30',
      bubbleType: 'tomorrow'
    })
  );

  const signature = homeTasksSubject.taskListSignature([
    { id: 'task-1', updatedAt: '2026-07-30T01:00:00.000Z', status: 'pending' }
  ]);
  const changedSignature = homeTasksSubject.taskListSignature([
    { id: 'task-1', updatedAt: '2026-07-30T02:00:00.000Z', status: 'pending' }
  ]);
  assert.notEqual(signature, changedSignature);
});

test('task bubble highlights once, advances one item per click and pops without completing tasks', () => {
  const initial = homeTasksSubject.createTaskBubbleState('signature-a');
  const highlighted = homeTasksSubject.advanceTaskBubbleState(initial, 2, '2026-07-30T03:00:00.000Z');
  const next = homeTasksSubject.advanceTaskBubbleState(highlighted, 2, '2026-07-30T03:00:01.000Z');
  const popped = homeTasksSubject.advanceTaskBubbleState(next, 2, '2026-07-30T03:00:02.000Z');

  assert.equal(highlighted.highlighted, true);
  assert.equal(highlighted.currentIndex, 0);
  assert.equal(next.currentIndex, 1);
  assert.equal(next.poppedAt, null);
  assert.equal(popped.currentIndex, 1);
  assert.equal(popped.poppedAt, '2026-07-30T03:00:02.000Z');
  assert.equal('status' in popped, false);
});
