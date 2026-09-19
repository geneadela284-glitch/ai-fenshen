import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEETING_PHASE0_SCHEMA_VERSION,
  createAudioManifest,
  createAudioSegment,
  createMeeting,
  createTranscriptRevision,
  validateAudioManifest,
  validateAudioSegment,
  validateMeeting,
  validateTranscriptRevision
} from './meetingDataContracts.js';

test('meeting contracts normalize owner and required encrypted-data fields', () => {
  const meeting = createMeeting({
    meetingId: 'meeting-a',
    ownerId: 'forged-owner',
    trustedOwnerId: 'owner-a',
    title: '合同会议',
    sourceType: 'recording'
  });
  const manifest = createAudioManifest({ meetingId: meeting.meetingId, ownerId: meeting.ownerId });
  const segment = createAudioSegment({
    meetingId: meeting.meetingId,
    ownerId: meeting.ownerId,
    segmentId: 'segment-0',
    segmentIndex: 0,
    durationMs: 1000,
    byteSize: 1,
    plaintextHash: 'a'.repeat(64),
    encryptedBlobRef: 'segments/segment-0.enc',
    nonceRef: 'nonce-0'
  });
  const revision = createTranscriptRevision({
    meetingId: meeting.meetingId,
    ownerId: meeting.ownerId,
    transcriptRevisionId: 'transcript-raw-1',
    source: 'raw_asr',
    status: 'raw_ready',
    encryptedContentRef: 'records/transcript-raw-1.enc'
  });

  assert.equal(MEETING_PHASE0_SCHEMA_VERSION, 1);
  assert.equal(meeting.ownerId, 'owner-a');
  assert.equal(validateMeeting(meeting).valid, true);
  assert.equal(validateAudioManifest(manifest).valid, true);
  assert.equal(validateAudioSegment(segment).valid, true);
  assert.equal(validateTranscriptRevision(revision).valid, true);
  assert.equal(Object.prototype.hasOwnProperty.call(segment, 'plaintext'), false);
  assert.equal(Object.isFrozen(meeting), true);
});

test('contracts reject owner mismatch, invalid segment order and mutable raw revisions', () => {
  const segment = createAudioSegment({
    meetingId: 'meeting-a', ownerId: 'owner-a', segmentId: 'segment-0', segmentIndex: 0,
    durationMs: 1000, plaintextHash: 'a'.repeat(64), encryptedBlobRef: 'segments/0.enc', nonceRef: 'nonce'
  });
  assert.equal(validateAudioSegment(segment, { ownerId: 'owner-b' }).valid, false);
  assert.equal(validateAudioSegment({ ...segment, durationMs: 0 }).valid, false);
  assert.equal(validateAudioSegment({ ...segment, segmentIndex: -1 }).valid, false);

  const raw = createTranscriptRevision({
    meetingId: 'meeting-a', ownerId: 'owner-a', transcriptRevisionId: 'raw-1',
    source: 'raw_asr', status: 'raw_ready', encryptedContentRef: 'records/raw-1.enc'
  });
  assert.equal(validateTranscriptRevision({ ...raw, status: 'user_edited', parentRevisionId: null }).valid, false);
});
