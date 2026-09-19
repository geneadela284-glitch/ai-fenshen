import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyUserAgent,
  evaluateRecordingAttemptGate,
  MeetingRecordingAttemptStore
} from './meetingRecordingAttemptStore.js';

const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1';
const iphoneChromeUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.7258.76 Mobile/15E148 Safari/604.1';

function attempt(overrides = {}) {
  return {
    generation: '270',
    implementationCommit: 'commit',
    clientBuildId: 'build',
    assetVersionId: 'asset',
    isIphoneProfile: true,
    supportedAacCodecMime: true,
    supportedAacPlainMime: true,
    selectedProfile: 'AAC_MP4_PRIMARY',
    actualMimeType: 'audio/mp4;codecs=mp4a.40.2',
    ...overrides
  };
}

test('server gate accepts exact AAC primary identity and rejects stale assets', () => {
  assert.deepEqual(evaluateRecordingAttemptGate({ attempt: attempt(), expectedGeneration: '270', expectedImplementationCommit: 'commit', expectedClientBuildId: 'build', expectedAssetVersionId: 'asset' }), {
    ok: true, serverGate: 'AAC_PRIMARY_ACTIVE', errorCode: null
  });
  assert.equal(evaluateRecordingAttemptGate({ attempt: attempt({ clientBuildId: 'old-build' }), expectedClientBuildId: 'build' }).errorCode, 'CLIENT_ASSET_VERSION_MISMATCH');
  assert.equal(evaluateRecordingAttemptGate({ attempt: attempt({ supportedAacCodecMime: false, supportedAacPlainMime: true, actualMimeType: 'audio/mp4' }) }).ok, true);
});

test('server gate classifies unsupported, fallback, constructor mismatch, and non-iPhone cases', () => {
  assert.equal(evaluateRecordingAttemptGate({ attempt: attempt({ supportedAacCodecMime: false, supportedAacPlainMime: false, selectedProfile: 'WEBM_FALLBACK' }) }).errorCode, 'AAC_UNSUPPORTED');
  assert.equal(evaluateRecordingAttemptGate({ attempt: attempt({ selectedProfile: 'WEBM_FALLBACK' }) }).errorCode, 'WEBM_FALLBACK_SELECTED');
  assert.equal(evaluateRecordingAttemptGate({ attempt: attempt({ actualMimeType: 'audio/webm;codecs=opus' }) }).errorCode, 'AAC_CONSTRUCTOR_MIME_MISMATCH');
  assert.equal(evaluateRecordingAttemptGate({ attempt: attempt({ isIphoneProfile: false }) }).errorCode, 'IPHONE_PROFILE_NOT_MATCHED');
});

test('server user-agent classifier accepts iPhone Chrome truthfully and rejects other iOS wrappers', () => {
  assert.deepEqual(classifyUserAgent(iphoneChromeUa), {
    normalizedDeviceClassification: 'iphone-chrome',
    isIOS: true,
    isSafari: false,
    isIphoneProfile: true
  });

  for (const userAgent of [
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/141.0 Mobile/15E148 Safari/605.1.15',
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 EdgiOS/139.0 Mobile/15E148 Safari/605.1.15',
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 GSA/382.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 OPiOS/5.0 Mobile/15E148 Safari/9537.53',
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148'
  ]) {
    assert.deepEqual(classifyUserAgent(userAgent), {
      normalizedDeviceClassification: 'ios-other',
      isIOS: true,
      isSafari: false,
      isIphoneProfile: false
    });
  }
});

test('recording attempt store is owner scoped and idempotent across duplicate submissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recording-attempt-store-'));
  const store = new MeetingRecordingAttemptStore({ dbPath: path.join(directory, 'attempts.sqlite') }).initialize();
  try {
    const gate = evaluateRecordingAttemptGate({ attempt: attempt() });
    const first = store.save({ authenticatedUserId: 'owner-a', scope: 'meeting-space', userAgent: iphoneUa, payload: { recordingAttemptId: 'attempt-a', ...attempt() }, gate });
    assert.equal(first.idempotent, false);
    assert.equal(first.attempt.ownerId, 'owner-a');
    const repeated = store.save({ authenticatedUserId: 'owner-a', scope: 'forged-scope', userAgent: iphoneUa, payload: { recordingAttemptId: 'attempt-a', ownerId: 'owner-b', ...attempt() }, gate });
    assert.equal(repeated.idempotent, true);
    assert.throws(() => store.save({ authenticatedUserId: 'owner-b', scope: 'meeting-space', userAgent: iphoneUa, payload: { recordingAttemptId: 'attempt-a', ...attempt() }, gate }), (error) => error.code === 'RECORDING_ATTEMPT_OWNER_MISMATCH');
    const bound = store.bind({ authenticatedUserId: 'owner-a', recordingAttemptId: 'attempt-a', meetingId: 'meeting-a', sourceId: 'source-a' });
    assert.equal(bound.meetingId, 'meeting-a');
    assert.equal(bound.sourceId, 'source-a');
    assert.equal(bound.idempotent, false);
    const repeatedBind = store.bind({ authenticatedUserId: 'owner-a', recordingAttemptId: 'attempt-a', meetingId: 'meeting-a', sourceId: 'source-a' });
    assert.equal(repeatedBind.idempotent, true);
    assert.throws(
      () => store.bind({ authenticatedUserId: 'owner-a', recordingAttemptId: 'attempt-a', meetingId: 'meeting-b', sourceId: 'source-b' }),
      (error) => error.code === 'RECORDING_ATTEMPT_BIND_CONFLICT'
    );
    assert.equal(store.findBySource({ authenticatedUserId: 'owner-a', meetingId: 'meeting-a', sourceId: 'source-a' }).recordingAttemptId, 'attempt-a');
    assert.equal(store.findBySource({ authenticatedUserId: 'owner-b', meetingId: 'meeting-a', sourceId: 'source-a' }), null);
    assert.equal(store.findByAttempt({ authenticatedUserId: 'owner-a', recordingAttemptId: 'attempt-a' }).meetingId, 'meeting-a');
    assert.equal(store.findByAttempt({ authenticatedUserId: 'owner-b', recordingAttemptId: 'attempt-a' }), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
