import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

import { createMemoryMeetingBackend, createMeetingPhase1Store } from './browserMeetingStore.js';
import { createMeetingPhase1Manager } from './meetingPhase1Manager.js';
import { createMeetingRecorderController } from './meetingRecorderController.js';
import {
  INDEPENDENT_MP4_SEGMENTS_V1,
  ROTATING_INDEPENDENT_MP4_MODE
} from './meetingRecordingContainerLayout.js';
import { createStage3cRefreshSafeRecorderFactory } from './meetingStage3cRefreshSafeRecorderAdapter.js';

const ownerContext = Object.freeze({
  trusted: true,
  ownerId: 'refresh-resume-regression-owner',
  sessionId: 'refresh-resume-regression-session',
  spaceId: 'meeting-space'
});

class PoisonedRefreshTrack {
  stop() {}
}

class PoisonedRefreshStream {
  getTracks() {
    return [new PoisonedRefreshTrack()];
  }
}

/** Models a page-scoped iOS AAC MediaRecorder whose native timeslices are the
 * only normal persistence source. A hard page disappearance intentionally
 * delivers no lifecycle, stop, pause, or error callback. */
class PoisonedRefreshMediaRecorder {
  static instances = [];

  static reset() {
    PoisonedRefreshMediaRecorder.instances = [];
  }

  static isTypeSupported(mimeType) {
    return mimeType === 'audio/mp4;codecs=mp4a.40.2';
  }

  constructor(_stream, options = {}) {
    this.mimeType = options.mimeType || 'audio/mp4;codecs=mp4a.40.2';
    this.state = 'inactive';
    this.pageOrdinal = PoisonedRefreshMediaRecorder.instances.length + 1;
    this.requestDataCalls = 0;
    this.stopCalls = 0;
    PoisonedRefreshMediaRecorder.instances.push(this);
  }

  start(timeslice) {
    this.timeslice = timeslice;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  pause() {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    queueMicrotask(() => this.onpause?.());
  }

  requestData() {
    this.requestDataCalls += 1;
    throw new Error('requestData must not run in passive-native-timeslice mode');
  }

  emitNativeTimeslice(index) {
    this.ondataavailable?.({
      data: new Blob([`audio-${this.pageOrdinal}-${index}`], { type: this.mimeType })
    });
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    // The old page already has three committed segments; its final callback is
    // intentionally empty so the refresh boundary does not add a fourth one.
    queueMicrotask(() => this.ondataavailable?.({
      data: new Blob(this.pageOrdinal === 1 ? [] : [`final-${this.pageOrdinal}`], { type: this.mimeType })
    }));
    queueMicrotask(() => this.onstop?.());
  }
}

function mediaDevices() {
  return {
    async getUserMedia() {
      return new PoisonedRefreshStream();
    }
  };
}

function waitFor(predicate, message) {
  return (async () => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(message);
  })();
}

test('no-lifecycle refresh -> recover -> explicit resume preserves 25 plus six passive checkpoints', async () => {
  PoisonedRefreshMediaRecorder.reset();
  const ownerKey = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const keyProvider = Object.freeze({
    withOwnerKey: (_context, callback) => callback(ownerKey)
  });
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl: webcrypto, keyProvider, backend });
  const traces = [];
  const pageTicks = [];
  let clock = Date.parse('2026-08-14T12:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const recorderFactory = createStage3cRefreshSafeRecorderFactory({
    cryptoImpl: webcrypto,
    controllerFactory: (options) => createMeetingRecorderController(options)
  });
  const createPage = (label) => createMeetingPhase1Manager({
    ownerContext,
    store,
    cryptoImpl: webcrypto,
    now,
    recorderFactory,
    onCheckpointTrace: async (trace) => traces.push({ label, ...trace }),
    recorderOptions: {
      mediaDevices: mediaDevices(),
      MediaRecorderImpl: PoisonedRefreshMediaRecorder,
      documentImpl: null,
      windowImpl: null,
      checkpointIntervalMs: 12_000,
      checkpointEventTimeoutMs: 100,
      stopTimeoutMs: 20,
      checkpointMode: 'passive-native-timeslice',
      nativeTimesliceMs: 12_000,
      setIntervalImpl: (callback) => {
        pageTicks.push({ label, callback });
        return { unref() {} };
      },
      clearIntervalImpl: () => {}
    }
  });

  const pageA = createPage('page-a');
  await pageA.initialize();
  const created = await pageA.createMeeting({ title: 'refresh-resume-durable-regression' });
  await pageA.startRecording();
  const tickA = () => pageTicks.find((entry) => entry.label === 'page-a')?.callback();

  for (let index = 0; index < 25; index += 1) {
    clock += 12_000;
    tickA();
    PoisonedRefreshMediaRecorder.instances[0].emitNativeTimeslice(index + 1);
    await waitFor(
      () => traces.filter((trace) => trace.label === 'page-a' && trace.event === 'checkpoint_succeeded').length >= index + 1,
      `page A checkpoint ${index + 1} did not commit`
    );
  }
  assert.equal(pageA.getSnapshot().active.meeting.committedDurationMs, 300_000);
  assert.deepEqual(
    pageA.getSnapshot().active.segments.map((segment) => segment.sequence),
    Array.from({ length: 25 }, (_, index) => index)
  );
  assert.equal(PoisonedRefreshMediaRecorder.instances[0].requestDataCalls, 0);
  assert.equal(PoisonedRefreshMediaRecorder.instances[0].stopCalls, 0);

  // Model Safari/Chrome returning to the browser home screen: page A vanishes
  // with no pagehide, visibility, stop, pause, finalization, or recorder error.

  const pageB = createPage('page-b');
  await pageB.initialize();
  assert.equal(pageB.getSnapshot().active.meeting.meetingId, created.meeting.meetingId);
  assert.equal(pageB.getSnapshot().active.meeting.recordingState, 'interrupted');
  assert.equal(pageB.getSnapshot().active.meeting.committedDurationMs, 300_000);
  assert.equal(PoisonedRefreshMediaRecorder.instances.length, 1);
  await pageB.startRecording();
  assert.equal(PoisonedRefreshMediaRecorder.instances.length, 2);
  const tickB = () => pageTicks.find((entry) => entry.label === 'page-b')?.callback();

  for (let index = 0; index < 6; index += 1) {
    clock += 12_000;
    tickB();
    PoisonedRefreshMediaRecorder.instances[1].emitNativeTimeslice(index + 1);
    await waitFor(
      () => traces.filter((trace) => trace.label === 'page-b' && trace.event === 'checkpoint_succeeded').length >= index + 1,
      `page B checkpoint ${index + 1} did not commit`
    );
  }

  const resumedSuccesses = traces
    .filter((trace) => trace.label === 'page-b' && trace.event === 'checkpoint_succeeded')
    .map((trace) => trace.committedDurationMs);
  assert.equal(resumedSuccesses.length, 6);
  assert.deepEqual(resumedSuccesses, [312_000, 324_000, 336_000, 348_000, 360_000, 372_000]);
  assert.deepEqual(
    pageB.getSnapshot().active.segments.slice(-6).map((segment) => segment.sequence),
    [25, 26, 27, 28, 29, 30]
  );
  assert.equal(PoisonedRefreshMediaRecorder.instances[1].requestDataCalls, 0);
  assert.equal(traces.some((trace) => trace.label === 'page-b' && trace.event === 'checkpoint_failed'), false);

  const pageC = createPage('page-c');
  await pageC.initialize();
  assert.equal(pageC.getSnapshot().active.meeting.meetingId, created.meeting.meetingId);
  assert.equal(pageC.getSnapshot().active.meeting.recordingState, 'interrupted');
  assert.equal(pageC.getSnapshot().active.meeting.committedDurationMs, 372_000);
  assert.equal(pageC.getSnapshot().active.segments.length, 31);
  assert.equal(PoisonedRefreshMediaRecorder.instances.length, 2);
  assert.equal(new Set(pageC.getSnapshot().active.segments.map((segment) => segment.chunkToken)).size, 31);
});

test('rotating refresh marks every reserved ordinal, exposes durable truth, and waits for explicit resume', async () => {
  const ownerKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const store = createMeetingPhase1Store({
    cryptoImpl: webcrypto,
    keyProvider: { withOwnerKey: (_context, callback) => callback(ownerKey) },
    backend: createMemoryMeetingBackend()
  });
  const attemptId = 'attempt-rotating-refresh';
  let pageBFactoryCalls = 0;
  const fakeRecorderFactory = (label) => (callbacks) => {
    if (label === 'page-b') pageBFactoryCalls += 1;
    let status = 'idle';
    return {
      get status() { return status; },
      async start(input) {
        status = 'recording';
        const info = {
          actualStarted: true,
          recordingAttemptId: input.recordingAttemptId || attemptId,
          captureEpoch: input.captureEpoch,
          containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
          actualMimeType: 'audio/mp4;codecs=mp4a.40.2'
        };
        await callbacks.onStarted(info);
        return info;
      },
      async stop() { status = 'idle'; return { finalized: true }; },
      async interrupt() { status = 'idle'; }
    };
  };
  const pageA = createMeetingPhase1Manager({
    ownerContext,
    store,
    recorderFactory: fakeRecorderFactory('page-a'),
    recorderOptions: { checkpointMode: ROTATING_INDEPENDENT_MP4_MODE }
  });
  await pageA.initialize();
  const created = await pageA.createMeeting({ title: 'rotating-refresh-reservation-recovery' });
  await pageA.startRecording();
  for (let captureOrdinal = 0; captureOrdinal < 2; captureOrdinal += 1) {
    const reservation = await store.reserveCaptureUnit(ownerContext, {
      meetingId: created.meeting.meetingId,
      sourceId: `recorded-${created.meeting.meetingId}`,
      recordingAttemptId: attemptId,
      captureEpoch: 0
    });
    assert.equal(reservation.captureOrdinal, captureOrdinal);
  }

  const pageB = createMeetingPhase1Manager({
    ownerContext,
    store,
    recorderFactory: fakeRecorderFactory('page-b'),
    recorderOptions: { checkpointMode: ROTATING_INDEPENDENT_MP4_MODE }
  });
  await pageB.initialize();
  const recovered = pageB.getSnapshot().active;
  assert.equal(recovered.meeting.recordingState, 'interrupted');
  assert.equal(recovered.meeting.committedDurationMs, 0);
  assert.equal(pageBFactoryCalls, 0);
  assert.deepEqual(
    recovered.manifest.captureOrdinals.map((entry) => [entry.captureOrdinal, entry.state, entry.errorCode]),
    [
      [0, 'discontinuity', 'CAPTURE_UNIT_UNSEALED_AT_REFRESH'],
      [1, 'discontinuity', 'CAPTURE_UNIT_UNSEALED_AT_REFRESH']
    ]
  );

  const resumed = await pageB.startRecording();
  assert.equal(pageBFactoryCalls, 1);
  assert.equal(resumed.meeting.recordingAttemptId, attemptId);
  assert.equal(resumed.meeting.captureEpoch, 1);
});
