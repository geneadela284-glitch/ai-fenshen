import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AAC_PLAYBACK_MIME,
  WEBM_PLAYBACK_MIME,
  detectStage3cPlaybackCapability
} from './meetingStage3cPlaybackCapability.js';
import {
  buildStage3cPlaybackTimeline,
  findStage3cTimelinePosition,
  resolveStage3cPlaybackWindow
} from './meetingStage3cPlaybackWindowPlanner.js';
import { createStage3cManagedMediaSourcePlayer } from './meetingStage3cManagedMediaSourcePlayer.js';
import { createStage3cPlaybackManager } from './meetingStage3cPlaybackManager.js';
import { createStage3cWebmBoundedReassemblyAdapter } from './meetingStage3cWebmBoundedReassembly.js';
import { buildBoundaryShapedFragments } from './meetingStage3cWebmBoundaryEvidenceFixture.js';

function fakeCapability(engine = 'managed-media-source', mimeType = AAC_PLAYBACK_MIME) {
  return { supported: true, engine, mimeType };
}

function source(overrides = {}) {
  return {
    sourceId: 'recorded-meeting-1',
    meetingId: 'meeting-1',
    origin: 'recorded',
    format: 'm4a',
    mimeType: AAC_PLAYBACK_MIME,
    durationMs: 9_000,
    committedDurationMs: 9_000,
    byteLength: 30,
    committedByteLength: 30,
    chunkCount: 3,
    revision: 4,
    ...overrides
  };
}

function segments() {
  return [0, 1, 2].map((sequence) => ({
    segmentId: `segment-${sequence}`,
    sequence,
    durationMs: 3_000,
    byteLength: 10,
    checksum: `${String(sequence).repeat(64)}`,
    mimeType: AAC_PLAYBACK_MIME,
    startedAt: new Date(0 + sequence * 3_000).toISOString(),
    endedAt: new Date(3_000 + sequence * 3_000).toISOString()
  }));
}

class FakeSourceBuffer extends EventTarget {
  constructor() {
    super();
    this.updating = false;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.appended = [];
  }

  appendBuffer(bytes) {
    this.appended.push(new Uint8Array(bytes));
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.buffered = { length: 1, start: () => 0, end: () => 12 };
      this.dispatchEvent(new Event('updateend'));
    });
  }

  abort() {
    this.updating = false;
  }
}

class FakeManagedMediaSource extends EventTarget {
  static isTypeSupported(mime) {
    return mime === AAC_PLAYBACK_MIME || mime === WEBM_PLAYBACK_MIME;
  }

  constructor() {
    super();
    this.readyState = 'closed';
    this.sourceBuffers = [];
    queueMicrotask(() => {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    });
  }

  addSourceBuffer(mime) {
    assert.equal(FakeManagedMediaSource.isTypeSupported(mime), true);
    const buffer = new FakeSourceBuffer();
    this.sourceBuffers.push(buffer);
    return buffer;
  }

  endOfStream() {
    this.readyState = 'ended';
  }
}

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.src = '';
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.disableRemotePlayback = false;
    this.playCalls = 0;
    this.paused = true;
  }

  setAttribute(name, value) {
    if (name === 'src') this.src = value;
  }

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }

  load() {}

  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

function fakeGlobal() {
  const urls = new Set();
  let created = 0;
  let revoked = 0;
  const globalObject = {
    isSecureContext: true,
    ManagedMediaSource: FakeManagedMediaSource,
    MediaSource: undefined,
    URL: {
      createObjectURL(value) {
        assert.ok(value instanceof FakeManagedMediaSource);
        created += 1;
        const url = `blob:stage3c-${created}`;
        urls.add(url);
        return url;
      },
      revokeObjectURL(url) {
        revoked += 1;
        urls.delete(url);
      }
    },
    document: {
      createElement(name) {
        assert.equal(name, 'audio');
        return new FakeAudio();
      }
    }
  };
  return {
    globalObject,
    counts: () => ({ created, revoked, activeUrls: urls.size })
  };
}

test('capability detection prefers exact ManagedMediaSource MIME support and fails closed in insecure contexts', () => {
  const managed = detectStage3cPlaybackCapability({
    globalObject: { isSecureContext: true, ManagedMediaSource: FakeManagedMediaSource, MediaSource: undefined },
    mimeType: AAC_PLAYBACK_MIME
  });
  assert.deepEqual(managed, { supported: true, engine: 'managed-media-source', mimeType: AAC_PLAYBACK_MIME });

  const insecure = detectStage3cPlaybackCapability({
    globalObject: { isSecureContext: false, ManagedMediaSource: FakeManagedMediaSource },
    mimeType: AAC_PLAYBACK_MIME
  });
  assert.equal(insecure.supported, false);
  assert.equal(insecure.errorCode, 'PLAYBACK_UNSUPPORTED');
});

test('capability detection falls back to standard MediaSource only when the exact MIME is supported', () => {
  class StandardMediaSource {
    static isTypeSupported(mime) { return mime === AAC_PLAYBACK_MIME; }
  }
  const result = detectStage3cPlaybackCapability({
    globalObject: { isSecureContext: true, ManagedMediaSource: undefined, MediaSource: StandardMediaSource },
    mimeType: AAC_PLAYBACK_MIME
  });
  assert.deepEqual(result, { supported: true, engine: 'media-source', mimeType: AAC_PLAYBACK_MIME });
});

test('timeline is contiguous, cumulative, and resolves bounded windows of at most three media chunks', () => {
  const timeline = buildStage3cPlaybackTimeline({ source: source(), segments: segments() });
  assert.equal(timeline.durationMs, 9_000);
  assert.deepEqual(findStage3cTimelinePosition(timeline, 3_100), { sequence: 1, offsetMs: 100 });
  const window = resolveStage3cPlaybackWindow(timeline, 8_500, { maxMediaChunks: 3 });
  assert.deepEqual(window.mediaChunks.map((item) => item.sequence), [2]);
  assert.equal(window.targetMs, 8_500);
  assert.throws(
    () => buildStage3cPlaybackTimeline({ source: source({ committedDurationMs: 8_000 }), segments: segments() }),
    (error) => error.code === 'PLAYBACK_SOURCE_TIMELINE_MISMATCH'
  );
});

test('ManagedMediaSource player appends a bounded window and balances URL/resources on dispose', async () => {
  const { globalObject, counts } = fakeGlobal();
  const player = createStage3cManagedMediaSourcePlayer({
    globalObject,
    capability: fakeCapability()
  });
  await player.loadWindow({
    mimeType: AAC_PLAYBACK_MIME,
    initBytes: Uint8Array.from([1]),
    mediaChunks: [Uint8Array.from([2]), Uint8Array.from([3]), Uint8Array.from([4])],
    targetMs: 1_000,
    autoplay: true
  });
  assert.equal(player.getSnapshot().activeResources, 3);
  assert.equal(player.getSnapshot().mediaChunkCount, 3);
  assert.equal(player.getSnapshot().audioPlayCalls, 1);
  await player.dispose();
  assert.deepEqual(counts(), { created: 1, revoked: 1, activeUrls: 0 });
  assert.equal(player.getSnapshot().activeResources, 0);
});

test('ManagedMediaSource player releases the old bounded window before loading the next one', async () => {
  const { globalObject, counts } = fakeGlobal();
  const player = createStage3cManagedMediaSourcePlayer({ globalObject, capability: fakeCapability() });
  await player.loadWindow({ mimeType: AAC_PLAYBACK_MIME, initBytes: Uint8Array.from([1]), mediaChunks: [Uint8Array.from([2])], targetMs: 0 });
  await player.loadWindow({ mimeType: AAC_PLAYBACK_MIME, initBytes: Uint8Array.from([3]), mediaChunks: [Uint8Array.from([4])], targetMs: 0 });
  assert.deepEqual(counts(), { created: 2, revoked: 1, activeUrls: 1 });
  await player.dispose();
  assert.deepEqual(counts(), { created: 2, revoked: 2, activeUrls: 0 });
});

test('ManagedMediaSource player rejects a window over three chunks without constructing a whole-meeting Blob', async () => {
  const { globalObject, counts } = fakeGlobal();
  const player = createStage3cManagedMediaSourcePlayer({ globalObject, capability: fakeCapability() });
  await assert.rejects(
    () => player.loadWindow({ mimeType: AAC_PLAYBACK_MIME, mediaChunks: [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3), Uint8Array.of(4)] }),
    (error) => error.code === 'PLAYBACK_WINDOW_LIMIT_INVALID'
  );
  assert.deepEqual(counts(), { created: 0, revoked: 0, activeUrls: 0 });
});

test('playback manager reads only the selected window and rejects unverified WebM boundaries', async () => {
  const reads = [];
  const store = {
    async getAudioSource() { return source(); },
    async getMeeting() { return { audioSources: [source()], segments: segments() }; },
    async readAudioSegment(_owner, meetingId, segmentId) {
      reads.push({ meetingId, segmentId });
      return Uint8Array.from([segmentId.endsWith('0') ? 1 : 2]);
    }
  };
  const loaded = [];
  const player = {
    audio: { currentTime: 0 },
    async loadWindow(input) { loaded.push(input); },
    async play() {},
    async pause() {},
    async dispose() {},
    getSnapshot() { return { activeResources: 0 }; }
  };
  const manager = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner', sessionId: 'session', spaceId: 'meeting-space' },
    audioStore: store,
    player,
    capabilityDetector: () => fakeCapability(),
    initBytesProvider: async () => Uint8Array.of(9)
  });
  await manager.open({ meetingId: 'meeting-1', sourceId: 'recorded-meeting-1' });
  reads.length = 0;
  loaded.length = 0;
  await manager.seekTo(8_500);
  assert.deepEqual(reads.map((item) => item.segmentId), ['segment-2']);
  assert.equal(loaded[0].mediaChunks.length, 1);
  await manager.seekTo(5_000);
  await manager.skipBy(15_000);
  assert.equal(manager.getSnapshot().currentTargetMs, 9_000);
  await manager.skipBy(-15_000);
  assert.equal(manager.getSnapshot().currentTargetMs, 0);
  await manager.dispose();
  await assert.rejects(
    async () => {
      const webmManager = createStage3cPlaybackManager({
        ownerContext: { trusted: true, ownerId: 'owner', sessionId: 'session', spaceId: 'meeting-space' },
        audioStore: {
          ...store,
          async getAudioSource() { return source({ format: 'webm-opus', mimeType: WEBM_PLAYBACK_MIME }); },
          async getMeeting() {
            const webmSource = source({ format: 'webm-opus', mimeType: WEBM_PLAYBACK_MIME });
            return { audioSources: [webmSource], segments: segments().map((item) => ({ ...item, mimeType: WEBM_PLAYBACK_MIME })) };
          }
        },
        player,
        capabilityDetector: () => fakeCapability('managed-media-source', WEBM_PLAYBACK_MIME),
        initBytesProvider: async () => Uint8Array.of(9)
      });
      await webmManager.open({ meetingId: 'meeting-1', sourceId: 'recorded-meeting-1' });
      await webmManager.seekTo(0);
    },
    (error) => error.code === 'PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED'
  );
});

test('AAC recorded sources use the bounded stored-fragment adapter without the WebM route', async () => {
  const loaded = [];
  let adapterCalls = 0;
  const value = source();
  const player = {
    audio: { currentTime: 0 },
    async loadWindow(input) { loaded.push(input); },
    async play() {},
    async pause() {},
    async dispose() {},
    getSnapshot() { return { activeResources: 0 }; }
  };
  const adapter = {
    async readWindow({ source: requested, window }) {
      adapterCalls += 1;
      assert.equal(requested.mimeType, AAC_PLAYBACK_MIME);
      return {
        classification: 'STORED_AAC_STORED_FRAGMENTS_SUPPORTED',
        initBytes: Uint8Array.of(9),
        mediaChunks: window.mediaChunks.map((entry) => ({ ...entry, bytes: Uint8Array.of(entry.sequence + 1) }))
      };
    }
  };
  const manager = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner', sessionId: 'session', spaceId: 'meeting-space' },
    audioStore: {
      async getAudioSource() { return value; },
      async getMeeting() { return { audioSources: [value], segments: segments() }; },
      async readAudioSegment() { throw new Error('AAC_ADAPTER_MUST_OWN_FRAGMENT_READS'); }
    },
    player,
    capabilityDetector: () => fakeCapability(),
    aacStoredFragmentAdapter: adapter,
    initBytesProvider: async () => { throw new Error('AAC_ADAPTER_MUST_OWN_INIT'); }
  });

  await manager.open({ meetingId: value.meetingId, sourceId: value.sourceId });
  await manager.seekTo(8_500);
  assert.equal(adapterCalls, 2);
  assert.equal(loaded.every((window) => window.mimeType === AAC_PLAYBACK_MIME), true);
  assert.equal(loaded.every((window) => window.initBytes.byteLength === 1), true);
  await manager.dispose();
});

test('independent AAC layout routes only through the independent bounded adapter', async () => {
  const loaded = [];
  let independentCalls = 0;
  const value = source({ containerLayout: 'independent-mp4-segments-v1' });
  const player = {
    audio: { currentTime: 0 },
    async loadWindow(input) { loaded.push(input); },
    async play() {},
    async pause() {},
    async dispose() {},
    getSnapshot() { return { activeResources: 0 }; }
  };
  const manager = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner' },
    audioStore: {
      async getAudioSource() { return value; },
      async getMeeting() { return { audioSources: [value], segments: segments() }; },
      async readAudioSegment() { throw new Error('INDEPENDENT_ADAPTER_OWNS_READS'); }
    },
    player,
    capabilityDetector: () => fakeCapability(),
    aacStoredFragmentAdapter: { async readWindow() { throw new Error('LEGACY_AAC_ROUTE_FORBIDDEN'); } },
    independentMp4SegmentAdapter: {
      async readWindow({ source: requested, window }) {
        independentCalls += 1;
        assert.equal(requested.containerLayout, 'independent-mp4-segments-v1');
        return {
          classification: 'STORED_AAC_INDEPENDENT_MP4_SEGMENTS_SUPPORTED',
          initBytes: Uint8Array.of(9),
          mediaChunks: window.mediaChunks.map((entry) => ({ ...entry, bytes: Uint8Array.of(1) }))
        };
      }
    }
  });

  await manager.open({ meetingId: value.meetingId, sourceId: value.sourceId });
  await manager.seekTo(8_500);
  assert.equal(independentCalls, 2);
  assert.equal(loaded.length, 2);
  await manager.dispose();
});

test('fresh playback open prepares the initial bounded window before the first play', async () => {
  const loaded = [];
  const value = source();
  const player = {
    audio: { currentTime: 0 },
    async loadWindow(input) { loaded.push(input); },
    async play() {},
    async pause() {},
    async dispose() {},
    getSnapshot() { return { activeResources: 3, requiresUserGesture: false }; }
  };
  const manager = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner', sessionId: 'session', spaceId: 'meeting-space' },
    audioStore: {
      async getAudioSource() { return value; },
      async getMeeting() { return { audioSources: [value], segments: segments() }; },
      async readAudioSegment() { return Uint8Array.of(1); }
    },
    player,
    capabilityDetector: () => fakeCapability(),
    initBytesProvider: async () => Uint8Array.of(9)
  });

  await manager.open({ meetingId: value.meetingId, sourceId: value.sourceId, initialTimeMs: 4_500 });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].targetMs, 4_500);
  await manager.pause();
  await manager.play();
  await manager.dispose();
});

test('playback manager fails closed when the source revision changes or capability is unavailable', async () => {
  const initial = source();
  let revision = 4;
  const store = {
    async getAudioSource() { return { ...initial, revision }; },
    async getMeeting() { return { audioSources: [{ ...initial, revision: 4 }], segments: segments() }; },
    async readAudioSegment() { return Uint8Array.of(1); }
  };
  const player = {
    audio: { currentTime: 0 },
    async loadWindow() {},
    async play() {},
    async pause() {},
    async dispose() {},
    getSnapshot() { return { activeResources: 0 }; }
  };
  const manager = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner', sessionId: 'session', spaceId: 'meeting-space' },
    audioStore: store,
    player,
    capabilityDetector: () => fakeCapability(),
    initBytesProvider: async () => Uint8Array.of(9)
  });
  await manager.open({ meetingId: 'meeting-1', sourceId: 'recorded-meeting-1' });
  revision = 5;
  await assert.rejects(() => manager.seekTo(0), (error) => error.code === 'PLAYBACK_BINDING_MISMATCH');

  const unsupported = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner', sessionId: 'session', spaceId: 'meeting-space' },
    audioStore: { ...store, async getAudioSource() { return initial; } },
    player,
    capabilityDetector: () => ({ supported: false, errorCode: 'PLAYBACK_UNSUPPORTED' })
  });
  await assert.rejects(() => unsupported.open({ meetingId: 'meeting-1', sourceId: 'recorded-meeting-1' }), (error) => error.code === 'PLAYBACK_UNSUPPORTED');
});

test('playback manager routes WebM through bounded reassembly and preserves the existing player contract', async () => {
  const fixture = buildBoundaryShapedFragments();
  const webmSource = {
    sourceId: 'recorded-webm',
    meetingId: 'meeting-webm',
    origin: 'recorded',
    format: 'webm-opus',
    mimeType: WEBM_PLAYBACK_MIME,
    durationMs: 3_000,
    committedDurationMs: 3_000,
    byteLength: fixture.fragments.reduce((total, bytes) => total + bytes.byteLength, 0),
    committedByteLength: fixture.fragments.reduce((total, bytes) => total + bytes.byteLength, 0),
    chunkCount: fixture.fragments.length,
    revision: 9,
    checksum: 'webm-source-checksum'
  };
  const webmSegments = fixture.fragments.map((bytes, sequence) => ({
    segmentId: `segment-${sequence}`,
    sequence,
    durationMs: 600,
    byteLength: bytes.byteLength,
    checksum: String(sequence).repeat(64),
    mimeType: WEBM_PLAYBACK_MIME
  }));
  const loaded = [];
  const player = {
    audio: { currentTime: 0 },
    async loadWindow(input) { loaded.push(input); },
    async play() {},
    async pause() {},
    async dispose() {},
    getSnapshot() { return { activeResources: 0, finalActiveResources: 0 }; }
  };
  const bytesById = new Map(webmSegments.map((segment, index) => [segment.segmentId, fixture.fragments[index]]));
  const audioStore = {
    async getAudioSource() { return webmSource; },
    async getMeeting() { return { audioSources: [webmSource], segments: webmSegments }; },
    async readAudioSegment(_owner, _meetingId, segmentId) { return bytesById.get(segmentId); }
  };
  const adapter = createStage3cWebmBoundedReassemblyAdapter({ audioStore, ownerContext: { trusted: true }, maxFragmentCount: 3 });
  const manager = createStage3cPlaybackManager({
    ownerContext: { trusted: true },
    audioStore,
    player,
    webmReassemblyAdapter: adapter,
    capabilityDetector: () => fakeCapability('managed-media-source', WEBM_PLAYBACK_MIME)
  });
  await manager.open({ meetingId: webmSource.meetingId, sourceId: webmSource.sourceId });
  loaded.length = 0;
  await manager.seekTo(900);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].initBytes.byteLength > 0, true);
  assert.equal(loaded[0].mediaChunks.length, 1);
  assert.equal(loaded[0].mediaChunks[0].timecodeMs, 1_000);
  assert.equal(loaded[0].mediaChunks[0].bytes instanceof Uint8Array, true);
  await manager.dispose();
});

test('playback manager serializes window replacement and coalesces pending targets with latest-seek-wins', async () => {
  const loaded = [];
  let activeLoads = 0;
  let peakLoads = 0;
  let opening = true;
  let releaseFirstLoad;
  const firstLoadStarted = new Promise((resolve) => { releaseFirstLoad = { started: resolve, complete: null }; });
  const firstLoadComplete = new Promise((resolve) => { releaseFirstLoad.complete = resolve; });
  const player = {
    audio: { currentTime: 0 },
    async loadWindow(input) {
      if (opening) {
        opening = false;
        loaded.push(input.targetMs);
        return;
      }
      activeLoads += 1;
      peakLoads = Math.max(peakLoads, activeLoads);
      if (loaded.length === 0) {
        releaseFirstLoad.started();
        await firstLoadComplete;
      }
      loaded.push(input.targetMs);
      activeLoads -= 1;
    },
    async play() {},
    async pause() {},
    async dispose() {},
    getSnapshot() { return { activeResources: 3, requiresUserGesture: false }; }
  };
  const value = source();
  const playbackStore = {
    async getAudioSource() { return value; },
    async getMeeting() { return { audioSources: [value], segments: segments() }; },
    async readAudioSegment() { return Uint8Array.of(1); }
  };
  const manager = createStage3cPlaybackManager({
    ownerContext: { trusted: true, ownerId: 'owner' },
    audioStore: playbackStore,
    player,
    capabilityDetector: () => fakeCapability(),
    initBytesProvider: async () => Uint8Array.of(9)
  });
  await manager.open({ meetingId: 'meeting-1', sourceId: 'recorded-meeting-1' });
  loaded.length = 0;
  const first = manager.seekTo(0);
  await firstLoadStarted;
  const superseded = manager.seekTo(3_000);
  const latest = manager.seekTo(8_500);
  releaseFirstLoad.complete();
  const [firstResult, supersededResult, latestResult] = await Promise.all([first, superseded, latest]);
  assert.equal(peakLoads, 1);
  assert.deepEqual(loaded, [0, 8_500]);
  assert.equal(firstResult.currentTargetMs, 0);
  assert.equal(supersededResult.currentTargetMs, 8_500);
  assert.equal(latestResult.currentTargetMs, 8_500);
  assert.equal(manager.getSnapshot().currentTargetMs, 8_500);
  await manager.dispose();
});
