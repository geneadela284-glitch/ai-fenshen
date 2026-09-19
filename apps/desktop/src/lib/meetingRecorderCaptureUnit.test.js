import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingRecorderCaptureUnit } from './meetingRecorderCaptureUnit.js';

class ScriptedRecorder {
  static instances = [];
  static nextScript = {};

  constructor(_stream, options = {}) {
    this.mimeType = options.mimeType || 'audio/mp4;codecs=mp4a.40.2';
    this.state = 'inactive';
    this.script = ScriptedRecorder.nextScript;
    this.startCalls = [];
    this.stopCalls = 0;
    this.requestDataCalls = 0;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    ScriptedRecorder.instances.push(this);
  }

  start(...args) {
    this.startCalls.push(args);
    if (this.script.startThrows) throw new Error('start failed');
    this.state = 'recording';
    if (this.script.startEvent !== false) queueMicrotask(() => this.onstart?.());
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

  stop() {
    this.stopCalls += 1;
    if (this.script.stopThrows) throw new Error('stop failed');
    this.state = 'inactive';
    for (const event of this.script.events || []) {
      const deliver = () => {
        if (event.type === 'data') {
          const parts = event.parts || [event.bytes || Uint8Array.of(1, 2, 3)];
          for (const value of parts) {
            this.ondataavailable?.({
              data: new Blob([value], { type: this.mimeType })
            });
          }
        } else if (event.type === 'empty') {
          this.ondataavailable?.({ data: new Blob([], { type: this.mimeType }) });
        } else if (event.type === 'stop') {
          this.onstop?.();
        } else if (event.type === 'error') {
          this.onerror?.({ error: Object.assign(new Error('runtime failure'), { code: event.code }) });
        }
      };
      if (event.delayMs) setTimeout(deliver, event.delayMs);
      else queueMicrotask(deliver);
    }
  }
}

function identity(overrides = {}) {
  return Object.freeze({
    pageEpoch: 'page-1',
    recorderGeneration: 7,
    captureEpoch: 2,
    captureOrdinal: 9,
    captureUnitId: 'capture-unit-9',
    chunkToken: 'chunk-token-9',
    ...overrides
  });
}

function inspectContainer(bytes) {
  if (bytes[0] === 0xff) {
    const error = new Error('invalid container');
    error.code = 'INDEPENDENT_MP4_MEDIA_INVALID';
    throw error;
  }
  return Object.freeze({
    initBytes: bytes.slice(0, 1),
    mediaBytes: bytes.slice(1),
    timescale: 48_000,
    trackId: 1,
    trackFingerprint: 'audio:test',
    fragmentCount: 1,
    firstDecodeTime: 0,
    durationTicks: 576_000,
    durationMs: 12_000
  });
}

function createUnit({ script, monotonic, traces = [], unitIdentity = identity(), sealTimeoutMs = 30 } = {}) {
  ScriptedRecorder.nextScript = script || {
    events: [{ type: 'data' }, { type: 'stop' }]
  };
  return createMeetingRecorderCaptureUnit({
    MediaRecorderImpl: ScriptedRecorder,
    stream: { getTracks: () => [] },
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    identity: unitIdentity,
    inspectContainer,
    now: () => '2026-08-15T10:00:00.000Z',
    monotonicNow: monotonic || (() => 0),
    sealTimeoutMs,
    maxSegmentBytes: 1_024,
    onTrace(trace) {
      traces.push(trace);
    }
  });
}

test('seals data-before-stop with zero-argument start and no long-lived recorder APIs', async () => {
  ScriptedRecorder.instances = [];
  let mono = 100;
  const unit = createUnit({
    monotonic: () => mono,
    script: { events: [{ type: 'data', bytes: Uint8Array.of(1, 2, 3) }, { type: 'stop' }] }
  });
  await unit.start();
  mono = 12_100;
  const sealed = await unit.requestStop('rotation');
  const recorder = ScriptedRecorder.instances.at(-1);

  assert.equal(sealed.state, 'SEALED');
  assert.equal(sealed.durationMs, 12_000);
  assert.equal(sealed.partCount, 1);
  assert.equal(sealed.byteLength, 3);
  assert.deepEqual(recorder.startCalls, [[]]);
  assert.equal(recorder.stopCalls, 1);
  assert.equal(recorder.requestDataCalls, 0);
  assert.equal(recorder.pauseCalls, 0);
  assert.equal(recorder.resumeCalls, 0);
  assert.equal(recorder.ondataavailable, null);
  assert.equal(recorder.onstop, null);
});

test('accepts stop-before-data and combines multipart data in event order', async () => {
  const unit = createUnit({
    script: {
      events: [
        { type: 'stop' },
        { type: 'data', parts: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)] }
      ]
    }
  });
  await unit.start();
  const sealed = await unit.requestStop('rotation');

  assert.equal(sealed.partCount, 2);
  assert.deepEqual([...sealed.bytes], [1, 2, 3, 4]);
  assert.deepEqual([...new Uint8Array(await sealed.blob.arrayBuffer())], [1, 2, 3, 4]);
});

for (const fixture of [
  {
    name: 'empty-only data',
    script: { events: [{ type: 'empty' }, { type: 'stop' }] },
    code: 'CAPTURE_UNIT_EMPTY_BLOB',
    state: 'EMPTY_BLOB'
  },
  {
    name: 'missing data',
    script: { events: [{ type: 'stop' }] },
    code: 'CAPTURE_UNIT_SEAL_TIMEOUT',
    state: 'SEAL_TIMEOUT'
  },
  {
    name: 'missing stop',
    script: { events: [{ type: 'data' }] },
    code: 'CAPTURE_UNIT_SEAL_TIMEOUT',
    state: 'SEAL_TIMEOUT'
  },
  {
    name: 'invalid MP4',
    script: { events: [{ type: 'data', bytes: Uint8Array.of(0xff, 1) }, { type: 'stop' }] },
    code: 'CAPTURE_UNIT_CONTAINER_INVALID',
    state: 'CONTAINER_INVALID'
  }
]) {
  test(`fails one CaptureUnit exactly for ${fixture.name}`, async () => {
    const unit = createUnit({ script: fixture.script, sealTimeoutMs: 15 });
    await unit.start();
    await assert.rejects(
      unit.requestStop('rotation'),
      (error) => error?.code === fixture.code
    );
    assert.equal(unit.getSnapshot().state, fixture.state);
  });
}

test('maps start and stop call failures without retaining handlers', async () => {
  const startFailure = createUnit({ script: { startThrows: true } });
  await assert.rejects(
    startFailure.start(),
    (error) => error?.code === 'CAPTURE_UNIT_START_FAILED'
  );
  assert.equal(startFailure.getSnapshot().state, 'START_FAILED');

  const stopFailure = createUnit({ script: { stopThrows: true } });
  await stopFailure.start();
  await assert.rejects(
    stopFailure.requestStop('rotation'),
    (error) => error?.code === 'CAPTURE_UNIT_STOP_FAILED'
  );
  const recorder = ScriptedRecorder.instances.at(-1);
  assert.equal(stopFailure.getSnapshot().state, 'STOP_FAILED');
  assert.equal(recorder.ondataavailable, null);
  assert.equal(recorder.onstop, null);
  assert.equal(recorder.onerror, null);
});

test('rejects a preconstructed or successor recorder whose actual MIME is not AAC/MP4', () => {
  const recorder = new ScriptedRecorder({}, { mimeType: 'audio/mp4;codecs=mp4a.40.2' });
  recorder.mimeType = 'audio/webm;codecs=opus';

  assert.throws(
    () => createMeetingRecorderCaptureUnit({
      recorderInstance: recorder,
      stream: { getTracks: () => [] },
      mimeType: 'audio/mp4;codecs=mp4a.40.2',
      identity: identity(),
      inspectContainer
    }),
    (error) => error?.code === 'CAPTURE_UNIT_START_FAILED'
      && error?.cause?.code === 'AAC_PRIMARY_MIME_MISMATCH'
  );
  assert.equal(recorder.state, 'inactive');
  assert.equal(recorder.ondataavailable, undefined);
  assert.equal(recorder.onstop, undefined);
});

test('delayed stop remains inside the terminal barrier and duplicate stop requests share one result', async () => {
  const unit = createUnit({
    script: {
      events: [
        { type: 'data' },
        { type: 'stop', delayMs: 5 }
      ]
    },
    sealTimeoutMs: 30
  });
  await unit.start();
  const first = unit.requestStop('rotation');
  const second = unit.requestStop('duplicate');
  assert.equal(first, second);
  const sealed = await first;
  assert.equal(sealed.state, 'SEALED');
  assert.equal(ScriptedRecorder.instances.at(-1).stopCalls, 1);
});

test('dispose makes captured late callbacks stale and they cannot mutate a successor identity', async () => {
  const traces = [];
  const unit = createUnit({
    traces,
    script: { events: [] },
    unitIdentity: identity({ captureOrdinal: 10, captureUnitId: 'capture-unit-10', chunkToken: 'chunk-token-10' })
  });
  await unit.start();
  const recorder = ScriptedRecorder.instances.at(-1);
  const lateData = recorder.ondataavailable;
  const lateStop = recorder.onstop;
  unit.dispose();
  lateData?.({ data: new Blob([Uint8Array.of(1, 2, 3)], { type: recorder.mimeType }) });
  lateStop?.();

  assert.equal(unit.getSnapshot().state, 'STALE');
  assert.equal(unit.getSnapshot().partCount, 0);
  assert.equal(traces.some((trace) => trace.event === 'capture_unit_event_stale'), true);
});

test('duplicate data and stop events settle once and release every timer and handler', async () => {
  const unit = createUnit({
    script: {
      events: [
        { type: 'data', bytes: Uint8Array.of(1, 2) },
        { type: 'stop' },
        { type: 'stop' }
      ]
    }
  });
  await unit.start();
  const sealed = await unit.requestStop('rotation');
  unit.dispose();

  assert.equal(sealed.partCount, 1);
  assert.equal(unit.getSnapshot().timerArmed, false);
  assert.equal(ScriptedRecorder.instances.at(-1).onstart, null);
  assert.equal(ScriptedRecorder.instances.at(-1).ondataavailable, null);
  assert.equal(ScriptedRecorder.instances.at(-1).onstop, null);
});
