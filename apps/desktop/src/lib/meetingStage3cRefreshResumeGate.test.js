import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

import { createMemoryMeetingBackend, createMeetingPhase1Store } from './browserMeetingStore.js';
import { createMeetingPhase1Manager } from './meetingPhase1Manager.js';
import { createStage3cRefreshSafeRecorderFactory } from './meetingStage3cRefreshSafeRecorderAdapter.js';

const cryptoImpl = webcrypto;
const ownerContext = Object.freeze({
  trusted: true,
  ownerId: 'stage3c-gate-owner',
  sessionId: 'stage3c-gate-session',
  spaceId: 'meeting-space'
});

class GateTrack {
  stop() {}
}

class GateStream {
  getTracks() {
    return [new GateTrack()];
  }
}

class RefreshGateMediaRecorder {
  static instances = [];

  static isTypeSupported(mimeType) {
    return mimeType === 'audio/webm;codecs=opus';
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
    this.state = 'inactive';
    this.pageOrdinal = RefreshGateMediaRecorder.instances.length + 1;
    RefreshGateMediaRecorder.instances.push(this);
  }

  start(timeslice) {
    this.timeslice = timeslice;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  emitTimeslice() {
    this.ondataavailable?.({
      data: new Blob([`stage3c-page-${this.pageOrdinal}-audio`], { type: this.mimeType })
    });
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.emitTimeslice();
    queueMicrotask(() => this.onstop?.());
  }
}

function mediaDevices() {
  return {
    async getUserMedia() {
      return new GateStream();
    }
  };
}

function monotonicClock() {
  let current = Date.parse('2026-08-09T22:30:00.000Z');
  return () => {
    current += 1_000;
    return new Date(current).toISOString();
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('Stage3C Gate A: a refreshed page resumes without reusing persisted chunk identity', async () => {
  RefreshGateMediaRecorder.instances = [];
  const ownerKey = await cryptoImpl.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const keyProvider = Object.freeze({
    withOwnerKey: (_context, callback) => callback(ownerKey)
  });
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider, backend });
  const now = monotonicClock();
  const recorderFactory = createStage3cRefreshSafeRecorderFactory({ cryptoImpl });
  const createPageManager = () => createMeetingPhase1Manager({
    ownerContext,
    store,
    cryptoImpl,
    now,
    recorderFactory,
    recorderOptions: {
      mediaDevices: mediaDevices(),
      MediaRecorderImpl: RefreshGateMediaRecorder,
      documentImpl: null,
      windowImpl: null,
      segmentDurationMs: 1_000
    }
  });

  const pageA = createPageManager();
  await pageA.initialize();
  const created = await pageA.createMeeting({ title: 'Stage3C refresh-resume gate' });
  const meetingId = created.meeting.meetingId;
  await pageA.startRecording();
  RefreshGateMediaRecorder.instances[0].emitTimeslice();
  await waitFor(
    () => pageA.getSnapshot().active?.segments?.length === 1,
    'page A timeslice was not persisted before reload'
  );

  const beforeReload = pageA.getSnapshot().active;
  assert.equal(beforeReload.meeting.recordingState, 'recording');
  assert.deepEqual(beforeReload.segments.map((segment) => segment.sequence), [0]);
  assert.match(
    beforeReload.segments[0].chunkToken,
    /^stage3c-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-recorder-1-0$/i
  );
  assert.equal(beforeReload.segments[0].durationMs > 0, true);
  assert.equal(beforeReload.audioSources[0].chunkCount, 1);

  // A hard browser refresh discards page A before its graceful dispose path can
  // persist an interruption. Page B must recover that orphaned recording.
  const pageB = createPageManager();
  await pageB.initialize();
  const recovered = await pageB.openMeeting(meetingId);
  assert.equal(recovered.meeting.recordingState, 'interrupted');
  assert.equal(recovered.meeting.interruptionReason, 'page_reload_recovery');
  assert.deepEqual(recovered.segments.map((segment) => segment.sequence), [0]);

  await pageB.startRecording();
  assert.equal(RefreshGateMediaRecorder.instances.length, 2);
  assert.equal(pageB.getSnapshot().active.meeting.recordingState, 'recording');

  await assert.doesNotReject(
    () => pageB.stopRecording(),
    'post-refresh audio with different bytes must receive a fresh chunk identity'
  );

  const completed = pageB.getSnapshot().active;
  assert.equal(completed.meeting.recordingState, 'stopped');
  assert.deepEqual(completed.segments.map((segment) => segment.sequence), [0, 1]);
  assert.equal(new Set(completed.segments.map((segment) => segment.chunkToken)).size, 2);
  assert.match(
    completed.segments[1].chunkToken,
    /^stage3c-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-recorder-1-0$/i
  );
  assert.notEqual(completed.segments[0].chunkToken, completed.segments[1].chunkToken);
  assert.equal(completed.segments.every((segment) => segment.durationMs > 0), true);

  const source = completed.audioSources.find((item) => item.origin === 'recorded');
  assert.equal(source.chunkCount, 2);
  assert.equal(
    source.committedDurationMs,
    completed.segments.reduce((total, segment) => total + segment.durationMs, 0)
  );

  const streamed = [];
  for await (const chunk of store.streamAudioSourceDetailed(ownerContext, {
    meetingId,
    sourceId: source.sourceId
  })) {
    streamed.push({
      sequence: chunk.sequence,
      durationMs: chunk.durationMs,
      text: new TextDecoder().decode(chunk.bytes)
    });
  }
  assert.deepEqual(streamed.map((chunk) => chunk.sequence), [0, 1]);
  assert.equal(streamed.every((chunk) => chunk.durationMs > 0), true);
  assert.deepEqual(streamed.map((chunk) => chunk.text), [
    'stage3c-page-1-audio',
    'stage3c-page-2-audio'
  ]);
});
