import test from 'node:test';
import assert from 'node:assert/strict';

import { mapDiarizationToTranscript } from './diarizationMapping.js';

const ownerContext = Object.freeze({
  trusted: true,
  ownerId: 'owner-a',
  sessionId: 'session-a',
  spaceId: 'meeting-space'
});

const transcriptRevision = {
  schemaVersion: 1,
  transcriptId: 'transcript-1',
  meetingId: 'meeting-1',
  sourceId: 'source-1',
  sourceRevision: 2,
  ownerId: 'owner-a',
  transcriptRevision: 7,
  segments: [
    {
      segmentId: 'segment-0',
      transcriptId: 'transcript-1',
      transcriptRevision: 7,
      sequence: 0,
      startMs: 0,
      endMs: 8_000,
      text: '你好，今天开始会议。',
      confidence: null,
      speakerRef: null,
      sourceChunkRefs: ['chunk-0']
    },
    {
      segmentId: 'segment-1',
      transcriptId: 'transcript-1',
      transcriptRevision: 7,
      sequence: 1,
      startMs: 8_000,
      endMs: 15_000,
      text: '好的，我来汇报进展。',
      confidence: null,
      speakerRef: null,
      sourceChunkRefs: ['chunk-0']
    },
    {
      segmentId: 'segment-2',
      transcriptId: 'transcript-1',
      transcriptRevision: 7,
      sequence: 2,
      startMs: 15_000,
      endMs: 20_000,
      text: '谢谢。',
      confidence: null,
      speakerRef: null,
      sourceChunkRefs: ['chunk-0']
    }
  ]
};

test('maps provider roles to stable anonymous speakerRefs by first appearance', () => {
  const result = mapDiarizationToTranscript({
    ownerContext,
    transcriptRevision,
    providerSegments: [
      { startMs: 0, endMs: 8_000, providerRole: 2, confidence: null },
      { startMs: 8_000, endMs: 15_000, providerRole: 1, confidence: null },
      { startMs: 15_000, endMs: 20_000, providerRole: 2, confidence: null }
    ],
    diarizationRevision: 1,
    now: '2026-08-08T00:00:00.000Z'
  });

  assert.deepEqual(result.speakerRefs.map((speaker) => [speaker.speakerId, speaker.label]), [
    ['speaker-1', '说话人1'],
    ['speaker-2', '说话人2']
  ]);
  assert.deepEqual(result.segments.map((segment) => ({
    segmentId: segment.transcriptSegmentId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    speakerRef: segment.speakerRef
  })), [
    { segmentId: 'segment-0', startMs: 0, endMs: 8_000, speakerRef: 'speaker-1' },
    { segmentId: 'segment-1', startMs: 8_000, endMs: 15_000, speakerRef: 'speaker-2' },
    { segmentId: 'segment-2', startMs: 15_000, endMs: 20_000, speakerRef: 'speaker-1' }
  ]);
  assert.equal('text' in result.segments[0], false);
});

test('uses unknown when provider coverage is missing or boundary ownership is ambiguous', () => {
  const result = mapDiarizationToTranscript({
    ownerContext,
    transcriptRevision,
    providerSegments: [
      { startMs: 0, endMs: 4_000, providerRole: 1, confidence: null },
      { startMs: 4_000, endMs: 8_000, providerRole: 2, confidence: null },
      { startMs: 15_000, endMs: 16_000, providerRole: 1, confidence: null }
    ],
    diarizationRevision: 1,
    now: '2026-08-08T00:00:00.000Z'
  });

  assert.deepEqual(result.segments.map((segment) => segment.speakerRef), [
    'unknown',
    'unknown',
    'unknown'
  ]);
});

test('does not accept a provider timeline that can reorder or overlap diarization intervals', () => {
  assert.throws(
    () => mapDiarizationToTranscript({
      ownerContext,
      transcriptRevision,
      providerSegments: [
        { startMs: 0, endMs: 9_000, providerRole: 1 },
        { startMs: 8_000, endMs: 15_000, providerRole: 2 }
      ],
      diarizationRevision: 1
    }),
    (error) => error.code === 'DIARIZATION_PROVIDER_TIMELINE_INVALID'
  );
});
