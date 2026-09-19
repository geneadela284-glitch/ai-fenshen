import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMeetingRecorderController } from './meetingRecorderController.js';

class FakeStream {
  constructor() {
    this.track = { stopped: false, stop: () => { this.track.stopped = true; } };
  }

  getTracks() {
    return [this.track];
  }
}

class PoisonedAfterResumeRecorder {
  static latest = null;

  constructor(_stream, options = {}) {
    this.mimeType = options.mimeType || 'audio/mp4;codecs=mp4a.40.2';
    this.state = 'inactive';
    this.requestDataCalls = 0;
    this.stopCalls = 0;
    this.onstart = null;
    this.onpause = null;
    this.onresume = null;
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    PoisonedAfterResumeRecorder.latest = this;
  }

  start() {
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  pause() {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    queueMicrotask(() => this.onpause?.());
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    queueMicrotask(() => this.onresume?.());
  }

  requestData() {
    this.requestDataCalls += 1;
    if (this.requestDataCalls === 4) {
      queueMicrotask(() => this.ondataavailable?.({
        data: new Blob([], { type: this.mimeType })
      }));
      return;
    }
    if (this.requestDataCalls >= 5) throw new Error('Safari requestData state poisoned');
    queueMicrotask(() => this.ondataavailable?.({
      data: new Blob([`segment-${this.requestDataCalls}`], { type: this.mimeType })
    }));
  }

  stop() {
    this.stopCalls += 1;
    if (this.state === 'inactive') throw new Error('stop called while inactive');
    this.state = 'inactive';
    queueMicrotask(() => this.ondataavailable?.({
      data: new Blob(['unexpected-final'], { type: this.mimeType })
    }));
    queueMicrotask(() => this.onstop?.());
  }

  emitNative(value = 'native-timeslice') {
    this.ondataavailable?.({
      data: new Blob([value], { type: this.mimeType })
    });
  }
}

class PassiveEmptyFinalRecorder extends PoisonedAfterResumeRecorder {
  stop() {
    this.stopCalls += 1;
    if (this.state === 'inactive') throw new Error('stop called while inactive');
    this.state = 'inactive';
    queueMicrotask(() => this.ondataavailable?.({
      data: new Blob([], { type: this.mimeType })
    }));
    queueMicrotask(() => this.onstop?.());
  }
}

function mediaDevices(stream) {
  return { async getUserMedia() { return stream; } };
}

async function eventually(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition did not settle');
}

test('legacy active poisoned requestData sequence preserves durable segments as finalization pending', async () => {
  const stream = new FakeStream();
  const ticks = [];
  const traces = [];
  const segments = [];
  let committedDurationMs = 0;
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: PoisonedAfterResumeRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    checkpointIntervalMs: 12_000,
    checkpointEventTimeoutMs: 5,
    stopTimeoutMs: 25,
    setIntervalImpl: (callback) => {
      ticks.push(callback);
      return { unref() {} };
    },
    clearIntervalImpl: () => {},
    onSegment: async (payload) => {
      committedDurationMs += payload.durationMs;
      segments.push(payload);
      return {
        meeting: { committedDurationMs },
        manifest: { revision: segments.length * 2 },
        segment: { sequence: segments.length - 1 }
      };
    },
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  await controller.start();
  ticks[0]();
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_succeeded'));

  await controller.pause();
  await controller.resume();
  ticks[0]();
  await eventually(() => traces.filter((trace) => trace.event === 'checkpoint_succeeded').length >= 3);

  ticks[0]();
  await eventually(() => traces.some((trace) => trace.errorCode === 'RECORDING_CHECKPOINT_DATA_TIMEOUT'));
  ticks[0]();
  await eventually(() => traces.filter((trace) => trace.errorCode === 'RECORDING_CHECKPOINT_REQUEST_DATA_FAILED').length >= 1);

  const committedBeforeStop = segments.length;
  const result = await controller.stop();

  assert.equal(result.finalizationPending, true);
  assert.equal(result.lastCommittedDurationMs, committedDurationMs);
  assert.equal(result.committedSegmentCount >= committedBeforeStop, true);
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
  assert.equal(segments.length >= committedBeforeStop, true);
  assert.equal(PoisonedAfterResumeRecorder.latest.stopCalls, 1);
  const finalRequestFailure = traces.find((trace) => trace.event === 'finalization_request_data_failed');
  assert.equal(finalRequestFailure?.requestDataCalled, true);
  assert.equal(finalRequestFailure?.requestDataReturned, false);
  assert.equal(finalRequestFailure?.errorCode, 'MEDIA_RECORDER_REQUEST_DATA_FAILED');
  const finalPending = traces.find((trace) => trace.event === 'finalization_pending');
  assert.equal(finalPending?.stopRequested, true);
  assert.equal(finalPending?.stopObserved, true);
  assert.equal(finalPending?.committedDurationMs, committedDurationMs);
});

test('passive AAC empty final tail preserves the durable baseline as finalization pending', async () => {
  const stream = new FakeStream();
  const traces = [];
  const segments = [];
  let committedDurationMs = 0;
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: PassiveEmptyFinalRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    checkpointMode: 'passive-native-timeslice',
    nativeTimesliceMs: 12_000,
    stopTimeoutMs: 25,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    onSegment: async (payload) => {
      committedDurationMs += payload.durationMs;
      segments.push(payload);
      return {
        meeting: { committedDurationMs },
        manifest: { revision: segments.length },
        segment: { sequence: segments.length - 1 }
      };
    },
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  await controller.start();
  PoisonedAfterResumeRecorder.latest.emitNative('durable-before-empty-tail');
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_succeeded'));
  const durationBeforeStop = committedDurationMs;
  const result = await controller.stop();

  assert.equal(result.finalized, false);
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_FINAL_DATA_EMPTY');
  assert.equal(result.committedSegmentCount, 1);
  assert.equal(result.lastPersistedSequence, 0);
  assert.equal(result.lastCommittedDurationMs, durationBeforeStop);
  assert.equal(segments.length, 1);
  assert.equal(PoisonedAfterResumeRecorder.latest.requestDataCalls, 0);
  assert.equal(PoisonedAfterResumeRecorder.latest.stopCalls, 1);
  assert.equal(stream.track.stopped, true);
  const pending = traces.find((trace) => trace.event === 'finalization_pending');
  assert.equal(pending?.requestDataCalled, false);
  assert.equal(pending?.requestDataReturned, false);
  assert.equal(pending?.stopObserved, true);
  assert.equal(pending?.stopDataEventObserved, true);
  assert.equal(pending?.committedDurationMs, durationBeforeStop);
});
