import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMeetingRecorderController, inspectMeetingRecorderCapabilities, probeMeetingRecorderCodecs } from './meetingRecorderController.js';
import { AAC_PRIMARY_PROFILE } from './meetingRecordingMediaProfile.js';

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

class FakeMediaRecorder {
  static supported = true;

  static isTypeSupported() {
    return FakeMediaRecorder.supported;
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
    this.state = 'inactive';
    this.onstart = null;
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }

  start(timeslice) {
    this.timeslice = timeslice;
    if (FakeMediaRecorder.startError) throw FakeMediaRecorder.startError;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  pause() {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    queueMicrotask(() => this.onpause?.());
  }

  emitChunk(value = 'audio') {
    this.ondataavailable?.({ data: new Blob([value], { type: this.mimeType }) });
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.emitChunk('final-audio');
    queueMicrotask(() => this.onstop?.());
  }
}

class LateDataMediaRecorder extends FakeMediaRecorder {
  static latest = null;

  constructor(...args) {
    super(...args);
    LateDataMediaRecorder.latest = this;
    this.requestDataCalls = 0;
  }

  requestData() {
    this.requestDataCalls += 1;
    queueMicrotask(() => this.emitChunk(''));
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    const stopHandler = this.onstop;
    queueMicrotask(() => stopHandler?.());
    queueMicrotask(() => this.emitChunk('late-final-audio'));
  }
}

class StaleCallbackMediaRecorder extends FakeMediaRecorder {
  static instances = [];

  constructor(...args) {
    super(...args);
    StaleCallbackMediaRecorder.instances.push(this);
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => this.emitChunk('final-audio'));
    queueMicrotask(() => this.onstop?.());
  }
}

class TwoPhaseFinalMediaRecorder extends FakeMediaRecorder {
  static mode = 'request-and-stop-audio';
  static latest = null;

  constructor(...args) {
    super(...args);
    TwoPhaseFinalMediaRecorder.latest = this;
    this.requestDataCalls = 0;
    this.stopCalls = 0;
    this.requestDataEventObserved = false;
    this.stopCalledBeforeRequestDataEvent = false;
  }

  requestData() {
    this.requestDataCalls += 1;
    const mode = TwoPhaseFinalMediaRecorder.mode;
    queueMicrotask(() => {
      this.requestDataEventObserved = true;
      this.emitChunk(mode === 'empty-request-then-stop-audio' || mode === 'empty-both' ? '' : 'request-data-audio');
    });
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    if (!this.requestDataEventObserved) this.stopCalledBeforeRequestDataEvent = true;
    this.state = 'inactive';
    const mode = TwoPhaseFinalMediaRecorder.mode;
    if (mode === 'stop-timeout') return;
    if (mode === 'stop-then-audio') {
      queueMicrotask(() => this.onstop?.());
      queueMicrotask(() => this.emitChunk('stop-audio'));
      return;
    }
    queueMicrotask(() => {
      this.emitChunk(mode === 'empty-both' ? '' : 'stop-audio');
      this.onstop?.();
    });
  }
}

class RequestDataFailureMediaRecorder extends TwoPhaseFinalMediaRecorder {
  requestData() {
    this.requestDataCalls += 1;
    throw new Error('requestData failed');
  }
}

class PrequeuedTimesliceMediaRecorder extends FakeMediaRecorder {
  static latest = null;

  constructor(...args) {
    super(...args);
    PrequeuedTimesliceMediaRecorder.latest = this;
    this.requestDataCalls = 0;
  }

  requestData() {
    this.requestDataCalls += 1;
    queueMicrotask(() => this.emitChunk('request-data-audio'));
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
    setTimeout(() => this.emitChunk('stop-final-audio'), 20);
  }
}

class StopFailureMediaRecorder extends TwoPhaseFinalMediaRecorder {
  requestData() {
    this.requestDataCalls += 1;
    this.requestDataEventObserved = true;
    this.emitChunk('request-data-audio');
  }

  stop() {
    this.stopCalls += 1;
    throw new Error('stop failed');
  }
}

class NoPauseMediaRecorder extends TwoPhaseFinalMediaRecorder {
  constructor(...args) {
    super(...args);
    this.pause = undefined;
  }
}

class PauseTimeoutMediaRecorder extends TwoPhaseFinalMediaRecorder {
  pause() {
    this.state = 'paused';
  }
}

class PauseErrorMediaRecorder extends TwoPhaseFinalMediaRecorder {
  pause() {
    this.state = 'paused';
    queueMicrotask(() => {
      const error = new Error('recorder failed while fencing final data');
      error.code = 'MEDIA_RECORDER_FAKE_FINAL_ERROR';
      this.onerror?.({ error });
      this.onpause?.();
    });
  }
}

class PauseErrorOnlyMediaRecorder extends TwoPhaseFinalMediaRecorder {
  pause() {
    this.state = 'paused';
    queueMicrotask(() => {
      const error = new Error('recorder failed before pause event');
      error.code = 'MEDIA_RECORDER_ASYNC_ONLY_ERROR';
      this.onerror?.({ error });
    });
  }
}

function mediaDevices(stream) {
  return {
    calls: 0,
    async getUserMedia() {
      this.calls += 1;
      return stream;
    }
  };
}

function documentHarness() {
  const listeners = new Map();
  return {
    hidden: false,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    emit(type) {
      listeners.get(type)?.();
    }
  };
}

function storageHarness() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('records browser codec capability without changing the default selection order', () => {
  const capabilities = inspectMeetingRecorderCapabilities({
    isTypeSupported(value) {
      return value === 'audio/mp4' || value === 'audio/mp4;codecs=mp4a.40.2';
    }
  }, ['audio/webm;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2']);
  assert.deepEqual(capabilities, [
    { requestedMimeType: 'audio/webm;codecs=opus', supported: false },
    { requestedMimeType: 'audio/mp4', supported: true },
    { requestedMimeType: 'audio/mp4;codecs=mp4a.40.2', supported: true }
  ]);
});

test('supports an explicit experimental AAC/MP4 preference without changing the default WebM order', async () => {
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: FakeMediaRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    mediaProfile: { device: 'iphone-safari', profile: AAC_PRIMARY_PROFILE }
  });
  const started = await controller.start();
  assert.equal(started.mimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(started.mediaProfile.profile, AAC_PRIMARY_PROFILE);
  await controller.stop();
});

test('iPhone AAC profile fails closed when the recorder reports a non-MP4 MIME', async () => {
  class MismatchedMediaRecorder extends FakeMediaRecorder {
    constructor(stream) {
      super(stream, { mimeType: 'audio/webm;codecs=opus' });
    }
  }
  MismatchedMediaRecorder.isTypeSupported = () => true;
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: MismatchedMediaRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    mediaProfile: { device: 'iphone-safari', profile: AAC_PRIMARY_PROFILE }
  });

  await assert.rejects(controller.start(), (error) => error.code === 'AAC_PRIMARY_MIME_MISMATCH');
  assert.equal(controller.status, 'idle');
});

test('pre-record AAC gate is acknowledged before start and receives complete runtime evidence', async () => {
  const evidence = [];
  let startCalls = 0;
  class GateMediaRecorder extends FakeMediaRecorder {
    static isTypeSupported(value) {
      return value === 'audio/mp4;codecs=mp4a.40.2';
    }

    start(...args) {
      startCalls += 1;
      return super.start(...args);
    }
  }
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: GateMediaRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-safari', profile: AAC_PRIMARY_PROFILE },
    requireAacPrimaryGate: true,
    recordingAttemptEvidence: async (value) => {
      evidence.push(value);
      return { ok: true, serverGate: 'AAC_PRIMARY_ACTIVE' };
    }
  });

  await controller.start();
  assert.equal(startCalls, 1);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].requestedMimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(evidence[0].actualMimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(evidence[0].mediaProfile.profile.id, AAC_PRIMARY_PROFILE.id);
  await controller.stop();
});

test('pre-record AAC gate rejects a WebM result before MediaRecorder.start()', async () => {
  let startCalls = 0;
  class WebmGateMediaRecorder extends FakeMediaRecorder {
    static isTypeSupported(value) {
      return value === 'audio/mp4;codecs=mp4a.40.2';
    }

    constructor(stream, options = {}) {
      super(stream, options);
      this.mimeType = 'audio/webm;codecs=opus';
    }

    start(...args) {
      startCalls += 1;
      return super.start(...args);
    }
  }
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: WebmGateMediaRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-safari', profile: AAC_PRIMARY_PROFILE },
    requireAacPrimaryGate: true,
    recordingAttemptEvidence: async () => ({ ok: false, errorCode: 'AAC_PRIMARY_MIME_MISMATCH' })
  });

  await assert.rejects(controller.start(), (error) => error.code === 'AAC_PRIMARY_MIME_MISMATCH');
  assert.equal(startCalls, 0);
  assert.equal(controller.status, 'idle');
});

test('pre-record AAC evidence is still captured when the MediaRecorder constructor fails', async () => {
  const evidence = [];
  class ConstructorFailureMediaRecorder extends FakeMediaRecorder {
    static isTypeSupported(value) {
      return value === 'audio/mp4;codecs=mp4a.40.2';
    }

    constructor() {
      throw Object.assign(new Error('unsupported constructor MIME'), { name: 'NotSupportedError' });
    }
  }
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: ConstructorFailureMediaRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    mediaProfile: { device: 'iphone-safari', profile: AAC_PRIMARY_PROFILE },
    requireAacPrimaryGate: true,
    recordingAttemptEvidence: async (value) => {
      evidence.push(value);
      return { ok: false, errorCode: 'AAC_CONSTRUCTOR_MIME_MISMATCH' };
    }
  });

  await assert.rejects(controller.start(), (error) => error.code === 'AAC_EXPERIMENT_UNSUPPORTED');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].actualMimeType, '');
  assert.equal(evidence[0].constructorErrorCode, 'NotSupportedError');
  assert.equal(controller.status, 'idle');
});

test('reads the candidate AAC experiment after the app view changes and refuses WebM preference', async () => {
  class CandidateMediaRecorder extends FakeMediaRecorder {
    static isTypeSupported(value) {
      return value === 'audio/webm;codecs=opus' || value === 'audio/mp4;codecs=mp4a.40.2';
    }
  }
  const sessionStorage = storageHarness();
  sessionStorage.setItem('meetingRecordingCodecExperiment', 'aac-mp4');
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: CandidateMediaRecorder,
    windowImpl: { sessionStorage }
  });

  const started = await controller.start();
  assert.equal(started.mimeType, 'audio/mp4;codecs=mp4a.40.2');
  await controller.stop();
});

test('candidate AAC mode fails closed when the browser exposes no AAC/MP4 MIME', async () => {
  class WebmOnlyMediaRecorder extends FakeMediaRecorder {
    static isTypeSupported(value) {
      return value === 'audio/webm;codecs=opus';
    }
  }
  const sessionStorage = storageHarness();
  sessionStorage.setItem('meetingRecordingCodecExperiment', 'aac-mp4');
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: WebmOnlyMediaRecorder,
    windowImpl: { sessionStorage }
  });

  await assert.rejects(controller.start(), (error) => error.code === 'AAC_EXPERIMENT_UNSUPPORTED');
  assert.equal(controller.status, 'idle');
});

test('codec probe creates a short in-memory recording and returns the actual MediaRecorder MIME type', async () => {
  const result = await probeMeetingRecorderCodecs({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: FakeMediaRecorder,
    candidates: ['audio/mp4;codecs=mp4a.40.2'],
    durationMs: 0
  });
  assert.deepEqual(result, [{
    requestedMimeType: 'audio/mp4;codecs=mp4a.40.2',
    supported: true,
    actualMimeType: 'audio/mp4;codecs=mp4a.40.2',
    encodedBytes: 11
  }]);
});

test('recording becomes active only after MediaRecorder start and flushes a final segment on stop', async () => {
  FakeMediaRecorder.startError = null;
  const stream = new FakeStream();
  const devices = mediaDevices(stream);
  const segments = [];
  const started = [];
  const controller = createMeetingRecorderController({
    mediaDevices: devices,
    MediaRecorderImpl: FakeMediaRecorder,
    documentImpl: documentHarness(),
    onStarted: (value) => started.push(value),
    onSegment: async (value) => segments.push(value)
  });

  const startResult = await controller.start();
  assert.equal(startResult.actualStarted, true);
  assert.equal(controller.status, 'recording');
  assert.equal(started.length, 1);
  assert.equal(devices.calls, 1);

  await controller.stop();
  assert.equal(controller.status, 'idle');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].blob.size > 0, true);
  assert.equal(stream.track.stopped, true);
});

test('permission, missing device, and start failures never report recording', async () => {
  const permissionDevices = { async getUserMedia() { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; } };
  const permissionController = createMeetingRecorderController({ mediaDevices: permissionDevices, MediaRecorderImpl: FakeMediaRecorder });
  await assert.rejects(permissionController.start(), (error) => error.code === 'MEDIA_PERMISSION_DENIED');
  assert.equal(permissionController.status, 'idle');

  FakeMediaRecorder.startError = new Error('cannot start');
  const startController = createMeetingRecorderController({ mediaDevices: mediaDevices(new FakeStream()), MediaRecorderImpl: FakeMediaRecorder });
  await assert.rejects(startController.start(), (error) => error.code === 'MEDIA_RECORDER_START_FAILED');
  assert.equal(startController.status, 'idle');
  FakeMediaRecorder.startError = null;
});

test('unsupported iOS is rejected before microphone acquisition', async () => {
  const devices = mediaDevices(new FakeStream());
  const controller = createMeetingRecorderController({
    mediaDevices: devices,
    MediaRecorderImpl: FakeMediaRecorder,
    preRecordErrorCode: 'IOS_BROWSER_UNSUPPORTED'
  });

  await assert.rejects(controller.start(), (error) => error.code === 'IOS_BROWSER_UNSUPPORTED');
  assert.equal(devices.calls, 0);
  assert.equal(controller.status, 'idle');
});

test('visibility interruption flushes before notifying and never auto-resumes', async () => {
  const stream = new FakeStream();
  const documentImpl = documentHarness();
  const events = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: FakeMediaRecorder,
    documentImpl,
    onSegment: async () => events.push('segment'),
    onInterrupted: async ({ reason }) => events.push(`interrupted:${reason}`)
  });

  await controller.start();
  documentImpl.hidden = true;
  documentImpl.emit('visibilitychange');
  for (let attempt = 0; attempt < 20 && events.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.deepEqual(events, ['segment', 'interrupted:page_hidden']);
  assert.equal(controller.status, 'idle');
});

test('interrupt is idempotent and explicit start is required to record again', async () => {
  const devices = mediaDevices(new FakeStream());
  const interruptions = [];
  const controller = createMeetingRecorderController({
    mediaDevices: devices,
    MediaRecorderImpl: FakeMediaRecorder,
    onInterrupted: async () => interruptions.push(true)
  });

  await controller.start();
  await controller.interrupt('incoming_call');
  await controller.interrupt('incoming_call');
  assert.equal(interruptions.length, 1);
  assert.equal(devices.calls, 1);
  await assert.rejects(controller.start(), (error) => error.code === 'RESUME_CONFIRMATION_REQUIRED');
  await controller.start({ explicitResume: true });
  assert.equal(devices.calls, 2);
  assert.equal(controller.status, 'recording');
});

test('stop waits for a final dataavailable callback that arrives after onstop', async () => {
  const segments = [];
  let releaseSegment;
  let segmentStarted = false;
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: LateDataMediaRecorder,
    onSegment: async (value) => {
      segmentStarted = true;
      await new Promise((resolve) => { releaseSegment = resolve; });
      segments.push(value);
    }
  });

  await controller.start();
  let settled = false;
  const stopPromise = controller.stop().then(() => { settled = true; });
  for (let attempt = 0; attempt < 40 && !segmentStarted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(segmentStarted, true);
  assert.equal(settled, false);
  releaseSegment();
  await stopPromise;
  assert.equal(segments.length, 1);
  assert.equal(segments[0].blob.size > 0, true);
});

test('stop requests exactly one final data flush', async () => {
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: LateDataMediaRecorder
  });

  await controller.start();
  await controller.stop();

  assert.equal(LateDataMediaRecorder.latest.requestDataCalls, 1);
});

test('requestData persistence completes before stop is called for WebM', async () => {
  TwoPhaseFinalMediaRecorder.mode = 'request-and-stop-audio';
  const stream = new FakeStream();
  const segments = [];
  let releasePersistence;
  let persistenceStarted;
  let persistenceCalls = 0;
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: TwoPhaseFinalMediaRecorder,
    onSegment: async (segment) => {
      persistenceCalls += 1;
      if (persistenceCalls === 1) {
        persistenceStarted?.();
        await new Promise((resolve) => { releasePersistence = resolve; });
      }
      segments.push(segment);
    }
  });

  await controller.start();
  const started = new Promise((resolve) => { persistenceStarted = resolve; });
  const stopPromise = controller.stop();
  try {
    await started;
    assert.equal(TwoPhaseFinalMediaRecorder.latest.stopCalls, 0);
    releasePersistence();
  await stopPromise;
  assert.equal(TwoPhaseFinalMediaRecorder.latest.stopCalls, 1);
  assert.equal(segments.length, 2);
  assert.equal(segments.every((segment) => segment.blob.size > 0), true);
  assert.equal(segments.every((segment) => segment.durationMs > 0), true);
  assert.deepEqual(segments.map((segment) => segment.chunkToken.replace(/^recorder-\d+-/, '')), ['0', '1']);
  assert.equal(stream.track.stopped, true);
  } finally {
    releasePersistence?.();
    await stopPromise.catch(() => {});
  }
});

test('requestData empty event is followed by a stop-phase audio chunk for AAC', async () => {
  TwoPhaseFinalMediaRecorder.mode = 'empty-request-then-stop-audio';
  const segments = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: TwoPhaseFinalMediaRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    onSegment: async (segment) => segments.push(segment)
  });

  const started = await controller.start();
  await controller.stop();
  assert.equal(started.mimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(TwoPhaseFinalMediaRecorder.latest.stopCalledBeforeRequestDataEvent, false);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].blob.type, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(segments[0].blob.size > 0, true);
});

test('AAC normal requestData and stop events preserve ordered non-empty chunks', async () => {
  TwoPhaseFinalMediaRecorder.mode = 'request-and-stop-audio';
  const segments = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: TwoPhaseFinalMediaRecorder,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    now: () => '2026-08-11T00:00:00.000Z',
    onSegment: async (segment) => segments.push(segment)
  });

  await controller.start();
  await controller.stop();
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((segment) => segment.chunkToken.replace(/^recorder-\d+-/, '')), ['0', '1']);
  assert.equal(segments.every((segment) => segment.blob.type === 'audio/mp4;codecs=mp4a.40.2'), true);
  assert.equal(segments.every((segment) => segment.blob.size > 0 && segment.durationMs > 0), true);
  assert.deepEqual(segments.map((segment) => segment.durationMs), [1, 1]);
});

test('a queued timeslice is drained before requestData and the later stop chunk is retained', async () => {
  const segments = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: PrequeuedTimesliceMediaRecorder,
    stopTimeoutMs: 500,
    onSegment: async (segment) => segments.push(segment)
  });

  await controller.start();
  queueMicrotask(() => PrequeuedTimesliceMediaRecorder.latest.emitChunk('prequeued-timeslice'));
  await controller.stop();

  assert.equal(PrequeuedTimesliceMediaRecorder.latest.requestDataCalls, 1);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((segment) => segment.blob.size), [19, 18, 16]);
  assert.deepEqual(segments.map((segment) => segment.chunkToken.replace(/^recorder-\d+-/, '')), ['0', '1', '2']);
  assert.equal(segments.every((segment) => segment.durationMs > 0), true);
});

test('stop event before a stop-phase audio chunk still commits the chunk', async () => {
  TwoPhaseFinalMediaRecorder.mode = 'stop-then-audio';
  const segments = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: TwoPhaseFinalMediaRecorder,
    onSegment: async (segment) => segments.push(segment)
  });

  await controller.start();
  await controller.stop();
  assert.equal(segments.length, 2);
  assert.equal(segments.every((segment) => segment.blob.size > 0), true);
});

test('two empty dataavailable events preserve the session as finalization pending', async () => {
  TwoPhaseFinalMediaRecorder.mode = 'empty-both';
  const stream = new FakeStream();
  const interrupted = [];
  const segments = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: TwoPhaseFinalMediaRecorder,
    stopTimeoutMs: 5,
    onSegment: async (segment) => segments.push(segment),
    onInterrupted: async (value) => interrupted.push(value)
  });

  await controller.start();
  await controller.interrupt('user_pause');
  assert.equal(controller.status, 'idle');
  assert.equal(segments.length, 0);
  assert.equal(interrupted.length, 1);
  assert.equal(stream.track.stopped, true);
});

test('pause path notifies interruption only after a non-empty final chunk is committed', async () => {
  TwoPhaseFinalMediaRecorder.mode = 'empty-request-then-stop-audio';
  const events = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: TwoPhaseFinalMediaRecorder,
    onSegment: async (segment) => events.push(`segment:${segment.blob.size}`),
    onInterrupted: async ({ reason }) => events.push(`interrupted:${reason}`)
  });

  await controller.start();
  await controller.interrupt('user_pause');
  assert.deepEqual(events, ['segment:10', 'interrupted:user_pause']);
});

test('requestData failure marks finalization pending and still attempts stop', async () => {
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: RequestDataFailureMediaRecorder,
    stopTimeoutMs: 5
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_REQUEST_DATA_FAILED');
  assert.equal(RequestDataFailureMediaRecorder.latest.stopCalls, 1);
});

test('missing pause fence preserves durable source as finalization pending', async () => {
  const stream = new FakeStream();
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: NoPauseMediaRecorder
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_FINAL_FENCE_UNAVAILABLE');
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
  assert.equal(TwoPhaseFinalMediaRecorder.latest.stopCalls, 1);
});

test('pause fence timeout remains distinct from stop timeout while preserving audio', async () => {
  const stream = new FakeStream();
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: PauseTimeoutMediaRecorder,
    stopTimeoutMs: 5
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_FINAL_FENCE_TIMEOUT');
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
  assert.equal(TwoPhaseFinalMediaRecorder.latest.stopCalls, 1);
});

test('an asynchronous recorder error during the final fence preserves finalization pending', async () => {
  const stream = new FakeStream();
  const errors = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: PauseErrorMediaRecorder,
    stopTimeoutMs: 100,
    onError: (error) => errors.push(error)
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_FAKE_FINAL_ERROR');
  assert.equal(PauseErrorMediaRecorder.latest.stopCalls, 1);
  assert.deepEqual(errors.map((error) => error.code), ['MEDIA_RECORDER_FAKE_FINAL_ERROR']);
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
});

test('an asynchronous recorder error preserves finalization pending without waiting for another event', async () => {
  const stream = new FakeStream();
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: PauseErrorOnlyMediaRecorder,
    stopTimeoutMs: 100
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_ASYNC_ONLY_ERROR');
  assert.equal(PauseErrorOnlyMediaRecorder.latest.stopCalls, 1);
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
});

test('lifecycle final-flush errors are reported once', async () => {
  const stream = new FakeStream();
  const documentImpl = documentHarness();
  const errors = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(stream),
    MediaRecorderImpl: PauseErrorOnlyMediaRecorder,
    documentImpl,
    stopTimeoutMs: 100,
    onError: (error) => errors.push(error)
  });

  await controller.start();
  documentImpl.hidden = true;
  documentImpl.emit('visibilitychange');
  for (let attempt = 0; attempt < 20 && errors.length < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.deepEqual(errors.map((error) => error.code), ['MEDIA_RECORDER_ASYNC_ONLY_ERROR']);
  assert.equal(controller.status, 'idle');
  assert.equal(stream.track.stopped, true);
});

test('persistence failure preserves the persistence error while finalization remains pending', async () => {
  TwoPhaseFinalMediaRecorder.mode = 'request-and-stop-audio';
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: TwoPhaseFinalMediaRecorder,
    onSegment: async () => {
      const error = new Error('persist failed');
      error.code = 'SEGMENT_PERSISTENCE_FAILED';
      throw error;
    }
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'SEGMENT_PERSISTENCE_FAILED');
  assert.equal(TwoPhaseFinalMediaRecorder.latest.stopCalls, 1);
});

test('stop failure is reported without invalidating the durable source', async () => {
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: StopFailureMediaRecorder,
    stopTimeoutMs: 100
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_STOP_FAILED');
  assert.equal(controller.status, 'idle');
});

test('stop timeout remains bounded by stopTimeoutMs and preserves finalization pending', async () => {
  TwoPhaseFinalMediaRecorder.mode = 'stop-timeout';
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: TwoPhaseFinalMediaRecorder,
    stopTimeoutMs: 5
  });

  await controller.start();
  const result = await controller.stop();
  assert.equal(result.finalizationPending, true);
  assert.equal(result.finalizationErrorCode, 'MEDIA_RECORDER_STOP_TIMEOUT');
  assert.equal(controller.status, 'idle');
});

test('late callbacks from an old recorder generation are ignored after explicit resume', async () => {
  const segments = [];
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: StaleCallbackMediaRecorder,
    onSegment: async (value) => segments.push(value)
  });

  await controller.start();
  const oldRecorder = StaleCallbackMediaRecorder.instances[0];
  await controller.interrupt('page_hidden');
  assert.equal(segments.length, 1);
  await controller.start({ explicitResume: true });
  oldRecorder.emitChunk('stale-audio');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(segments.length, 1);
  await controller.stop();
});

test('visibilitychange and pagehide share one final flush and one interruption', async () => {
  const documentImpl = documentHarness();
  const windowImpl = documentHarness();
  let interruptions = 0;
  const controller = createMeetingRecorderController({
    mediaDevices: mediaDevices(new FakeStream()),
    MediaRecorderImpl: FakeMediaRecorder,
    documentImpl,
    windowImpl,
    onInterrupted: async () => { interruptions += 1; }
  });

  await controller.start();
  documentImpl.hidden = true;
  documentImpl.emit('visibilitychange');
  windowImpl.emit('pagehide');
  for (let attempt = 0; attempt < 20 && interruptions < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(interruptions, 1);
  assert.equal(controller.status, 'idle');
});

test('concurrent explicit resume calls create only one new recorder', async () => {
  const devices = mediaDevices(new FakeStream());
  const controller = createMeetingRecorderController({
    mediaDevices: devices,
    MediaRecorderImpl: FakeMediaRecorder
  });

  await controller.start();
  await controller.interrupt('page_hidden');
  await Promise.all([
    controller.start({ explicitResume: true }),
    controller.start({ explicitResume: true })
  ]);

  assert.equal(devices.calls, 2);
  await controller.stop();
});
