import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyStage3cSpeakerCorrectionBinding,
  createStage3cTranscriptPlaybackSync
} from './meetingStage3cTranscriptPlaybackSync.js';

function binding(overrides = {}) {
  return {
    meetingId: 'meeting-1',
    sourceId: 'source-1',
    sourceRevision: 7,
    durationMs: 20_000,
    transcriptId: 'transcript-1',
    transcriptRevision: 3,
    ...overrides
  };
}

function transcript(overrides = {}) {
  return {
    meetingId: 'meeting-1',
    sourceId: 'source-1',
    sourceRevision: 7,
    transcriptId: 'transcript-1',
    transcriptRevision: 3,
    segments: [
      { segmentId: 'seg-1', sequence: 0, startMs: 0, endMs: 2_000, text: '第一句' },
      { segmentId: 'seg-2', sequence: 1, startMs: 3_000, endMs: 5_000, text: '第二句' },
      { segmentId: 'seg-3', sequence: 2, startMs: 5_000, endMs: 8_000, text: '第三句' }
    ],
    ...overrides
  };
}

function playback() {
  const calls = [];
  return {
    calls,
    getSnapshot() {
      return { opened: true, meetingId: 'meeting-1', sourceId: 'source-1', revision: 7 };
    },
    async seekTo(targetMs, options) {
      calls.push({ targetMs, options });
      return { targetMs };
    }
  };
}

test('clicking a segment seeks to its absolute start and exposes the effective speaker read-only', async () => {
  const player = playback();
  const sync = createStage3cTranscriptPlaybackSync({
    binding: binding(),
    transcript: transcript(),
    playbackManager: player,
    speakerProjection: { 'seg-2': { speakerRef: 'speaker-2', displayName: 'Speaker 2' } }
  });

  const result = await sync.clickSegment('seg-2');
  assert.equal(result.segment.segmentId, 'seg-2');
  assert.deepEqual(player.calls, [{ targetMs: 3_000, options: { autoplay: true } }]);
  assert.deepEqual(sync.getSegmentPresentation('seg-2').effectiveSpeaker, { speakerRef: 'speaker-2', displayName: 'Speaker 2' });
});

test('speaker correction effective projection shape is consumed read-only by transcript segment id', () => {
  const sync = createStage3cTranscriptPlaybackSync({
    binding: binding(),
    transcript: transcript(),
    playbackManager: playback(),
    speakerProjection: {
      meetingId: 'meeting-1',
      transcriptId: 'transcript-1',
      transcriptRevision: 3,
      segments: [{
        rawSegment: { segmentId: 'seg-1' },
        effectiveSpeaker: { speakerRef: 'speaker-1', displayLabel: '主持人' }
      }]
    }
  });
  assert.deepEqual(sync.getSegmentPresentation('seg-1').effectiveSpeaker, { speakerRef: 'speaker-1', displayLabel: '主持人' });
});

test('real Speaker Correction projection DTO without source binding does not block base Transcript Sync', () => {
  const projectionFromManager = {
    meetingId: 'meeting-1',
    transcriptId: 'transcript-1',
    transcriptRevision: 3,
    baseDiarizationRevisionId: 'diarization-1',
    baseDiarizationRevision: 1,
    baseDiarizationSnapshotHash: 'snapshot-hash',
    correctionRevisionId: 'correction-0',
    correctionRevision: 0,
    hasCorrections: false,
    speakerRefs: [],
    segments: [{
      rawSegment: { segmentId: 'seg-1' },
      effectiveSpeaker: { speakerRef: 'unknown', displayLabel: '未标注发言人' }
    }]
  };
  const sync = createStage3cTranscriptPlaybackSync({
    binding: binding(),
    transcript: transcript(),
    playbackManager: playback(),
    speakerCorrectionRevision: projectionFromManager
  });
  assert.equal(sync.updateCurrentTime(1_000).activeSegmentId, 'seg-1');
  assert.equal(sync.getSegmentPresentation('seg-1').effectiveSpeaker, null);
});

test('Speaker Correction binding classifier distinguishes incomplete, valid, and mismatched DTOs', () => {
  const expected = binding();
  const incomplete = { meetingId: expected.meetingId, transcriptId: expected.transcriptId, transcriptRevision: expected.transcriptRevision };
  const complete = { ...incomplete, sourceId: expected.sourceId, sourceRevision: expected.sourceRevision };
  assert.equal(classifyStage3cSpeakerCorrectionBinding(incomplete, expected), 'incomplete');
  assert.equal(classifyStage3cSpeakerCorrectionBinding(complete, expected), 'valid');
  assert.equal(classifyStage3cSpeakerCorrectionBinding({ ...complete, sourceRevision: 8 }, expected), 'mismatch');
});

test('current-time updates highlight only a segment interval and leave gaps unhighlighted', () => {
  const sync = createStage3cTranscriptPlaybackSync({ binding: binding(), transcript: transcript(), playbackManager: playback() });
  assert.equal(sync.updateCurrentTime(1_000).activeSegment.segmentId, 'seg-1');
  assert.equal(sync.getSnapshot().currentTimeMs, 1_000);
  assert.equal(sync.updateCurrentTime(2_500).activeSegment, null);
  assert.equal(sync.updateCurrentTime(3_000).activeSegment.segmentId, 'seg-2');
  assert.equal(sync.updateCurrentTime(20_000).activeSegment, null);
});

test('manual scrolling pauses follow and return-to-current restores follow and scroll target', () => {
  const scrolled = [];
  const sync = createStage3cTranscriptPlaybackSync({
    binding: binding(),
    transcript: transcript(),
    playbackManager: playback(),
    scrollToSegment: (segmentId) => scrolled.push(segmentId)
  });
  sync.updateCurrentTime(3_100);
  sync.onUserScroll();
  sync.setSegmentVisibility('seg-2', false);
  assert.equal(sync.getSnapshot().autoFollowEnabled, false);
  assert.equal(sync.getSnapshot().showReturnToCurrent, true);
  sync.returnToCurrent();
  assert.deepEqual(scrolled, ['seg-2']);
  assert.equal(sync.getSnapshot().autoFollowEnabled, true);
  assert.equal(sync.getSnapshot().showReturnToCurrent, false);
});

test('virtualization keeps a 1000-segment transcript window at or below 200 entries', () => {
  const segments = Array.from({ length: 1_000 }, (_, index) => ({
    segmentId: `seg-${index}`,
    sequence: index,
    startMs: index * 1_000,
    endMs: index * 1_000 + 800,
    text: `句子 ${index}`
  }));
  const sync = createStage3cTranscriptPlaybackSync({
    binding: binding({ durationMs: 1_000_000 }),
    transcript: transcript({ segments }),
    playbackManager: playback(),
    maxDomSegments: 200
  });
  const window = sync.getVirtualizedWindow({ centerIndex: 500, viewportSize: 40 });
  assert.ok(window.segments.length <= 200);
  assert.ok(window.startIndex <= 500 && window.endIndex > 500);
});

test('source or transcript revision mismatch fails closed before seek or highlight', async () => {
  const player = playback();
  assert.throws(
    () => createStage3cTranscriptPlaybackSync({ binding: binding({ sourceRevision: 8 }), transcript: transcript(), playbackManager: player }),
    (error) => error.code === 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH'
  );
  const sync = createStage3cTranscriptPlaybackSync({ binding: binding(), transcript: transcript(), playbackManager: player });
  player.getSnapshot = () => ({ opened: true, meetingId: 'meeting-1', sourceId: 'source-1', revision: 8 });
  await assert.rejects(() => sync.clickSegment('seg-1'), (error) => error.code === 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  assert.deepEqual(player.calls, []);
});

test('related diarization and correction revisions must remain bound to the current transcript', () => {
  assert.throws(
    () => createStage3cTranscriptPlaybackSync({
      binding: binding(),
      transcript: transcript(),
      diarizationRevision: { meetingId: 'meeting-1', sourceId: 'source-1', sourceRevision: 7, transcriptId: 'transcript-1', transcriptRevision: 2 },
      playbackManager: playback()
    }),
    (error) => error.code === 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH'
  );
  assert.throws(
    () => createStage3cTranscriptPlaybackSync({
      binding: binding(),
      transcript: transcript(),
      speakerCorrectionRevision: { meetingId: 'meeting-1', sourceId: 'source-1', sourceRevision: 7, transcriptId: 'transcript-1', transcriptRevision: 2 },
      playbackManager: playback()
    }),
    (error) => error.code === 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH'
  );
});

test('invalid or overlapping timelines fail closed without mutating transcript data', () => {
  const segments = [
    { segmentId: 'seg-1', sequence: 0, startMs: 0, endMs: 2_000, text: 'a' },
    { segmentId: 'seg-2', sequence: 1, startMs: 1_500, endMs: 3_000, text: 'b' }
  ];
  assert.throws(
    () => createStage3cTranscriptPlaybackSync({ binding: binding(), transcript: transcript({ segments }), playbackManager: playback() }),
    (error) => error.code === 'TRANSCRIPT_PLAYBACK_TIMELINE_INVALID'
  );
  assert.deepEqual(segments[0], { segmentId: 'seg-1', sequence: 0, startMs: 0, endMs: 2_000, text: 'a' });
});

test('missing source or revision identity fails closed instead of guessing a mapping', () => {
  assert.throws(
    () => createStage3cTranscriptPlaybackSync({
      binding: binding({ sourceRevision: undefined }),
      transcript: transcript(),
      playbackManager: playback()
    }),
    (error) => error.code === 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH'
  );
});
