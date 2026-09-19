import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEETING_PHASE1_STATES,
  createMeetingPhase1Session,
  transitionMeetingPhase1Session
} from './meetingPhase1State.js';
import {
  CONTINUOUS_FRAGMENT_STREAM_V1,
  INDEPENDENT_MP4_SEGMENTS_V1
} from './meetingRecordingContainerLayout.js';

const NOW = '2026-08-06T12:00:00.000Z';

function readySession() {
  const draft = createMeetingPhase1Session({
    meetingId: 'meeting-a',
    ownerId: 'owner-a',
    title: '现场会议',
    now: NOW
  });
  return transitionMeetingPhase1Session(draft, { type: 'prepare' }, { now: NOW }).state;
}

test('phase 1 session exposes the frozen lifecycle states and prepares a draft', () => {
  assert.deepEqual(MEETING_PHASE1_STATES, ['draft', 'ready', 'recording', 'interrupted', 'finalization_pending', 'stopped', 'failed_retryable', 'failed_terminal']);
  const session = createMeetingPhase1Session({ meetingId: 'meeting-a', ownerId: 'owner-a', title: '现场会议', now: NOW });
  assert.equal(session.recordingState, 'draft');
  assert.equal(session.ownerId, 'owner-a');
  const prepared = transitionMeetingPhase1Session(session, { type: 'prepare' }, { now: NOW });
  assert.equal(prepared.state.recordingState, 'ready');
  assert.equal(prepared.accepted, true);
});

test('recording starts only after a real MediaRecorder start signal', () => {
  const session = readySession();
  const failed = transitionMeetingPhase1Session(session, { type: 'recorder_started', actualStarted: false }, { now: NOW });
  assert.equal(failed.state.recordingState, 'failed_retryable');
  assert.equal(failed.errorCode, 'MEDIA_RECORDER_NOT_STARTED');

  const started = transitionMeetingPhase1Session(session, { type: 'recorder_started', actualStarted: true }, { now: NOW });
  assert.equal(started.state.recordingState, 'recording');
  assert.equal(started.state.actualRecorderStarted, true);
});

test('logical recording identity is fixed on first start and capture epoch advances only on explicit resume', () => {
  const ready = readySession();
  const started = transitionMeetingPhase1Session(ready, {
    type: 'recorder_started',
    actualStarted: true,
    recordingAttemptId: 'attempt-stable',
    captureEpoch: 0,
    containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
  }, { now: NOW });
  assert.equal(started.accepted, true);
  assert.equal(started.state.recordingAttemptId, 'attempt-stable');
  assert.equal(started.state.captureEpoch, 0);
  assert.equal(started.state.containerLayout, INDEPENDENT_MP4_SEGMENTS_V1);

  const interrupted = transitionMeetingPhase1Session(started.state, {
    type: 'interrupted',
    reason: 'page_reload_recovery'
  }, { now: NOW }).state;
  const resumed = transitionMeetingPhase1Session(interrupted, {
    type: 'recorder_started',
    actualStarted: true,
    explicitResume: true,
    recordingAttemptId: 'attempt-stable',
    captureEpoch: 1,
    containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
  }, { now: NOW });
  assert.equal(resumed.accepted, true);
  assert.equal(resumed.state.recordingAttemptId, 'attempt-stable');
  assert.equal(resumed.state.captureEpoch, 1);
});

test('attempt, layout, and capture epoch mismatch fail closed without changing the interrupted session', () => {
  const started = transitionMeetingPhase1Session(readySession(), {
    type: 'recorder_started',
    actualStarted: true,
    recordingAttemptId: 'attempt-stable',
    captureEpoch: 0,
    containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
  }, { now: NOW }).state;
  const interrupted = transitionMeetingPhase1Session(started, {
    type: 'interrupted',
    reason: 'user_pause'
  }, { now: NOW }).state;
  const fixtures = [
    {
      event: {
        recordingAttemptId: 'attempt-forged',
        captureEpoch: 1,
        containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
      },
      errorCode: 'RECORDING_ATTEMPT_ID_MISMATCH'
    },
    {
      event: {
        recordingAttemptId: 'attempt-stable',
        captureEpoch: 1,
        containerLayout: CONTINUOUS_FRAGMENT_STREAM_V1
      },
      errorCode: 'RECORDING_CONTAINER_LAYOUT_MISMATCH'
    },
    {
      event: {
        recordingAttemptId: 'attempt-stable',
        captureEpoch: 0,
        containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
      },
      errorCode: 'CAPTURE_EPOCH_MISMATCH'
    }
  ];
  for (const fixture of fixtures) {
    const result = transitionMeetingPhase1Session(interrupted, {
      type: 'recorder_started',
      actualStarted: true,
      explicitResume: true,
      ...fixture.event
    }, { now: NOW });
    assert.equal(result.accepted, false);
    assert.equal(result.errorCode, fixture.errorCode);
    assert.deepEqual(result.state, interrupted);
  }
});

test('legacy sessions without logical identity fields default safely to continuous layout', () => {
  const legacy = { ...readySession() };
  delete legacy.recordingAttemptId;
  delete legacy.captureEpoch;
  delete legacy.containerLayout;
  const started = transitionMeetingPhase1Session(legacy, {
    type: 'recorder_started',
    actualStarted: true
  }, { now: NOW });

  assert.equal(started.accepted, true);
  assert.equal(started.state.recordingAttemptId, '');
  assert.equal(started.state.captureEpoch, -1);
  assert.equal(started.state.containerLayout, CONTINUOUS_FRAGMENT_STREAM_V1);
});

test('illegal transitions are rejected and stopped sessions cannot accept segments', () => {
  const draft = createMeetingPhase1Session({ meetingId: 'meeting-a', ownerId: 'owner-a', now: NOW });
  const illegal = transitionMeetingPhase1Session(draft, { type: 'stop' }, { now: NOW });
  assert.equal(illegal.accepted, false);
  assert.equal(illegal.errorCode, 'SESSION_NOT_READY');

  const recording = transitionMeetingPhase1Session(readySession(), { type: 'recorder_started', actualStarted: true }, { now: NOW }).state;
  const stopped = transitionMeetingPhase1Session(recording, { type: 'stop' }, { now: NOW }).state;
  const segment = transitionMeetingPhase1Session(stopped, { type: 'segment_committed', durationMs: 1000, byteLength: 10 }, { now: NOW });
  assert.equal(stopped.recordingState, 'stopped');
  assert.equal(segment.accepted, false);
  assert.equal(segment.errorCode, 'SESSION_STOPPED');
});

test('interruption never auto-resumes and explicit recorder start is required', () => {
  const recording = transitionMeetingPhase1Session(readySession(), { type: 'recorder_started', actualStarted: true }, { now: NOW }).state;
  const interrupted = transitionMeetingPhase1Session(recording, { type: 'interrupted', reason: 'page_hidden' }, { now: NOW }).state;
  assert.equal(interrupted.recordingState, 'interrupted');
  assert.equal(interrupted.interruptionReason, 'page_hidden');

  const stillInterrupted = transitionMeetingPhase1Session(interrupted, { type: 'tick' }, { now: NOW });
  assert.equal(stillInterrupted.state.recordingState, 'interrupted');
  assert.equal(stillInterrupted.accepted, false);

  const resumed = transitionMeetingPhase1Session(interrupted, { type: 'recorder_started', actualStarted: true, explicitResume: true }, { now: NOW });
  assert.equal(resumed.state.recordingState, 'recording');
  assert.equal(resumed.state.interruptionReason, '');
});

test('asset gate failure during durable interrupted resume preserves the explicit-resume state', () => {
  const recording = transitionMeetingPhase1Session(
    readySession(),
    { type: 'recorder_started', actualStarted: true },
    { now: NOW }
  ).state;
  const committed = transitionMeetingPhase1Session(recording, {
    type: 'segment_committed',
    durationMs: 12_000,
    byteLength: 1_024,
    sequence: 0
  }, { now: NOW }).state;
  const interrupted = transitionMeetingPhase1Session(
    committed,
    { type: 'interrupted', reason: 'page_reload_recovery' },
    { now: NOW }
  ).state;

  const blocked = transitionMeetingPhase1Session(interrupted, {
    type: 'recorder_start_failed',
    errorCode: 'CLIENT_ASSET_VERSION_MISMATCH'
  }, { now: NOW });

  assert.equal(blocked.accepted, true);
  assert.equal(blocked.state.recordingState, 'interrupted');
  assert.equal(blocked.state.interruptionReason, 'page_reload_recovery');
  assert.equal(blocked.state.errorCode, 'CLIENT_ASSET_VERSION_MISMATCH');
  assert.equal(blocked.state.committedSegmentCount, 1);
  assert.equal(blocked.state.committedDurationMs, 12_000);
});

test('current client recovery clears only a durable legacy asset mismatch without losing audio', () => {
  const legacy = Object.freeze({
    ...readySession(),
    recordingState: 'failed_retryable',
    committedSegmentCount: 25,
    committedDurationMs: 300_000,
    lastCommittedDurationMs: 300_000,
    lastPersistedSequence: 24,
    recoverable: true,
    interruptionReason: 'page_reload_recovery',
    errorCode: 'CLIENT_ASSET_VERSION_MISMATCH'
  });

  const recovered = transitionMeetingPhase1Session(
    legacy,
    { type: 'asset_gate_recovered' },
    { now: NOW }
  );

  assert.equal(recovered.accepted, true);
  assert.equal(recovered.state.recordingState, 'interrupted');
  assert.equal(recovered.state.interruptionReason, 'page_reload_recovery');
  assert.equal(recovered.state.errorCode, '');
  assert.equal(recovered.state.committedSegmentCount, 25);
  assert.equal(recovered.state.committedDurationMs, 300_000);
  assert.equal(recovered.state.lastPersistedSequence, 24);
});

test('duplicate stop and duplicate interruption are idempotent', () => {
  const recording = transitionMeetingPhase1Session(readySession(), { type: 'recorder_started', actualStarted: true }, { now: NOW }).state;
  const stopped = transitionMeetingPhase1Session(recording, { type: 'stop' }, { now: NOW });
  const repeatedStop = transitionMeetingPhase1Session(stopped.state, { type: 'stop' }, { now: NOW });
  assert.equal(repeatedStop.accepted, false);
  assert.equal(repeatedStop.idempotent, true);
  assert.equal(repeatedStop.state.recordingState, 'stopped');

  const interrupted = transitionMeetingPhase1Session(recording, { type: 'interrupted', reason: 'page_hidden' }, { now: NOW }).state;
  const repeatedInterrupt = transitionMeetingPhase1Session(interrupted, { type: 'interrupted', reason: 'page_hidden' }, { now: NOW });
  assert.equal(repeatedInterrupt.accepted, false);
  assert.equal(repeatedInterrupt.idempotent, true);
});

test('durable checkpoint and watchdog state preserve recoverability without changing the recording state', () => {
  const recording = transitionMeetingPhase1Session(
    createMeetingPhase1Session({ meetingId: 'checkpoint-meeting', ownerId: 'owner-a', now: NOW }),
    { type: 'prepare' },
    { now: NOW }
  ).state;
  const active = transitionMeetingPhase1Session(recording, { type: 'recorder_started', actualStarted: true }, { now: NOW }).state;
  const checkpoint = transitionMeetingPhase1Session(active, {
    type: 'persistence_checkpoint',
    lastPersistedSequence: 3,
    lastCommittedDurationMs: 40_000,
    lastSuccessfulPersistAt: NOW
  }, { now: NOW });
  assert.equal(checkpoint.accepted, true);
  assert.equal(checkpoint.state.recordingState, 'recording');
  assert.equal(checkpoint.state.recoverable, true);
  assert.equal(checkpoint.state.lastPersistedSequence, 3);
  assert.equal(checkpoint.state.lastCommittedDurationMs, 40_000);
  const stalled = transitionMeetingPhase1Session(checkpoint.state, {
    type: 'persistence_stalled',
    errorCode: 'RECORDING_PERSISTENCE_STALLED'
  }, { now: NOW });
  assert.equal(stalled.accepted, true);
  assert.equal(stalled.state.recordingState, 'recording');
  assert.equal(stalled.state.persistenceStalled, true);
  assert.equal(stalled.state.errorCode, 'RECORDING_PERSISTENCE_STALLED');
});

test('rotation persistence failure becomes an explicit recoverable interruption after capture halts', () => {
  const recording = transitionMeetingPhase1Session(
    readySession(),
    {
      type: 'recorder_started',
      actualStarted: true,
      recordingAttemptId: 'attempt-rotation-stall',
      captureEpoch: 0,
      containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
    },
    { now: NOW }
  ).state;
  const interrupted = transitionMeetingPhase1Session(recording, {
    type: 'persistence_interrupted',
    errorCode: 'CAPTURE_UNIT_COMMIT_FAILED'
  }, { now: NOW });

  assert.equal(interrupted.accepted, true);
  assert.equal(interrupted.state.recordingState, 'interrupted');
  assert.equal(interrupted.state.actualRecorderStarted, false);
  assert.equal(interrupted.state.interruptionReason, 'CAPTURE_UNIT_COMMIT_FAILED');
  assert.equal(interrupted.state.errorCode, 'CAPTURE_UNIT_COMMIT_FAILED');
  assert.equal(interrupted.state.persistenceStalled, true);
  assert.equal(interrupted.state.recoverable, true);
});

test('segment commit failure enters retryable state and retry returns to ready', () => {
  const recording = transitionMeetingPhase1Session(readySession(), { type: 'recorder_started', actualStarted: true }, { now: NOW }).state;
  const failed = transitionMeetingPhase1Session(recording, { type: 'segment_commit_failed', errorCode: 'SEGMENT_ATOMIC_COMMIT_FAILED' }, { now: NOW });
  assert.equal(failed.accepted, true);
  assert.equal(failed.state.recordingState, 'failed_retryable');
  assert.equal(failed.state.errorCode, 'SEGMENT_ATOMIC_COMMIT_FAILED');
  const retried = transitionMeetingPhase1Session(failed.state, { type: 'retry' }, { now: NOW });
  assert.equal(retried.state.recordingState, 'ready');
});
