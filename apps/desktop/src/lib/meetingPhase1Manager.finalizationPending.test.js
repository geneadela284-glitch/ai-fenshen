import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

import { createMemoryMeetingBackend, createMeetingPhase1Store } from './browserMeetingStore.js';
import { createMeetingPhase1Manager } from './meetingPhase1Manager.js';
import {
  INDEPENDENT_MP4_SEGMENTS_V1,
  ROTATING_INDEPENDENT_MP4_MODE
} from './meetingRecordingContainerLayout.js';

const cryptoImpl = webcrypto;
const ownerContext = Object.freeze({
  trusted: true,
  ownerId: 'owner-finalization-manager',
  sessionId: 'session-finalization-manager',
  spaceId: 'meeting-space'
});

async function keyProvider() {
  const key = await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { withOwnerKey: (_context, callback) => callback(key) };
}

test('manager exposes FINALIZATION_PENDING, keeps durable audio, and retries finalize idempotently', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await keyProvider(), backend });
  let recorder = null;
  const manager = createMeetingPhase1Manager({
    ownerContext,
    store,
    recorderFactory: (callbacks) => {
      let status = 'idle';
      recorder = {
        get status() { return status; },
        async start() {
          status = 'recording';
          await callbacks.onStarted({ actualStarted: true });
        },
        async emitDurableSegment() {
          await callbacks.onSegment({
            blob: new Blob(['durable-before-finalization'], { type: 'audio/mp4;codecs=mp4a.40.2' }),
            durationMs: 1_200_000,
            mimeType: 'audio/mp4;codecs=mp4a.40.2',
            startedAt: '2026-08-14T14:00:00.000Z',
            endedAt: '2026-08-14T14:20:00.000Z'
          });
        },
        async stop() {
          status = 'idle';
          return {
            finalized: false,
            finalizationPending: true,
            finalizationErrorCode: 'MEDIA_RECORDER_REQUEST_DATA_FAILED',
            lastCommittedDurationMs: 1_200_000,
            committedSegmentCount: 1
          };
        },
        async interrupt(reason) {
          status = 'idle';
          await callbacks.onInterrupted({ reason });
          return { idempotent: false, reason };
        }
      };
      return recorder;
    }
  });

  await manager.initialize();
  await manager.createMeeting({ title: 'finalization-pending' });
  await manager.startRecording();
  await recorder.emitDurableSegment();

  const pending = await manager.stopRecording();
  assert.equal(pending.meeting.recordingState, 'finalization_pending');
  assert.equal(pending.meeting.finalizationPending, true);
  assert.equal(pending.meeting.committedDurationMs, 1_200_000);
  assert.equal(pending.segments.length, 1);

  const finalized = await manager.stopRecording();
  assert.equal(finalized.meeting.recordingState, 'stopped');
  assert.equal(finalized.meeting.finalizationPending, false);
  assert.equal(finalized.meeting.committedDurationMs, 1_200_000);
  assert.equal(finalized.segments.length, 1);

  const repeated = await manager.stopRecording();
  assert.equal(repeated.meeting.recordingState, 'stopped');
  assert.equal(repeated.segments.length, 1);
});

test('independent CaptureUnit retry replays or closes only the tail and never duplicates durable audio', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await keyProvider(), backend });
  const attemptId = 'attempt-independent-finalization';
  let recorder = null;
  const manager = createMeetingPhase1Manager({
    ownerContext,
    store,
    recorderOptions: { checkpointMode: ROTATING_INDEPENDENT_MP4_MODE },
    recorderFactory: (callbacks) => {
      let status = 'idle';
      recorder = {
        get status() { return status; },
        async start(input) {
          status = 'recording';
          const info = {
            actualStarted: true,
            recordingAttemptId: input.recordingAttemptId || attemptId,
            captureEpoch: input.captureEpoch,
            containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
            actualMimeType: 'audio/mp4;codecs=mp4a.40.2'
          };
          await callbacks.onStarted(info);
          return info;
        },
        async emitDurableUnit() {
          const reservation = await callbacks.capturePersistencePort.reserveCaptureUnit({
            recordingAttemptId: attemptId,
            captureEpoch: 0
          });
          const bytes = Uint8Array.of(1, 2, 3, 4);
          const staged = await callbacks.capturePersistencePort.stagePendingCaptureUnit({
            recordingAttemptId: attemptId,
            captureEpoch: 0,
            unit: {
              identity: {
                pageEpoch: 'page-independent-finalization',
                recorderGeneration: 1,
                captureEpoch: 0,
                ...reservation
              },
              startedAt: '2026-08-15T14:00:00.000Z',
              endedAt: '2026-08-15T14:00:12.000Z',
              durationMs: 12_000,
              mimeType: 'audio/mp4;codecs=mp4a.40.2',
              containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
              byteLength: bytes.byteLength
            },
            bytes
          });
          return callbacks.capturePersistencePort.commitPendingCaptureUnit({ journalId: staged.journalId });
        },
        async stop() {
          await callbacks.capturePersistencePort.reserveCaptureUnit({
            recordingAttemptId: attemptId,
            captureEpoch: 0
          });
          status = 'idle';
          return {
            finalized: false,
            finalizationPending: true,
            finalizationErrorCode: 'FINALIZATION_PENDING_TAIL_SEAL',
            lastCommittedDurationMs: 12_000
          };
        },
        async interrupt() { status = 'idle'; }
      };
      return recorder;
    }
  });

  await manager.initialize();
  await manager.createMeeting({ title: 'independent-finalization-retry' });
  await manager.startRecording();
  await recorder.emitDurableUnit();
  const pending = await manager.stopRecording();
  assert.equal(pending.meeting.recordingState, 'finalization_pending');
  assert.equal(pending.meeting.committedDurationMs, 12_000);
  assert.equal(pending.segments.length, 1);

  const finalized = await manager.stopRecording();
  assert.equal(finalized.meeting.recordingState, 'stopped');
  assert.equal(finalized.meeting.committedDurationMs, 12_000);
  assert.equal(finalized.segments.length, 1);
  assert.deepEqual(finalized.segments.map((segment) => segment.sequence), [0]);
  assert.deepEqual(finalized.manifest.captureOrdinals.map((entry) => entry.state), ['committed', 'discontinuity']);
  assert.equal(backend.dump().pendingSegments.length, 0);

  const repeated = await manager.stopRecording();
  assert.equal(repeated.segments.length, 1);
  assert.equal(repeated.meeting.committedDurationMs, 12_000);
});
