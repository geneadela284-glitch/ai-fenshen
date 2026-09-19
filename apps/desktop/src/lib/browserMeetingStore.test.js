import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

import {
  MEETING_PHASE1_DATABASE_VERSION,
  createIndexedDbMeetingBackend,
  createMemoryMeetingBackend,
  createMeetingPhase1Store
} from './browserMeetingStore.js';
import { INDEPENDENT_MP4_SEGMENTS_V1 } from './meetingRecordingContainerLayout.js';
import {
  createMeetingPhase1Session,
  transitionMeetingPhase1Session
} from './meetingPhase1State.js';

const cryptoImpl = webcrypto;

function ownerContext(ownerId) {
  return Object.freeze({
    trusted: true,
    ownerId,
    sessionId: `session-${ownerId}`,
    spaceId: 'meeting-space'
  });
}

async function createKeyProvider() {
  const key = await cryptoImpl.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return {
    async withOwnerKey(_context, callback) {
      return callback(key);
    }
  };
}

async function preparedRecording(store, context) {
  const created = await store.createMeeting(context, {
    meetingId: 'meeting-a',
    title: '现场会议',
    scope: 'meeting'
  });
  let session = transitionMeetingPhase1Session(created.meeting, { type: 'prepare' }, { now: '2026-08-06T13:10:00.000Z' }).state;
  session = transitionMeetingPhase1Session(session, { type: 'recorder_started', actualStarted: true }, { now: '2026-08-06T13:10:01.000Z' }).state;
  await store.saveSession(context, session);
  return session;
}

function segment(sequence = 0, segmentId = `segment-${sequence}`, mimeType = 'audio/webm;codecs=opus') {
  return {
    segmentId,
    sequence,
    startedAt: `2026-08-06T13:10:${String(sequence).padStart(2, '0')}.000Z`,
    endedAt: `2026-08-06T13:10:${String(sequence + 1).padStart(2, '0')}.000Z`,
    durationMs: 1000,
    mimeType
  };
}

async function sha256Hex(value) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

async function captureUnit(reservation, audioBytes, overrides = {}) {
  return {
    identity: {
      pageEpoch: 'page-real-1',
      recorderGeneration: 8,
      captureEpoch: overrides.captureEpoch ?? 0,
      captureOrdinal: reservation.captureOrdinal,
      captureUnitId: reservation.captureUnitId,
      chunkToken: reservation.chunkToken
    },
    startedAt: overrides.startedAt || '2026-08-15T09:00:00.000Z',
    endedAt: overrides.endedAt || '2026-08-15T09:00:12.000Z',
    durationMs: overrides.durationMs || 12_000,
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
    byteLength: audioBytes.byteLength,
    checksum: await sha256Hex(audioBytes),
    ...overrides
  };
}

async function reserveAndStage(store, context, {
  meetingId = 'meeting-a',
  recordingAttemptId = 'attempt-a',
  captureEpoch = 0,
  marker = 'INDEPENDENT_MP4_CAPTURE_UNIT'
} = {}) {
  const sourceId = `recorded-${meetingId}`;
  const reservation = await store.reserveCaptureUnit(context, {
    meetingId,
    sourceId,
    recordingAttemptId,
    captureEpoch
  });
  const audioBytes = new TextEncoder().encode(`${marker}-${reservation.captureOrdinal}`);
  const unit = await captureUnit(reservation, audioBytes, { captureEpoch });
  const staged = await store.stagePendingCaptureUnit(context, {
    meetingId,
    sourceId,
    recordingAttemptId,
    unit,
    bytes: audioBytes
  });
  return { reservation, audioBytes, unit, staged };
}

test('meeting and audio segments are encrypted, owner-scoped, idempotent, and recoverable', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-a');
  const session = await preparedRecording(store, context);
  const bytes = new TextEncoder().encode('PHASE1A_SYNTHETIC_AUDIO_SEGMENT_0');

  const first = await store.commitAudioSegment(context, {
    meetingId: session.meetingId,
    segment: segment(0),
    bytes
  });
  const duplicate = await store.commitAudioSegment(context, {
    meetingId: session.meetingId,
    segment: segment(0),
    bytes
  });

  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.meeting.committedSegmentCount, 1);

  await assert.rejects(
    store.commitAudioSegment(context, { meetingId: session.meetingId, segment: segment(1, 'segment-1'), bytes }),
    (error) => error.code === 'SEGMENT_CONTENT_DUPLICATE'
  );

  const reopened = await store.getMeeting(context, session.meetingId);
  assert.equal(reopened.meeting.title, '现场会议');
  assert.equal(reopened.meeting.committedSegmentCount, 1);
  assert.equal(reopened.segments.length, 1);
  assert.equal(reopened.segments[0].byteLength, bytes.byteLength);
  assert.equal((await store.readAudioSegment(context, session.meetingId, 'segment-0')).byteLength, bytes.byteLength);
  const detailed = [];
  for await (const chunk of store.streamAudioSourceDetailed(context, { meetingId: session.meetingId, sourceId: `recorded-${session.meetingId}` })) detailed.push(chunk);
  assert.deepEqual(detailed.map((chunk) => chunk.sourceChunkId), ['segment-0']);
  assert.equal(detailed[0].bytes.byteLength, bytes.byteLength);

  const persisted = JSON.stringify(backend.dump());
  assert.doesNotMatch(persisted, /PHASE1A_SYNTHETIC_AUDIO_SEGMENT_0/);
  assert.doesNotMatch(persisted, /现场会议/);
});

test('encrypted AAC/MP4 recording segments persist and reconstruct as an m4a AudioSource', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-aac');
  const session = await preparedRecording(store, context);
  const mimeType = 'audio/mp4;codecs=mp4a.40.2';
  await store.commitAudioSegment(context, {
    meetingId: session.meetingId,
    segment: segment(0, 'aac-segment-0', mimeType),
    bytes: new TextEncoder().encode('AAC_MP4_INIT_CHUNK')
  });
  const stopped = transitionMeetingPhase1Session(
    (await store.getMeeting(context, session.meetingId)).meeting,
    { type: 'stop' },
    { now: '2026-08-06T13:11:00.000Z' }
  ).state;
  await store.saveSession(context, stopped);
  const reopened = await store.getMeeting(context, session.meetingId);
  assert.equal(reopened.audioSources[0].format, 'm4a');
  assert.equal(reopened.audioSources[0].mimeType, mimeType);
  const streamed = [];
  for await (const chunk of store.streamAudioSourceDetailed(context, { meetingId: session.meetingId, sourceId: `recorded-${session.meetingId}` })) streamed.push(chunk);
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0].mimeType, mimeType);
  assert.deepEqual([...streamed[0].bytes], [...new TextEncoder().encode('AAC_MP4_INIT_CHUNK')]);
});

test('deleting a recorded AudioSource removes only recording data and preserves the meeting shell', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-recorded-delete');
  const session = await preparedRecording(store, context);
  const bytes = new TextEncoder().encode('PHASE1A_RECORDED_AUDIO_TO_DELETE');
  const committed = await store.commitAudioSegment(context, {
    meetingId: session.meetingId,
    segment: segment(0),
    bytes
  });
  const stopped = transitionMeetingPhase1Session(committed.meeting, { type: 'stop' }, { now: '2026-08-06T13:11:00.000Z' }).state;
  await store.saveSession(context, stopped);

  const deleted = await store.deleteAudioSource(context, {
    meetingId: session.meetingId,
    sourceId: `recorded-${session.meetingId}`
  });

  assert.equal(deleted, true);
  const reopened = await store.getMeeting(context, session.meetingId);
  assert.equal(reopened.meeting.title, '现场会议');
  assert.equal(reopened.meeting.recordingState, 'stopped');
  assert.equal(reopened.meeting.committedSegmentCount, 0);
  assert.equal(reopened.meeting.committedDurationMs, 0);
  assert.equal(reopened.meeting.totalBytes, 0);
  assert.equal(reopened.segments.length, 0);
  assert.equal(reopened.audioSources.length, 0);
  assert.equal(backend.dump().meetings.length, 1);
  assert.equal(backend.dump().segments.length, 0);
});

test('persistent manifest cursor assigns omitted sequence and stable chunk token is idempotent', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-sequence');
  const session = await preparedRecording(store, context);
  const firstBytes = new TextEncoder().encode('PHASE1A_SEQUENCE_ZERO');
  const first = await store.commitAudioSegment(context, {
    meetingId: session.meetingId,
    segment: {
      ...segment(0, 'segment-first'),
      sequence: undefined,
      chunkToken: 'recorder-1-0'
    },
    bytes: firstBytes
  });
  const duplicate = await store.commitAudioSegment(context, {
    meetingId: session.meetingId,
    segment: {
      ...segment(99, 'segment-retry'),
      sequence: undefined,
      chunkToken: 'recorder-1-0'
    },
    bytes: firstBytes
  });
  const second = await store.commitAudioSegment(context, {
    meetingId: session.meetingId,
    segment: {
      ...segment(99, 'segment-second'),
      sequence: undefined,
      chunkToken: 'recorder-1-1'
    },
    bytes: new TextEncoder().encode('PHASE1A_SEQUENCE_ONE')
  });

  assert.equal(first.segment.sequence, 0);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.segment.segmentId, 'segment-first');
  assert.equal(second.segment.sequence, 1);
});

test('owner context scopes every operation and rejects client owner overrides', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const ownerA = ownerContext('owner-a');
  const ownerB = ownerContext('owner-b');
  await preparedRecording(store, ownerA);

  await assert.rejects(
    store.getMeeting(ownerB, 'meeting-a'),
    (error) => error.code === 'MEETING_NOT_FOUND'
  );
  await assert.rejects(
    store.createMeeting(ownerA, { meetingId: 'meeting-b', title: '伪造', ownerId: 'owner-b' }),
    (error) => error.code === 'OWNER_ID_OVERRIDE_REJECTED'
  );
  await assert.rejects(
    store.commitAudioSegment(ownerB, { meetingId: 'meeting-a', segment: segment(0), bytes: new Uint8Array([1]) }),
    (error) => error.code === 'MEETING_NOT_FOUND'
  );
});

test('out-of-order, stopped, and corrupted manifest writes fail closed', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-a');
  const session = await preparedRecording(store, context);

  await assert.rejects(
    store.commitAudioSegment(context, { meetingId: session.meetingId, segment: segment(2), bytes: new Uint8Array([2]) }),
    (error) => error.code === 'SEGMENT_OUT_OF_ORDER'
  );

  const committed = await store.commitAudioSegment(context, { meetingId: session.meetingId, segment: segment(0), bytes: new Uint8Array([4]) });
  const updated = await store.saveSession(context, transitionMeetingPhase1Session(committed.meeting, { type: 'stop' }, { now: '2026-08-06T13:11:00.000Z' }).state);
  assert.equal(updated.recordingState, 'stopped');
  await assert.rejects(
    store.commitAudioSegment(context, { meetingId: session.meetingId, segment: segment(0), bytes: new Uint8Array([3]) }),
    (error) => error.code === 'SEGMENT_AFTER_STOP'
  );

  const segmentKey = backend.dump().segments.find((record) => record.meetingId === 'meeting-a')?.id;
  backend.deleteDirect('segments', segmentKey);
  await assert.rejects(
    store.getMeeting(context, 'meeting-a'),
    (error) => error.code === 'MANIFEST_SEGMENT_MISMATCH'
  );
});

test('segment, manifest, and meeting writes are atomic on storage failure', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-a');
  const session = await preparedRecording(store, context);
  backend.failNextAtomic(new Error('SIMULATED_PROCESS_CRASH_BEFORE_COMMIT'));

  await assert.rejects(
    store.commitAudioSegment(context, { meetingId: session.meetingId, segment: segment(0), bytes: new Uint8Array([9, 8, 7]) }),
    (error) => error.code === 'SEGMENT_ATOMIC_COMMIT_FAILED'
  );
  const reopened = await store.getMeeting(context, session.meetingId);
  assert.equal(reopened.meeting.committedSegmentCount, 0);
  assert.equal(reopened.segments.length, 0);
  assert.equal(backend.dump().segments.length, 0);
});

test('ciphertext or AAD tampering is rejected while the original segment remains encrypted', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-a');
  const session = await preparedRecording(store, context);
  await store.commitAudioSegment(context, { meetingId: session.meetingId, segment: segment(0), bytes: new Uint8Array([5, 4, 3]) });
  const segmentKey = backend.dump().segments.find((record) => record.segmentId === 'segment-0')?.id;
  backend.mutate('segments', segmentKey, (record) => ({
    ...record,
    audioCiphertext: Uint8Array.from(record.audioCiphertext, (value, index) => index === 0 ? value ^ 0xff : value)
  }));

  await assert.rejects(
    store.getMeeting(context, session.meetingId),
    (error) => error.code === 'MEETING_CIPHERTEXT_INVALID'
  );
});

test('v4 to v6 IndexedDB upgrade adds only pendingSegments and analysisBundles and preserves prior stores', async () => {
  const priorStores = [
    'meetings',
    'manifests',
    'segments',
    'audioSources',
    'audioManifests',
    'audioAssets',
    'transcriptDocuments',
    'transcriptRevisions',
    'transcriptionJobs',
    'transcriptionChunks',
    'diarizationDocuments',
    'diarizationRevisions',
    'diarizationJobs'
  ];
  const stores = new Set(priorStores);
  const created = [];
  let openedVersion = 0;
  let transaction = null;
  const database = {
    objectStoreNames: {
      contains(name) {
        return stores.has(name);
      }
    },
    createObjectStore(name) {
      created.push(name);
      stores.add(name);
    },
    transaction() {
      transaction = {
        objectStore() {
          return {
            getAll() {
              const result = {};
              queueMicrotask(() => {
                result.result = [];
                result.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return result;
            }
          };
        }
      };
      return transaction;
    }
  };
  const indexedDBImpl = {
    open(_name, version) {
      openedVersion = version;
      const request = { result: database };
      queueMicrotask(() => {
        request.onupgradeneeded?.({ oldVersion: 4, newVersion: version });
        request.onsuccess?.();
      });
      return request;
    }
  };

  const backend = createIndexedDbMeetingBackend({ indexedDBImpl, databaseName: 'upgrade-test' });
  await backend.list('meetings');

  assert.equal(MEETING_PHASE1_DATABASE_VERSION, 6);
  assert.deepEqual(created, ['pendingSegments', 'analysisBundles']);
  assert.deepEqual(priorStores.filter((name) => !stores.has(name)), []);
  assert.equal(openedVersion, 6);
});

test('pending CaptureUnit journal is encrypted, owner-scoped, and atomically advances durable audio', async () => {
  const backend = createMemoryMeetingBackend();
  const keyProvider = await createKeyProvider();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider, backend });
  const context = ownerContext('owner-journal');
  await preparedRecording(store, context);
  const pending = await reserveAndStage(store, context, { marker: 'SECRET_CAPTURE_AUDIO' });

  const raw = backend.dump().pendingSegments[0];
  assert.equal(raw.captureOrdinal, 0);
  assert.equal(Object.hasOwn(raw, 'chunkToken'), false);
  assert.equal(Object.hasOwn(raw, 'audioBytes'), false);
  assert.doesNotMatch(JSON.stringify(raw), /SECRET_CAPTURE_AUDIO/);
  assert.doesNotMatch(JSON.stringify(raw), new RegExp(pending.reservation.chunkToken));

  await assert.rejects(
    store.commitPendingCaptureUnit(ownerContext('owner-other'), {
      meetingId: 'meeting-a',
      journalId: pending.staged.journalId
    }),
    (error) => error?.code === 'MEETING_NOT_FOUND'
  );
  const committed = await store.commitPendingCaptureUnit(context, {
    meetingId: 'meeting-a',
    journalId: pending.staged.journalId
  });

  assert.equal(committed.segment.sequence, 0);
  assert.equal(committed.segment.captureOrdinal, 0);
  assert.equal(committed.segment.containerLayout, INDEPENDENT_MP4_SEGMENTS_V1);
  assert.equal(committed.meeting.committedDurationMs, 12_000);
  assert.equal(committed.manifest.expectedSegmentIndex, 1);
  assert.equal(backend.dump().pendingSegments.length, 0);
  const reopened = await store.getMeeting(context, 'meeting-a');
  assert.equal(reopened.segments[0].captureUnitId, pending.reservation.captureUnitId);
  assert.equal(reopened.audioSources[0].containerLayout, INDEPENDENT_MP4_SEGMENTS_V1);
});

test('pending journal rejects owner override, token conflict, and retains bytes after append failure', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-conflict');
  await preparedRecording(store, context);

  const reservation = await store.reserveCaptureUnit(context, {
    meetingId: 'meeting-a',
    sourceId: 'recorded-meeting-a',
    recordingAttemptId: 'attempt-a',
    captureEpoch: 0
  });
  const originalBytes = new TextEncoder().encode('ORIGINAL_PENDING_BYTES');
  const originalUnit = await captureUnit(reservation, originalBytes);
  const staged = await store.stagePendingCaptureUnit(context, {
    meetingId: 'meeting-a',
    sourceId: 'recorded-meeting-a',
    recordingAttemptId: 'attempt-a',
    unit: originalUnit,
    bytes: originalBytes
  });

  await assert.rejects(
    store.stagePendingCaptureUnit(context, {
      ownerId: 'owner-forged',
      meetingId: 'meeting-a',
      sourceId: 'recorded-meeting-a',
      recordingAttemptId: 'attempt-a',
      unit: originalUnit,
      bytes: originalBytes
    }),
    (error) => error?.code === 'OWNER_ID_OVERRIDE_REJECTED'
  );
  const changedBytes = new TextEncoder().encode('CHANGED_PENDING_BYTES');
  await assert.rejects(
    store.stagePendingCaptureUnit(context, {
      meetingId: 'meeting-a',
      sourceId: 'recorded-meeting-a',
      recordingAttemptId: 'attempt-a',
      unit: await captureUnit(reservation, changedBytes),
      bytes: changedBytes
    }),
    (error) => error?.code === 'PENDING_SEGMENT_TOKEN_CONFLICT'
  );

  backend.failNextAtomic(new Error('SIMULATED_APPEND_FAILURE'));
  await assert.rejects(
    store.commitPendingCaptureUnit(context, { meetingId: 'meeting-a', journalId: staged.journalId }),
    (error) => error?.code === 'SEGMENT_ATOMIC_COMMIT_FAILED'
  );
  assert.equal(backend.dump().pendingSegments.length, 1);
  assert.equal((await store.getMeeting(context, 'meeting-a')).meeting.committedDurationMs, 0);
});

test('pending journal computes the trusted checksum when CaptureUnit omits it', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-computed-checksum');
  await preparedRecording(store, context);
  const reservation = await store.reserveCaptureUnit(context, {
    meetingId: 'meeting-a',
    sourceId: 'recorded-meeting-a',
    recordingAttemptId: 'attempt-a',
    captureEpoch: 0
  });
  const audioBytes = new TextEncoder().encode('COMPUTED_BY_PERSISTENCE_BOUNDARY');
  const withChecksum = await captureUnit(reservation, audioBytes);
  const { checksum: _untrustedChecksum, ...unit } = withChecksum;

  const staged = await store.stagePendingCaptureUnit(context, {
    meetingId: 'meeting-a',
    sourceId: 'recorded-meeting-a',
    recordingAttemptId: 'attempt-a',
    unit,
    bytes: audioBytes
  });
  const committed = await store.commitPendingCaptureUnit(context, {
    meetingId: 'meeting-a',
    journalId: staged.journalId
  });

  assert.equal(committed.segment.checksum, await sha256Hex(audioBytes));
});

test('refresh replay and append-before-cleanup replay are idempotent and never duplicate duration', async () => {
  const backend = createMemoryMeetingBackend();
  const keyProvider = await createKeyProvider();
  const firstStore = createMeetingPhase1Store({ cryptoImpl, keyProvider, backend });
  const context = ownerContext('owner-replay');
  await preparedRecording(firstStore, context);
  const firstPending = await reserveAndStage(firstStore, context, { marker: 'REFRESH_PENDING' });

  const reopenedStore = createMeetingPhase1Store({ cryptoImpl, keyProvider, backend });
  const replayed = await reopenedStore.replayPendingCaptureUnits(context, { meetingId: 'meeting-a' });
  assert.equal(replayed.committedCount, 1);
  assert.equal((await reopenedStore.getMeeting(context, 'meeting-a')).meeting.committedDurationMs, 12_000);

  const secondPending = await reserveAndStage(reopenedStore, context, { marker: 'APPEND_BEFORE_CLEANUP' });
  const retainedEncryptedRow = structuredClone(backend.dump().pendingSegments[0]);
  await reopenedStore.commitPendingCaptureUnit(context, {
    meetingId: 'meeting-a',
    journalId: secondPending.staged.journalId
  });
  await backend.atomicPut([{
    storeName: 'pendingSegments',
    id: retainedEncryptedRow.id,
    value: retainedEncryptedRow
  }]);

  const afterCrashStore = createMeetingPhase1Store({ cryptoImpl, keyProvider, backend });
  const duplicateReplay = await afterCrashStore.replayPendingCaptureUnits(context, { meetingId: 'meeting-a' });
  const recovered = await afterCrashStore.getMeeting(context, 'meeting-a');
  assert.equal(duplicateReplay.idempotentCount, 1);
  assert.equal(recovered.meeting.committedSegmentCount, 2);
  assert.equal(recovered.meeting.committedDurationMs, 24_000);
  assert.equal(backend.dump().pendingSegments.length, 0);
});

test('out-of-order sealed units wait for the earlier ordinal and then commit in ordinal order', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-order');
  await preparedRecording(store, context);
  const sourceId = 'recorded-meeting-a';
  const common = { meetingId: 'meeting-a', sourceId, recordingAttemptId: 'attempt-a', captureEpoch: 0 };
  const first = await store.reserveCaptureUnit(context, common);
  const second = await store.reserveCaptureUnit(context, common);
  const secondBytes = new TextEncoder().encode('SECOND_SEALED_FIRST');
  await store.stagePendingCaptureUnit(context, {
    ...common,
    unit: await captureUnit(second, secondBytes),
    bytes: secondBytes
  });

  await assert.rejects(
    store.replayPendingCaptureUnits(context, { meetingId: 'meeting-a' }),
    (error) => error?.code === 'PENDING_SEGMENT_OUT_OF_ORDER'
  );

  const firstBytes = new TextEncoder().encode('FIRST_SEALED_SECOND');
  await store.stagePendingCaptureUnit(context, {
    ...common,
    unit: await captureUnit(first, firstBytes),
    bytes: firstBytes
  });
  const replayed = await store.replayPendingCaptureUnits(context, { meetingId: 'meeting-a' });
  const meeting = await store.getMeeting(context, 'meeting-a');
  assert.equal(replayed.committedCount, 2);
  assert.deepEqual(meeting.segments.map((item) => item.captureOrdinal), [0, 1]);
  assert.deepEqual(meeting.segments.map((item) => item.sequence), [0, 1]);
});

test('a discontinuity consumes capture ordinal only and later committed sequence stays contiguous', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const context = ownerContext('owner-discontinuity');
  await preparedRecording(store, context);
  const common = {
    meetingId: 'meeting-a',
    sourceId: 'recorded-meeting-a',
    recordingAttemptId: 'attempt-a',
    captureEpoch: 0
  };
  const failed = await store.reserveCaptureUnit(context, common);
  await store.recordCaptureDiscontinuity(context, {
    ...common,
    captureOrdinal: failed.captureOrdinal,
    captureUnitId: failed.captureUnitId,
    chunkToken: failed.chunkToken,
    errorCode: 'CAPTURE_UNIT_EMPTY_BLOB'
  });
  const healthy = await reserveAndStage(store, context, { marker: 'HEALTHY_AFTER_GAP' });
  await store.replayPendingCaptureUnits(context, { meetingId: 'meeting-a' });
  const reopened = await store.getMeeting(context, 'meeting-a');

  assert.equal(healthy.reservation.captureOrdinal, 1);
  assert.equal(reopened.segments.length, 1);
  assert.equal(reopened.segments[0].captureOrdinal, 1);
  assert.equal(reopened.segments[0].sequence, 0);
  assert.equal(reopened.meeting.committedDurationMs, 12_000);
  assert.equal(reopened.manifest.captureOrdinals[0].state, 'discontinuity');
  assert.equal(reopened.manifest.captureOrdinals[1].state, 'committed');
});

test('meeting deletion removes only the matching owner and meeting pending rows', async () => {
  const backend = createMemoryMeetingBackend();
  const keyProvider = await createKeyProvider();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider, backend });
  const ownerA = ownerContext('owner-delete-a');
  const ownerB = ownerContext('owner-delete-b');
  await preparedRecording(store, ownerA);
  await preparedRecording(store, ownerB);
  await reserveAndStage(store, ownerA, { marker: 'OWNER_A_PENDING' });
  await reserveAndStage(store, ownerB, { marker: 'OWNER_B_PENDING' });

  await store.deleteMeeting(ownerA, 'meeting-a');
  assert.equal(backend.dump().pendingSegments.length, 1);
  assert.equal((await store.getMeeting(ownerB, 'meeting-a')).meeting.ownerId, 'owner-delete-b');
  const replay = await store.replayPendingCaptureUnits(ownerB, { meetingId: 'meeting-a' });
  assert.equal(replay.committedCount, 1);
});
