import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const compositionPath = fileURLToPath(new URL('./browserMeetingPhase1.js', import.meta.url));
const source = await readFile(compositionPath, 'utf8');
const playbackPath = fileURLToPath(new URL('./meetingStage3cBrowserPlayback.js', import.meta.url));
const playbackSource = await readFile(playbackPath, 'utf8');

test('browser composition exposes only an additive owner-scoped playback session seam', () => {
  assert.match(source, /createStage3cBrowserPlaybackSession/);
  assert.match(source, /audioStore:\s*store/);
  assert.match(source, /createSession:\s*\(\)\s*=>/);
  assert.match(source, /playback,/);
  assert.doesNotMatch(source, /createStage3cTranscriptPlaybackSync/);
  assert.doesNotMatch(source, /MeetingPlaybackPanel/);
});

test('browser playback injects the bounded WebM adapter without changing UI or transcript seams', () => {
  assert.match(playbackSource, /createStage3cWebmBoundedReassemblyAdapter/);
  assert.match(playbackSource, /webmReassemblyAdapter/);
  assert.match(playbackSource, /createStage3cIndependentMp4SegmentAdapter/);
  assert.match(playbackSource, /independentMp4SegmentAdapter/);
  assert.doesNotMatch(playbackSource, /MeetingPlaybackPanel/);
  assert.doesNotMatch(playbackSource, /TranscriptPlaybackSync/);
});
