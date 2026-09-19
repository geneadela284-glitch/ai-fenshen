import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStage3cPlaybackDependency } from './meetingStage3cPlaybackDependency.js';

const audioSource = Object.freeze({
  sourceId: 'recorded-meeting-1',
  meetingId: 'meeting-1',
  origin: 'recorded',
  durationMs: 12_000,
  revision: 1
});

const transcript = Object.freeze({
  document: Object.freeze({ transcriptId: 'transcript-1', transcriptRevision: 1, status: 'ready' }),
  currentRevision: Object.freeze({ segments: Object.freeze([{ segmentId: 'segment-1', startMs: 0, endMs: 1_000, text: '你好' }]) })
});

const playback = Object.freeze({ createSession() {} });

test('audio + ready transcript initializes playback and transcript sync', () => {
  assert.deepEqual(resolveStage3cPlaybackDependency({ source: audioSource, transcript, playback }), {
    mode: 'playback-ready',
    transcript: 'available'
  });
});

test('audio + pending transcript keeps playback ready without transcript sync', () => {
  assert.deepEqual(resolveStage3cPlaybackDependency({
    source: audioSource,
    transcript: { document: { status: 'transcribing' }, currentRevision: { segments: [] } },
    playback
  }), { mode: 'playback-ready', transcript: 'unavailable' });
});

test('audio + failed transcript keeps playback ready without transcript sync', () => {
  assert.deepEqual(resolveStage3cPlaybackDependency({
    source: audioSource,
    transcript: { document: { status: 'failed_retryable' }, currentRevision: { segments: [] } },
    playback
  }), { mode: 'playback-ready', transcript: 'unavailable' });
});

test('audio + empty transcript keeps playback ready without transcript sync', () => {
  assert.deepEqual(resolveStage3cPlaybackDependency({
    source: audioSource,
    transcript: { document: { status: 'ready' }, currentRevision: { segments: [] } },
    playback
  }), { mode: 'playback-ready', transcript: 'unavailable' });
});

test('no audio + ready transcript is readable-only', () => {
  assert.deepEqual(resolveStage3cPlaybackDependency({ source: null, transcript, playback }), {
    mode: 'readable-only',
    reason: 'AUDIO_SOURCE_UNAVAILABLE',
    transcript: 'available'
  });
});

test('audio + unsupported playback source is readable-only', () => {
  assert.deepEqual(resolveStage3cPlaybackDependency({ source: audioSource, transcript: null, playback: null }), {
    mode: 'readable-only',
    reason: 'PLAYBACK_UNSUPPORTED',
    transcript: 'unavailable'
  });
});
