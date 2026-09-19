import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEETING_AUDIO_IMPORT_STATES,
  createMeetingAudioImportSession,
  transitionMeetingAudioImport
} from './meetingAudioImportState.js';

function session() {
  return createMeetingAudioImportSession({
    importId: 'import-1',
    meetingId: 'meeting-1',
    ownerId: 'owner-1',
    sourceId: 'source-1',
    originalFileName: 'meeting.wav',
    mimeType: 'audio/wav',
    format: 'wav',
    byteLength: 1024,
    durationMs: 1000,
    now: '2026-08-07T00:00:00.000Z'
  });
}

function transition(current, event) {
  const result = transitionMeetingAudioImport(current, event, { now: '2026-08-07T00:00:01.000Z' });
  assert.equal(result.accepted, true);
  return result.state;
}

test('audio import contract exposes only the Stage 2 lifecycle', () => {
  assert.deepEqual(MEETING_AUDIO_IMPORT_STATES, [
    'selected',
    'validating',
    'importing',
    'committed',
    'rejected',
    'failed_retryable',
    'cancelled',
    'deleting',
    'deleted'
  ]);
});

test('audio import follows selected, validating, importing, committed', () => {
  let current = session();
  current = transition(current, { type: 'begin_validation' });
  current = transition(current, { type: 'validation_passed' });
  current = transition(current, { type: 'chunk_committed', byteLength: 512, durationMs: 500 });
  current = transition(current, { type: 'commit', checksum: 'a'.repeat(64) });
  assert.equal(current.importState, 'committed');
  assert.equal(current.chunkCount, 1);
  assert.equal(current.committedByteLength, 512);
  assert.equal(current.committedDurationMs, 500);
  assert.equal(current.checksum, 'a'.repeat(64));
});

test('rejection, retryable failure, cancellation and deletion are explicit', () => {
  let rejected = transition(session(), { type: 'begin_validation' });
  rejected = transition(rejected, { type: 'validation_rejected', errorCode: 'AUDIO_FORMAT_UNSUPPORTED' });
  assert.equal(rejected.importState, 'rejected');

  let failed = transition(session(), { type: 'begin_validation' });
  failed = transition(failed, { type: 'validation_passed' });
  failed = transition(failed, { type: 'failed_retryable', errorCode: 'IMPORT_STREAM_FAILED' });
  failed = transition(failed, { type: 'retry' });
  assert.equal(failed.importState, 'validating');

  let cancelled = transition(session(), { type: 'cancel' });
  assert.equal(cancelled.importState, 'cancelled');
  cancelled = transition(cancelled, { type: 'begin_delete' });
  cancelled = transition(cancelled, { type: 'delete' });
  assert.equal(cancelled.importState, 'deleted');
});

test('illegal terminal transitions fail closed', () => {
  let current = transition(session(), { type: 'begin_validation' });
  current = transition(current, { type: 'validation_passed' });
  current = transition(current, { type: 'commit', checksum: 'b'.repeat(64) });
  const result = transitionMeetingAudioImport(current, { type: 'retry' }, { now: '2026-08-07T00:00:02.000Z' });
  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'IMPORT_NOT_RETRYABLE');
  assert.equal(result.state.importState, 'committed');
});
