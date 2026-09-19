import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AAC_PLAYBACK_MIME } from './meetingStage3cPlaybackCapability.js';
import { createStage3cManagedMediaSourcePlayer } from './meetingStage3cManagedMediaSourcePlayer.js';
import { createStage3cBrowserPlaybackSession } from './meetingStage3cBrowserPlayback.js';
import { createStage3cPlaybackManager } from './meetingStage3cPlaybackManager.js';

class GestureSourceBuffer extends EventTarget {
  constructor() {
    super();
    this.updating = false;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
  }

  appendBuffer() {
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.buffered = { length: 1, start: () => 0, end: () => 30 };
      this.dispatchEvent(new Event('updateend'));
    });
  }

  abort() { this.updating = false; }
}

class GestureMediaSource extends EventTarget {
  static isTypeSupported(mimeType) { return mimeType === AAC_PLAYBACK_MIME; }

  constructor() {
    super();
    this.readyState = 'closed';
    queueMicrotask(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    });
  }

  addSourceBuffer() { return new GestureSourceBuffer(); }
  endOfStream() { this.readyState = 'ended'; }
}

class GestureAudio extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.paused = true;
    this.playCalls = 0;
    this.rejectPlayCall = null;
  }

  setAttribute() {}
  removeAttribute() {}
  load() {}
  pause() { this.paused = true; }

  play() {
    this.playCalls += 1;
    if (this.playCalls === this.rejectPlayCall) {
      return Promise.reject(Object.assign(new Error('NotAllowedError'), { name: 'NotAllowedError' }));
    }
    this.paused = false;
    return Promise.resolve();
  }
}

function fakeGlobal(audio) {
  let created = 0;
  let revoked = 0;
  const globalObject = {
    isSecureContext: true,
    ManagedMediaSource: GestureMediaSource,
    MediaSource: undefined,
    URL: {
      createObjectURL() { created += 1; return `blob:gesture-${created}`; },
      revokeObjectURL() { revoked += 1; }
    },
    document: { createElement() { return audio; } }
  };
  return { globalObject, counts: () => ({ created, revoked }) };
}

function source() {
  return {
    sourceId: 'source-gesture',
    meetingId: 'meeting-gesture',
    format: 'm4a',
    mimeType: AAC_PLAYBACK_MIME,
    durationMs: 9_000,
    committedDurationMs: 9_000,
    byteLength: 30,
    committedByteLength: 30,
    chunkCount: 3,
    revision: 1,
    checksum: 'a'.repeat(64),
    playbackInitSegmentId: 'init'
  };
}

function mp4Box(type, payload = []) {
  const value = Uint8Array.from(payload);
  const bytes = new Uint8Array(8 + value.byteLength);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = type.charCodeAt(index);
  bytes.set(value, 8);
  return bytes;
}

function validAacInit() {
  return Uint8Array.from([
    ...mp4Box('ftyp', [0x69, 0x73, 0x6f, 0x6d]),
    ...mp4Box('moov', mp4Box('mvex', mp4Box('trex', [0, 0, 0, 1])))
  ]);
}

function validAacFragment(sequence) {
  return Uint8Array.from([
    ...mp4Box('moof', mp4Box('mfhd', [0, 0, 0, sequence + 1])),
    ...mp4Box('mdat', [sequence, sequence + 1])
  ]);
}

function segments() {
  return [0, 1, 2].map((sequence) => ({
    segmentId: `segment-${sequence}`,
    sequence,
    durationMs: 3_000,
    byteLength: 10,
    checksum: String(sequence).repeat(64),
    mimeType: AAC_PLAYBACK_MIME
  }));
}

function store() {
  const value = source();
  return {
    async getAudioSource() { return value; },
    async getMeeting() { return { audioSources: [value], segments: segments() }; },
    async readAudioSegment(_owner, _meetingId, segmentId) {
      if (segmentId === 'init') return validAacInit();
      return validAacFragment(Number(String(segmentId).split('-').pop()));
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('cross-window play rejection keeps the prepared window and exposes an explicit gesture retry', async () => {
  const audio = new GestureAudio();
  audio.rejectPlayCall = 2;
  const { globalObject, counts } = fakeGlobal(audio);
  const player = createStage3cManagedMediaSourcePlayer({
    globalObject,
    capability: { supported: true, engine: 'managed-media-source', mimeType: AAC_PLAYBACK_MIME }
  });

  await player.loadWindow({ mimeType: AAC_PLAYBACK_MIME, initBytes: Uint8Array.of(1), mediaChunks: [Uint8Array.of(2)], autoplay: true });
  const second = await player.loadWindow({ mimeType: AAC_PLAYBACK_MIME, initBytes: Uint8Array.of(3), mediaChunks: [Uint8Array.of(4)], autoplay: true });

  assert.equal(second.requiresUserGesture, true);
  assert.equal(player.getSnapshot().activeResources, 3);
  assert.deepEqual(counts(), { created: 2, revoked: 1 });

  await player.play();
  assert.equal(player.getSnapshot().requiresUserGesture, false);
  await player.dispose();
  assert.deepEqual(counts(), { created: 2, revoked: 2 });
}
);

test('browser playback reuses one audio element while replacing bounded windows', async () => {
  const { globalObject } = fakeGlobal(new GestureAudio());
  const createdAudios = [];
  globalObject.document.createElement = () => {
    const audio = new GestureAudio();
    createdAudios.push(audio);
    return audio;
  };
  const session = createStage3cBrowserPlaybackSession({
    ownerContext: { trusted: true, ownerId: 'owner' },
    audioStore: store(),
    globalObject
  });

  await session.open({ meetingId: 'meeting-gesture', sourceId: 'source-gesture' });
  await session.seekTo(0, { autoplay: true });
  const firstAudio = session.getAudioElement();
  await session.seekTo(6_000, { autoplay: false });
  assert.equal(createdAudios.length, 1);
  assert.equal(session.getAudioElement(), firstAudio);
  await session.dispose();
}
);

test('explicit play keeps the prepared window on a real user-gesture rejection', async () => {
  const audio = new GestureAudio();
  audio.rejectPlayCall = 1;
  const { globalObject, counts } = fakeGlobal(audio);
  const player = createStage3cManagedMediaSourcePlayer({
    globalObject,
    capability: { supported: true, engine: 'managed-media-source', mimeType: AAC_PLAYBACK_MIME }
  });

  await player.loadWindow({ mimeType: AAC_PLAYBACK_MIME, initBytes: Uint8Array.of(1), mediaChunks: [Uint8Array.of(2)] });
  await assert.rejects(() => player.play(), (error) => error.code === 'PLAYBACK_USER_GESTURE_REQUIRED');
  assert.equal(player.getSnapshot().activeResources, 3);
  assert.equal(player.getSnapshot().requiresUserGesture, false);
  await player.dispose();
  assert.deepEqual(counts(), { created: 1, revoked: 1 });
});

test('AbortError during autoplay is not mislabeled as a gesture request and still cleans resources', async () => {
  const audio = new GestureAudio();
  audio.rejectPlayCall = 1;
  audio.play = () => {
    audio.playCalls += 1;
    return Promise.reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
  };
  const { globalObject, counts } = fakeGlobal(audio);
  const player = createStage3cManagedMediaSourcePlayer({
    globalObject,
    capability: { supported: true, engine: 'managed-media-source', mimeType: AAC_PLAYBACK_MIME }
  });

  await assert.rejects(
    () => player.loadWindow({ mimeType: AAC_PLAYBACK_MIME, initBytes: Uint8Array.of(1), mediaChunks: [Uint8Array.of(2)], autoplay: true }),
    (error) => error.code === 'PLAYBACK_PLAY_ABORTED'
  );
  assert.equal(player.getSnapshot().activeResources, 0);
  assert.deepEqual(counts(), { created: 1, revoked: 1 });
});

test('pause waits behind an in-flight seek window instead of aborting its pending play', async () => {
  const boundSource = source();
  const loadStarted = deferred();
  const loadSettled = deferred();
  let pauseCalls = 0;
  let initialLoad = true;
  const player = {
    audio: { currentTime: 0 },
    async loadWindow() {
      if (initialLoad) {
        initialLoad = false;
        return;
      }
      loadStarted.resolve();
      return loadSettled.promise;
    },
    async play() {},
    async pause() {
      pauseCalls += 1;
      loadSettled.reject(Object.assign(new Error('Safari cancelled pending play'), {
        code: 'PLAYBACK_PLAY_ABORTED',
        name: 'AbortError'
      }));
    },
    async dispose() {},
    getSnapshot() { return { activeResources: 3 }; }
  };
  const managerStore = {
    async getAudioSource() { return boundSource; },
    async getMeeting() { return { audioSources: [boundSource], segments: segments() }; },
    async readAudioSegment() { return Uint8Array.of(1); }
  };
  const session = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner' },
    audioStore: managerStore,
    player,
    capabilityDetector: async ({ mimeType }) => ({ supported: true, engine: 'managed-media-source', mimeType }),
    sourceBoundaryVerifier: () => true,
    initBytesProvider: async () => Uint8Array.of(1)
  });

  await session.open({ meetingId: boundSource.meetingId, sourceId: boundSource.sourceId });
  const seekResult = session.seekTo(6_000, { autoplay: true }).then(
    () => ({ status: 'fulfilled' }),
    (error) => ({ status: 'rejected', error })
  );
  await loadStarted.promise;
  const pauseResult = session.pause();
  await Promise.resolve();

  assert.equal(pauseCalls, 0, 'pause must be serialized after the active window replacement');
  loadSettled.resolve();
  assert.deepEqual(await seekResult, { status: 'fulfilled' });
  await pauseResult;
  assert.equal(pauseCalls, 1);
});

test('pause during replacement runs before a coalesced pending seek and both remain serialized', async () => {
  const boundSource = source();
  const firstStarted = deferred();
  const firstSettled = deferred();
  const events = [];
  let loadCount = 0;
  const player = {
    audio: { currentTime: 0 },
    async loadWindow(input) {
      if (loadCount === 0) {
        loadCount += 1;
        return;
      }
      loadCount += 1;
      events.push(`load:${input.targetMs}:${input.autoplay}:start`);
      if (loadCount === 2) {
        firstStarted.resolve();
        await firstSettled.promise;
      }
      events.push(`load:${input.targetMs}:${input.autoplay}:end`);
    },
    async play() {},
    async pause() { events.push('pause'); },
    async dispose() {},
    getSnapshot() { return { activeResources: 3 }; }
  };
  const managerStore = {
    async getAudioSource() { return boundSource; },
    async getMeeting() { return { audioSources: [boundSource], segments: segments() }; },
    async readAudioSegment() { return Uint8Array.of(1); }
  };
  const session = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner' },
    audioStore: managerStore,
    player,
    capabilityDetector: async ({ mimeType }) => ({ supported: true, engine: 'managed-media-source', mimeType }),
    sourceBoundaryVerifier: () => true,
    initBytesProvider: async () => Uint8Array.of(1)
  });

  await session.open({ meetingId: boundSource.meetingId, sourceId: boundSource.sourceId });
  const first = session.seekTo(0, { autoplay: true });
  await firstStarted.promise;
  const pending = session.seekTo(6_000, { autoplay: true });
  const pause = session.pause();
  firstSettled.resolve();
  await Promise.all([first, pending, pause]);
  assert.deepEqual(events, ['load:0:true:start', 'load:0:true:end', 'pause', 'load:6000:false:start', 'load:6000:false:end']);
  await session.dispose();
});

test('close during a seek waits for the critical replacement and then releases the player', async () => {
  const boundSource = source();
  const loadStarted = deferred();
  const loadSettled = deferred();
  const events = [];
  let initialLoad = true;
  const player = {
    audio: { currentTime: 0 },
    async loadWindow() {
      if (initialLoad) {
        initialLoad = false;
        return;
      }
      events.push('load:start');
      loadStarted.resolve();
      await loadSettled.promise;
      events.push('load:end');
    },
    async play() {},
    async pause() {},
    async dispose() { events.push('dispose'); },
    getSnapshot() { return { activeResources: 3 }; }
  };
  const managerStore = {
    async getAudioSource() { return boundSource; },
    async getMeeting() { return { audioSources: [boundSource], segments: segments() }; },
    async readAudioSegment() { return Uint8Array.of(1); }
  };
  const session = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner' },
    audioStore: managerStore,
    player,
    capabilityDetector: async ({ mimeType }) => ({ supported: true, engine: 'managed-media-source', mimeType }),
    sourceBoundaryVerifier: () => true,
    initBytesProvider: async () => Uint8Array.of(1)
  });

  await session.open({ meetingId: boundSource.meetingId, sourceId: boundSource.sourceId });
  const seek = session.seekTo(6_000, { autoplay: true });
  await loadStarted.promise;
  const close = session.dispose();
  await Promise.resolve();
  assert.deepEqual(events, ['load:start']);
  loadSettled.resolve();
  await Promise.all([seek, close]);
  assert.deepEqual(events, ['load:start', 'load:end', 'dispose']);
  await assert.rejects(() => session.seekTo(0), (error) => error.code === 'PLAYBACK_MANAGER_DISPOSED');
});
