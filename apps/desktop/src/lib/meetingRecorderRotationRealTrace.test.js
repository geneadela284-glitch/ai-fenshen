import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingRecorderController } from './meetingRecorderController.js';

const AAC_MIME = 'audio/mp4;codecs=mp4a.40.2';
const ROTATING_MODE = 'rotating-independent-mp4';
const REAL_STALL_ERROR = 'IOS_CHROME_PASSIVE_TIMESLICE_STREAM_STALLED_AFTER_EMPTY_DATAAVAILABLE';

class FakeTrack {
  stop() {}
}

class FakeStream {
  getTracks() {
    return [new FakeTrack()];
  }
}

class ManualTimerQueue {
  constructor() {
    this.elapsedMs = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout = (callback, delayMs = 0) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, {
      callback,
      dueAt: this.elapsedMs + Math.max(0, Number(delayMs) || 0)
    });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  async advanceBy(durationMs) {
    const target = this.elapsedMs + durationMs;
    for (;;) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.elapsedMs = task.dueAt;
      task.callback();
      await drainMicrotasks();
    }
    this.elapsedMs = target;
    await drainMicrotasks();
  }
}

class RealIosChromeStalledRecorder {
  static instances = [];

  static isTypeSupported(value) {
    return value === AAC_MIME;
  }

  static reset() {
    RealIosChromeStalledRecorder.instances = [];
  }

  constructor(_stream, options = {}) {
    this.mimeType = options.mimeType || AAC_MIME;
    this.state = 'inactive';
    this.startArguments = null;
    this.requestDataCalls = 0;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.stopCalls = 0;
    this.nativeNonEmptyEvents = 0;
    this.nativeEmptyEvents = 0;
    this.finalDataavailableObserved = false;
    RealIosChromeStalledRecorder.instances.push(this);
  }

  start(...args) {
    this.startArguments = args;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  requestData() {
    this.requestDataCalls += 1;
  }

  pause() {
    this.pauseCalls += 1;
  }

  resume() {
    this.resumeCalls += 1;
  }

  emitNativeTimeslice(size) {
    if (size > 0) this.nativeNonEmptyEvents += 1;
    else this.nativeEmptyEvents += 1;
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(size)], { type: this.mimeType })
    });
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    if (this.startArguments?.length === 0) {
      queueMicrotask(() => {
        this.finalDataavailableObserved = true;
        this.ondataavailable?.({
          data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType })
        });
      });
    }
    queueMicrotask(() => this.onstop?.());
  }

  diagnosePassiveStall({ silentIntervalCount }) {
    if (
      this.startArguments?.length === 1
      && this.nativeNonEmptyEvents === 1
      && this.nativeEmptyEvents === 1
      && silentIntervalCount > 0
      && this.finalDataavailableObserved === false
    ) {
      return REAL_STALL_ERROR;
    }
    return '';
  }
}

async function drainMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function assertOrderedEvents(traces, expected) {
  let cursor = -1;
  for (const event of expected) {
    cursor = traces.findIndex((trace, index) => index > cursor && trace.event === event);
    assert.notEqual(cursor, -1, `missing ordered trace event ${event}`);
  }
}

function createRotationPersistence(onSegment, initialOrdinal = 25) {
  let nextOrdinal = initialOrdinal;
  const pending = new Map();
  return Object.freeze({
    async reserveCaptureUnit(input) {
      const captureOrdinal = nextOrdinal++;
      return Object.freeze({
        captureOrdinal,
        captureEpoch: input.captureEpoch,
        recordingAttemptId: input.recordingAttemptId,
        captureUnitId: `unit-${captureOrdinal}`,
        chunkToken: `token-${captureOrdinal}`
      });
    },
    async stagePendingCaptureUnit({ unit }) {
      const journalId = `journal-${unit.identity.captureOrdinal}`;
      pending.set(journalId, unit);
      return Object.freeze({ journalId });
    },
    async commitPendingCaptureUnit({ journalId }) {
      const unit = pending.get(journalId);
      pending.delete(journalId);
      return onSegment({
        blob: unit.blob,
        chunkToken: unit.identity.chunkToken,
        durationMs: unit.durationMs,
        mimeType: unit.mimeType,
        startedAt: unit.startedAt,
        endedAt: unit.endedAt
      });
    },
    async recordCaptureDiscontinuity() {
      return Object.freeze({ recorded: true });
    },
    async replayPendingCaptureUnits() {
      return Object.freeze({ committedCount: 0 });
    },
    async finalizeCaptureManifest() {
      return Object.freeze({ finalized: true, finalizationPending: false });
    }
  });
}

function sharedOptions({ clock, traces, onSegment, checkpointMode, timers, schedulerTicks = [] }) {
  const options = {
    mediaDevices: {
      async getUserMedia() {
        return new FakeStream();
      }
    },
    MediaRecorderImpl: RealIosChromeStalledRecorder,
    preferredMimeType: AAC_MIME,
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-chrome', profile: { id: 'aac-primary' } },
    requireAacPrimaryGate: true,
    recordingAttemptEvidence: async () => ({
      ok: true,
      recordingAttemptId: 'attempt-real-0512'
    }),
    checkpointMode,
    nativeTimesliceMs: 12_000,
    checkpointIntervalMs: 12_000,
    checkpointEventTimeoutMs: 25,
    stopTimeoutMs: 25,
    now: () => new Date(clock()).toISOString(),
    monotonicNow: () => timers?.elapsedMs || 0,
    setIntervalImpl(callback) {
      schedulerTicks.push(callback);
      return { unref() {} };
    },
    clearIntervalImpl() {},
    setTimeoutImpl: timers?.setTimeout || globalThis.setTimeout,
    clearTimeoutImpl: timers?.clearTimeout || globalThis.clearTimeout,
    onSegment,
    async onCheckpointTrace(trace) {
      traces.push(trace);
    }
  };
  if (checkpointMode === ROTATING_MODE) {
    options.capturePersistencePort = createRotationPersistence(onSegment);
    options.inspectContainer = (bytes) => Object.freeze({
      initBytes: bytes.slice(0, 1),
      mediaBytes: bytes.slice(1),
      timescale: 48_000,
      trackId: 1,
      trackFingerprint: 'trace-aac',
      fragmentCount: 1,
      firstDecodeTime: 0,
      durationTicks: 576_000,
      durationMs: 12_000
    });
  }
  return options;
}

test('real iOS Chrome passive trace freezes at 05:12 after one non-empty event, one empty event, then silence', async () => {
  RealIosChromeStalledRecorder.reset();
  const traces = [];
  const schedulerTicks = [];
  const recordingStartedAt = Date.parse('2026-08-15T07:00:00.000Z');
  let clock = recordingStartedAt;
  let lastCommittedDurationMs = 300_105;
  let committedSegmentCount = 24;
  const controller = createMeetingRecorderController(sharedOptions({
    clock: () => clock,
    traces,
    schedulerTicks,
    checkpointMode: 'passive-native-timeslice',
    async onSegment(payload) {
      committedSegmentCount += 1;
      lastCommittedDurationMs += payload.durationMs;
      return {
        segment: { sequence: committedSegmentCount - 1 },
        meeting: { committedDurationMs: lastCommittedDurationMs },
        manifest: { revision: committedSegmentCount }
      };
    }
  }));

  await controller.start({ explicitResume: true });
  const recorder = RealIosChromeStalledRecorder.instances[0];
  assert.deepEqual(recorder.startArguments, [12_000]);

  clock += 12_000;
  recorder.emitNativeTimeslice(2_400);
  await eventually(
    () => traces.some((trace) => trace.event === 'checkpoint_succeeded'),
    'the first resumed passive event did not commit'
  );

  clock += 12_000;
  recorder.emitNativeTimeslice(0);
  await eventually(
    () => traces.some((trace) => trace.event === 'checkpoint_dataavailable' && trace.empty === true),
    'the observed empty passive event was not recorded'
  );

  const silentIntervalCount = 173;
  clock = recordingStartedAt + (35 * 60_000);
  schedulerTicks[0]?.();
  const finalization = await controller.stop({ reason: 'user_stop' });
  const rootErrorCode = recorder.diagnosePassiveStall({ silentIntervalCount });

  assert.equal(lastCommittedDurationMs, 312_105);
  assert.equal(committedSegmentCount, 25);
  assert.equal(recorder.finalDataavailableObserved, false);
  assert.equal(rootErrorCode, REAL_STALL_ERROR);
  assert.equal(finalization.finalizationPending, true);
  assert.equal(lastCommittedDurationMs, 312_105);
});

test('public controller rotating mode commits six complete post-boundary units without long-lived MediaRecorder calls', async () => {
  RealIosChromeStalledRecorder.reset();
  const timers = new ManualTimerQueue();
  const traces = [];
  const committed = [];
  const baseClock = Date.parse('2026-08-15T08:00:00.000Z');
  let committedDurationMs = 312_105;
  let committedSegmentCount = 25;
  const controller = createMeetingRecorderController(sharedOptions({
    clock: () => baseClock + timers.elapsedMs,
    timers,
    traces,
    checkpointMode: ROTATING_MODE,
    async onSegment(payload) {
      committed.push(payload);
      committedSegmentCount += 1;
      committedDurationMs += payload.durationMs;
      return {
        segment: { sequence: committedSegmentCount - 1 },
        meeting: { committedDurationMs },
        manifest: { revision: committedSegmentCount }
      };
    }
  }));

  await controller.start({
    explicitResume: true,
    meetingId: 'meeting-real-0512',
    sourceId: 'recorded-meeting-real-0512',
    recordingAttemptId: 'attempt-real-0512',
    captureEpoch: 1,
    containerLayout: 'independent-mp4-segments-v1'
  });

  // This is the intentional RED against the current long-lived controller:
  // it calls start(20_000) and owns only one recorder instead of start().
  assert.deepEqual(RealIosChromeStalledRecorder.instances[0].startArguments, []);

  for (let index = 0; index < 6; index += 1) {
    await timers.advanceBy(12_000);
    await eventually(
      () => committed.length >= index + 1,
      `rotating CaptureUnit ${index + 1} did not commit`
    );
  }

  assert.equal(committed.length, 6);
  assert.equal(committedSegmentCount, 31);
  assert.equal(committedDurationMs, 384_105);
  assert.equal(RealIosChromeStalledRecorder.instances.length >= 7, true);
  assert.equal(
    RealIosChromeStalledRecorder.instances.every((instance) => instance.startArguments?.length === 0),
    true
  );
  assert.equal(
    RealIosChromeStalledRecorder.instances.reduce((total, instance) => total + instance.requestDataCalls, 0),
    0
  );
  assert.equal(
    RealIosChromeStalledRecorder.instances.reduce((total, instance) => total + instance.pauseCalls, 0),
    0
  );
  assert.equal(
    RealIosChromeStalledRecorder.instances.reduce((total, instance) => total + instance.resumeCalls, 0),
    0
  );
  assertOrderedEvents(traces, [
    'unit_reserved',
    'recorder_constructed',
    'capture_unit_start_requested',
    'capture_unit_start_acknowledged',
    'rotation_timer_armed',
    'rotation_timer_fired',
    'cutover_started',
    'old_stop_requested',
    'successor_start_requested',
    'capture_unit_dataavailable',
    'container_validated',
    'encryption_started',
    'encryption_completed',
    'journal_committed',
    'commit_started',
    'manifest_committed',
    'pending_deleted',
    'unit_disposed'
  ]);
});
