import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingRecorderController } from './meetingRecorderController.js';

class FakeTrack {
  stopped = false;

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

const REAL_CHROME_NATIVE_RESUME_SEQUENCE = Object.freeze([
  Object.freeze({ kind: 'data', blobSize: 19_491 }),
  Object.freeze({ kind: 'data', blobSize: 0 }),
  Object.freeze({ kind: 'data', blobSize: 0 }),
  Object.freeze({ kind: 'throw', errorName: 'InvalidStateError' })
]);

class ChromeAacPausePoisonRecorder {
  static instances = [];
  static pageEpoch = 1;

  static reset() {
    ChromeAacPausePoisonRecorder.instances = [];
    ChromeAacPausePoisonRecorder.pageEpoch = 1;
  }

  static beginNewPage() {
    ChromeAacPausePoisonRecorder.pageEpoch += 1;
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
    this.pageEpoch = ChromeAacPausePoisonRecorder.pageEpoch;
    ChromeAacPausePoisonRecorder.instances.push(this);
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
    if (!this.nativeResumeUsed) {
      queueMicrotask(() => this.emitBlob(280_000));
      return;
    }
    const fixture = REAL_CHROME_NATIVE_RESUME_SEQUENCE[this.postNativeResumeCalls]
      || REAL_CHROME_NATIVE_RESUME_SEQUENCE.at(-1);
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
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.emitBlob(74_502));
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

test('real iPhone Chrome pause uses a new page and then sustains six durable checkpoints', async () => {
  ChromeAacPausePoisonRecorder.reset();
  const schedulerTicks = [];
  const traces = [];
  const attempts = [];
  const streams = [];
  let sequence = 26;
  let committedDurationMs = 340_000;
  const createController = () => createMeetingRecorderController({
    mediaDevices: {
      getUserMedia: async () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      }
    },
    MediaRecorderImpl: ChromeAacPausePoisonRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-chrome', profile: { id: 'aac-primary' } },
    requireAacPrimaryGate: true,
    checkpointMode: 'passive-native-timeslice',
    nativeTimesliceMs: 12_000,
    recordingAttemptEvidence: async () => {
      const recordingAttemptId = `chrome-attempt-${attempts.length + 1}`;
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
      committedDurationMs += 12_000;
      return {
        segment: { sequence },
        meeting: { committedDurationMs },
        manifest: { revision: sequence + 1 }
      };
    },
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  const controller = createController();
  await controller.start();
  ChromeAacPausePoisonRecorder.instances[0].emitBlob(280_000);
  await waitForTraceCount(traces, 'checkpoint_succeeded', 1);
  const paused = await controller.pause();

  assert.equal(paused.sessionBoundary, true);
  assert.equal(controller.status, 'paused');
  assert.equal(ChromeAacPausePoisonRecorder.instances[0].stopCalls, 1);
  assert.equal(ChromeAacPausePoisonRecorder.instances[0].requestDataCalls, 0);
  assert.equal(ChromeAacPausePoisonRecorder.instances[0].pauseCalls, 0);
  assert.equal(streams[0].track.stopped, true);
  const pauseCheckpoint = traces.filter((trace) => trace.event === 'checkpoint_succeeded').at(-1);
  assert.equal(pauseCheckpoint.trigger, 'stop-tail');
  assert.equal(pauseCheckpoint.committedDurationMs, 364_000);

  await assert.rejects(
    () => controller.resume(),
    (error) => error?.code === 'RECORDER_PAGE_RELOAD_REQUIRED'
  );
  assert.equal(ChromeAacPausePoisonRecorder.instances[0].resumeCalls, 0);

  ChromeAacPausePoisonRecorder.beginNewPage();
  const resumedController = createController();
  await resumedController.start({ explicitResume: true });
  for (let index = 1; index <= 6; index += 1) {
    schedulerTicks.at(-1)();
    ChromeAacPausePoisonRecorder.instances[1].emitBlob(280_000 + index);
    await waitForTraceCount(traces, 'checkpoint_succeeded', 2 + index);
  }

  const resumedSuccesses = traces
    .filter((trace) => trace.event === 'checkpoint_succeeded')
    .slice(-6);
  assert.deepEqual(
    resumedSuccesses.map((trace) => trace.committedDurationMs),
    [376_000, 388_000, 400_000, 412_000, 424_000, 436_000]
  );
  assert.deepEqual(
    resumedSuccesses.map((trace) => trace.committedSequence),
    [29, 30, 31, 32, 33, 34]
  );
  assert.equal(resumedSuccesses.every((trace) => trace.inFlight === false), true);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_failed'), false);
  assert.equal(ChromeAacPausePoisonRecorder.instances.length, 2);
  assert.equal(ChromeAacPausePoisonRecorder.instances[0].nativeResumeUsed, false);
  assert.equal(ChromeAacPausePoisonRecorder.instances[1].requestDataCalls, 0);
  assert.equal(attempts.length, 2);
  assert.notEqual(resumedSuccesses[0].recordingAttemptId, pauseCheckpoint.recordingAttemptId);

  await resumedController.stop();
});
