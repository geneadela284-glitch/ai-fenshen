import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTranscriptRevision,
  createTranscriptSegment,
  stableTranscriptSegmentId
} from '../stage3a/transcriptContracts.js';
import {
  createDiarizationRevision,
  createDiarizationSegment,
  createSpeakerRef
} from '../stage3b/diarizationContracts.js';
import {
  createBaseSpeakerCorrectionSnapshot,
  createSpeakerCorrectionRevision
} from '../stage3b/speakerCorrectionContracts.js';
import {
  createEvidenceRef,
  validateEvidenceRef
} from './meetingEvidenceRefContracts.js';
import { resolveEvidenceRef } from './meetingEvidenceRefResolver.js';

const NOW = '2026-08-16T10:00:00.000Z';
const HASH = 'a'.repeat(64);

function owner(ownerId = 'owner-a') {
  return { trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' };
}

function source(overrides = {}) {
  return {
    sourceId: 'source-a',
    meetingId: 'meeting-a',
    ownerId: 'owner-a',
    scope: 'meeting',
    origin: 'recorded',
    importState: 'committed',
    revision: 2,
    checksum: HASH,
    durationMs: 5_000,
    ...overrides
  };
}

function transcriptRevision({ revision = 1, firstText = '李总负责跟进报价，2026-08-17交付。', includeFirst = true } = {}) {
  const specs = [
    { sequence: 0, startMs: 0, endMs: 2_000, text: firstText },
    { sequence: 1, startMs: 2_000, endMs: 4_000, text: '金额暂未确定，会议暂不形成最终决定。' }
  ].filter((_, index) => includeFirst || index > 0).map((item, index) => includeFirst
    ? item
    : { ...item, sequence: index, startMs: 0, endMs: 2_000 });
  const segments = specs.map((item) => createTranscriptSegment({
    transcriptId: 'transcript-a',
    transcriptRevision: revision,
    segmentId: stableTranscriptSegmentId({ transcriptId: 'transcript-a', ...item }),
    sequence: item.sequence,
    startMs: item.startMs,
    endMs: item.endMs,
    text: item.text,
    confidence: 0.95,
    speakerRef: null,
    sourceChunkRefs: [`chunk-${item.sequence}`],
    revision
  }));
  return createTranscriptRevision({
    ownerContext: owner(),
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    transcriptRevision: revision,
    segments,
    createdAt: NOW,
    createdBy: 'system'
  });
}

function speakerContexts(transcript = transcriptRevision()) {
  const speakerRefs = [createSpeakerRef({
    ownerContext: owner(),
    meetingId: 'meeting-a',
    speakerId: 'speaker-1',
    createdAt: NOW,
    updatedAt: NOW
  })];
  const diarization = createDiarizationRevision({
    ownerContext: owner(),
    diarizationRevisionId: 'diarization-a-1',
    meetingId: 'meeting-a',
    transcriptId: 'transcript-a',
    transcriptRevision: transcript.transcriptRevision,
    speakerRefs,
    segments: [createDiarizationSegment({
      meetingId: 'meeting-a',
      transcriptId: 'transcript-a',
      transcriptRevision: transcript.transcriptRevision,
      transcriptSegmentId: transcript.segments[0].segmentId,
      startMs: transcript.segments[0].startMs,
      endMs: transcript.segments[0].endMs,
      speakerRef: 'speaker-1',
      confidence: 0.9,
      revision: 1
    })],
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1
  });
  const base = createBaseSpeakerCorrectionSnapshot({
    ownerContext: owner(),
    diarizationRevision: diarization,
    baseDiarizationSnapshotHash: HASH,
    now: NOW
  });
  const correction = createSpeakerCorrectionRevision({
    ownerContext: owner(),
    parent: base,
    correctionRevisionId: 'correction-a-1',
    speakerRefs: base.speakerRefs.map((item) => ({ ...item, displayLabel: '李总', labelSource: 'user_entered' })),
    assignments: base.assignments,
    nextSpeakerOrdinal: base.nextSpeakerOrdinal,
    audit: {
      mutationRequestId: 'mutation-a-1',
      operation: 'rename',
      actorType: 'owner_user',
      actorOwnerId: 'owner-a',
      changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '李总' }],
      occurredAt: NOW
    },
    createdAt: NOW
  });
  return { diarization, correction };
}

function evidence(overrides = {}) {
  const transcript = transcriptRevision();
  return createEvidenceRef({
    ownerContext: owner(),
    source: source(),
    transcriptRevision: transcript,
    segmentId: transcript.segments[0].segmentId,
    textSpan: { startOffset: 0, endOffset: 2, quote: '李总' },
    createdAt: NOW,
    ...overrides
  });
}

test('creates a valid owner-scoped EvidenceRef bound to the current segment', () => {
  const value = evidence();
  assert.equal(value.ownerId, 'owner-a');
  assert.equal(value.scope, 'meeting');
  assert.equal(value.meetingId, 'meeting-a');
  assert.equal(value.transcriptRevision, 1);
  assert.equal(value.status, 'VALID');
  assert.equal(validateEvidenceRef(value, {
    ownerContext: owner(),
    source: source(),
    transcriptRevision: transcriptRevision()
  }).valid, true);
});

test('rejects an EvidenceRef whose source belongs to another meeting', () => {
  assert.throws(
    () => evidence({ source: source({ meetingId: 'meeting-b' }) }),
    (error) => ['MEETING_SCOPE_MISMATCH', 'SOURCE_MEETING_MISMATCH', 'SOURCE_SCOPE_MISMATCH'].includes(error.code)
  );
});

test('rejects an EvidenceRef for a missing transcript segment', () => {
  assert.throws(
    () => evidence({ segmentId: 'segment-does-not-exist' }),
    (error) => error.code === 'EVIDENCE_SEGMENT_NOT_FOUND'
  );
});

test('marks a reference stale when the current transcript revision changes', () => {
  const original = transcriptRevision();
  const ref = evidence({ transcriptRevision: original });
  const changed = transcriptRevision({ revision: 2, firstText: '李总负责跟进报价，日期需要再次确认。' });
  const result = resolveEvidenceRef({
    ownerContext: owner(),
    evidenceRef: ref,
    source: source(),
    currentTranscriptRevision: changed
  });
  assert.equal(result.status, 'STALE');
  assert.equal(result.reason, 'TRANSCRIPT_TEXT_CHANGED');
});

test('marks a reference stale instead of silently retargeting the new text', () => {
  const ref = evidence();
  const current = transcriptRevision({ revision: 2 });
  const result = resolveEvidenceRef({
    ownerContext: owner(),
    evidenceRef: ref,
    source: source(),
    currentTranscriptRevision: current
  });
  assert.equal(result.status, 'STALE');
  assert.equal(result.transcriptLocator.transcriptRevision, 1);
});

test('marks a reference invalid when its segment was deleted', () => {
  const original = transcriptRevision();
  const ref = evidence({
    transcriptRevision: original,
    segmentId: original.segments[1].segmentId,
    textSpan: { startOffset: 0, endOffset: 2, quote: '金额' }
  });
  const current = transcriptRevision({ revision: 2, includeFirst: false });
  const result = resolveEvidenceRef({
    ownerContext: owner(),
    evidenceRef: ref,
    source: source(),
    currentTranscriptRevision: current
  });
  assert.equal(result.status, 'INVALID');
  assert.equal(result.reason, 'SEGMENT_DELETED');
});

test('projects only the corrected speaker name onto the EvidenceRef', () => {
  const transcript = transcriptRevision();
  const { diarization, correction } = speakerContexts(transcript);
  const ref = evidence({ transcriptRevision: transcript, diarizationRevision: diarization, speakerCorrectionRevision: correction });
  assert.equal(ref.speakerId, 'speaker-1');
  assert.equal(ref.resolvedSpeakerName, '李总');
});

test('keeps the raw diarization speaker unchanged when correction supplies a name', () => {
  const transcript = transcriptRevision();
  const { diarization, correction } = speakerContexts(transcript);
  const rawSnapshot = structuredClone(diarization);
  const ref = evidence({ transcriptRevision: transcript, diarizationRevision: diarization, speakerCorrectionRevision: correction });
  assert.equal(ref.speakerId, diarization.segments[0].speakerRef);
  assert.deepEqual(diarization, rawSnapshot);
  assert.equal(ref.resolvedSpeakerName, '李总');
});

test('requires an exact contiguous text span and stores its hash', () => {
  const ref = evidence({ textSpan: { startOffset: 0, endOffset: '李总负责'.length, quote: '李总负责' } });
  assert.equal(ref.textSpan.quote, '李总负责');
  assert.match(ref.textHash, /^[0-9a-f]{64}$/);
  assert.throws(
    () => evidence({ textSpan: { startOffset: 0, endOffset: 2, quote: '李总X' } }),
    (error) => error.code === 'EVIDENCE_TEXT_SPAN_MISMATCH'
  );
});

test('rejects cross-owner EvidenceRef creation', () => {
  const transcript = transcriptRevision();
  assert.throws(
    () => createEvidenceRef({
      ownerContext: owner('owner-b'),
      source: source(),
      transcriptRevision: transcript,
      segmentId: transcript.segments[0].segmentId,
      textSpan: { startOffset: 0, endOffset: 2, quote: '李总' },
      createdAt: NOW
    }),
    (error) => error.code === 'OWNER_SCOPE_MISMATCH'
  );
});

test('rejects cross-owner reads without revealing another owner record', () => {
  const ref = evidence();
  assert.throws(
    () => resolveEvidenceRef({
      ownerContext: owner('owner-b'),
      evidenceRef: ref,
      source: source(),
      currentTranscriptRevision: transcriptRevision()
    }),
    (error) => error.code === 'OWNER_SCOPE_MISMATCH'
  );
});

test('rejects cross-owner resolution through the grounding resolver', () => {
  const ref = evidence();
  assert.throws(
    () => resolveEvidenceRef({ ownerContext: owner('owner-b'), evidenceRef: ref }),
    (error) => error.code === 'OWNER_SCOPE_MISMATCH'
  );
});

test('creates an idempotent EvidenceRef for duplicate input', () => {
  const transcript = transcriptRevision();
  const input = {
    ownerContext: owner(),
    source: source(),
    transcriptRevision: transcript,
    segmentId: transcript.segments[0].segmentId,
    textSpan: { startOffset: 0, endOffset: 2, quote: '李总' },
    createdAt: NOW
  };
  assert.deepEqual(createEvidenceRef(input), createEvidenceRef(input));
});

test('resolves an EvidenceRef to transcript and bounded playback locations', () => {
  const ref = evidence();
  const result = resolveEvidenceRef({
    ownerContext: owner(),
    evidenceRef: ref,
    source: source(),
    currentTranscriptRevision: transcriptRevision()
  });
  assert.equal(result.status, 'VALID');
  assert.deepEqual(result.playbackLocator, {
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    startMs: 0,
    endMs: 2_000
  });
  assert.equal(result.transcriptLocator.segmentId, ref.segmentId);
});

test('rejects a corrupted text hash', () => {
  const invalid = { ...evidence(), textHash: 'b'.repeat(64) };
  const result = resolveEvidenceRef({
    ownerContext: owner(),
    evidenceRef: invalid,
    source: source(),
    currentTranscriptRevision: transcriptRevision()
  });
  assert.equal(result.status, 'INVALID');
  assert.equal(result.reason, 'TEXT_HASH_MISMATCH');
});

test('survives local-first serialization and reopen without copying transcript or audio', () => {
  const ref = evidence();
  const reopened = JSON.parse(JSON.stringify(ref));
  assert.equal('audio' in reopened, false);
  assert.equal('transcript' in reopened, false);
  const result = resolveEvidenceRef({
    ownerContext: owner(),
    evidenceRef: reopened,
    source: source(),
    currentTranscriptRevision: transcriptRevision()
  });
  assert.equal(result.status, 'VALID');
});
