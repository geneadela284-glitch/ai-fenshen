import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

import { createMemoryMeetingBackend, createMeetingPhase1Store } from './browserMeetingStore.js';
import { transitionMeetingPhase1Session } from './meetingPhase1State.js';
import { createStage3cRefreshSafeRecorderFactory } from './meetingStage3cRefreshSafeRecorderAdapter.js';

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';

function sequentialCrypto(values) {
  let calls = 0;
  return {
    randomUUID() {
      const value = values[calls];
      calls += 1;
      return value;
    },
    get calls() {
      return calls;
    }
  };
}

function captureControllerFactory() {
  const controllers = [];
  const controllerFactory = (options) => {
    const controller = Object.freeze({ options });
    controllers.push(controller);
    return controller;
  };
  return { controllerFactory, controllers };
}

test('a unique stable namespace is allocated once per controller without changing segment data', async () => {
  const cryptoImpl = sequentialCrypto([UUID_A, UUID_B]);
  const capture = captureControllerFactory();
  const received = [];
  const promiseA = Promise.resolve({ accepted: 'a' });
  const promiseB = Promise.resolve({ accepted: 'b' });
  const sink = (segment) => {
    received.push(segment);
    return received.length === 1 ? promiseA : promiseB;
  };
  const recorderFactory = createStage3cRefreshSafeRecorderFactory({
    cryptoImpl,
    controllerFactory: capture.controllerFactory
  });

  recorderFactory({ onSegment: sink, marker: 'page-a' });
  recorderFactory({ onSegment: sink, marker: 'page-b' });

  assert.equal(cryptoImpl.calls, 2);
  assert.equal(capture.controllers.length, 2);
  assert.equal(capture.controllers[0].options.marker, 'page-a');
  assert.equal(capture.controllers[1].options.marker, 'page-b');

  const blob = new Blob(['unchanged-audio'], { type: 'audio/webm;codecs=opus' });
  const segment = Object.freeze({
    blob,
    chunkToken: 'recorder-1-0',
    durationMs: 1_234,
    mimeType: 'audio/webm;codecs=opus',
    startedAt: '2026-08-10T09:00:00.000Z',
    endedAt: '2026-08-10T09:00:01.234Z'
  });
  const resultA = capture.controllers[0].options.onSegment(segment);
  const resultB = capture.controllers[1].options.onSegment(segment);

  assert.equal(resultA, promiseA);
  assert.equal(resultB, promiseB);
  assert.equal(received[0].chunkToken, `stage3c-v1-${UUID_A}-recorder-1-0`);
  assert.equal(received[1].chunkToken, `stage3c-v1-${UUID_B}-recorder-1-0`);
  assert.notEqual(received[0].chunkToken, received[1].chunkToken);
  for (const projected of received) {
    assert.equal(projected.blob, blob);
    assert.equal(projected.durationMs, segment.durationMs);
    assert.equal(projected.mimeType, segment.mimeType);
    assert.equal(projected.startedAt, segment.startedAt);
    assert.equal(projected.endedAt, segment.endedAt);
  }
  assert.equal(await received[0].blob.text(), 'unchanged-audio');
});

test('the same controller maps a duplicate original token identically and preserves Store idempotency', async () => {
  const ownerContext = Object.freeze({
    trusted: true,
    ownerId: 'stage3c-adapter-owner',
    sessionId: 'stage3c-adapter-session',
    spaceId: 'meeting-space'
  });
  const ownerKey = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const store = createMeetingPhase1Store({
    cryptoImpl: webcrypto,
    keyProvider: Object.freeze({ withOwnerKey: (_context, callback) => callback(ownerKey) }),
    backend: createMemoryMeetingBackend()
  });
  const { meeting: session } = await store.createMeeting(ownerContext, {
    meetingId: 'stage3c-adapter-idempotency',
    title: 'Stage3C adapter idempotency',
    scope: 'meeting'
  });
  const prepared = transitionMeetingPhase1Session(session, { type: 'prepare' }, { now: '2026-08-10T09:10:01.000Z' }).state;
  await store.saveSession(ownerContext, prepared);
  const recording = transitionMeetingPhase1Session(prepared, { type: 'recorder_started', actualStarted: true }, { now: '2026-08-10T09:10:02.000Z' }).state;
  await store.saveSession(ownerContext, recording);

  const capture = captureControllerFactory();
  const observedTokens = [];
  const recorderFactory = createStage3cRefreshSafeRecorderFactory({
    cryptoImpl: sequentialCrypto([UUID_A]),
    controllerFactory: capture.controllerFactory
  });
  recorderFactory({
    async onSegment(segment) {
      observedTokens.push(segment.chunkToken);
      return store.commitAudioSegment(ownerContext, {
        meetingId: session.meetingId,
        segment: {
          segmentId: `segment-${segment.chunkToken}`,
          chunkToken: segment.chunkToken,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          durationMs: segment.durationMs,
          mimeType: segment.mimeType
        },
        bytes: new Uint8Array(await segment.blob.arrayBuffer())
      });
    }
  });

  const payload = Object.freeze({
    blob: new Blob(['same-controller-retry'], { type: 'audio/webm;codecs=opus' }),
    chunkToken: 'recorder-1-0',
    durationMs: 1_000,
    mimeType: 'audio/webm;codecs=opus',
    startedAt: '2026-08-10T09:10:02.000Z',
    endedAt: '2026-08-10T09:10:03.000Z'
  });
  const first = await capture.controllers[0].options.onSegment(payload);
  const duplicate = await capture.controllers[0].options.onSegment(payload);

  assert.deepEqual(observedTokens, [
    `stage3c-v1-${UUID_A}-recorder-1-0`,
    `stage3c-v1-${UUID_A}-recorder-1-0`
  ]);
  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal((await store.getMeeting(ownerContext, session.meetingId)).segments.length, 1);
});

test('missing or invalid randomUUID fails closed without invoking the controller factory', () => {
  for (const cryptoImpl of [
    {},
    { randomUUID: () => '' },
    { randomUUID: () => 'not-a-uuid' },
    { randomUUID: () => null }
  ]) {
    let controllerCalls = 0;
    const recorderFactory = createStage3cRefreshSafeRecorderFactory({
      cryptoImpl,
      controllerFactory: () => {
        controllerCalls += 1;
        return {};
      }
    });
    assert.throws(
      () => recorderFactory({}),
      (error) => ['STAGE3C_RECORDER_NONCE_UNAVAILABLE', 'STAGE3C_RECORDER_NONCE_INVALID'].includes(error.code)
    );
    assert.equal(controllerCalls, 0);
  }
});
