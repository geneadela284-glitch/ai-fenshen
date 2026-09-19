import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingRecorderController } from './meetingRecorderController.js';

class PassiveTrack {
  stop() {}
}

class PassiveStream {
  getTracks() {
    return [new PassiveTrack()];
  }
}

class WebKitDualTriggerTerminationRecorder {
  static latest = null;

  static isTypeSupported(value) {
    return value === 'audio/mp4;codecs=mp4a.40.2';
  }

  constructor(_stream, options = {}) {
    this.mimeType = options.mimeType || 'audio/mp4;codecs=mp4a.40.2';
    this.state = 'inactive';
    this.requestDataCalls = 0;
    this.stopCalls = 0;
    this.webContentTerminated = false;
    this.terminateAfterNextNativeTimeslice = false;
    WebKitDualTriggerTerminationRecorder.latest = this;
  }

  start(timeslice) {
    this.timeslice = timeslice;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  requestData() {
    this.requestDataCalls += 1;
    if (this.requestDataCalls === 25) this.terminateAfterNextNativeTimeslice = true;
  }

  emitNativeTimeslice(size = 2_400) {
    if (this.webContentTerminated) return;
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(size)], { type: this.mimeType })
    });
    if (this.terminateAfterNextNativeTimeslice) {
      this.terminateAfterNextNativeTimeslice = false;
      queueMicrotask(() => {
        this.webContentTerminated = true;
      });
    }
  }

  stop() {
    if (this.webContentTerminated || this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  }
}

class PassiveStopTailRecorder extends WebKitDualTriggerTerminationRecorder {
  constructor(stream, options = {}) {
    super(stream, options);
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.stopTailSize = 333;
  }

  pause() {
    this.pauseCalls += 1;
    this.state = 'paused';
    queueMicrotask(() => this.onpause?.());
  }

  resume() {
    this.resumeCalls += 1;
    this.state = 'recording';
    queueMicrotask(() => this.onresume?.());
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.emitNativeTimeslice(this.stopTailSize));
    queueMicrotask(() => this.onstop?.());
  }
}

class PassiveEmptyStopTailRecorder extends PassiveStopTailRecorder {
  constructor(stream, options = {}) {
    super(stream, options);
    this.stopTailSize = 0;
  }
}

class PassiveMissingStopBarrierRecorder extends PassiveStopTailRecorder {
  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
  }
}

class PassiveStopFailureRecorder extends PassiveStopTailRecorder {
  stop() {
    this.stopCalls += 1;
    throw new Error('native stop failed');
  }
}

class PassiveDelayedStopBarrierRecorder extends PassiveStopTailRecorder {
  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    setTimeout(() => this.emitNativeTimeslice(this.stopTailSize), 10);
    setTimeout(() => this.onstop?.(), 20);
  }
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function passiveControllerOptions({
  clock,
  schedulerTicks,
  traces,
  statuses = [],
  onSegment,
  persistenceStallTimeoutMs = 40_000,
  MediaRecorderImpl = WebKitDualTriggerTerminationRecorder,
  stopTimeoutMs = 100
}) {
  return {
    mediaDevices: {
      async getUserMedia() {
        return new PassiveStream();
      }
    },
    MediaRecorderImpl,
    now: () => new Date(clock()).toISOString(),
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-chrome', profile: { id: 'aac-primary' } },
    requireAacPrimaryGate: true,
    recordingAttemptEvidence: async () => ({
      ok: true,
      recordingAttemptId: 'attempt-passive-real-sequence'
    }),
    checkpointMode: 'passive-native-timeslice',
    nativeTimesliceMs: 12_000,
    checkpointIntervalMs: 12_000,
    checkpointEventTimeoutMs: 100,
    stopTimeoutMs,
    persistenceStallTimeoutMs,
    setIntervalImpl(callback) {
      schedulerTicks.push(callback);
      return { unref() {} };
    },
    clearIntervalImpl() {},
    onSegment,
    async onCheckpointTrace(trace) {
      traces.push(trace);
    },
    async onPersistenceStatus(status) {
      statuses.push(status);
    }
  };
}

test('verified iOS AAC passive mode commits 325 native timeslices without requestData', async () => {
  const schedulerTicks = [];
  const traces = [];
  const committed = [];
  let clock = Date.parse('2026-08-15T10:00:00.000Z');
  let committedDurationMs = 0;

  const controller = createMeetingRecorderController({
    mediaDevices: {
      async getUserMedia() {
        return new PassiveStream();
      }
    },
    MediaRecorderImpl: WebKitDualTriggerTerminationRecorder,
    now: () => new Date(clock).toISOString(),
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-chrome', profile: { id: 'aac-primary' } },
    requireAacPrimaryGate: true,
    recordingAttemptEvidence: async () => ({
      ok: true,
      recordingAttemptId: 'attempt-passive-real-sequence'
    }),
    checkpointMode: 'passive-native-timeslice',
    nativeTimesliceMs: 12_000,
    checkpointIntervalMs: 12_000,
    checkpointEventTimeoutMs: 100,
    setIntervalImpl(callback) {
      schedulerTicks.push(callback);
      return { unref() {} };
    },
    clearIntervalImpl() {},
    async onSegment(payload) {
      committedDurationMs += payload.durationMs;
      const sequence = committed.length;
      committed.push(payload);
      return {
        segment: { sequence },
        meeting: { committedDurationMs },
        manifest: { revision: sequence + 1 }
      };
    },
    async onCheckpointTrace(trace) {
      traces.push(trace);
    }
  });

  await controller.start();
  assert.equal(schedulerTicks.length, 1);
  assert.equal(WebKitDualTriggerTerminationRecorder.latest.timeslice, 12_000);

  for (let index = 0; index < 325; index += 1) {
    clock += 12_000;
    schedulerTicks[0]();
    WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice();
    await eventually(
      () => traces.filter((trace) => trace.event === 'checkpoint_succeeded').length >= index + 1,
      `native timeslice ${index + 1} did not commit`
    );
  }

  const recorder = WebKitDualTriggerTerminationRecorder.latest;
  assert.equal(committed.length, 325);
  assert.equal(committedDurationMs, 3_900_000);
  assert.equal(recorder.requestDataCalls, 0);
  assert.equal(recorder.webContentTerminated, false);
  const checkpointTraces = traces.filter((trace) => trace.event.startsWith('checkpoint_'));
  const successes = traces.filter((trace) => trace.event === 'checkpoint_succeeded');
  assert.deepEqual(successes.map((trace) => trace.timesliceOrdinal), Array.from({ length: 325 }, (_, index) => index));
  assert.deepEqual(successes.map((trace) => trace.committedSequence), Array.from({ length: 325 }, (_, index) => index));
  assert.deepEqual(successes.map((trace) => trace.manifestRevision), Array.from({ length: 325 }, (_, index) => index + 1));
  assert.equal(successes.at(-1).committedDurationMs, 3_900_000);
  assert.equal(new Set(successes.map((trace) => trace.checkpointId)).size, 325);
  assert.equal(checkpointTraces.length > 0, true);
  assert.equal(checkpointTraces.every((trace) => trace.checkpointMode === 'passive-native-timeslice'), true);
  assert.equal(checkpointTraces.every((trace) => trace.requestDataCalled === false), true);
  assert.equal(checkpointTraces.every((trace) => trace.requestDataReturned === false), true);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_scheduler_armed' && trace.schedulerRole === 'watchdog'), true);
});

test('an empty passive native event does not consume sequence or poison the next commit', async () => {
  const schedulerTicks = [];
  const traces = [];
  const committed = [];
  let clock = Date.parse('2026-08-15T11:00:00.000Z');
  let committedDurationMs = 0;
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    async onSegment(payload) {
      committedDurationMs += payload.durationMs;
      const sequence = committed.length;
      committed.push(payload);
      return {
        segment: { sequence },
        meeting: { committedDurationMs },
        manifest: { revision: sequence + 1 }
      };
    }
  }));

  await controller.start();
  clock += 12_000;
  WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(0);
  await eventually(
    () => traces.some((trace) => trace.event === 'checkpoint_dataavailable' && trace.empty === true),
    'empty native event was not traced'
  );
  assert.equal(committed.length, 0);
  assert.equal(committedDurationMs, 0);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_succeeded'), false);

  clock += 12_000;
  WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(321);
  await eventually(
    () => traces.some((trace) => trace.event === 'checkpoint_succeeded'),
    'non-empty event after empty event did not commit'
  );
  const success = traces.find((trace) => trace.event === 'checkpoint_succeeded');
  assert.equal(success.timesliceOrdinal, 1);
  assert.equal(success.committedSequence, 0);
  assert.equal(success.manifestRevision, 1);
  assert.equal(success.inFlight, false);
  assert.equal(committed.length, 1);
  assert.equal(WebKitDualTriggerTerminationRecorder.latest.requestDataCalls, 0);
});

test('delayed passive commits retain event-local trace identity and result attribution', async () => {
  const schedulerTicks = [];
  const traces = [];
  const pending = [];
  let clock = Date.parse('2026-08-15T12:00:00.000Z');
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    onSegment(payload) {
      return new Promise((resolve) => pending.push({ payload, resolve }));
    }
  }));

  await controller.start();
  clock += 12_000;
  WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(111);
  clock += 12_000;
  WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(222);
  await eventually(() => pending.length === 1, 'first delayed commit did not enter the queue');
  pending[0].resolve({
    segment: { sequence: 0 },
    meeting: { committedDurationMs: 12_000 },
    manifest: { revision: 1 }
  });
  await eventually(() => pending.length === 2, 'second delayed commit did not enter the queue');
  pending[1].resolve({
    segment: { sequence: 1 },
    meeting: { committedDurationMs: 24_000 },
    manifest: { revision: 2 }
  });
  await eventually(
    () => traces.filter((trace) => trace.event === 'checkpoint_succeeded').length === 2,
    'delayed commits did not settle'
  );

  const dataTraces = traces.filter((trace) => trace.event === 'checkpoint_dataavailable');
  const successes = traces.filter((trace) => trace.event === 'checkpoint_succeeded');
  assert.deepEqual(dataTraces.map((trace) => trace.timesliceOrdinal), [0, 1]);
  assert.deepEqual(dataTraces.map((trace) => trace.blobSize), [111, 222]);
  assert.deepEqual(successes.map((trace) => trace.checkpointId), dataTraces.map((trace) => trace.checkpointId));
  assert.deepEqual(successes.map((trace) => trace.committedSequence), [0, 1]);
  assert.deepEqual(successes.map((trace) => trace.committedDurationMs), [12_000, 24_000]);
  assert.deepEqual(successes.map((trace) => trace.manifestRevision), [1, 2]);
});

test('an exact passive persistence error does not roll back or poison later native commits', async () => {
  const schedulerTicks = [];
  const traces = [];
  let clock = Date.parse('2026-08-15T13:00:00.000Z');
  let calls = 0;
  let successfulCommits = 0;
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    async onSegment() {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('encryption unavailable'), { code: 'ENCRYPTION_FAILED' });
      }
      successfulCommits += 1;
      return {
        segment: { sequence: successfulCommits - 1 },
        meeting: { committedDurationMs: successfulCommits * 12_000 },
        manifest: { revision: successfulCommits }
      };
    }
  }));

  await controller.start();
  for (let index = 0; index < 3; index += 1) {
    clock += 12_000;
    WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(100 + index);
  }
  await eventually(
    () => traces.some((trace) => trace.event === 'checkpoint_failed' && trace.errorCode === 'ENCRYPTION_FAILED'),
    'exact persistence error was not retained'
  );
  await eventually(
    () => traces.filter((trace) => trace.event === 'checkpoint_succeeded').length === 2,
    'later native event did not recover after the persistence failure'
  );

  const successes = traces.filter((trace) => trace.event === 'checkpoint_succeeded');
  assert.deepEqual(successes.map((trace) => trace.timesliceOrdinal), [0, 2]);
  assert.deepEqual(successes.map((trace) => trace.committedSequence), [0, 1]);
  assert.deepEqual(successes.map((trace) => trace.committedDurationMs), [12_000, 24_000]);
  assert.equal(WebKitDualTriggerTerminationRecorder.latest.requestDataCalls, 0);
});

test('the passive watchdog reports a true persistence stall without flushing audio', async () => {
  const schedulerTicks = [];
  const traces = [];
  const statuses = [];
  let clock = Date.parse('2026-08-15T14:00:00.000Z');
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    statuses,
    persistenceStallTimeoutMs: 40_000,
    async onSegment() {
      return { segment: { sequence: 0 }, meeting: { committedDurationMs: 12_000 } };
    }
  }));

  await controller.start();
  clock += 40_001;
  schedulerTicks[0]();
  await eventually(
    () => statuses.some((status) => status.phase === 'stalled'),
    'passive persistence stall was not reported'
  );
  const stalled = statuses.find((status) => status.phase === 'stalled');
  assert.equal(stalled.errorCode, 'RECORDING_PERSISTENCE_STALLED');
  assert.equal(stalled.ageMs, 40_001);
  assert.equal(WebKitDualTriggerTerminationRecorder.latest.requestDataCalls, 0);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_succeeded'), false);
});

test('verified iOS passive pause seals one stop tail without requestData or native pause/resume', async () => {
  const schedulerTicks = [];
  const traces = [];
  let clock = Date.parse('2026-08-15T15:00:00.000Z');
  let committedDurationMs = 0;
  let sequence = -1;
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    MediaRecorderImpl: PassiveStopTailRecorder,
    async onSegment(payload) {
      committedDurationMs += payload.durationMs;
      sequence += 1;
      return {
        segment: { sequence },
        meeting: { committedDurationMs },
        manifest: { revision: sequence + 1 }
      };
    }
  }));

  await controller.start();
  clock += 12_000;
  WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(222);
  await eventually(
    () => traces.filter((trace) => trace.event === 'checkpoint_succeeded').length === 1,
    'pre-pause native timeslice did not commit'
  );
  clock += 3_000;
  const paused = await controller.pause();
  const recorder = WebKitDualTriggerTerminationRecorder.latest;

  assert.equal(paused.actualPaused, true);
  assert.equal(paused.sessionBoundary, true);
  assert.equal(paused.boundaryPending, false);
  assert.equal(paused.errorCode, '');
  assert.equal(controller.status, 'paused');
  assert.equal(recorder.stopCalls, 1);
  assert.equal(recorder.requestDataCalls, 0);
  assert.equal(recorder.pauseCalls, 0);
  assert.equal(recorder.resumeCalls, 0);
  assert.equal(sequence, 1);
  assert.equal(committedDurationMs, 15_000);
  const tailSuccess = traces.filter((trace) => trace.event === 'checkpoint_succeeded').at(-1);
  assert.equal(tailSuccess.trigger, 'stop-tail');
  assert.equal(tailSuccess.committedSequence, 1);
  assert.equal(tailSuccess.committedDurationMs, 15_000);
  await assert.rejects(
    () => controller.resume(),
    (error) => error?.code === 'RECORDER_PAGE_RELOAD_REQUIRED'
  );
});

test('verified iOS passive finalization drains then seals one stop tail without pause or requestData', async () => {
  const schedulerTicks = [];
  const traces = [];
  let clock = Date.parse('2026-08-15T16:00:00.000Z');
  let committedDurationMs = 0;
  let sequence = -1;
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    MediaRecorderImpl: PassiveStopTailRecorder,
    async onSegment(payload) {
      committedDurationMs += payload.durationMs;
      sequence += 1;
      return {
        segment: { sequence },
        meeting: { committedDurationMs },
        manifest: { revision: sequence + 1 }
      };
    }
  }));

  await controller.start();
  for (let index = 0; index < 2; index += 1) {
    clock += 12_000;
    WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(200 + index);
    await eventually(
      () => traces.filter((trace) => trace.event === 'checkpoint_succeeded').length === index + 1,
      `pre-final native timeslice ${index + 1} did not commit`
    );
  }
  clock += 3_000;
  const result = await controller.stop({ reason: 'user_stop' });
  const recorder = WebKitDualTriggerTerminationRecorder.latest;

  assert.equal(result.finalized, true);
  assert.equal(result.finalizationPending, false);
  assert.equal(result.committedSegmentCount, 3);
  assert.equal(result.lastPersistedSequence, 2);
  assert.equal(result.lastCommittedDurationMs, 27_000);
  assert.equal(recorder.stopCalls, 1);
  assert.equal(recorder.pauseCalls, 0);
  assert.equal(recorder.resumeCalls, 0);
  assert.equal(recorder.requestDataCalls, 0);
  const finalized = traces.find((trace) => trace.event === 'finalization_succeeded');
  assert.equal(finalized?.requestDataCalled, false);
  assert.equal(finalized?.requestDataReturned, false);
  assert.equal(finalized?.requestDataEventRequired, false);
  assert.equal(finalized?.stopObserved, true);
  assert.equal(finalized?.stopDataEventObserved, true);
});

for (const fixture of [
  {
    name: 'empty stop tail',
    MediaRecorderImpl: PassiveEmptyStopTailRecorder,
    errorCode: 'MEDIA_RECORDER_FINAL_DATA_EMPTY',
    stopObserved: true,
    stopDataEventObserved: true
  },
  {
    name: 'missing stop event and tail',
    MediaRecorderImpl: PassiveMissingStopBarrierRecorder,
    errorCode: 'MEDIA_RECORDER_STOP_TIMEOUT',
    stopObserved: false,
    stopDataEventObserved: false
  },
  {
    name: 'native stop failure',
    MediaRecorderImpl: PassiveStopFailureRecorder,
    errorCode: 'MEDIA_RECORDER_STOP_FAILED',
    stopObserved: false,
    stopDataEventObserved: false
  }
]) {
  test(`passive finalization keeps prior durable audio after ${fixture.name}`, async () => {
    const schedulerTicks = [];
    const traces = [];
    let clock = Date.parse('2026-08-15T17:00:00.000Z');
    let committedDurationMs = 0;
    let sequence = -1;
    const controller = createMeetingRecorderController(passiveControllerOptions({
      clock: () => clock,
      schedulerTicks,
      traces,
      MediaRecorderImpl: fixture.MediaRecorderImpl,
      stopTimeoutMs: 30,
      async onSegment(payload) {
        committedDurationMs += payload.durationMs;
        sequence += 1;
        return {
          segment: { sequence },
          meeting: { committedDurationMs },
          manifest: { revision: sequence + 1 }
        };
      }
    }));

    await controller.start();
    clock += 12_000;
    WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(200);
    await eventually(
      () => traces.some((trace) => trace.event === 'checkpoint_succeeded'),
      'durable baseline did not commit'
    );
    const result = await controller.stop({ reason: 'user_stop' });
    const recorder = WebKitDualTriggerTerminationRecorder.latest;

    assert.equal(result.finalized, false);
    assert.equal(result.finalizationPending, true);
    assert.equal(result.finalizationErrorCode, fixture.errorCode);
    assert.equal(result.committedSegmentCount, 1);
    assert.equal(result.lastPersistedSequence, 0);
    assert.equal(result.lastCommittedDurationMs, 12_000);
    assert.equal(recorder.stopCalls, 1);
    assert.equal(recorder.pauseCalls, 0);
    assert.equal(recorder.requestDataCalls, 0);
    const pending = traces.find((trace) => trace.event === 'finalization_pending');
    assert.equal(pending?.stopObserved, fixture.stopObserved);
    assert.equal(pending?.stopDataEventObserved, fixture.stopDataEventObserved);
    assert.equal(pending?.committedDurationMs, 12_000);
  });
}

test('a delayed passive stop event and tail finalize within the bounded barrier', async () => {
  const schedulerTicks = [];
  const traces = [];
  let clock = Date.parse('2026-08-15T18:00:00.000Z');
  let sequence = -1;
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    MediaRecorderImpl: PassiveDelayedStopBarrierRecorder,
    stopTimeoutMs: 100,
    async onSegment(payload) {
      sequence += 1;
      return {
        segment: { sequence },
        meeting: { committedDurationMs: (sequence + 1) * payload.durationMs },
        manifest: { revision: sequence + 1 }
      };
    }
  }));

  await controller.start();
  clock += 12_000;
  WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(200);
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_succeeded'));
  clock += 3_000;
  const result = await controller.stop();

  assert.equal(result.finalized, true);
  assert.equal(result.finalizationPending, false);
  assert.equal(result.committedSegmentCount, 2);
  assert.equal(WebKitDualTriggerTerminationRecorder.latest.requestDataCalls, 0);
});

test('a passive stop-tail persistence failure keeps the exact error and durable baseline', async () => {
  const schedulerTicks = [];
  const traces = [];
  let clock = Date.parse('2026-08-15T19:00:00.000Z');
  let calls = 0;
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    MediaRecorderImpl: PassiveStopTailRecorder,
    async onSegment() {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('tail commit failed'), { code: 'INDEXEDDB_COMMIT_FAILED' });
      }
      return {
        segment: { sequence: 0 },
        meeting: { committedDurationMs: 12_000 },
        manifest: { revision: 1 }
      };
    }
  }));

  await controller.start();
  clock += 12_000;
  WebKitDualTriggerTerminationRecorder.latest.emitNativeTimeslice(200);
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_succeeded'));
  clock += 3_000;
  const result = await controller.stop();

  assert.equal(result.finalized, false);
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'INDEXEDDB_COMMIT_FAILED');
  assert.equal(result.committedSegmentCount, 1);
  assert.equal(result.lastPersistedSequence, 0);
  assert.equal(result.lastCommittedDurationMs, 12_000);
  assert.equal(WebKitDualTriggerTerminationRecorder.latest.requestDataCalls, 0);
});

test('a stale passive callback from a cleaned generation cannot mutate the resumed generation', async () => {
  const schedulerTicks = [];
  const traces = [];
  let clock = Date.parse('2026-08-15T20:00:00.000Z');
  let sequence = -1;
  let committedDurationMs = 0;
  const controller = createMeetingRecorderController(passiveControllerOptions({
    clock: () => clock,
    schedulerTicks,
    traces,
    MediaRecorderImpl: PassiveStopTailRecorder,
    async onSegment(payload) {
      sequence += 1;
      committedDurationMs += payload.durationMs;
      return {
        segment: { sequence },
        meeting: { committedDurationMs },
        manifest: { revision: sequence + 1 }
      };
    }
  }));

  await controller.start();
  const oldRecorder = WebKitDualTriggerTerminationRecorder.latest;
  const oldDataCallback = oldRecorder.ondataavailable;
  clock += 12_000;
  oldRecorder.emitNativeTimeslice(200);
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_succeeded'));
  clock += 3_000;
  await controller.stop();
  const committedBeforeResume = sequence;

  await controller.start({ explicitResume: true });
  const resumedRecorder = WebKitDualTriggerTerminationRecorder.latest;
  const successesBeforeStale = traces.filter((trace) => trace.event === 'checkpoint_succeeded').length;
  oldDataCallback({
    data: new Blob(['stale-old-generation'], { type: oldRecorder.mimeType })
  });
  await eventually(
    () => traces.some((trace) => trace.event === 'checkpoint_dataavailable_stale'),
    'stale passive callback was not traced'
  );
  assert.equal(sequence, committedBeforeResume);
  assert.equal(traces.filter((trace) => trace.event === 'checkpoint_succeeded').length, successesBeforeStale);

  clock += 12_000;
  resumedRecorder.emitNativeTimeslice(201);
  await eventually(
    () => traces.filter((trace) => trace.event === 'checkpoint_succeeded').length === successesBeforeStale + 1,
    'resumed generation did not commit after stale callback'
  );
  const stale = traces.find((trace) => trace.event === 'checkpoint_dataavailable_stale');
  const resumedSuccess = traces.filter((trace) => trace.event === 'checkpoint_succeeded').at(-1);
  assert.equal(stale.errorCode, 'STALE_RECORDER_GENERATION');
  assert.notEqual(stale.recorderGeneration, resumedSuccess.recorderGeneration);
  assert.equal(resumedSuccess.committedSequence, committedBeforeResume + 1);
  assert.equal(oldRecorder.requestDataCalls, 0);
  assert.equal(resumedRecorder.requestDataCalls, 0);
});
