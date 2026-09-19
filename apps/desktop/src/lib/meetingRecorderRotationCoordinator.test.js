import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingRecorderRotationCoordinator } from './meetingRecorderRotationCoordinator.js';

class ManualTimers {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
    this.maxActive = 0;
  }

  setTimeout = (callback, delayMs = 0) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delayMs });
    this.maxActive = Math.max(this.maxActive, this.tasks.size);
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  async fireNext(delayMs = 12_000) {
    const match = [...this.tasks.entries()].find(([, task]) => task.delayMs === delayMs);
    assert.ok(match, `missing ${delayMs}ms timer`);
    const [id, task] = match;
    this.tasks.delete(id);
    this.now += delayMs;
    task.callback();
    await drain();
  }
}

async function drain() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function logicalInput(overrides = {}) {
  return Object.freeze({
    meetingId: 'meeting-rotation',
    sourceId: 'recorded-meeting-rotation',
    recordingAttemptId: 'attempt-rotation',
    captureEpoch: 0,
    containerLayout: 'independent-mp4-segments-v1',
    ...overrides
  });
}

function createPersistence({
  log,
  blockCommits = false,
  initialOrdinal = 0,
  failJournalOrdinals = new Set(),
  failCommitOrdinals = new Set()
} = {}) {
  let nextOrdinal = initialOrdinal;
  let sequence = 0;
  let committedDurationMs = 0;
  let releaseCommit = null;
  const pendingCommit = blockCommits
    ? new Promise((resolve) => { releaseCommit = resolve; })
    : null;
  return {
    get releaseCommit() { return releaseCommit; },
    async reserveCaptureUnit(input) {
      const captureOrdinal = nextOrdinal++;
      log.push(`reserve:${captureOrdinal}:epoch-${input.captureEpoch}`);
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
      if (failJournalOrdinals.has(unit.identity.captureOrdinal)) {
        throw Object.assign(new Error('journal failed'), { code: 'PENDING_SEGMENT_JOURNAL_FAILED' });
      }
      return { journalId: `journal-${unit.identity.captureOrdinal}` };
    },
    async commitPendingCaptureUnit({ journalId }) {
      const ordinal = Number(journalId.split('-').at(-1));
      log.push(`commit-start:${ordinal}`);
      if (failCommitOrdinals.has(ordinal)) {
        throw Object.assign(new Error('commit failed'), { code: 'SEGMENT_ATOMIC_COMMIT_FAILED' });
      }
      if (pendingCommit) await pendingCommit;
      committedDurationMs += 12_000;
      const result = {
        segment: { sequence: sequence++ },
        meeting: { committedDurationMs },
        manifest: { revision: sequence }
      };
      log.push(`commit-end:${ordinal}`);
      return result;
    },
    async recordCaptureDiscontinuity({ captureOrdinal, errorCode }) {
      log.push(`gap:${captureOrdinal}:${errorCode}`);
      return { captureOrdinal, errorCode };
    },
    async replayPendingCaptureUnits() {
      return { committedCount: 0 };
    },
    async finalizeCaptureManifest() {
      log.push('manifest-finalized');
      return { finalized: true, finalizationPending: false };
    }
  };
}

function createCaptureFactory({
  log,
  failures = new Map(),
  startFailures = new Map(),
  deferred = new Map()
} = {}) {
  const units = [];
  const factory = ({ identity }) => {
    let state = 'CREATED';
    let startCalls = 0;
    let stopCalls = 0;
    let resolveDeferred;
    const unit = {
      identity,
      get startCalls() { return startCalls; },
      get stopCalls() { return stopCalls; },
      async start() {
        startCalls += 1;
        log.push(`start:${identity.captureOrdinal}`);
        const startFailureCode = startFailures.get(identity.captureOrdinal);
        if (startFailureCode) {
          state = 'START_FAILED';
          throw Object.assign(new Error(startFailureCode), { code: startFailureCode });
        }
        state = 'RECORDING';
        return { actualStarted: true, identity };
      },
      requestStop(reason) {
        stopCalls += 1;
        state = 'SEALING';
        log.push(`stop:${identity.captureOrdinal}:${reason}`);
        const failureCode = failures.get(identity.captureOrdinal);
        if (failureCode) {
          return Promise.reject(Object.assign(new Error(failureCode), { code: failureCode }));
        }
        if (deferred.has(identity.captureOrdinal)) {
          const promise = new Promise((resolve) => { resolveDeferred = resolve; });
          deferred.set(identity.captureOrdinal, () => {
            state = 'SEALED';
            resolveDeferred(sealed(identity));
          });
          return promise;
        }
        state = 'SEALED';
        return Promise.resolve(sealed(identity));
      },
      dispose() {
        state = state === 'SEALED' ? state : 'STALE';
        log.push(`dispose:${identity.captureOrdinal}`);
      },
      getSnapshot() {
        return { state, identity };
      }
    };
    units.push(unit);
    return unit;
  };
  return { factory, units };
}

function sealed(identity) {
  const bytes = Uint8Array.of(identity.captureOrdinal + 1, 2, 3);
  return Object.freeze({
    state: 'SEALED',
    identity,
    blob: new Blob([bytes], { type: 'audio/mp4;codecs=mp4a.40.2' }),
    bytes,
    inspection: { durationMs: 12_000 },
    startedAt: '2026-08-15T10:00:00.000Z',
    endedAt: '2026-08-15T10:00:12.000Z',
    durationMs: 12_000,
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    containerLayout: 'independent-mp4-segments-v1',
    partCount: 1,
    byteLength: bytes.byteLength,
    checksum: 'a'.repeat(64)
  });
}

function setup({
  failures,
  startFailures,
  deferred,
  blockCommits = false,
  initialOrdinal = 0,
  failJournalOrdinals,
  failCommitOrdinals
} = {}) {
  const log = [];
  const timers = new ManualTimers();
  const capture = createCaptureFactory({ log, failures, startFailures, deferred });
  const persistence = createPersistence({
    log,
    blockCommits,
    initialOrdinal,
    failJournalOrdinals,
    failCommitOrdinals
  });
  let acquiredStreams = 0;
  let stoppedTracks = 0;
  const coordinator = createMeetingRecorderRotationCoordinator({
    mediaDevices: {
      async getUserMedia() {
        acquiredStreams += 1;
        return {
          getTracks() {
            return [{ stop() { stoppedTracks += 1; } }];
          }
        };
      }
    },
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    pageEpoch: 'page-coordinator',
    recorderGeneration: 11,
    captureUnitFactory: capture.factory,
    capturePersistencePort: persistence,
    captureUnitMs: 12_000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    monotonicNow: () => timers.now,
    now: () => new Date(Date.parse('2026-08-15T10:00:00.000Z') + timers.now).toISOString(),
    onCheckpointTrace(trace) {
      log.push(`trace:${trace.event}`);
    }
  });
  return {
    coordinator,
    log,
    timers,
    units: capture.units,
    persistence,
    resources: () => ({ acquiredStreams, stoppedTracks })
  };
}

test('a failed initial CaptureUnit start closes its reserved ordinal before a retry can commit', async () => {
  const fixture = setup({
    startFailures: new Map([[0, 'CAPTURE_UNIT_START_FAILED']])
  });

  await assert.rejects(
    fixture.coordinator.start(logicalInput()),
    (error) => error?.code === 'CAPTURE_UNIT_START_FAILED'
  );
  await eventually(
    () => fixture.log.includes('gap:0:CAPTURE_UNIT_START_FAILED'),
    'failed initial reservation was not closed'
  );

  assert.equal(fixture.log.includes('dispose:0'), true);
  assert.equal(fixture.coordinator.getSnapshot().activeUnitCount, 0);
  assert.equal(fixture.coordinator.getSnapshot().streamActive, false);
  assert.equal(fixture.resources().stoppedTracks, 1);

  await fixture.coordinator.start(logicalInput());
  await fixture.timers.fireNext();
  await eventually(() => fixture.log.includes('commit-end:1'), 'retry remained blocked behind ordinal 0');
});

test('a failed explicit resume restores the paused epoch and can retry the same resume identity', async () => {
  const startFailures = new Map([[2, 'CAPTURE_UNIT_START_FAILED']]);
  const fixture = setup({ startFailures });
  await fixture.coordinator.start(logicalInput());
  await fixture.coordinator.pause();

  await assert.rejects(
    fixture.coordinator.resume(logicalInput({ captureEpoch: 1 })),
    (error) => error?.code === 'CAPTURE_UNIT_START_FAILED'
  );
  await eventually(
    () => fixture.log.includes('gap:2:CAPTURE_UNIT_START_FAILED'),
    'failed resume reservation was not closed'
  );
  assert.equal(fixture.coordinator.getSnapshot().captureEpoch, 0);
  assert.equal(fixture.coordinator.status, 'paused');

  startFailures.delete(2);
  const resumed = await fixture.coordinator.resume(logicalInput({ captureEpoch: 1 }));
  assert.equal(resumed.actualStarted, true);
  assert.equal(fixture.coordinator.getSnapshot().captureEpoch, 1);
  assert.equal(fixture.coordinator.getSnapshot().activeCaptureOrdinal, 3);
});

test('a successor start failure closes both ordinals and interrupts without a false recording state', async () => {
  const fixture = setup({
    startFailures: new Map([[1, 'CAPTURE_UNIT_START_FAILED']])
  });
  await fixture.coordinator.start(logicalInput());
  await fixture.timers.fireNext();
  await eventually(
    () => fixture.coordinator.getSnapshot().status === 'interrupted',
    'successor start failure did not interrupt capture'
  );

  assert.equal(fixture.log.includes('commit-end:0'), true);
  assert.equal(fixture.log.includes('gap:1:CAPTURE_UNIT_START_FAILED'), true);
  assert.equal(fixture.coordinator.getSnapshot().activeUnitCount, 0);
  assert.equal(fixture.coordinator.getSnapshot().streamActive, false);
  assert.equal(fixture.coordinator.getSnapshot().errorCode, 'CAPTURE_UNIT_START_FAILED');
});

test('cutover starts successor before old encryption or IndexedDB persistence and keeps one start/stop per unit', async () => {
  const fixture = setup();
  await fixture.coordinator.start(logicalInput());
  await fixture.timers.fireNext();
  await eventually(() => fixture.log.includes('commit-end:0'), 'first unit did not commit');

  const stopIndex = fixture.log.indexOf('stop:0:rotation');
  const successorIndex = fixture.log.indexOf('start:1');
  const stageIndex = fixture.log.indexOf('stage:0');
  assert.equal(stopIndex >= 0, true);
  assert.equal(successorIndex > stopIndex, true);
  assert.equal(stageIndex > successorIndex, true);
  assert.equal(fixture.units[0].startCalls, 1);
  assert.equal(fixture.units[0].stopCalls, 1);
  assert.equal(fixture.units[1].startCalls, 1);
  assert.equal(fixture.coordinator.getSnapshot().activeCaptureOrdinal, 1);
});

test('twenty delayed seals and commits retain capture ordinal and committed sequence order', async () => {
  const deferred = new Map(Array.from({ length: 20 }, (_, index) => [index, null]));
  const fixture = setup({ deferred });
  await fixture.coordinator.start(logicalInput());
  for (let index = 0; index < 20; index += 1) {
    await fixture.timers.fireNext();
  }
  for (let index = 19; index >= 0; index -= 1) deferred.get(index)?.();
  await eventually(
    () => fixture.log.filter((item) => item.startsWith('commit-end:')).length === 20,
    'delayed units did not drain'
  );

  assert.deepEqual(
    fixture.log.filter((item) => item.startsWith('commit-end:')),
    Array.from({ length: 20 }, (_, index) => `commit-end:${index}`)
  );
  assert.equal(fixture.coordinator.getSnapshot().lastCommittedDurationMs, 240_000);
});

test('one failed seal records a discontinuity and a healthy successor resets the failure streak', async () => {
  const failures = new Map([[0, 'CAPTURE_UNIT_EMPTY_BLOB']]);
  const fixture = setup({ failures });
  await fixture.coordinator.start(logicalInput());
  await fixture.timers.fireNext();
  await eventually(() => fixture.log.includes('gap:0:CAPTURE_UNIT_EMPTY_BLOB'), 'gap not recorded');
  await fixture.timers.fireNext();
  await eventually(() => fixture.log.includes('commit-end:1'), 'healthy successor not committed');

  const snapshot = fixture.coordinator.getSnapshot();
  assert.equal(snapshot.consecutiveSealFailures, 0);
  assert.equal(snapshot.status, 'recording');
  assert.equal(snapshot.lastCommittedDurationMs, 12_000);
});

test('two consecutive seal failures stop false recording with the exact second failure', async () => {
  const failures = new Map([
    [0, 'CAPTURE_UNIT_EMPTY_BLOB'],
    [1, 'CAPTURE_UNIT_SEAL_TIMEOUT']
  ]);
  const fixture = setup({ failures });
  await fixture.coordinator.start(logicalInput());
  await fixture.timers.fireNext();
  await fixture.timers.fireNext();
  await eventually(
    () => fixture.coordinator.getSnapshot().status === 'interrupted',
    'two failures did not interrupt capture'
  );

  assert.equal(fixture.coordinator.getSnapshot().errorCode, 'CAPTURE_UNIT_SEAL_TIMEOUT');
  assert.equal(fixture.coordinator.getSnapshot().timerCount, 0);
});

test('sealed-uncommitted high water never exceeds three and stops at a safe boundary', async () => {
  const fixture = setup({ blockCommits: true });
  await fixture.coordinator.start(logicalInput());
  for (let index = 0; index < 4; index += 1) {
    const timerExists = fixture.coordinator.getSnapshot().timerCount > 0;
    if (!timerExists) break;
    await fixture.timers.fireNext();
    await drain();
  }
  await eventually(
    () => fixture.coordinator.getSnapshot().status === 'stalled',
    'backpressure did not stop capture'
  );

  assert.equal(fixture.coordinator.getSnapshot().maxSealedUncommitted <= 3, true);
  assert.equal(fixture.coordinator.getSnapshot().sealedUncommitted, 3);
  assert.equal(fixture.coordinator.getSnapshot().errorCode, 'CAPTURE_ROTATION_BACKPRESSURE');
  fixture.persistence.releaseCommit?.();
});

for (const failure of [
  {
    name: 'journal',
    setup: { failJournalOrdinals: new Set([0]) },
    errorCode: 'CAPTURE_UNIT_JOURNAL_FAILED'
  },
  {
    name: 'atomic commit',
    setup: { failCommitOrdinals: new Set([0]) },
    errorCode: 'CAPTURE_UNIT_COMMIT_FAILED'
  }
]) {
  test(`${failure.name} failure halts the successor and releases the microphone at a safe boundary`, async () => {
    const fixture = setup(failure.setup);
    await fixture.coordinator.start(logicalInput());
    await fixture.timers.fireNext();
    await eventually(
      () => fixture.coordinator.getSnapshot().activeUnitCount === 0
        && fixture.coordinator.getSnapshot().streamActive === false,
      `${failure.name} failure retained active capture resources`
    );

    const snapshot = fixture.coordinator.getSnapshot();
    assert.equal(snapshot.status, 'stalled');
    assert.equal(snapshot.errorCode, failure.errorCode);
    assert.equal(snapshot.timerCount, 0);
    assert.equal(fixture.resources().stoppedTracks, 1);
    assert.equal(fixture.log.includes(`gap:1:${failure.errorCode}`), true);
    assert.equal(fixture.log.includes(`gap:2:${failure.errorCode}`), true);
  });
}

test('pause and resume keep logical identity, change only capture epoch, and release old stream', async () => {
  const fixture = setup();
  await fixture.coordinator.start(logicalInput());
  const paused = await fixture.coordinator.pause();
  assert.equal(paused.actualPaused, true);
  assert.equal(fixture.coordinator.status, 'paused');
  assert.equal(fixture.resources().stoppedTracks, 1);

  await fixture.coordinator.resume(logicalInput({ captureEpoch: 1 }));
  const identities = fixture.units.map((unit) => unit.identity);
  assert.equal(fixture.coordinator.status, 'recording');
  assert.equal(identities[0].recorderGeneration, identities[1].recorderGeneration);
  assert.equal(identities[0].captureEpoch, 0);
  assert.equal(identities[1].captureEpoch, 1);
  assert.equal(fixture.resources().acquiredStreams, 2);
});

test('stop finalizes durable truth and dispose releases timers, units, and stream exactly once', async () => {
  const fixture = setup();
  await fixture.coordinator.start(logicalInput());
  const stopped = await fixture.coordinator.stop({ reason: 'user_stop' });
  fixture.coordinator.dispose();
  fixture.coordinator.dispose();

  assert.equal(stopped.finalized, true);
  assert.equal(stopped.finalizationPending, false);
  assert.equal(stopped.lastCommittedDurationMs, 12_000);
  assert.equal(fixture.log.includes('manifest-finalized'), true);
  assert.equal(fixture.coordinator.getSnapshot().timerCount, 0);
  assert.equal(fixture.coordinator.getSnapshot().activeUnitCount, 0);
  assert.equal(fixture.resources().stoppedTracks, 1);
});

test('concurrent stop callers share one finalization result and never duplicate manifest close', async () => {
  const fixture = setup();
  await fixture.coordinator.start(logicalInput());

  const first = fixture.coordinator.stop({ reason: 'user_stop' });
  const second = fixture.coordinator.stop({ reason: 'user_stop' });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.finalized, true);
  assert.equal(fixture.log.filter((entry) => entry === 'manifest-finalized').length, 1);
});

test('a refreshed coordinator drains from the first durable non-zero capture ordinal', async () => {
  const fixture = setup({ initialOrdinal: 25 });
  await fixture.coordinator.start(logicalInput({ captureEpoch: 2 }));
  await fixture.timers.fireNext();
  await eventually(() => fixture.log.includes('commit-end:25'), 'resumed ordinal 25 did not drain');

  assert.equal(fixture.coordinator.getSnapshot().activeCaptureOrdinal, 26);
  assert.equal(fixture.coordinator.getSnapshot().lastPersistedSequence, 0);
});
