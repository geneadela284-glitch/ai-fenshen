import test from 'node:test';
import assert from 'node:assert/strict';

import { canStartTeacherAudio, loadCachedSpeech } from './playback.js';

test('a visible feedback celebration does not delay ready teacher audio', () => {
  const request = { signal: new AbortController().signal };
  assert.equal(canStartTeacherAudio({ request, pageHidden: false, feedbackVisible: true }), true);
  assert.equal(canStartTeacherAudio({ request, pageHidden: true, feedbackVisible: false }), false);
});

test('listen prefetch and a quick button press share one speech request', async () => {
  const cache = new Map();
  let calls = 0;
  let release;
  const loading = new Promise((resolve) => { release = resolve; });
  const load = () => { calls += 1; return loading; };
  const prefetched = loadCachedSpeech(cache, 'Hello!', load);
  const clicked = loadCachedSpeech(cache, 'Hello!', load);
  assert.equal(calls, 1);
  release('audio-blob');
  assert.equal(await prefetched, 'audio-blob');
  assert.equal(await clicked, 'audio-blob');
  assert.equal(await loadCachedSpeech(cache, 'Hello!', load), 'audio-blob');
  assert.equal(calls, 1);
});
