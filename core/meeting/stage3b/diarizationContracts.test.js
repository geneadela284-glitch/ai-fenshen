import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIARIZATION_SCHEMA_VERSION,
  DIARIZATION_SOURCES,
  createDiarizationRevision,
  createDiarizationSegment,
  createSpeakerRef,
  validateDiarizationRevision
} from './diarizationContracts.js';

const ownerContext = Object.freeze({
  trusted: true,
  ownerId: 'owner-a',
  sessionId: 'session-a',
  spaceId: 'meeting-space'
});

const baseSegment = {
  meetingId: 'meeting-1',
  transcriptId: 'transcript-1',
  transcriptRevision: 7,
  transcriptSegmentId: 'segment-0',
  startMs: 0,
  endMs: 8_000,
  speakerRef: 'speaker-1',
  confidence: null,
  source: 'provider_role_separation',
  revision: 1
};

test('SpeakerRef defaults to anonymous labels and rejects identity-bearing labels', () => {
  const speaker = createSpeakerRef({
    ownerContext,
    meetingId: 'meeting-1',
    speakerId: 'speaker-1',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  });

  assert.deepEqual(speaker, {
    schemaVersion: DIARIZATION_SCHEMA_VERSION,
    speakerId: 'speaker-1',
    ownerId: 'owner-a',
    meetingId: 'meeting-1',
    label: '说话人1',
    source: 'provider_role_separation',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    revision: 1
  });

  assert.throws(
    () => createSpeakerRef({
      ownerContext,
      meetingId: 'meeting-1',
      speakerId: 'speaker-1',
      label: '张三'
    }),
    (error) => error.code === 'DIARIZATION_REAL_NAME_FORBIDDEN'
  );
  assert.throws(
    () => createSpeakerRef({
      ownerContext: { ...ownerContext, trusted: false },
      meetingId: 'meeting-1',
      speakerId: 'speaker-1'
    }),
    (error) => error.code === 'OWNER_CONTEXT_UNTRUSTED'
  );
});

test('DiarizationSegment keeps the immutable Stage 3A timeline and anonymous speakerRef', () => {
  const segment = createDiarizationSegment(baseSegment);
  assert.deepEqual(segment, {
    schemaVersion: DIARIZATION_SCHEMA_VERSION,
    meetingId: 'meeting-1',
    transcriptId: 'transcript-1',
    transcriptRevision: 7,
    transcriptSegmentId: 'segment-0',
    startMs: 0,
    endMs: 8_000,
    speakerRef: 'speaker-1',
    confidence: null,
    source: 'provider_role_separation',
    revision: 1
  });

  assert.throws(
    () => createDiarizationSegment({ ...baseSegment, speakerRef: '张三' }),
    (error) => error.code === 'DIARIZATION_SPEAKER_REF_INVALID'
  );
  assert.throws(
    () => createDiarizationSegment({ ...baseSegment, endMs: 0 }),
    (error) => error.code === 'DIARIZATION_TIMELINE_INVALID'
  );
});

test('DiarizationRevision binds every mapping to one Stage 3A transcript revision', () => {
  const speaker = createSpeakerRef({
    ownerContext,
    meetingId: 'meeting-1',
    speakerId: 'speaker-1',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  });
  const segment = createDiarizationSegment(baseSegment);
  const revision = createDiarizationRevision({
    ownerContext,
    diarizationRevisionId: 'diarization-revision-1',
    meetingId: 'meeting-1',
    transcriptId: 'transcript-1',
    transcriptRevision: 7,
    source: 'provider_role_separation',
    speakerRefs: [speaker],
    segments: [segment],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  });

  assert.equal(revision.schemaVersion, DIARIZATION_SCHEMA_VERSION);
  assert.equal(revision.transcriptRevision, 7);
  assert.deepEqual(validateDiarizationRevision(revision, { ownerContext }), { valid: true, errors: [] });
  assert.deepEqual(DIARIZATION_SOURCES, ['provider_role_separation', 'unknown']);

  assert.throws(
    () => createDiarizationRevision({
      ownerContext,
      diarizationRevisionId: 'diarization-revision-2',
      meetingId: 'meeting-1',
      transcriptId: 'transcript-1',
      transcriptRevision: 8,
      source: 'provider_role_separation',
      speakerRefs: [speaker],
      segments: [segment]
    }),
    (error) => error.code === 'DIARIZATION_SEGMENT_TRANSCRIPT_REVISION_MISMATCH'
  );
});
