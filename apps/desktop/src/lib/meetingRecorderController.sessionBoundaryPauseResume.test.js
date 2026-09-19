import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingRecorderController } from './meetingRecorderController.js';

class FakeTrack {
  constructor() {
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor() {
    this.track = new FakeTrack();
  }

  getTracks() {
    return [this.track];
  }
}

const REAL_IPHONE_RESUME_SEQUENCE = Object.freeze([
  Object.freeze({ kind: 'data', blobSize: 19_491 }),
  Object.freeze({ kind: 'data', blobSize: 0 }),
  Object.freeze({ kind: 'data', blobSize: 0 }),
  Object.freeze({ kind: 'throw', errorName: 'InvalidStateError' })
]);

class SafariAacPausePoisonRecorder {
  static instances = [];
  static pageEpoch = 1;

  static reset() {
    SafariAacPausePoisonRecorder.instances = [];
    SafariAacPausePoisonRecorder.pageEpoch = 1;
  }

  static beginNewPage() {
    SafariAacPausePoisonRecorder.pageEpoch += 1;
  }

  static isTypeSupported(value) {
    return value === 'audio/mp4;codecs=mp4a.40.2';
  }

  constructor(_stream, options = {}) {
    this.mimeType = options.mimeType || 'audio/mp4;codecs=mp4a.40.2';
    this.state = 'inactive';
    this.requestDataCalls = 0;
    this.postNativeResumeCalls = 0;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.stopCalls = 0;
    this.nativeResumeUsed = false;
    this.failRequestData = false;
    this.stopTailSize = 74_502;
    this.pageEpoch = SafariAacPausePoisonRecorder.pageEpoch;
    this.pageInstanceIndex = SafariAacPausePoisonRecorder.instances
      .filter((instance) => instance.pageEpoch === this.pageEpoch).length;
    SafariAacPausePoisonRecorder.instances.push(this);
  }

  start(timeslice) {
    this.timeslice = timeslice;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  requestData() {
    if (this.state !== 'recording') {
      const error = new Error('InvalidStateError');
      error.name = 'InvalidStateError';
      throw error;
    }
    this.requestDataCalls += 1;
    if (this.failRequestData) {
      throw new Error('Safari requestData state poisoned');
    }
    if (!this.nativeResumeUsed && this.pageInstanceIndex === 0) {
      const size = this.requestDataCalls === 2 ? 74_502 : 280_000;
      queueMicrotask(() => this.emitBlob(size));
      return;
    }
    const fixture = REAL_IPHONE_RESUME_SEQUENCE[this.postNativeResumeCalls]
      || REAL_IPHONE_RESUME_SEQUENCE.at(-1);
    this.postNativeResumeCalls += 1;
    if (fixture.kind === 'throw') {
      this.state = 'inactive';
      const error = new Error(fixture.errorName);
      error.name = fixture.errorName;
      throw error;
    }
    queueMicrotask(() => this.emitBlob(fixture.blobSize));
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
    this.nativeResumeUsed = true;
    this.state = 'recording';
    // Real Gen283 iPhone evidence: state changed without a resume event.
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.emitBlob(this.stopTailSize));
    queueMicrotask(() => this.onstop?.());
  }

  emitBlob(size) {
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(size)], { type: this.mimeType })
    });
  }
}

function flushTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForTraceCount(traces, event, count) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (traces.filter((trace) => trace.event === event).length >= count) return;
    await flushTurn();
  }
  assert.fail(`timed out waiting for ${count} ${event} traces`);
}

test('real iPhone seq101 pause boundary requires a new page before six durable resume checkpoints', async () => {
  SafariAacPausePoisonRecorder.reset();
  const schedulerTicks = [];
  const traces = [];
  const attempts = [];
  const streams = [];
  let sequence = 99;
  let committedDurationMs = 1_200_382;
  const createController = () => createMeetingRecorderController({
    mediaDevices: {
      getUserMedia: async () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      }
    },
    MediaRecorderImpl: SafariAacPausePoisonRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-safari', profile: { id: 'aac-primary' } },
    requireAacPrimaryGate: true,
    checkpointMode: 'passive-native-timeslice',
    nativeTimesliceMs: 12_000,
    recordingAttemptEvidence: async () => {
      const recordingAttemptId = `attempt-${attempts.length + 1}`;
      attempts.push(recordingAttemptId);
      return { ok: true, recordingAttemptId };
    },
    checkpointIntervalMs: 12_000,
    checkpointEventTimeoutMs: 15,
    stopTimeoutMs: 30,
    setIntervalImpl: (callback) => {
      schedulerTicks.push(callback);
      return schedulerTicks.length;
    },
    clearIntervalImpl: () => {},
    onSegment: async () => {
      sequence += 1;
      if (sequence === 100) committedDurationMs = 1_212_385;
      else if (sequence === 101) committedDurationMs = 1_215_306;
      else committedDurationMs += 12_000;
      return {
        segment: { sequence },
        meeting: { committedDurationMs },
        manifest: { revision: 6 + (sequence * 2) }
      };
    },
    onCheckpointTrace: async (trace) => traces.push(trace)
  });
  const controller = createController();

  await controller.start();
  SafariAacPausePoisonRecorder.instances[0].emitBlob(280_000);
  schedulerTicks.at(-1)();
  await waitForTraceCount(traces, 'checkpoint_succeeded', 1);

  await controller.pause();
  const pauseCheckpoint = traces.filter((trace) => trace.event === 'checkpoint_succeeded').at(-1);
  assert.equal(pauseCheckpoint.trigger, 'stop-tail');
  assert.equal(pauseCheckpoint.committedSequence, 101);
  assert.equal(pauseCheckpoint.committedDurationMs, 1_215_306);
  assert.equal(controller.status, 'paused');
  const boundaryData = traces.find((trace) => trace.event === 'recorder_pause_boundary_dataavailable');
  assert.equal(boundaryData?.blobSize, 74_502);
  assert.equal(boundaryData?.empty, false);
  assert.equal(traces.filter((trace) => trace.event === 'recorder_pause_boundary_stop_event').length, 1);
  assert.equal(traces.filter((trace) => trace.event === 'recorder_pause_boundary_sealed').length, 1);
  assert.equal(streams[0].track.stopped, true);

  await assert.rejects(
    () => controller.resume(),
    (error) => error?.code === 'RECORDER_PAGE_RELOAD_REQUIRED'
  );
  assert.equal(SafariAacPausePoisonRecorder.instances.length, 1);

  SafariAacPausePoisonRecorder.beginNewPage();
  const resumedController = createController();
  await resumedController.start({ explicitResume: true });
  for (let index = 1; index <= 6; index += 1) {
    schedulerTicks.at(-1)();
    SafariAacPausePoisonRecorder.instances[1].emitBlob(280_000 + index);
    await waitForTraceCount(traces, 'checkpoint_succeeded', 2 + index);
  }

  const resumedSuccesses = traces
    .filter((trace) => trace.event === 'checkpoint_succeeded')
    .slice(-6);
  assert.deepEqual(
    resumedSuccesses.map((trace) => trace.committedDurationMs),
    [1_227_306, 1_239_306, 1_251_306, 1_263_306, 1_275_306, 1_287_306]
  );
  assert.deepEqual(resumedSuccesses.map((trace) => trace.committedSequence), [102, 103, 104, 105, 106, 107]);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_failed'), false);
  assert.equal(SafariAacPausePoisonRecorder.instances.length, 2);
  assert.equal(SafariAacPausePoisonRecorder.instances[0].stopCalls, 1);
  assert.equal(SafariAacPausePoisonRecorder.instances[0].pauseCalls, 0);
  assert.equal(SafariAacPausePoisonRecorder.instances[0].resumeCalls, 0);
  assert.equal(SafariAacPausePoisonRecorder.instances[0].requestDataCalls, 0);
  assert.equal(SafariAacPausePoisonRecorder.instances[1].requestDataCalls, 0);
  assert.equal(attempts.length, 2);
  assert.notEqual(resumedSuccesses[0].recordingAttemptId, pauseCheckpoint.recordingAttemptId);

  await resumedController.stop();
});

test('a legacy requestData poison cannot affect the passive Safari AAC stop boundary', async () => {
  SafariAacPausePoisonRecorder.reset();
  const schedulerTicks = [];
  const traces = [];
  const streams = [];
  let sequence = -1;
  const controller = createMeetingRecorderController({
    mediaDevices: {
      getUserMedia: async () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      }
    },
    MediaRecorderImpl: SafariAacPausePoisonRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-safari', profile: { id: 'aac-primary' } },
    requireAacPrimaryGate: true,
    checkpointMode: 'passive-native-timeslice',
    nativeTimesliceMs: 12_000,
    recordingAttemptEvidence: async () => ({ ok: true, recordingAttemptId: 'attempt-poisoned-pause' }),
    checkpointEventTimeoutMs: 15,
    stopTimeoutMs: 30,
    setIntervalImpl: (callback) => {
      schedulerTicks.push(callback);
      return schedulerTicks.length;
    },
    clearIntervalImpl: () => {},
    onSegment: async () => ({
      segment: { sequence: ++sequence },
      meeting: { committedDurationMs: (sequence + 1) * 12_000 },
      manifest: { revision: sequence + 1 }
    }),
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  await controller.start();
  SafariAacPausePoisonRecorder.instances[0].emitBlob(280_000);
  schedulerTicks.at(-1)();
  await waitForTraceCount(traces, 'checkpoint_succeeded', 1);
  SafariAacPausePoisonRecorder.instances[0].failRequestData = true;

  const paused = await controller.pause();

  assert.equal(paused.actualPaused, true);
  assert.equal(paused.boundaryPending, false);
  assert.equal(paused.errorCode, '');
  assert.equal(controller.status, 'paused');
  assert.equal(SafariAacPausePoisonRecorder.instances[0].stopCalls, 1);
  assert.equal(SafariAacPausePoisonRecorder.instances[0].requestDataCalls, 0);
  assert.equal(streams[0].track.stopped, true);
  assert.equal(traces.some((trace) => (
    trace.event === 'recorder_pause_boundary_sealed'
      && trace.stopObserved === true
      && trace.boundaryPending === false
  )), true);
});

test('ending from an iPhone AAC pause boundary does not poison the next meeting start', async () => {
  SafariAacPausePoisonRecorder.reset();
  const schedulerTicks = [];
  let sequence = -1;
  const controller = createMeetingRecorderController({
    mediaDevices: { getUserMedia: async () => new FakeStream() },
    MediaRecorderImpl: SafariAacPausePoisonRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-safari', profile: { id: 'aac-primary' } },
    requireAacPrimaryGate: true,
    checkpointMode: 'passive-native-timeslice',
    nativeTimesliceMs: 12_000,
    recordingAttemptEvidence: async () => ({ ok: true, recordingAttemptId: `attempt-${sequence + 2}` }),
    checkpointEventTimeoutMs: 15,
    stopTimeoutMs: 30,
    setIntervalImpl: (callback) => {
      schedulerTicks.push(callback);
      return schedulerTicks.length;
    },
    clearIntervalImpl: () => {},
    onSegment: async () => ({
      segment: { sequence: ++sequence },
      meeting: { committedDurationMs: (sequence + 1) * 12_000 },
      manifest: { revision: sequence + 1 }
    })
  });

  await controller.start();
  SafariAacPausePoisonRecorder.instances[0].emitBlob(280_000);
  schedulerTicks.at(-1)();
  await flushTurn();
  await controller.pause();
  assert.equal(controller.status, 'paused');
  await controller.stop({ reason: 'user_stop' });
  assert.equal(controller.status, 'idle');

  await assert.doesNotReject(() => controller.start());
  assert.equal(controller.status, 'recording');
  assert.equal(SafariAacPausePoisonRecorder.instances.length, 2);
  await controller.stop();
});
