import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingRecorderRotationCoordinator } from './meetingRecorderRotationCoordinator.js';

const AAC_MIME = 'audio/mp4;codecs=mp4a.40.2';
const LAYOUT = 'independent-mp4-segments-v1';
const UNIT_MS = 12_000;

class ManualTimers {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout = (callback, delayMs = 0) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delayMs });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  async fireRotation() {
    const match = [...this.tasks.entries()].find(([, task]) => task.delayMs === UNIT_MS);
    assert.ok(match, 'rotation timer missing');
    const [id, task] = match;
    this.tasks.delete(id);
    this.now += UNIT_MS;
    task.callback();
    await drain();
  }
}

async function drain() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function logical(captureEpoch) {
  return Object.freeze({
    meetingId: 'meeting-resume-gap',
    sourceId: 'recorded-meeting-resume-gap',
    recordingAttemptId: 'attempt-resume-gap',
    captureEpoch,
    containerLayout: LAYOUT
  });
}

function sealed(identity) {
  const bytes = Uint8Array.of(identity.captureOrdinal + 1, 2, 3);
  return Object.freeze({
    state: 'SEALED',
    identity,
    blob: new Blob([bytes], { type: AAC_MIME }),
    bytes,
    inspection: { durationMs: UNIT_MS },
    startedAt: '2026-08-18T00:00:00.000Z',
    endedAt: '2026-08-18T00:00:12.000Z',
    durationMs: UNIT_MS,
    mimeType: AAC_MIME,
    containerLayout: LAYOUT,
    partCount: 1,
    byteLength: bytes.byteLength,
    checksum: 'a'.repeat(64)
  });
}

test('refreshes the microphone stream before the first post-resume AAC rotation', async () => {
  const timers = new ManualTimers();
  const log = [];
  let nextOrdinal = 0;
  let sequence = 0;
  let committedDurationMs = 0;
  let acquiredStreams = 0;
  let resumedStream = null;
  const stoppedStreams = [];

  const persistence = {
    async reserveCaptureUnit(input) {
      const captureOrdinal = nextOrdinal++;
      return {
        captureOrdinal,
        captureUnitId: `unit-${captureOrdinal}`,
        chunkToken: `token-${captureOrdinal}`,
        captureEpoch: input.captureEpoch,
        recordingAttemptId: input.recordingAttemptId
      };
    },
    async stagePendingCaptureUnit({ unit }) {
      log.push(`stage:${unit.identity.captureOrdinal}`);
      return { journalId: `journal-${unit.identity.captureOrdinal}` };
    },
    async commitPendingCaptureUnit({ journalId }) {
      const captureOrdinal = Number(journalId.split('-').at(-1));
      committedDurationMs += UNIT_MS;
      log.push(`commit:${captureOrdinal}`);
      return {
        segment: { sequence: sequence++ },
        meeting: { committedDurationMs },
        manifest: { revision: sequence }
      };
    },
    async recordCaptureDiscontinuity({ captureOrdinal, errorCode }) {
      log.push(`gap:${captureOrdinal}:${errorCode}`);
      return { captureOrdinal, errorCode };
    },
    async replayPendingCaptureUnits() {
      return { committedCount: 0 };
    },
    async finalizeCaptureManifest() {
      return { finalized: true, finalizationPending: false };
    }
  };

  const streams = [];
  const mediaDevices = {
    async getUserMedia() {
      const stream = {
        id: `stream-${++acquiredStreams}`,
        getTracks() {
          return [{
            stop() {
              if (!stoppedStreams.includes(stream.id)) stoppedStreams.push(stream.id);
            }
          }];
        }
      };
      streams.push(stream);
      if (acquiredStreams === 2) resumedStream = stream;
      return stream;
    }
  };

  const captureUnitFactory = ({ identity, stream }) => {
    let state = 'CREATED';
    const shouldFailOnReusedPostResumeStream = (
      identity.captureEpoch === 1
      && identity.captureOrdinal === 3
      && stream === resumedStream
    );
    return {
      identity,
      async start() {
        state = 'RECORDING';
      },
      requestStop() {
        if (state !== 'RECORDING') {
          return Promise.reject(Object.assign(new Error('CAPTURE_UNIT_STOP_FAILED'), {
            code: 'CAPTURE_UNIT_STOP_FAILED'
          }));
        }
        state = 'SEALED';
        if (shouldFailOnReusedPostResumeStream) {
          return Promise.reject(Object.assign(new Error('CAPTURE_UNIT_EMPTY_BLOB'), {
            code: 'CAPTURE_UNIT_EMPTY_BLOB'
          }));
        }
        return Promise.resolve(sealed(identity));
      },
      dispose() {
        if (state !== 'SEALED') state = 'STALE';
      },
      getSnapshot() {
        return { state, identity };
      }
    };
  };

  const coordinator = createMeetingRecorderRotationCoordinator({
    mediaDevices,
    mimeType: AAC_MIME,
    pageEpoch: 'page-resume-gap',
    recorderGeneration: 314,
    captureUnitFactory,
    capturePersistencePort: persistence,
    captureUnitMs: UNIT_MS,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    monotonicNow: () => timers.now,
    now: () => new Date(Date.parse('2026-08-18T00:00:00.000Z') + timers.now).toISOString(),
    onCheckpointTrace(trace) {
      log.push(`trace:${trace.event}`);
    }
  });

  await coordinator.start(logical(0));
  await coordinator.pause();
  await coordinator.resume(logical(1));

  await timers.fireRotation();
  await eventually(
    () => log.includes('commit:2'),
    `resumed capture unit did not commit: ${JSON.stringify(log)}`
  );
  await timers.fireRotation();
  await coordinator.stop({ reason: 'user_stop' });

  assert.equal(log.some((entry) => entry.startsWith('gap:2:')), false);
  assert.equal(
    coordinator.getSnapshot().lastCommittedDurationMs,
    UNIT_MS * 4,
    JSON.stringify({ log, acquiredStreams, stoppedStreams })
  );
  assert.equal(acquiredStreams, 3);
  assert.deepEqual(stoppedStreams, ['stream-1', 'stream-2', 'stream-3']);
  assert.equal(streams[2].id, 'stream-3');
});
