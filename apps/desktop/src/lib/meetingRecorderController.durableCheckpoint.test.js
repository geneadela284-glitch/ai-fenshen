import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMeetingRecorderController } from './meetingRecorderController.js';

class RequestOnlyRecorder {
  static latest = null;

  constructor(_stream, options = {}) {
    this.mimeType = options.mimeType || 'audio/mp4;codecs=mp4a.40.2';
    this.state = 'inactive';
    this.requestDataCalls = 0;
    this.onstart = null;
    this.ondataavailable = null;
    this.onpause = null;
    this.onstop = null;
    RequestOnlyRecorder.latest = this;
  }

  start(timeslice) {
    this.timeslice = timeslice;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  pause() {
    this.state = 'paused';
    queueMicrotask(() => this.onpause?.());
  }

  requestData() {
    this.requestDataCalls += 1;
    queueMicrotask(() => this.ondataavailable?.({
      data: new Blob([`checkpoint-${this.requestDataCalls}`], { type: this.mimeType })
    }));
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => this.ondataavailable?.({
      data: new Blob(['final'], { type: this.mimeType })
    }));
    queueMicrotask(() => this.onstop?.());
  }
}

function devices() {
  return { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } };
}

async function eventually(predicate, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition did not settle');
}

test('20-minute equivalent periodic checkpoints persist request-only recorder chunks and serialize in-flight work', async () => {
  const ticks = [];
  const statuses = [];
  let clock = Date.parse('2026-08-14T10:00:00.000Z');
  let committedDurationMs = 0;
  const committed = [];
  const controller = createMeetingRecorderController({
    mediaDevices: devices(),
    MediaRecorderImpl: RequestOnlyRecorder,
    now: () => new Date(clock).toISOString(),
    checkpointIntervalMs: 12_000,
    persistenceStallTimeoutMs: 30_000,
    checkpointEventTimeoutMs: 100,
    setIntervalImpl: (callback) => { ticks.push(callback); return { unref() {} }; },
    clearIntervalImpl: () => {},
    onSegment: async (payload) => {
      committedDurationMs += payload.durationMs;
      committed.push(payload);
      return { meeting: { committedDurationMs }, segment: { sequence: committed.length - 1 } };
    },
    onPersistenceStatus: async (status) => statuses.push(status)
  });

  await controller.start();
  assert.equal(ticks.length, 1);
  for (let index = 0; index < 100; index += 1) {
    clock += 12_000;
    ticks[0]();
    await eventually(() => statuses.filter((status) => status.phase === 'checkpoint_success').length >= index + 1);
  }

  assert.equal(RequestOnlyRecorder.latest.requestDataCalls, 100);
  assert.equal(committed.length, 100);
  assert.equal(committedDurationMs >= 1_200_000, true);
  assert.equal(statuses.some((status) => status.phase === 'stalled'), false);
  await controller.stop();
  assert.equal(controller.status, 'idle');
});
test('persistence watchdog reports a stalled recording without converting it into a silent success', async () => {
  const ticks = [];
  const statuses = [];
  let clock = Date.parse('2026-08-14T10:00:00.000Z');
  class SilentRecorder extends RequestOnlyRecorder {
    requestData() { this.requestDataCalls += 1; }
  }
  const controller = createMeetingRecorderController({
    mediaDevices: devices(),
    MediaRecorderImpl: SilentRecorder,
    now: () => new Date(clock).toISOString(),
    checkpointIntervalMs: 10_000,
    persistenceStallTimeoutMs: 20_000,
    checkpointEventTimeoutMs: 1,
    setIntervalImpl: (callback) => { ticks.push(callback); return { unref() {} }; },
    clearIntervalImpl: () => {},
    onPersistenceStatus: async (status) => statuses.push(status)
  });
  await controller.start();
  clock += 25_000;
  ticks[0]();
  await eventually(() => statuses.some((status) => status.phase === 'stalled'));
  assert.equal(statuses.find((status) => status.phase === 'stalled').errorCode, 'RECORDING_PERSISTENCE_STALLED');
  await controller.stop().catch(() => {});
  assert.equal(controller.status, 'idle');
});

test('checkpoint trace survives a failed request and records the next successful checkpoint', async () => {
  const ticks = [];
  const statuses = [];
  const traces = [];
  let clock = Date.parse('2026-08-14T10:00:00.000Z');
  class IntermittentRecorder extends RequestOnlyRecorder {
    requestData() {
      this.requestDataCalls += 1;
      if (this.requestDataCalls === 2) return;
      queueMicrotask(() => this.ondataavailable?.({
        data: new Blob([`checkpoint-${this.requestDataCalls}`], { type: this.mimeType })
      }));
    }
  }
  const controller = createMeetingRecorderController({
    mediaDevices: devices(),
    MediaRecorderImpl: IntermittentRecorder,
    now: () => new Date(clock).toISOString(),
    checkpointIntervalMs: 10_000,
    checkpointEventTimeoutMs: 1,
    setIntervalImpl: (callback) => { ticks.push(callback); return { unref() {} }; },
    clearIntervalImpl: () => {},
    onSegment: async (payload) => ({
      meeting: { committedDurationMs: payload.durationMs },
      segment: { sequence: 0 }
    }),
    onPersistenceStatus: async (status) => statuses.push(status),
    onCheckpointTrace: async (trace) => traces.push(trace)
  });

  await controller.start();
  clock += 10_000;
  ticks[0]();
  await eventually(() => statuses.some((status) => status.phase === 'checkpoint_success'));
  clock += 10_000;
  ticks[0]();
  await eventually(() => statuses.some((status) => status.phase === 'checkpoint_failed'));
  clock += 10_000;
  ticks[0]();
  await eventually(() => statuses.filter((status) => status.phase === 'checkpoint_success').length >= 2);

  assert.equal(traces.some((trace) => trace.event === 'checkpoint_requested'), true);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_failed' && trace.errorCode === 'RECORDING_CHECKPOINT_DATA_TIMEOUT'), true);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_succeeded' && trace.dataavailableAt && trace.commitCompletedAt), true);
  assert.equal(traces.every((trace) => !Object.hasOwn(trace, 'blob') && !Object.hasOwn(trace, 'data')), true);
  await controller.stop();
});

test('requestData and commit failures are classified, then the scheduler continues', async () => {
  const ticks = [];
  const statuses = [];
  const traces = [];
  class FailureRecorder extends RequestOnlyRecorder {
    requestData() {
      this.requestDataCalls += 1;
      if (this.requestDataCalls === 1) throw new Error('request failed');
      queueMicrotask(() => this.ondataavailable?.({
        data: new Blob([`checkpoint-${this.requestDataCalls}`], { type: this.mimeType })
      }));
    }
  }
  let commitCalls = 0;
  const controller = createMeetingRecorderController({
    mediaDevices: devices(),
    MediaRecorderImpl: FailureRecorder,
    checkpointIntervalMs: 10_000,
    checkpointEventTimeoutMs: 20,
    setIntervalImpl: (callback) => { ticks.push(callback); return { unref() {} }; },
    clearIntervalImpl: () => {},
    onSegment: async (payload) => {
      commitCalls += 1;
      if (commitCalls === 1) throw Object.assign(new Error('commit failed'), { code: 'INDEXEDDB_COMMIT_FAILED' });
      return { meeting: { committedDurationMs: payload.durationMs }, segment: { sequence: 0 } };
    },
    onPersistenceStatus: async (status) => statuses.push(status),
    onCheckpointTrace: async (trace) => traces.push(trace)
  });
  await controller.start();
  ticks[0]();
  await eventually(() => traces.some((trace) => trace.errorCode === 'RECORDING_CHECKPOINT_REQUEST_DATA_FAILED'));
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_run_settled'));
  ticks[0]();
  await eventually(() => traces.some((trace) => trace.errorCode === 'INDEXEDDB_COMMIT_FAILED'));
  await eventually(() => traces.filter((trace) => trace.event === 'checkpoint_run_settled').length >= 2);
  ticks[0]();
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_succeeded'));
  assert.equal(statuses.filter((status) => status.phase === 'checkpoint_success').length, 1);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_failed' && trace.errorCode === 'RECORDING_CHECKPOINT_REQUEST_DATA_FAILED'), true);
  assert.equal(traces.some((trace) => trace.event === 'checkpoint_failed' && trace.errorCode === 'INDEXEDDB_COMMIT_FAILED'), true);
  await controller.stop().catch(() => {});
});

test('empty and delayed dataavailable events remain distinguishable from a timeout', async () => {
  const ticks = [];
  const traces = [];
  class EmptyThenDataRecorder extends RequestOnlyRecorder {
    requestData() {
      this.requestDataCalls += 1;
      queueMicrotask(() => this.ondataavailable?.({ data: new Blob([], { type: this.mimeType }) }));
      if (this.requestDataCalls > 1) {
        queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['non-empty'], { type: this.mimeType }) }));
      }
    }
  }
  const controller = createMeetingRecorderController({
    mediaDevices: devices(),
    MediaRecorderImpl: EmptyThenDataRecorder,
    checkpointEventTimeoutMs: 5,
    setIntervalImpl: (callback) => { ticks.push(callback); return { unref() {} }; },
    clearIntervalImpl: () => {},
    onSegment: async (payload) => ({ meeting: { committedDurationMs: payload.durationMs }, segment: { sequence: 0 } }),
    onCheckpointTrace: async (trace) => traces.push(trace)
  });
  await controller.start();
  ticks[0]();
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_dataavailable' && trace.empty === true));
  await eventually(() => traces.some((trace) => trace.errorCode === 'RECORDING_CHECKPOINT_DATA_TIMEOUT'));
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_run_settled'));
  ticks[0]();
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_succeeded'));
  await controller.stop();
});

test('a dataavailable event that arrives after timeout is retained as late checkpoint evidence', async () => {
  const ticks = [];
  const traces = [];
  let releaseData = null;
  class DelayedRecorder extends RequestOnlyRecorder {
    requestData() {
      this.requestDataCalls += 1;
      releaseData = () => this.ondataavailable?.({
        data: new Blob(['late-checkpoint'], { type: this.mimeType })
      });
    }
  }
  const controller = createMeetingRecorderController({
    mediaDevices: devices(),
    MediaRecorderImpl: DelayedRecorder,
    checkpointEventTimeoutMs: 1,
    setIntervalImpl: (callback) => { ticks.push(callback); return { unref() {} }; },
    clearIntervalImpl: () => {},
    onSegment: async (payload) => ({ meeting: { committedDurationMs: payload.durationMs }, segment: { sequence: 0 } }),
    onCheckpointTrace: async (trace) => traces.push(trace)
  });
  await controller.start();
  ticks[0]();
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_failed' && trace.errorCode === 'RECORDING_CHECKPOINT_DATA_TIMEOUT'));
  assert.equal(typeof releaseData, 'function');
  releaseData();
  await eventually(() => traces.some((trace) => trace.event === 'checkpoint_dataavailable_late'));
  const late = traces.find((trace) => trace.event === 'checkpoint_dataavailable_late');
  assert.equal(late.late, true);
  assert.equal(late.blobSize > 0, true);
  assert.equal(typeof late.checkpointId, 'string');
  await controller.stop().catch(() => {});
});
