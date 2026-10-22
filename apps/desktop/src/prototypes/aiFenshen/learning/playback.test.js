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

test('a cancelled download cannot poison a new listen request or replace its cache',async()=>{
 const cache=new Map(),first=new AbortController(),second=new AbortController();let release;
 const old=loadCachedSpeech(cache,'Hello',()=>new Promise(r=>{release=r;}),first.signal);
 first.abort();
 const fresh=loadCachedSpeech(cache,'Hello',async()=> 'new-audio',second.signal);
 release('old-audio');
 const [oldResult,newResult]=await Promise.allSettled([old,fresh]);
 assert.equal(oldResult.status,'rejected');assert.equal(newResult.value,'new-audio');
 assert.equal(await loadCachedSpeech(cache,'Hello',()=>{throw Error('must use cache');},second.signal),'new-audio');
});
