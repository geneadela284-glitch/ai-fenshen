import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AAC_PLAYBACK_MIME } from './meetingStage3cPlaybackCapability.js';
import { createStage3cManagedMediaSourcePlayer } from './meetingStage3cManagedMediaSourcePlayer.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class CrossWindowSourceBuffer extends EventTarget {
  constructor(events) {
    super();
    this.events = events;
    this.updating = false;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
  }

  appendBuffer() {
    this.events.push('append-requested');
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.buffered = { length: 1, start: () => 30.001, end: () => 60 };
      this.events.push('append-complete');
      this.dispatchEvent(new Event('updateend'));
    });
  }

  abort() { this.updating = false; }
}

class CrossWindowMediaSource extends EventTarget {
  static events = null;
  static isTypeSupported(mimeType) { return mimeType === AAC_PLAYBACK_MIME; }

  constructor() {
    super();
    this.readyState = 'closed';
    queueMicrotask(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    });
  }

  addSourceBuffer() { return new CrossWindowSourceBuffer(CrossWindowMediaSource.events); }
  endOfStream() { this.readyState = 'ended'; }
}

class CrossWindowAudio extends EventTarget {
  constructor(events, { playFailure = null, delaySeek = false } = {}) {
    super();
    this.events = events;
    this.playFailure = playFailure;
    this.delaySeek = delaySeek;
    this._currentTime = 0;
    this.seeking = false;
    this.paused = true;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.seekGate = deferred();
  }

  get currentTime() { return this._currentTime; }

  set currentTime(value) {
    this.events.push(`current-time:${value}`);
    this._currentTime = value;
    this.seeking = this.delaySeek;
    if (!this.delaySeek) return;
    this.seekGate.promise.then(() => {
      this.seeking = false;
      this.events.push('seeked');
      this.dispatchEvent(new Event('seeked'));
    });
  }

  setAttribute() {}
  removeAttribute() {}
  load() {}
  pause() { this.paused = true; }

  play() {
    this.events.push(`play:${this.currentTime}:${this.seeking}`);
    if (this.playFailure) return Promise.reject(this.playFailure);
    this.paused = false;
    return Promise.resolve();
  }
}

function makePlayer(audio, events) {
  CrossWindowMediaSource.events = events;
  let created = 0;
  let revoked = 0;
  const globalObject = {
    ManagedMediaSource: CrossWindowMediaSource,
    MediaSource: undefined,
    URL: {
      createObjectURL() { created += 1; return `blob:cross-window-${created}`; },
      revokeObjectURL() { revoked += 1; }
    },
    document: { createElement() { return audio; } }
  };
  return {
    player: createStage3cManagedMediaSourcePlayer({
      globalObject,
      capability: { supported: true, engine: 'managed-media-source', mimeType: AAC_PLAYBACK_MIME },
      operationTimeoutMs: 100
    }),
    counts: () => ({ created, revoked })
  };
}

test('cross-window target is buffered and seek-settled before autoplay begins', async () => {
  const events = [];
  const audio = new CrossWindowAudio(events, { delaySeek: true });
  const { player, counts } = makePlayer(audio, events);
  const result = player.loadWindow({
    mimeType: AAC_PLAYBACK_MIME,
    initBytes: Uint8Array.of(1),
    mediaChunks: [Uint8Array.of(2)],
    targetMs: 31_300,
    autoplay: true
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('play:0:false'), false, 'play must not run while audio is still at the old window time');
  assert.equal(events.includes('current-time:31.3'), true, 'the target must be assigned after append');
  assert.equal(events.some((entry) => entry.startsWith('play:')), false, 'play must wait for seek settlement');

  audio.seekGate.resolve();
  await result;
  assert.deepEqual(events.slice(-2), ['seeked', 'play:31.3:false']);
  await player.dispose();
  assert.deepEqual(counts(), { created: 1, revoked: 1 });
});

test('NotAllowedError is classified only after the buffered target has settled', async () => {
  const events = [];
  const failure = Object.assign(new Error('gesture required'), { name: 'NotAllowedError' });
  const audio = new CrossWindowAudio(events, { playFailure: failure });
  const { player } = makePlayer(audio, events);

  const snapshot = await player.loadWindow({
    mimeType: AAC_PLAYBACK_MIME,
    initBytes: Uint8Array.of(1),
    mediaChunks: [Uint8Array.of(2)],
    targetMs: 31_300,
    autoplay: true
  });

  assert.equal(snapshot.requiresUserGesture, true);
  assert.equal(audio.currentTime, 31.3);
  assert.equal(events.at(-1), 'play:31.3:false');
  await player.dispose();
});

test('AbortError after settled positioning remains PLAYBACK_PLAY_ABORTED with balanced cleanup', async () => {
  const events = [];
  const failure = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  const audio = new CrossWindowAudio(events, { playFailure: failure });
  const { player, counts } = makePlayer(audio, events);

  await assert.rejects(
    () => player.loadWindow({
      mimeType: AAC_PLAYBACK_MIME,
      initBytes: Uint8Array.of(1),
      mediaChunks: [Uint8Array.of(2)],
      targetMs: 31_300,
      autoplay: true
    }),
    (error) => error.code === 'PLAYBACK_PLAY_ABORTED' && error.cause === failure
  );
  assert.equal(events.includes('play:31.3:false'), true);
  assert.deepEqual(counts(), { created: 1, revoked: 1 });
  assert.equal(player.getSnapshot().activeResources, 0);
});

test('a cross-window target outside the appended buffered ranges fails before play', async () => {
  const events = [];
  const audio = new CrossWindowAudio(events);
  const { player, counts } = makePlayer(audio, events);

  await assert.rejects(
    () => player.loadWindow({
      mimeType: AAC_PLAYBACK_MIME,
      initBytes: Uint8Array.of(1),
      mediaChunks: [Uint8Array.of(2)],
      targetMs: 10_000,
      autoplay: true
    }),
    (error) => error.code === 'PLAYBACK_TARGET_NOT_BUFFERED'
  );
  assert.equal(events.some((entry) => entry.startsWith('play:')), false);
  assert.deepEqual(counts(), { created: 1, revoked: 1 });
});

test('paused cross-window positioning settles without issuing autoplay', async () => {
  const events = [];
  const audio = new CrossWindowAudio(events);
  const { player } = makePlayer(audio, events);

  const snapshot = await player.loadWindow({
    mimeType: AAC_PLAYBACK_MIME,
    initBytes: Uint8Array.of(1),
    mediaChunks: [Uint8Array.of(2)],
    targetMs: 31_300,
    autoplay: false
  });
  assert.equal(audio.currentTime, 31.3);
  assert.equal(audio.paused, true);
  assert.equal(snapshot.audioPlayCalls, 0);
  assert.equal(events.some((entry) => entry.startsWith('play:')), false);
  await player.dispose();
});
