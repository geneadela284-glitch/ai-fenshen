import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MEETING_PHASE1_STATES,
  createMeetingPhase1Session,
  transitionMeetingPhase1Session
} from './meetingPhase1State.js';

const NOW = '2026-08-14T14:00:00.000Z';

function recordingSession() {
  let session = createMeetingPhase1Session({
    meetingId: 'meeting-finalization-pending',
    ownerId: 'owner-finalization-pending',
    now: NOW
  });
  session = transitionMeetingPhase1Session(session, { type: 'prepare' }, { now: NOW }).state;
  session = transitionMeetingPhase1Session(session, { type: 'recorder_started', actualStarted: true }, { now: NOW }).state;
  session = transitionMeetingPhase1Session(session, {
    type: 'segment_committed',
    sequence: 0,
    durationMs: 1_200_000,
    byteLength: 128_000
  }, { now: NOW }).state;
  return session;
}

test('finalization pending preserves durable duration and finalization retry is idempotent', () => {
  assert.equal(MEETING_PHASE1_STATES.includes('finalization_pending'), true);
  const pending = transitionMeetingPhase1Session(recordingSession(), {
    type: 'finalization_pending',
    errorCode: 'MEDIA_RECORDER_REQUEST_DATA_FAILED'
  }, { now: NOW });

  assert.equal(pending.accepted, true);
  assert.equal(pending.state.recordingState, 'finalization_pending');
  assert.equal(pending.state.committedSegmentCount, 1);
  assert.equal(pending.state.committedDurationMs, 1_200_000);
  assert.equal(pending.state.recoverable, true);
  assert.equal(pending.state.errorCode, 'MEDIA_RECORDER_REQUEST_DATA_FAILED');

  const finalized = transitionMeetingPhase1Session(pending.state, { type: 'finalize' }, { now: NOW });
  assert.equal(finalized.accepted, true);
  assert.equal(finalized.state.recordingState, 'stopped');
  assert.equal(finalized.state.committedSegmentCount, 1);
  assert.equal(finalized.state.committedDurationMs, 1_200_000);
  assert.equal(finalized.state.recoverable, false);

  const repeated = transitionMeetingPhase1Session(finalized.state, { type: 'finalize' }, { now: NOW });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.state.recordingState, 'stopped');
});
