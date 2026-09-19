import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import { createMeetingRecorderController } from './meetingRecorderController.js';
import { createMemoryMeetingBackend, createMeetingPhase1Store } from './browserMeetingStore.js';
import { createMeetingPhase1Manager } from './meetingPhase1Manager.js';

class FakeTrack {
  stop() {}
}

class FakeStream {
  getTracks() {
    return [new FakeTrack()];
  }
}

class NativePauseResumeRecorder {
  static instances = [];

  static isTypeSupported(value) {
    return value === 'audio/mp4;codecs=mp4a.40.2';
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'audio/mp4;codecs=mp4a.40.2';
    this.state = 'inactive';
    this.requestDataCalls = 0;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.stopCalls = 0;
    this.onstart = null;
    this.onpause = null;
    this.onresume = null;
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    NativePauseResumeRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  requestData() {
    this.requestDataCalls += 1;
    queueMicrotask(() => this.emitChunk(`checkpoint-${this.requestDataCalls}`));
  }

  pause() {
    assert.equal(this.state, 'recording');
    this.pauseCalls += 1;
    this.state = 'paused';
    queueMicrotask(() => this.onpause?.());
  }

  resume() {
    assert.equal(this.state, 'paused');
    this.resumeCalls += 1;
    this.state = 'recording';
    queueMicrotask(() => this.onresume?.());
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.emitChunk('final-audio'));
    queueMicrotask(() => this.onstop?.());
  }

  emitChunk(value) {
    this.ondataavailable?.({
      data: new Blob([value], { type: this.mimeType })
    });
  }
}

class StateOnlyResumeRecorder extends NativePauseResumeRecorder {
  resume() {
    assert.equal(this.state, 'paused');
    this.resumeCalls += 1;
    this.state = 'recording';
    // Real iPhone Safari AAC evidence: the native state advances, but no
    // MediaRecorder "resume" event is delivered to the page.
  }
}

class StateOnlyResumeRecorderWithEmptyStop extends StateOnlyResumeRecorder {
  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.ondataavailable?.({
      data: new Blob([], { type: this.mimeType })
    }));
    queueMicrotask(() => this.onstop?.());
  }
}

function flushTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForTraceCount(traces, event, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (traces.filter((trace) => trace.event === event).length >= count) return;
    await flushTurn();
  }
  assert.fail(`timed out waiting for ${count} ${event} traces`);
}

function ownerContext(ownerId = 'owner-native-pause') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' });
}

async function keyProvider() {
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { withOwnerKey: (_context, callback) => callback(key) };
}

test('non-iPhone native pause/resume keeps one MediaRecorder lifecycle across 100+20 checkpoints', async () => {
  NativePauseResumeRecorder.instances.length = 0;
  const schedulerTicks = [];
  const traces = [];
  let sequence = -1;
  let durationMs = 0;
  const controller = createMeetingRecorderController({
    mediaDevices: { getUserMedia: async () => new FakeStream() },
    MediaRecorderImpl: NativePauseResumeRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    checkpointIntervalMs: 12_000,
    setIntervalImpl: (callback) => {
      schedulerTicks.push(callback);
      return schedulerTicks.length;
    },
    clearIntervalImpl: () => {},
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'desktop', profile: { id: 'aac-capable' } },
    onSegment: async () => ({
      segment: { sequence: ++sequence },
      meeting: { committedDurationMs: (durationMs += 12_000) },
      manifest: { revision: sequence + 1 }
    }),
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  await controller.start();
  assert.equal(NativePauseResumeRecorder.instances.length, 1);
  const recorder = NativePauseResumeRecorder.instances[0];

  for (let index = 1; index <= 100; index += 1) {
    schedulerTicks[0]();
    await waitForTraceCount(traces, 'checkpoint_succeeded', index);
  }

  const beforePause = traces.filter((trace) => trace.event === 'checkpoint_succeeded');
  const generation = beforePause[0].recorderGeneration;
  const pageEpoch = beforePause[0].pageEpoch;
  const attemptId = beforePause[0].recordingAttemptId;

  await controller.pause();
  assert.equal(controller.status, 'paused');
  assert.equal(recorder.pauseCalls, 1);

  await controller.resume();
  assert.equal(controller.status, 'recording');
  assert.equal(recorder.resumeCalls, 1);
  assert.equal(NativePauseResumeRecorder.instances.length, 1);

  for (let index = 101; index <= 120; index += 1) {
    schedulerTicks[0]();
    await waitForTraceCount(traces, 'checkpoint_succeeded', index);
  }

  const successes = traces.filter((trace) => trace.event === 'checkpoint_succeeded');
  assert.equal(successes.length, 120);
  assert.ok(successes.every((trace) => trace.recorderGeneration === generation));
  assert.ok(successes.every((trace) => trace.pageEpoch === pageEpoch));
  assert.ok(successes.every((trace) => trace.recordingAttemptId === attemptId));
  assert.equal(sequence, 119);
  assert.equal(durationMs, 1_440_000);
  assert.equal(traces.filter((trace) => trace.event === 'checkpoint_failed').length, 0);

  await controller.stop();
  assert.equal(recorder.stopCalls, 1);
});

test('real iPhone passive empty pause tail stays durable and blocks a second recorder in the same page', async () => {
  NativePauseResumeRecorder.instances.length = 0;
  const schedulerTicks = [];
  const traces = [];
  const attempts = [];
  let sequence = -1;
  let durationMs = 0;
  const controller = createMeetingRecorderController({
    mediaDevices: { getUserMedia: async () => new FakeStream() },
    MediaRecorderImpl: StateOnlyResumeRecorderWithEmptyStop,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    checkpointIntervalMs: 12_000,
    stopTimeoutMs: 20,
    setIntervalImpl: (callback) => {
      schedulerTicks.push(callback);
      return schedulerTicks.length;
    },
    clearIntervalImpl: () => {},
    recordingAttemptEvidence: async () => {
      const recordingAttemptId = `attempt-${attempts.length + 1}`;
      attempts.push(recordingAttemptId);
      return { ok: true, recordingAttemptId };
    },
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-safari', profile: { id: 'aac-primary' } },
    requireAacPrimaryGate: true,
    checkpointMode: 'passive-native-timeslice',
    nativeTimesliceMs: 12_000,
    onSegment: async () => {
      sequence += 1;
      if (sequence < 100) durationMs = (sequence + 1) * 12_000;
      else if (sequence === 100) durationMs = 1_212_385;
      else if (sequence === 101) durationMs = 1_215_306;
      else durationMs += 12_000;
      return {
        segment: { sequence },
        meeting: { committedDurationMs: durationMs },
        manifest: { revision: 6 + (sequence * 2) }
      };
    },
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  await controller.start();
  const recorder = NativePauseResumeRecorder.instances[0];
  for (let index = 1; index <= 101; index += 1) {
    recorder.emitChunk(`native-timeslice-${index}`);
    schedulerTicks[0]();
    await waitForTraceCount(traces, 'checkpoint_succeeded', index);
  }

  const generation = traces.find((trace) => trace.event === 'checkpoint_succeeded').recorderGeneration;
  const pageEpoch = traces.find((trace) => trace.event === 'checkpoint_succeeded').pageEpoch;
  const attemptId = traces.find((trace) => trace.event === 'checkpoint_succeeded').recordingAttemptId;
  const paused = await controller.pause();
  const pauseCheckpoint = traces.filter((trace) => trace.event === 'checkpoint_succeeded').at(-1);
  assert.equal(paused.boundaryPending, true);
  assert.equal(paused.errorCode, '');
  assert.equal(paused.stopDataEventObserved, true);
  assert.equal(paused.empty, true);
  assert.equal(pauseCheckpoint.trigger, 'native-timeslice');
  assert.equal(pauseCheckpoint.committedSequence, 100);
  assert.equal(pauseCheckpoint.committedDurationMs, 1_212_385);

  await assert.rejects(
    () => controller.resume(),
    (error) => error?.code === 'RECORDER_PAGE_RELOAD_REQUIRED'
  );
  assert.equal(controller.status, 'paused');
  assert.equal(recorder.state, 'inactive');
  assert.equal(recorder.stopCalls, 1);
  assert.equal(recorder.requestDataCalls, 0);
  assert.equal(recorder.pauseCalls, 0);
  assert.equal(recorder.resumeCalls, 0);
  assert.equal(traces.filter((trace) => trace.event === 'recorder_resume_requested').length, 0);
  assert.equal(traces.filter((trace) => trace.event === 'recorder_resumed').length, 0);

  const successes = traces.filter((trace) => trace.event === 'checkpoint_succeeded');
  assert.equal(successes.length, 101);
  assert.ok(successes.every((trace) => trace.recorderGeneration === generation));
  assert.ok(successes.every((trace) => trace.pageEpoch === pageEpoch));
  assert.ok(successes.every((trace) => trace.recordingAttemptId === attemptId));
  assert.equal(successes.at(-1).committedSequence, 100);
  assert.equal(successes.at(-1).committedDurationMs, 1_212_385);
  assert.equal(traces.filter((trace) => trace.event === 'checkpoint_scheduler_armed').length, 1);
  assert.equal(traces.filter((trace) => trace.event === 'checkpoint_failed').length, 0);
  assert.equal(NativePauseResumeRecorder.instances.length, 1);
  assert.equal(attempts.length, 1);

  await controller.stop();
});

test('native pause/resume aborts an in-flight checkpoint without poisoning the next flush', async () => {
  class DelayedFirstRequestRecorder extends NativePauseResumeRecorder {
    requestData() {
      this.requestDataCalls += 1;
      if (this.requestDataCalls === 1) return;
      queueMicrotask(() => this.emitChunk(`checkpoint-${this.requestDataCalls}`));
    }
  }
  const schedulerTicks = [];
  const traces = [];
  const controller = createMeetingRecorderController({
    mediaDevices: { getUserMedia: async () => new FakeStream() },
    MediaRecorderImpl: DelayedFirstRequestRecorder,
    setIntervalImpl: (callback) => {
      schedulerTicks.push(callback);
      return schedulerTicks.length;
    },
    clearIntervalImpl: () => {},
    checkpointEventTimeoutMs: 20,
    onSegment: async () => ({ segment: { sequence: 0 }, meeting: { committedDurationMs: 12_000 } }),
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  await controller.start();
  schedulerTicks[0]();
  await flushTurn();
  await controller.pause();
  assert.equal(controller.status, 'paused');
  assert.equal(traces.filter((trace) => trace.event === 'checkpoint_failed').length, 0);
  assert.equal(traces.filter((trace) => trace.event === 'checkpoint_aborted').length, 1);
  await controller.resume();
  assert.equal(controller.status, 'recording');
  await controller.stop();
});

test('native pause/resume can repeat five times without creating a new generation', async () => {
  NativePauseResumeRecorder.instances.length = 0;
  const schedulerTicks = [];
  const traces = [];
  let sequence = -1;
  const controller = createMeetingRecorderController({
    mediaDevices: { getUserMedia: async () => new FakeStream() },
    MediaRecorderImpl: NativePauseResumeRecorder,
    setIntervalImpl: (callback) => {
      schedulerTicks.push(callback);
      return schedulerTicks.length;
    },
    clearIntervalImpl: () => {},
    onSegment: async () => ({ segment: { sequence: ++sequence }, meeting: { committedDurationMs: (sequence + 1) * 12_000 } }),
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  await controller.start();
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const tick = schedulerTicks.at(-1);
    tick();
    await waitForTraceCount(traces, 'checkpoint_succeeded', cycle + 1);
    await controller.pause();
    await controller.resume();
  }
  const generations = new Set(traces.filter((trace) => trace.event === 'checkpoint_succeeded').map((trace) => trace.recorderGeneration));
  assert.deepEqual([...generations].length, 1);
  assert.equal(NativePauseResumeRecorder.instances.length, 1);
  assert.equal(NativePauseResumeRecorder.instances[0].pauseCalls, 5);
  assert.equal(NativePauseResumeRecorder.instances[0].resumeCalls, 5);
  await controller.stop();
});

test('manager native pause/resume keeps the same recorder and persists explicit user pause', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({
    cryptoImpl: webcrypto,
    keyProvider: await keyProvider(),
    backend
  });
  let recorder = null;
  let startCalls = 0;
  let pauseCalls = 0;
  let resumeCalls = 0;
  const manager = createMeetingPhase1Manager({
    ownerContext: ownerContext(),
    store,
    recorderFactory: (callbacks) => {
      let status = 'idle';
      recorder = {
        get status() { return status; },
        async start() {
          startCalls += 1;
          status = 'recording';
          await callbacks.onStarted({ actualStarted: true, actualMimeType: 'audio/mp4;codecs=mp4a.40.2' });
        },
        async pause() {
          pauseCalls += 1;
          status = 'paused';
        },
        async resume() {
          resumeCalls += 1;
          status = 'recording';
        },
        async stop() {
          status = 'idle';
          await callbacks.onSegment({
            blob: new Blob(['final'], { type: 'audio/mp4;codecs=mp4a.40.2' }),
            durationMs: 12_000,
            mimeType: 'audio/mp4;codecs=mp4a.40.2',
            startedAt: '2026-08-14T12:00:00.000Z',
            endedAt: '2026-08-14T12:00:12.000Z'
          });
        },
        async interrupt() {
          status = 'idle';
        }
      };
      return recorder;
    }
  });
  await manager.initialize();
  await manager.createMeeting({ title: 'Native pause lifecycle' });
  await manager.startRecording();
  const firstRecorder = recorder;
  const paused = await manager.pauseRecording();
  assert.equal(paused.meeting.recordingState, 'interrupted');
  assert.equal(paused.meeting.interruptionReason, 'user_pause');
  assert.equal(manager.getSnapshot().recorderStatus, 'paused');
  const resumed = await manager.resumeRecording();
  assert.equal(resumed.meeting.recordingState, 'recording');
  assert.equal(manager.getSnapshot().recorderStatus, 'recording');
  assert.equal(recorder, firstRecorder);
  assert.equal(startCalls, 1);
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 1);
  await manager.stopRecording();
});

test('manager propagates a durable recorder session boundary only after user-pause state is persisted', async () => {
  const store = createMeetingPhase1Store({
    cryptoImpl: webcrypto,
    keyProvider: await keyProvider(),
    backend: createMemoryMeetingBackend()
  });
  const manager = createMeetingPhase1Manager({
    ownerContext: ownerContext(),
    store,
    recorderFactory: (callbacks) => {
      let status = 'idle';
      return {
        get status() { return status; },
        async start() {
          status = 'recording';
          await callbacks.onStarted({
            actualStarted: true,
            actualMimeType: 'audio/mp4;codecs=mp4a.40.2'
          });
        },
        async pause() {
          status = 'paused';
          return {
            actualPaused: true,
            sessionBoundary: true,
            boundaryPending: true,
            errorCode: 'RECORDING_CHECKPOINT_REQUEST_DATA_FAILED'
          };
        },
        async stop() { status = 'idle'; },
        async interrupt() { status = 'idle'; }
      };
    }
  });
  await manager.initialize();
  await manager.createMeeting({ title: 'Safari page boundary' });
  await manager.startRecording();

  const paused = await manager.pauseRecording();

  assert.equal(paused.meeting.recordingState, 'interrupted');
  assert.equal(paused.meeting.interruptionReason, 'user_pause');
  assert.equal(paused.recorderSessionBoundary, true);
  assert.equal(paused.recorderBoundaryPending, true);
  assert.equal(paused.recorderBoundaryErrorCode, 'RECORDING_CHECKPOINT_REQUEST_DATA_FAILED');
});
