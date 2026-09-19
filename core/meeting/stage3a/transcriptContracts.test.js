import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTranscriptDocument,
  createTranscriptSegment,
  createTranscriptRevision,
  createCorrectionRevision,
  assertCommittedAudioSource,
  stableTranscriptSegmentId,
  validateTranscriptDocument,
  validateTranscriptSegment
} from './transcriptContracts.js';

function owner(ownerId = 'owner-a') {
  return Object.freeze({
    trusted: true,
    ownerId,
    sessionId: `session-${ownerId}`,
    spaceId: 'meeting-space'
  });
}

function source(overrides = {}) {
  return {
    sourceId: 'source-a',
    meetingId: 'meeting-a',
    ownerId: 'owner-a',
    scope: 'meeting',
    origin: 'imported',
    importState: 'committed',
    revision: 4,
    checksum: 'a'.repeat(64),
    ...overrides
  };
}

function documentValue(overrides = {}) {
  return createTranscriptDocument({
    ownerContext: owner(),
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 4,
    language: 'zh-CN',
    provider: 'deterministic-fixture',
    model: 'fixture-v1',
    status: 'partial',
    ...overrides
  });
}

function segment(overrides = {}) {
  return createTranscriptSegment({
    transcriptId: 'transcript-a',
    transcriptRevision: 1,
    segmentId: stableTranscriptSegmentId({ transcriptId: 'transcript-a', sequence: 0, startMs: 0, endMs: 1000 }),
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    text: '会议开始。',
    confidence: 0.91,
    speakerRef: null,
    sourceChunkRefs: ['chunk-0'],
    ...overrides
  });
}

test('TranscriptDocument is owner-scoped and records the source revision', () => {
  const value = documentValue();
  assert.equal(value.ownerId, 'owner-a');
  assert.equal(value.sourceRevision, 4);
  assert.equal(value.transcriptRevision, 1);
  assert.equal(validateTranscriptDocument(value, { ownerContext: owner(), source: source() }).valid, true);
  assert.throws(
    () => documentValue({ ownerId: 'owner-b' }),
    (error) => error.code === 'OWNER_ID_OVERRIDE_REJECTED'
  );
  assert.equal(
    validateTranscriptDocument(value, { ownerContext: owner('owner-b'), source: source({ ownerId: 'owner-b' }) }).valid,
    false
  );
});

test('only committed recorded/imported sources can enter Stage 3A', () => {
  assert.doesNotThrow(() => assertCommittedAudioSource({ ownerContext: owner(), source: source() }));
  for (const invalid of [
    source({ importState: 'importing' }),
    source({ importState: 'cancelled' }),
    source({ importState: 'deleted' }),
    source({ origin: 'pasted_transcript' }),
    source({ ownerId: 'owner-b' }),
    source({ scope: 'other' })
  ]) {
    assert.throws(
      () => assertCommittedAudioSource({ ownerContext: owner(), source: invalid }),
      (error) => ['AUDIO_SOURCE_NOT_COMMITTED', 'AUDIO_SOURCE_ORIGIN_INVALID', 'OWNER_SCOPE_MISMATCH', 'AUDIO_SCOPE_MISMATCH'].includes(error.code)
    );
  }
});

test('TranscriptSegment has a stable anchor, monotonic bounds and no guessed speaker', () => {
  const first = segment();
  const second = segment({
    transcriptRevision: 2,
    text: '会议正式开始。'
  });
  assert.equal(first.segmentId, second.segmentId);
  assert.equal(first.speakerRef, null);
  assert.equal(validateTranscriptSegment(first, { transcriptId: 'transcript-a', revision: 1, previousEndMs: 0 }).valid, true);
  assert.equal(validateTranscriptSegment({ ...first, speakerRef: '张三' }, { transcriptId: 'transcript-a', revision: 1 }).valid, false);
  assert.equal(validateTranscriptSegment({ ...first, endMs: 0 }, { transcriptId: 'transcript-a', revision: 1 }).valid, false);
});

test('raw revision is retained and correction changes text only', () => {
  const rawSegments = [segment(), segment({
    segmentId: stableTranscriptSegmentId({ transcriptId: 'transcript-a', sequence: 1, startMs: 1000, endMs: 2000 }),
    sequence: 1,
    startMs: 1000,
    endMs: 2000,
    text: '讨论预算。',
    sourceChunkRefs: ['chunk-1']
  })];
  const raw = createTranscriptRevision({
    ownerContext: owner(),
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 4,
    transcriptRevision: 1,
    kind: 'raw_asr',
    segments: rawSegments
  });
  const corrected = createCorrectionRevision({
    ownerContext: owner(),
    parent: raw,
    actorId: 'owner-a',
    edits: [{ segmentId: rawSegments[1].segmentId, text: '讨论预算和时间。', startOffset: 0, endOffset: 5 }]
  });
  assert.equal(raw.segments[1].text, '讨论预算。');
  assert.equal(corrected.transcriptRevision, 2);
  assert.equal(corrected.segments[1].text, '讨论预算和时间。');
  assert.equal(corrected.segments[1].startMs, raw.segments[1].startMs);
  assert.equal(corrected.segments[1].endMs, raw.segments[1].endMs);
  assert.equal(corrected.changes[0].previousText, '讨论预算。');
  assert.equal(corrected.changes[0].nextText, '讨论预算和时间。');
  assert.throws(
    () => createCorrectionRevision({
      ownerContext: owner(),
      parent: raw,
      actorId: 'owner-a',
      edits: [{ segmentId: rawSegments[0].segmentId, text: '非法重排', startMs: 10 }]
    }),
    (error) => error.code === 'TRANSCRIPT_TIMELINE_IMMUTABLE'
  );
});
