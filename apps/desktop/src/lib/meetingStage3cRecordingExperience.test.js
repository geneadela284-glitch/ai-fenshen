import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as recordingExperienceModule from './meetingStage3cRecordingExperience.js';

const { createMeetingStage3cRecordingExperience } = recordingExperienceModule;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function managerHarness(initialSnapshot) {
  let snapshot = initialSnapshot;
  const listeners = new Set();
  const calls = [];
  const implementations = {};
  const manager = {
    calls,
    implementations,
    getSnapshot() { return snapshot; },
    setSnapshot(next) {
      snapshot = next;
      for (const listener of listeners) listener(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async startRecording() {
      calls.push(['startRecording']);
      return implementations.startRecording?.();
    },
    async interruptRecording(reason) {
      calls.push(['interruptRecording', reason]);
      return implementations.interruptRecording?.(reason);
    },
    async stopRecording() {
      calls.push(['stopRecording']);
      return implementations.stopRecording?.();
    }
  };
  return manager;
}

function rawSnapshot({
  state = 'ready', recorderStatus = 'idle', actualStarted = false,
  interruptionReason = null, committedDurationMs = 0, errorCode = null,
  persistenceStalled = false
} = {}) {
  return {
    active: {
      meeting: {
        meetingId: 'meeting-secret-id',
        ownerId: 'owner-secret',
        recordingState: state,
        interruptionReason,
        committedDurationMs,
        errorCode,
        persistenceStalled,
        revision: 42
      },
      segments: [{ chunkToken: 'secret-token', mimeType: 'audio/webm;codecs=opus' }]
    },
    recorderStatus,
    recorderInfo: { actualStarted, mimeType: 'audio/webm', codec: 'opus', fingerprint: 'secret' },
    database: { key: 'secret' }
  };
}

function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance(ms) { value += ms; }
  };
}

function meterHarness() {
  let snapshot = Object.freeze({ available: true, level: 0.25, bars: Object.freeze([0.1, 0.25]) });
  let stopCalls = 0;
  let disposeCalls = 0;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    setSnapshot(next) {
      snapshot = next;
      for (const listener of listeners) listener(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async stop() { stopCalls += 1; },
    async dispose() { disposeCalls += 1; },
    get stopCalls() { return stopCalls; },
    get disposeCalls() { return disposeCalls; }
  };
}

function intervalHarness() {
  const callbacks = new Map();
  let nextId = 1;
  return {
    setIntervalImpl(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clearIntervalImpl(id) {
      callbacks.delete(id);
    },
    tick() {
      for (const callback of [...callbacks.values()]) callback();
    },
    get activeCount() {
      return callbacks.size;
    }
  };
}

test('projects true red recording only when persisted, recorder, and actual-start truth all agree', () => {
  const variants = [
    rawSnapshot({ state: 'ready', recorderStatus: 'starting', actualStarted: false }),
    rawSnapshot({ state: 'recording', recorderStatus: 'starting', actualStarted: false }),
    rawSnapshot({ state: 'recording', recorderStatus: 'recording', actualStarted: false }),
    rawSnapshot({ state: 'interrupted', recorderStatus: 'idle', actualStarted: true }),
    rawSnapshot({ state: 'failed_retryable', recorderStatus: 'idle', actualStarted: false })
  ];
  for (const raw of variants) {
    const experience = createMeetingStage3cRecordingExperience({ manager: managerHarness(raw), now: () => 0 });
    assert.equal(experience.getSnapshot().isRecording, false);
    experience.dispose();
  }

  const experience = createMeetingStage3cRecordingExperience({
    manager: managerHarness(rawSnapshot({ state: 'recording', recorderStatus: 'recording', actualStarted: true })),
    now: () => 0
  });
  assert.equal(experience.getSnapshot().isRecording, true);
  assert.equal(experience.getSnapshot().status, '正在录音');
  experience.dispose();
});

test('pause, resume, and end delegate to the existing manager contract and stop metering, including end while paused', async () => {
  const manager = managerHarness(rawSnapshot({ state: 'recording', recorderStatus: 'recording', actualStarted: true }));
  const meter = meterHarness();
  const experience = createMeetingStage3cRecordingExperience({ manager, microphoneMeter: meter, now: () => 0 });

  await experience.pause();
  manager.setSnapshot(rawSnapshot({ state: 'interrupted', interruptionReason: 'user_pause', committedDurationMs: 5_000 }));
  await experience.resume();
  await experience.end();
  manager.setSnapshot(rawSnapshot({ state: 'interrupted', interruptionReason: 'user_pause', committedDurationMs: 7_000 }));
  await experience.end();

  assert.deepEqual(manager.calls, [
    ['interruptRecording', 'user_pause'],
    ['startRecording'],
    ['stopRecording'],
    ['stopRecording']
  ]);
  assert.equal(meter.stopCalls, 4);
  experience.dispose();
});

test('a durable Safari pause boundary reloads once after persistence and never auto-resumes recording', async () => {
  const manager = managerHarness(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true, committedDurationMs: 1_215_306
  }));
  const reloads = [];
  manager.implementations.interruptRecording = async () => ({
    recorderSessionBoundary: true,
    meeting: { recordingState: 'interrupted', interruptionReason: 'user_pause' }
  });
  const experience = createMeetingStage3cRecordingExperience({
    manager,
    now: () => 0,
    reloadRecorderSession: () => {
      reloads.push('reload');
      return true;
    }
  });

  await experience.pause();

  assert.deepEqual(reloads, ['reload']);
  assert.deepEqual(manager.calls, [['interruptRecording', 'user_pause']]);
  assert.equal(manager.calls.some(([method]) => method === 'startRecording'), false);
  experience.dispose();
});

test('recorder session reload cache-busts the current document without starting media', () => {
  assert.equal(typeof recordingExperienceModule.reloadMeetingRecorderSession, 'function');
  const replaced = [];

  const result = recordingExperienceModule.reloadMeetingRecorderSession({
    locationImpl: {
      href: 'https://example.test/meeting?run=final',
      replace(value) { replaced.push(value); }
    },
    now: () => 286
  });

  assert.equal(result, true);
  assert.deepEqual(replaced, [
    'https://example.test/meeting?run=final&__meeting_recorder_session=286'
  ]);
});

test('locks concurrent mutations so double submit cannot call the manager twice', async () => {
  const pending = deferred();
  const manager = managerHarness(rawSnapshot());
  manager.implementations.startRecording = () => pending.promise;
  const experience = createMeetingStage3cRecordingExperience({ manager, now: () => 0 });

  const first = experience.start();
  const second = experience.start();
  assert.equal(experience.getSnapshot().isBusy, true);
  assert.equal(manager.calls.length, 1);
  assert.equal(first, second);
  pending.resolve();
  await first;
  assert.equal(experience.getSnapshot().isBusy, false);
  experience.dispose();
});

test('establishes the mutation lock before a manager call can synchronously re-enter a command', async () => {
  const pending = deferred();
  const manager = managerHarness(rawSnapshot());
  let experience;
  let reentered;
  let attemptedReentry = false;
  manager.implementations.startRecording = () => {
    if (!attemptedReentry) {
      attemptedReentry = true;
      reentered = experience.start();
    }
    return pending.promise;
  };
  experience = createMeetingStage3cRecordingExperience({ manager, now: () => 0 });

  const first = experience.start();
  assert.equal(manager.calls.length, 1);
  assert.equal(reentered, first);
  pending.resolve();
  await first;
  experience.dispose();
});

test('suppresses red state and freezes time immediately while pause or end is pending', async () => {
  const time = clock(1_000);
  const pausePending = deferred();
  const manager = managerHarness(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true, committedDurationMs: 4_000
  }));
  manager.implementations.interruptRecording = () => pausePending.promise;
  const experience = createMeetingStage3cRecordingExperience({ manager, now: time.now });
  time.advance(2_000);

  const pause = experience.pause();
  const frozenAtPause = experience.getSnapshot().durationMs;
  assert.equal(experience.getSnapshot().isRecording, false);
  assert.equal(experience.getSnapshot().status, '正在暂停');
  time.advance(10_000);
  assert.equal(experience.getSnapshot().durationMs, frozenAtPause);
  pausePending.resolve();
  await pause;

  manager.setSnapshot(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true, committedDurationMs: frozenAtPause
  }));
  const endPending = deferred();
  manager.implementations.stopRecording = () => endPending.promise;
  const end = experience.end();
  assert.equal(experience.getSnapshot().isRecording, false);
  assert.equal(experience.getSnapshot().status, '正在结束');
  endPending.resolve();
  await end;
  experience.dispose();
});

test('failed pause and end restore continued recording time without disabling its microphone meter', async () => {
  const time = clock(10_000);
  const manager = managerHarness(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true, committedDurationMs: 4_000
  }));
  const meter = meterHarness();
  const experience = createMeetingStage3cRecordingExperience({
    manager,
    microphoneMeter: meter,
    now: time.now,
    ...intervalHarness()
  });

  const pausePending = deferred();
  manager.implementations.interruptRecording = () => pausePending.promise;
  const pause = experience.pause();
  time.advance(5_000);
  pausePending.reject(new Error('pause rejected'));
  await assert.rejects(pause, /pause rejected/);
  assert.equal(experience.getSnapshot().isRecording, true);
  assert.equal(experience.getSnapshot().durationMs, 9_000);
  assert.equal(meter.stopCalls, 0);

  const endPending = deferred();
  manager.implementations.stopRecording = () => endPending.promise;
  const end = experience.end();
  time.advance(3_000);
  endPending.reject(new Error('end rejected'));
  await assert.rejects(end, /end rejected/);
  assert.equal(experience.getSnapshot().isRecording, true);
  assert.equal(experience.getSnapshot().durationMs, 12_000);
  assert.equal(meter.stopCalls, 0);
  experience.dispose();
});

test('cleans microphone analysis when recorder start fails or a system interruption arrives', async () => {
  const manager = managerHarness(rawSnapshot());
  const meter = meterHarness();
  manager.implementations.startRecording = async () => {
    const error = new Error('recorder failed');
    error.code = 'MEDIA_RECORDER_START_FAILED';
    throw error;
  };
  const experience = createMeetingStage3cRecordingExperience({ manager, microphoneMeter: meter, now: () => 0 });
  await assert.rejects(experience.start(), /recorder failed/);
  assert.equal(meter.stopCalls, 1);

  manager.setSnapshot(rawSnapshot({ state: 'recording', recorderStatus: 'recording', actualStarted: true }));
  manager.setSnapshot(rawSnapshot({ state: 'interrupted', interruptionReason: 'page_reload_recovery' }));
  assert.equal(meter.stopCalls, 2);
  experience.dispose();
});

test('cleans microphone analysis when an external or recovered user pause is observed', () => {
  const manager = managerHarness(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true
  }));
  const meter = meterHarness();
  const experience = createMeetingStage3cRecordingExperience({ manager, microphoneMeter: meter, now: () => 0 });

  manager.setSnapshot(rawSnapshot({
    state: 'interrupted', interruptionReason: 'user_pause', committedDurationMs: 1_000
  }));

  assert.equal(experience.getSnapshot().status, '已暂停');
  assert.equal(meter.stopCalls, 1);
  experience.dispose();
});

test('timer accumulates monotonically, rebases committed segments without double count, freezes, resumes, and formats 60+ minutes', () => {
  const time = clock(10_000);
  const manager = managerHarness(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true, committedDurationMs: 3_600_000
  }));
  const experience = createMeetingStage3cRecordingExperience({ manager, now: time.now });

  assert.equal(experience.getSnapshot().durationText, '01:00:00');
  time.advance(5_000);
  assert.equal(experience.getSnapshot().durationMs, 3_605_000);

  manager.setSnapshot(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true, committedDurationMs: 3_603_000
  }));
  assert.equal(experience.getSnapshot().durationMs, 3_605_000);
  time.advance(2_000);
  assert.equal(experience.getSnapshot().durationMs, 3_607_000);

  manager.setSnapshot(rawSnapshot({ state: 'interrupted', interruptionReason: 'user_pause', committedDurationMs: 3_607_000 }));
  time.advance(20_000);
  assert.equal(experience.getSnapshot().durationMs, 3_607_000);
  assert.equal(experience.getSnapshot().durationText, '01:00:07');

  manager.setSnapshot(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true, committedDurationMs: 3_607_000
  }));
  time.advance(3_000);
  assert.equal(experience.getSnapshot().durationMs, 3_610_000);
  experience.dispose();
});

test('notifies facade subscribers on live timer ticks and microphone measurements', () => {
  const time = clock(5_000);
  const intervals = intervalHarness();
  const meter = meterHarness();
  const manager = managerHarness(rawSnapshot({
    state: 'recording', recorderStatus: 'recording', actualStarted: true, committedDurationMs: 2_000
  }));
  const experience = createMeetingStage3cRecordingExperience({
    manager,
    microphoneMeter: meter,
    now: time.now,
    ...intervals
  });
  const observed = [];
  experience.subscribe((snapshot) => observed.push(snapshot));

  time.advance(1_000);
  intervals.tick();
  assert.equal(observed.at(-1)?.durationMs, 3_000);

  meter.setSnapshot(Object.freeze({
    available: true,
    level: 0.75,
    bars: Object.freeze([0.25, 0.75])
  }));
  assert.equal(observed.at(-1)?.microphone.level, 0.75);
  assert.equal(intervals.activeCount, 1);
  experience.dispose();
  assert.equal(intervals.activeCount, 0);
});

test('projects recovery states truthfully: user pause, system interruption requiring explicit continue, and terminal stop', () => {
  const manager = managerHarness(rawSnapshot({ state: 'interrupted', interruptionReason: 'user_pause', committedDurationMs: 1_000 }));
  const experience = createMeetingStage3cRecordingExperience({ manager, now: () => 0 });
  assert.deepEqual(
    { status: experience.getSnapshot().status, isPaused: experience.getSnapshot().isPaused, canResume: experience.getSnapshot().canResume },
    { status: '已暂停', isPaused: true, canResume: true }
  );

  manager.setSnapshot(rawSnapshot({ state: 'interrupted', interruptionReason: 'page_reload_recovery', committedDurationMs: 1_000 }));
  assert.equal(experience.getSnapshot().status, '已中断');
  assert.equal(experience.getSnapshot().message.includes('继续'), true);
  assert.equal(experience.getSnapshot().isInterrupted, true);

  manager.setSnapshot(rawSnapshot({ state: 'interrupted', interruptionReason: 'page_hidden', committedDurationMs: 1_000 }));
  assert.equal(experience.getSnapshot().status, '已中断');

  manager.setSnapshot(rawSnapshot({ state: 'stopped', committedDurationMs: 1_500 }));
  assert.equal(experience.getSnapshot().status, '已结束');
  assert.equal(experience.getSnapshot().isStopped, true);
  assert.equal(experience.getSnapshot().canResume, false);
  experience.dispose();
});

test('projects finalization pending as safely persisted audio with an idempotent finalize action', () => {
  const manager = managerHarness(rawSnapshot({
    state: 'finalization_pending',
    committedDurationMs: 48_000,
    errorCode: 'MEDIA_RECORDER_REQUEST_DATA_FAILED'
  }));
  const experience = createMeetingStage3cRecordingExperience({ manager, now: () => 0 });
  const snapshot = experience.getSnapshot();
  assert.equal(snapshot.status, '已安全保存，待完成封存');
  assert.equal(snapshot.isFinalizationPending, true);
  assert.equal(snapshot.canStart, false);
  assert.equal(snapshot.canPause, false);
  assert.equal(snapshot.canEnd, true);
  assert.match(snapshot.message, /已安全保存至 00:48/);
  assert.doesNotMatch(snapshot.message, /MEDIA_RECORDER_REQUEST_DATA_FAILED/);
  experience.dispose();
});

test('surfaces a durable persistence stall without hiding the active recording controls', () => {
  const manager = managerHarness(rawSnapshot({
    state: 'recording',
    recorderStatus: 'recording',
    actualStarted: true,
    persistenceStalled: true
  }));
  const experience = createMeetingStage3cRecordingExperience({ manager });
  const snapshot = experience.getSnapshot();
  assert.equal(snapshot.isRecording, true);
  assert.equal(snapshot.persistenceStalled, true);
  assert.equal(snapshot.canPause, true);
  assert.match(snapshot.message, /持久化检查未完成/);
  experience.dispose();
});

test('does not mutate manager inputs and returns deeply frozen UI-safe snapshots without technical fields or raw error codes', () => {
  const raw = rawSnapshot({ state: 'failed_retryable', errorCode: 'SEGMENT_ATOMIC_COMMIT_FAILED' });
  const before = structuredClone(raw);
  const meter = meterHarness();
  const experience = createMeetingStage3cRecordingExperience({ manager: managerHarness(raw), microphoneMeter: meter, now: () => 0 });
  const snapshot = experience.getSnapshot();

  assert.deepEqual(raw, before);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.microphone), true);
  assert.equal(Object.isFrozen(snapshot.microphone.bars), true);
  assert.equal(snapshot.status, '录音未完成');
  assert.equal(snapshot.message.includes('SEGMENT_ATOMIC_COMMIT_FAILED'), false);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['ownerId', 'key', 'database', 'chunkToken', 'MIME', 'mime', 'codec', 'fingerprint', 'revision', 'errorCode', 'SEGMENT_ATOMIC_COMMIT_FAILED']) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
  experience.dispose();
});
