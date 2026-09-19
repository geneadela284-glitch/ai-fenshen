import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { inspectIndependentMp4Segment } from '../../../../core/meeting/stage3c/independentMp4.js';
import { createMemoryMeetingBackend, createMeetingPhase1Store } from './browserMeetingStore.js';
import { createMeetingPhase1Manager } from './meetingPhase1Manager.js';
import { createMeetingRecorderRotationCoordinator } from './meetingRecorderRotationCoordinator.js';
import {
  INDEPENDENT_MP4_SEGMENTS_V1,
  IOS_AAC_CAPTURE_UNIT_MS
} from './meetingRecordingContainerLayout.js';
import { ROTATING_INDEPENDENT_MP4_MODE } from './meetingRecordingDurabilityMode.js';

const OWNER = Object.freeze({
  trusted: true,
  ownerId: 'owner-rotation-endurance',
  sessionId: 'session-rotation-endurance',
  spaceId: 'meeting-space'
});
const ATTEMPT_ID = 'attempt-rotation-endurance';
const MIME_TYPE = 'audio/mp4;codecs=mp4a.40.2';
const BASE_TIME = Date.parse('2026-08-15T10:00:00.000Z');

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function ascii(value) {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

function u16(value) {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u24(value) {
  return Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32(value) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  );
}

function box(type, payload = new Uint8Array()) {
  return concat(u32(payload.byteLength + 8), ascii(type), payload);
}

function fullBox(type, version, flags, payload = new Uint8Array()) {
  return box(type, concat(Uint8Array.of(version), u24(flags), payload));
}

function completeTwelveSecondMp4() {
  const sampleEntry = concat(
    new Uint8Array(6),
    u16(1),
    new Uint8Array(8),
    u16(2),
    u16(16),
    u16(0),
    u16(0),
    u32(48_000 << 16),
    box('esds', Uint8Array.of(0, 0, 0, 0, 0x11, 0x90))
  );
  const tkhd = fullBox('tkhd', 0, 0x000003, concat(
    u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(52)
  ));
  const mdhd = fullBox('mdhd', 0, 0, concat(
    u32(0), u32(0), u32(48_000), u32(0), u16(0), u16(0)
  ));
  const hdlr = fullBox('hdlr', 0, 0, concat(
    u32(0), ascii('soun'), new Uint8Array(12), ascii('Synthetic\0')
  ));
  const stsd = fullBox('stsd', 0, 0, concat(u32(1), box('mp4a', sampleEntry)));
  const trak = box('trak', concat(tkhd, box('mdia', concat(mdhd, hdlr, box('minf', box('stbl', stsd))))));
  const trex = fullBox('trex', 0, 0, concat(u32(1), u32(1), u32(576_000), u32(0), u32(0)));
  const moov = box('moov', concat(trak, box('mvex', trex)));
  const ftyp = box('ftyp', concat(ascii('isom'), u32(0), ascii('isomiso6mp41')));
  const tfhd = fullBox('tfhd', 0, 0, u32(1));
  const tfdt = fullBox('tfdt', 0, 0, u32(0));
  const trun = fullBox('trun', 0, 0, u32(1));
  const moof = box('moof', concat(
    fullBox('mfhd', 0, 0, u32(1)),
    box('traf', concat(tfhd, tfdt, trun))
  ));
  return concat(ftyp, moov, moof, box('mdat', Uint8Array.of(1, 2, 3, 4)));
}

const COMPLETE_MP4 = completeTwelveSecondMp4();

function completeMp4ForOrdinal(captureOrdinal) {
  const bytes = COMPLETE_MP4.slice();
  bytes[bytes.byteLength - 2] = (captureOrdinal >>> 8) & 0xff;
  bytes[bytes.byteLength - 1] = captureOrdinal & 0xff;
  return bytes;
}

class VirtualTimers {
  constructor(clock) {
    this.clock = clock;
    this.monotonicMs = 0;
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

  advance(ms) {
    this.monotonicMs += ms;
    this.clock.elapsedMs += ms;
  }

  async fireRotation() {
    const match = [...this.tasks.entries()].find(([, task]) => task.delayMs === IOS_AAC_CAPTURE_UNIT_MS);
    assert.ok(match, 'rotation timer missing');
    const [id, task] = match;
    this.tasks.delete(id);
    this.advance(IOS_AAC_CAPTURE_UNIT_MS);
    task.callback();
    await settle();
  }
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function waitForManagerCount(page, expectedCount) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const current = page.manager.getSnapshot().active;
    if (current.meeting.committedSegmentCount === expectedCount) return current;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`committed segment count did not reach ${expectedCount}: ${JSON.stringify(page.coordinator?.getSnapshot?.())}`);
}

async function keyProvider() {
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return Object.freeze({ withOwnerKey: (_context, callback) => callback(key) });
}

function makeCaptureUnitFactory({ clock, timers, resources }) {
  return ({ identity }) => {
    let state = 'CREATED';
    let startedAtMs = null;
    let disposed = false;
    resources.constructed += 1;
    return {
      identity,
      async start() {
        assert.equal(state, 'CREATED');
        state = 'RECORDING';
        startedAtMs = clock.elapsedMs;
        resources.activeRecorders += 1;
        resources.maxActiveRecorders = Math.max(resources.maxActiveRecorders, resources.activeRecorders);
        resources.activeHandlers += 3;
        return { actualStarted: true, identity };
      },
      async requestStop() {
        assert.equal(state, 'RECORDING');
        state = 'SEALED';
        const durationMs = clock.elapsedMs - startedAtMs;
        assert.equal(durationMs, IOS_AAC_CAPTURE_UNIT_MS);
        const bytes = completeMp4ForOrdinal(identity.captureOrdinal);
        return Object.freeze({
          state: 'SEALED',
          identity,
          blob: new Blob([bytes], { type: MIME_TYPE }),
          bytes,
          inspection: inspectIndependentMp4Segment(bytes),
          startedAt: new Date(BASE_TIME + startedAtMs).toISOString(),
          endedAt: new Date(BASE_TIME + clock.elapsedMs).toISOString(),
          durationMs,
          mimeType: MIME_TYPE,
          containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
          partCount: 1,
          byteLength: bytes.byteLength
        });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        resources.disposed += 1;
        if (state === 'RECORDING' || state === 'SEALED') resources.activeRecorders -= 1;
        resources.activeHandlers -= state === 'CREATED' ? 0 : 3;
        state = state === 'SEALED' ? 'SEALED' : 'STALE';
      },
      getSnapshot() {
        return { state, identity, timerCount: timers.tasks.size };
      }
    };
  };
}

function createPage({ label, generation, clock, backend, store, traces, journalStats }) {
  const timers = new VirtualTimers(clock);
  const resources = {
    streamsAcquired: 0,
    activeStreams: 0,
    constructed: 0,
    disposed: 0,
    activeRecorders: 0,
    maxActiveRecorders: 0,
    activeHandlers: 0
  };
  let coordinator = null;
  const recorderFactory = (options) => {
    const port = options.capturePersistencePort;
    const trackedPort = Object.freeze({
      ...port,
      async stagePendingCaptureUnit(input) {
        const result = await port.stagePendingCaptureUnit(input);
        const depth = backend.dump().pendingSegments.length;
        journalStats.maxDepth = Math.max(journalStats.maxDepth, depth);
        return result;
      },
      async commitPendingCaptureUnit(input) {
        const result = await port.commitPendingCaptureUnit(input);
        const depth = backend.dump().pendingSegments.length;
        journalStats.maxDepth = Math.max(journalStats.maxDepth, depth);
        return result;
      }
    });
    coordinator = createMeetingRecorderRotationCoordinator({
      mediaDevices: {
        async getUserMedia() {
          resources.streamsAcquired += 1;
          resources.activeStreams += 1;
          let stopped = false;
          return {
            getTracks() {
              return [{
                stop() {
                  if (stopped) return;
                  stopped = true;
                  resources.activeStreams -= 1;
                }
              }];
            }
          };
        }
      },
      mimeType: MIME_TYPE,
      pageEpoch: label,
      recorderGeneration: generation,
      captureUnitFactory: makeCaptureUnitFactory({ clock, timers, resources }),
      capturePersistencePort: trackedPort,
      captureUnitMs: IOS_AAC_CAPTURE_UNIT_MS,
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
      monotonicNow: () => timers.monotonicMs,
      now: () => new Date(BASE_TIME + clock.elapsedMs).toISOString(),
      onStarted: options.onStarted,
      onInterrupted: options.onInterrupted,
      onError: options.onError,
      onPersistenceStatus: options.onPersistenceStatus,
      onCheckpointTrace: (trace) => {
        traces.push({ label, ...trace });
        return options.onCheckpointTrace(trace);
      }
    });
    return Object.freeze({
      get status() { return coordinator.status; },
      start(input = {}) {
        return coordinator.start({ ...input, recordingAttemptId: input.recordingAttemptId || ATTEMPT_ID });
      },
      pause: coordinator.pause,
      resume(input = {}) {
        return coordinator.resume({ ...input, recordingAttemptId: input.recordingAttemptId || ATTEMPT_ID });
      },
      stop: coordinator.stop,
      interrupt: coordinator.interrupt,
      dispose: coordinator.dispose,
      getSnapshot: coordinator.getSnapshot
    });
  };
  const manager = createMeetingPhase1Manager({
    ownerContext: OWNER,
    store,
    cryptoImpl: webcrypto,
    now: () => new Date(BASE_TIME + clock.elapsedMs).toISOString(),
    recorderFactory,
    recorderOptions: { checkpointMode: ROTATING_INDEPENDENT_MP4_MODE }
  });
  return Object.freeze({
    label,
    generation,
    timers,
    resources,
    manager,
    get coordinator() { return coordinator; }
  });
}

async function driveToCommittedCount({ page, expectedCount, samples }) {
  let current = page.manager.getSnapshot().active;
  while (current.meeting.committedSegmentCount < expectedCount) {
    const nextCount = current.meeting.committedSegmentCount + 1;
    await page.timers.fireRotation();
    current = await waitForManagerCount(page, nextCount);
    samples.push({
      count: current.meeting.committedSegmentCount,
      durationMs: current.meeting.committedDurationMs,
      totalBytes: current.meeting.totalBytes,
      revision: current.manifest.revision
    });
  }
  return current;
}

test('325 rotating CaptureUnits survive native pause, hard refresh, explicit resume, and finalization', async () => {
  const inspection = inspectIndependentMp4Segment(COMPLETE_MP4);
  assert.equal(inspection.durationMs, IOS_AAC_CAPTURE_UNIT_MS);
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl: webcrypto, keyProvider: await keyProvider(), backend });
  const clock = { elapsedMs: 0 };
  const traces = [];
  const samples = [];
  const journalStats = { maxDepth: 0 };
  const pageA = createPage({
    label: 'page-endurance-a',
    generation: 91,
    clock,
    backend,
    store,
    traces,
    journalStats
  });

  await pageA.manager.initialize();
  const created = await pageA.manager.createMeeting({ title: '65-minute-rotation-endurance' });
  const meetingId = created.meeting.meetingId;
  await pageA.manager.startRecording();
  await driveToCommittedCount({ page: pageA, expectedCount: 99, samples });

  pageA.timers.advance(IOS_AAC_CAPTURE_UNIT_MS);
  const paused = await pageA.manager.pauseRecording();
  assert.equal(paused.meeting.recordingState, 'interrupted');
  assert.equal(paused.meeting.interruptionReason, 'user_pause');
  assert.equal(paused.meeting.committedSegmentCount, 100);
  assert.equal(paused.meeting.committedDurationMs, 1_200_000);
  assert.equal(pageA.coordinator.getSnapshot().timerCount, 0);
  assert.equal(pageA.resources.activeStreams, 0);

  const resumed = await pageA.manager.resumeRecording();
  assert.equal(resumed.meeting.recordingAttemptId, ATTEMPT_ID);
  assert.equal(resumed.meeting.captureEpoch, 1);
  assert.equal(pageA.coordinator.getSnapshot().recorderGeneration, 91);
  await driveToCommittedCount({ page: pageA, expectedCount: 175, samples });
  assert.equal(
    traces.filter((trace) => trace.label === pageA.label && trace.event === 'manifest_committed' && trace.captureEpoch === 1).length >= 6,
    true
  );

  const beforeRefresh = await store.getMeeting(OWNER, meetingId);
  assert.equal(beforeRefresh.meeting.committedDurationMs, 2_100_000);
  assert.equal(beforeRefresh.meeting.committedSegmentCount, 175);
  assert.equal(pageA.coordinator.dispose(), true);
  assert.equal(pageA.timers.tasks.size, 0);
  assert.equal(pageA.resources.activeStreams, 0);
  assert.equal(pageA.resources.activeRecorders, 0);
  assert.equal(pageA.resources.activeHandlers, 0);

  const pageB = createPage({
    label: 'page-endurance-b',
    generation: 92,
    clock,
    backend,
    store,
    traces,
    journalStats
  });
  await pageB.manager.initialize();
  const recovered = pageB.manager.getSnapshot().active;
  assert.equal(recovered.meeting.meetingId, meetingId);
  assert.equal(recovered.meeting.recordingState, 'interrupted');
  assert.equal(recovered.meeting.interruptionReason, 'page_reload_recovery');
  assert.equal(recovered.meeting.recordingAttemptId, ATTEMPT_ID);
  assert.equal(recovered.meeting.committedDurationMs, 2_100_000);
  assert.equal(recovered.meeting.committedSegmentCount, 175);
  assert.equal(pageB.resources.streamsAcquired, 0);

  const refreshGaps = recovered.manifest.captureOrdinals.filter((entry) => (
    entry.state === 'discontinuity' && entry.errorCode === 'CAPTURE_UNIT_UNSEALED_AT_REFRESH'
  ));
  assert.equal(refreshGaps.length, 2);
  assert.deepEqual(refreshGaps.map((entry) => entry.captureOrdinal), [176, 177]);

  const explicitlyResumed = await pageB.manager.startRecording();
  assert.equal(explicitlyResumed.meeting.recordingAttemptId, ATTEMPT_ID);
  assert.equal(explicitlyResumed.meeting.captureEpoch, 2);
  assert.equal(pageB.coordinator.getSnapshot().pageEpoch, pageB.label);
  assert.equal(pageB.coordinator.getSnapshot().recorderGeneration, 92);
  await driveToCommittedCount({ page: pageB, expectedCount: 324, samples });
  assert.equal(
    traces.filter((trace) => trace.label === pageB.label && trace.event === 'manifest_committed' && trace.captureEpoch === 2).length >= 6,
    true
  );

  pageB.timers.advance(IOS_AAC_CAPTURE_UNIT_MS);
  const stopped = await pageB.manager.stopRecording();
  assert.equal(stopped.meeting.recordingState, 'stopped');
  assert.equal(stopped.meeting.recordingAttemptId, ATTEMPT_ID);
  assert.equal(stopped.meeting.ownerId, OWNER.ownerId);
  assert.equal(stopped.meeting.scope, 'meeting');
  assert.equal(stopped.meeting.committedSegmentCount, 325);
  assert.equal(stopped.meeting.committedDurationMs, 3_900_000);
  assert.equal(stopped.manifest.status, 'closed');
  assert.equal(stopped.manifest.containerLayout, INDEPENDENT_MP4_SEGMENTS_V1);
  assert.deepEqual(stopped.segments.map((segment) => segment.sequence), Array.from({ length: 325 }, (_, index) => index));

  for (let index = 1; index < samples.length; index += 1) {
    assert.equal(samples[index].count >= samples[index - 1].count, true);
    assert.equal(samples[index].durationMs >= samples[index - 1].durationMs, true);
    assert.equal(samples[index].totalBytes >= samples[index - 1].totalBytes, true);
    assert.equal(samples[index].revision >= samples[index - 1].revision, true);
  }

  const represented = [...stopped.manifest.captureOrdinals].sort((left, right) => left.captureOrdinal - right.captureOrdinal);
  assert.deepEqual(represented.map((entry) => entry.captureOrdinal), Array.from({ length: represented.length }, (_, index) => index));
  const committedOrdinals = represented.filter((entry) => entry.state === 'committed').map((entry) => entry.captureOrdinal);
  const discontinuities = represented.filter((entry) => entry.state === 'discontinuity');
  assert.equal(committedOrdinals.length, 325);
  assert.equal(discontinuities.length, represented.length - committedOrdinals.length);
  assert.equal(represented.every((entry) => ['committed', 'discontinuity'].includes(entry.state)), true);

  for (const sequence of [0, 162, 324]) {
    const segment = stopped.segments[sequence];
    const audio = await store.readAudioSegment(OWNER, meetingId, segment.segmentId);
    assert.deepEqual([...audio], [...completeMp4ForOrdinal(segment.captureOrdinal)]);
  }

  assert.equal(journalStats.maxDepth <= 3, true);
  assert.equal(backend.dump().pendingSegments.length, 0);
  assert.equal(pageB.coordinator.getSnapshot().timerCount, 0);
  assert.equal(pageB.coordinator.getSnapshot().activeUnitCount, 0);
  assert.equal(pageB.resources.activeStreams, 0);
  assert.equal(pageB.resources.activeRecorders, 0);
  assert.equal(pageB.resources.activeHandlers, 0);
  assert.equal(pageA.timers.maxActive <= 1, true);
  assert.equal(pageB.timers.maxActive <= 1, true);
});

function finalizationHarness({ tailFailureCode = '', failJournal = false, failCommit = false, failManifest = false, delayedTail = false } = {}) {
  const clock = { elapsedMs: 0 };
  const timers = new VirtualTimers(clock);
  const reservations = [];
  const journals = new Map();
  const segments = [];
  let nextOrdinal = 0;
  let committedDurationMs = 0;
  let manifestRevision = 0;
  let failuresEnabled = true;
  let manifestClosed = false;
  let manifestCloseCalls = 0;
  let maxJournalDepth = 0;
  let releaseDelayedTail = null;
  const persistence = {
    async reserveCaptureUnit(input) {
      const captureOrdinal = nextOrdinal++;
      const reservation = {
        captureOrdinal,
        captureUnitId: `final-unit-${captureOrdinal}`,
        chunkToken: `final-token-${captureOrdinal}`,
        captureEpoch: input.captureEpoch,
        recordingAttemptId: input.recordingAttemptId,
        state: 'reserved'
      };
      reservations.push(reservation);
      return reservation;
    },
    async stagePendingCaptureUnit({ unit }) {
      const ordinal = unit.identity.captureOrdinal;
      if (failJournal && failuresEnabled && ordinal === 1) {
        throw Object.assign(new Error('journal failed'), { code: 'PENDING_SEGMENT_JOURNAL_FAILED' });
      }
      const reservation = reservations[ordinal];
      reservation.state = 'pending';
      const journalId = `final-journal-${ordinal}`;
      journals.set(journalId, { unit, committed: false });
      maxJournalDepth = Math.max(maxJournalDepth, [...journals.values()].filter((entry) => !entry.committed).length);
      return { journalId };
    },
    async commitPendingCaptureUnit({ journalId }) {
      const entry = journals.get(journalId);
      assert.ok(entry, 'pending journal missing');
      const ordinal = entry.unit.identity.captureOrdinal;
      if (entry.committed) {
        const existing = segments.find((segment) => segment.captureOrdinal === ordinal);
        return {
          idempotent: true,
          segment: existing,
          meeting: { committedDurationMs },
          manifest: { revision: manifestRevision }
        };
      }
      if (failCommit && failuresEnabled && ordinal === 1) {
        throw Object.assign(new Error('commit failed'), { code: 'SEGMENT_ATOMIC_COMMIT_FAILED' });
      }
      const segment = {
        sequence: segments.length,
        captureOrdinal: ordinal,
        durationMs: entry.unit.durationMs,
        chunkToken: entry.unit.identity.chunkToken
      };
      segments.push(segment);
      entry.committed = true;
      reservations[ordinal].state = 'committed';
      committedDurationMs += entry.unit.durationMs;
      manifestRevision += 1;
      return {
        idempotent: false,
        segment,
        meeting: { committedDurationMs },
        manifest: { revision: manifestRevision }
      };
    },
    async recordCaptureDiscontinuity({ captureOrdinal, errorCode }) {
      const reservation = reservations[captureOrdinal];
      if (reservation.state === 'discontinuity') return { idempotent: true, captureOrdinal, errorCode };
      reservation.state = 'discontinuity';
      reservation.errorCode = errorCode;
      manifestRevision += 1;
      return { idempotent: false, captureOrdinal, errorCode };
    },
    async replayPendingCaptureUnits() {
      let committedCount = 0;
      for (const [journalId, entry] of journals) {
        if (entry.committed) continue;
        await this.commitPendingCaptureUnit({ journalId });
        committedCount += 1;
      }
      return { committedCount, committedDurationMs };
    },
    async finalizeCaptureManifest({ allowSafeTailClosure }) {
      manifestCloseCalls += 1;
      if (failManifest && failuresEnabled) {
        throw Object.assign(new Error('manifest close failed'), { code: 'CAPTURE_MANIFEST_CLOSE_FAILED' });
      }
      if (manifestClosed) return { finalized: true, finalizationPending: false, idempotent: true };
      const unresolved = reservations.filter((reservation) => !['committed', 'discontinuity'].includes(reservation.state));
      if (unresolved.length && allowSafeTailClosure !== true) throw new Error('unresolved capture ordinal');
      for (const reservation of unresolved) {
        reservation.state = 'discontinuity';
        reservation.errorCode = 'CAPTURE_UNIT_UNSEALED_AT_FINALIZE';
      }
      manifestClosed = true;
      manifestRevision += 1;
      return { finalized: true, finalizationPending: false, idempotent: false };
    }
  };

  const captureUnitFactory = ({ identity }) => {
    let startedAtMs = 0;
    let disposed = false;
    return {
      identity,
      async start() {
        startedAtMs = clock.elapsedMs;
        return { actualStarted: true, identity };
      },
      requestStop() {
        if (identity.captureOrdinal === 1 && tailFailureCode) {
          return Promise.reject(Object.assign(new Error(tailFailureCode), { code: tailFailureCode }));
        }
        const result = () => {
          const bytes = completeMp4ForOrdinal(identity.captureOrdinal);
          return Object.freeze({
            identity,
            bytes,
            blob: new Blob([bytes], { type: MIME_TYPE }),
            startedAt: new Date(BASE_TIME + startedAtMs).toISOString(),
            endedAt: new Date(BASE_TIME + clock.elapsedMs).toISOString(),
            durationMs: IOS_AAC_CAPTURE_UNIT_MS,
            mimeType: MIME_TYPE,
            containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
            byteLength: bytes.byteLength
          });
        };
        if (identity.captureOrdinal === 1 && delayedTail) {
          return new Promise((resolve) => { releaseDelayedTail = () => resolve(result()); });
        }
        return Promise.resolve(result());
      },
      dispose() {
        disposed = true;
      },
      getSnapshot() {
        return { disposed, identity };
      }
    };
  };
  const coordinator = createMeetingRecorderRotationCoordinator({
    mediaDevices: {
      async getUserMedia() {
        return { getTracks: () => [{ stop() {} }] };
      }
    },
    mimeType: MIME_TYPE,
    pageEpoch: 'page-finalization-matrix',
    recorderGeneration: 93,
    captureUnitFactory,
    capturePersistencePort: persistence,
    captureUnitMs: IOS_AAC_CAPTURE_UNIT_MS,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    monotonicNow: () => timers.monotonicMs,
    now: () => new Date(BASE_TIME + clock.elapsedMs).toISOString()
  });

  return {
    coordinator,
    timers,
    persistence,
    releaseDelayedTail: () => releaseDelayedTail?.(),
    disableFailures() { failuresEnabled = false; },
    async retryFinalize() {
      failuresEnabled = false;
      await persistence.replayPendingCaptureUnits();
      return persistence.finalizeCaptureManifest({ allowSafeTailClosure: true });
    },
    snapshot() {
      return {
        committedDurationMs,
        segments: structuredClone(segments),
        reservations: structuredClone(reservations),
        manifestRevision,
        manifestClosed,
        manifestCloseCalls,
        maxJournalDepth
      };
    }
  };
}

async function prepareFinalizationHarness(options) {
  const fixture = finalizationHarness(options);
  await fixture.coordinator.start({
    meetingId: 'meeting-finalization-matrix',
    sourceId: 'recorded-meeting-finalization-matrix',
    recordingAttemptId: 'attempt-finalization-matrix',
    captureEpoch: 0,
    containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
  });
  await fixture.timers.fireRotation();
  for (let attempt = 0; attempt < 500 && fixture.snapshot().segments.length < 1; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.snapshot().segments.length, 1);
  fixture.timers.advance(IOS_AAC_CAPTURE_UNIT_MS);
  return fixture;
}

for (const variant of [
  { name: 'empty tail', options: { tailFailureCode: 'CAPTURE_UNIT_EMPTY_BLOB' }, expected: 'FINALIZATION_PENDING_TAIL_SEAL' },
  { name: 'seal timeout', options: { tailFailureCode: 'CAPTURE_UNIT_SEAL_TIMEOUT' }, expected: 'FINALIZATION_PENDING_TAIL_SEAL' },
  { name: 'journal failure', options: { failJournal: true }, expected: 'FINALIZATION_PENDING_JOURNAL' },
  { name: 'commit failure', options: { failCommit: true }, expected: 'FINALIZATION_PENDING_COMMIT' },
  { name: 'manifest close failure', options: { failManifest: true }, expected: 'FINALIZATION_PENDING_MANIFEST' }
]) {
  test(`finalization ${variant.name} preserves durable truth and retries without duplication`, async () => {
    const fixture = await prepareFinalizationHarness(variant.options);
    const baseline = fixture.snapshot();
    const pending = await fixture.coordinator.stop({ reason: 'user_stop' });

    assert.equal(pending.finalized, false);
    assert.equal(pending.finalizationPending, true);
    assert.equal(pending.finalizationErrorCode, variant.expected);
    assert.equal(pending.lastCommittedDurationMs >= baseline.committedDurationMs, true);
    assert.equal(fixture.snapshot().segments.length >= baseline.segments.length, true);
    assert.equal(new Set(fixture.snapshot().segments.map((segment) => segment.chunkToken)).size, fixture.snapshot().segments.length);

    const retried = await fixture.retryFinalize();
    const afterRetry = fixture.snapshot();
    assert.equal(retried.finalized, true);
    assert.equal(afterRetry.manifestClosed, true);
    assert.equal(afterRetry.committedDurationMs >= baseline.committedDurationMs, true);
    assert.deepEqual(afterRetry.segments.map((segment) => segment.sequence), Array.from({ length: afterRetry.segments.length }, (_, index) => index));
    assert.equal(new Set(afterRetry.segments.map((segment) => segment.chunkToken)).size, afterRetry.segments.length);
    assert.equal(afterRetry.reservations.every((reservation) => ['committed', 'discontinuity'].includes(reservation.state)), true);
    assert.equal(afterRetry.maxJournalDepth <= 3, true);

    await fixture.retryFinalize();
    const idempotent = fixture.snapshot();
    assert.equal(idempotent.segments.length, afterRetry.segments.length);
    assert.equal(idempotent.committedDurationMs, afterRetry.committedDurationMs);
    assert.equal(idempotent.reservations.length, afterRetry.reservations.length);
  });
}

test('delayed final stop stays inside one barrier and completes without FINALIZATION_PENDING', async () => {
  const fixture = await prepareFinalizationHarness({ delayedTail: true });
  let settled = false;
  const stopping = fixture.coordinator.stop({ reason: 'user_stop' }).then((result) => {
    settled = true;
    return result;
  });
  await settle();
  assert.equal(settled, false);
  fixture.releaseDelayedTail();
  const finalized = await stopping;

  assert.equal(finalized.finalized, true);
  assert.equal(finalized.finalizationPending, false);
  assert.equal(fixture.snapshot().segments.length, 2);
  assert.equal(fixture.snapshot().committedDurationMs, 24_000);
});
