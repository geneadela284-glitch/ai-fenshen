import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMeetingRecorderController } from './meetingRecorderController.js';

class Track {
  stopped = false;

  stop() {
    this.stopped = true;
  }
}

class Stream {
  constructor() {
    this.track = new Track();
  }

  getTracks() {
    return [this.track];
  }
}

class SafariDelayedFinalMediaRecorder {
  static latest = null;

  static isTypeSupported(mimeType) {
    return mimeType === 'audio/webm;codecs=opus' || mimeType === 'audio/mp4;codecs=mp4a.40.2';
  }

  constructor(stream, { mimeType } = {}) {
    this.stream = stream;
    this.mimeType = mimeType || 'audio/webm;codecs=opus';
    this.state = 'inactive';
    this.onstart = null;
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.requestDataCalls = 0;
    this.pauseCalls = 0;
    this.stopCalls = 0;
    SafariDelayedFinalMediaRecorder.latest = this;
  }

  start() {
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  pause() {
    if (this.state !== 'recording') return;
    this.pauseCalls += 1;
    this.state = 'paused';
    queueMicrotask(() => this.onpause?.());
  }

  requestData() {
    this.requestDataCalls += 1;
    this.ondataavailable?.({ data: new Blob([], { type: this.mimeType }) });
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['safari-final-audio'], { type: this.mimeType }) });
    }, 25);
  }
}

class SafariRequestDataEmptyMediaRecorder extends SafariDelayedFinalMediaRecorder {
  requestData() {
    super.requestData();
  }
}

class SafariNoFinalDataMediaRecorder extends SafariDelayedFinalMediaRecorder {
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  }
}

class SafariRequestDataFailureMediaRecorder extends SafariDelayedFinalMediaRecorder {
  requestData() {
    throw new Error('requestData unavailable');
  }
}

function devices(stream) {
  return {
    async getUserMedia() {
      return stream;
    }
  };
}

for (const mimeType of ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2']) {
  test(`Safari delayed final data is persisted before ${mimeType} pause succeeds`, async () => {
    const stream = new Stream();
    const segments = [];
    let interrupted = 0;
    const controller = createMeetingRecorderController({
      mediaDevices: devices(stream),
      MediaRecorderImpl: SafariDelayedFinalMediaRecorder,
      preferredMimeType: mimeType,
      ...(mimeType.startsWith('audio/mp4') ? {
        checkpointMode: 'passive-native-timeslice',
        nativeTimesliceMs: 12_000
      } : {}),
      stopTimeoutMs: 250,
      onSegment: async (segment) => segments.push(segment),
      onInterrupted: async () => { interrupted += 1; }
    });

    await controller.start();
    await controller.interrupt('user_pause');

    assert.equal(interrupted, 1);
    assert.equal(controller.status, 'idle');
    assert.equal(stream.track.stopped, true);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].blob.type, mimeType);
    assert.equal(segments[0].blob.size, Buffer.byteLength('safari-final-audio'));
    assert.equal(segments[0].durationMs > 0, true);
    if (mimeType.startsWith('audio/mp4')) {
      assert.equal(SafariDelayedFinalMediaRecorder.latest.requestDataCalls, 0);
      assert.equal(SafariDelayedFinalMediaRecorder.latest.pauseCalls, 0);
      assert.equal(SafariDelayedFinalMediaRecorder.latest.stopCalls, 1);
    }
  });

  test(`Safari delayed final data is persisted before ${mimeType} stop succeeds`, async () => {
    const stream = new Stream();
    const segments = [];
    const controller = createMeetingRecorderController({
      mediaDevices: devices(stream),
      MediaRecorderImpl: SafariDelayedFinalMediaRecorder,
      preferredMimeType: mimeType,
      ...(mimeType.startsWith('audio/mp4') ? {
        checkpointMode: 'passive-native-timeslice',
        nativeTimesliceMs: 12_000
      } : {}),
      stopTimeoutMs: 250,
      onSegment: async (segment) => segments.push(segment)
    });

    await controller.start();
    await controller.stop({ reason: 'user_stop' });

    assert.equal(controller.status, 'idle');
    assert.equal(stream.track.stopped, true);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].blob.type, mimeType);
    assert.equal(segments[0].blob.size, Buffer.byteLength('safari-final-audio'));
    assert.equal(segments[0].durationMs > 0, true);
    if (mimeType.startsWith('audio/mp4')) {
      assert.equal(SafariDelayedFinalMediaRecorder.latest.requestDataCalls, 0);
      assert.equal(SafariDelayedFinalMediaRecorder.latest.pauseCalls, 0);
      assert.equal(SafariDelayedFinalMediaRecorder.latest.stopCalls, 1);
    }
  });
}

test('a requestData empty event does not release the stream before a delayed stop data event', async () => {
  const stream = new Stream();
  const segments = [];
  const controller = createMeetingRecorderController({
    mediaDevices: devices(stream),
    MediaRecorderImpl: SafariRequestDataEmptyMediaRecorder,
    stopTimeoutMs: 250,
    onSegment: async (segment) => segments.push(segment)
  });

  await controller.start();
  await controller.stop();

  assert.equal(segments.length, 1);
  assert.equal(stream.track.stopped, true);
});

test('missing final data preserves the durable contract as finalization pending before releasing resources', async () => {
  const stream = new Stream();
  const errors = [];
  const controller = createMeetingRecorderController({
    mediaDevices: devices(stream),
    MediaRecorderImpl: SafariNoFinalDataMediaRecorder,
    stopTimeoutMs: 20,
    onError: (error) => errors.push(error)
  });

  await controller.start();
  const result = await controller.stop();

  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_STOP_TIMEOUT');
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
  assert.deepEqual(errors.map((error) => error.code), ['MEDIA_RECORDER_STOP_TIMEOUT']);
});

test('final chunk persistence failure preserves prior audio as finalization pending after the event barrier', async () => {
  const stream = new Stream();
  const errors = [];
  const controller = createMeetingRecorderController({
    mediaDevices: devices(stream),
    MediaRecorderImpl: SafariDelayedFinalMediaRecorder,
    stopTimeoutMs: 250,
    onSegment: async () => { throw new Error('persist failed'); },
    onError: (error) => errors.push(error)
  });

  await controller.start();
  const result = await controller.stop();

  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_FINAL_FLUSH_FAILED');
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
  assert.deepEqual(errors.map((error) => error.code), ['MEDIA_RECORDER_FINAL_FLUSH_FAILED']);
});

test('requestData failure marks finalization pending even when stop emits a final chunk', async () => {
  const stream = new Stream();
  const controller = createMeetingRecorderController({
    mediaDevices: devices(stream),
    MediaRecorderImpl: SafariRequestDataFailureMediaRecorder,
    stopTimeoutMs: 250
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_REQUEST_DATA_FAILED');
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
});
