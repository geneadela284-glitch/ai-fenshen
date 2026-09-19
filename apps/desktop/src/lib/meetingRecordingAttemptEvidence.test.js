import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMeetingRecordingAttemptEvidenceClient,
  getMeetingClientBuildIdentity
} from './meetingRecordingAttemptEvidence.js';

function storageHarness() {
  const values = new Map();
  return {
    values,
    setItem(key, value) { values.set(key, String(value)); },
    getItem(key) { return values.get(key) || null; }
  };
}

function identity(overrides = {}) {
  return {
    generation: '270',
    implementationCommit: '9f832cf2940e58c31e83ad5424e93f5fe1d631b9',
    clientBuildId: 'gen270-aac-test',
    assetVersionId: 'assets-test',
    loadedAssetVersion: ['assets/index-test.js'],
    userAgent: 'iPhone Safari',
    isIOS: true,
    isSafari: true,
    isIphoneProfile: true,
    ...overrides
  };
}

function runtime(overrides = {}) {
  return {
    mediaProfile: { profile: { id: 'aac-mp4' }, reason: 'AAC_SUPPORTED' },
    capabilities: [
      { requestedMimeType: 'audio/mp4;codecs=mp4a.40.2', supported: true },
      { requestedMimeType: 'audio/mp4', supported: true }
    ],
    requestedMimeType: 'audio/mp4;codecs=mp4a.40.2',
    constructorOptions: { mimeType: 'audio/mp4;codecs=mp4a.40.2' },
    actualMimeType: 'audio/mp4;codecs=mp4a.40.2',
    ...overrides
  };
}

test('recording evidence client persists the full pre-record payload before server acknowledgement', async () => {
  const storage = storageHarness();
  let request = null;
  const client = createMeetingRecordingAttemptEvidenceClient({
    storage,
    identity: identity(),
    cryptoImpl: { randomUUID: () => 'attempt-uuid' },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, async json() { return { ok: true, serverGate: 'AAC_PRIMARY_ACTIVE', recordingAttempt: { recordingAttemptId: request.recordingAttemptId } }; } };
    }
  });
  const result = await client.submit(runtime());
  assert.equal(result.recordingAttemptId, 'recording-attempt-attempt-uuid');
  assert.equal(request.selectedProfile, 'AAC_MP4_PRIMARY');
  assert.equal(request.supportedAacCodecMime, true);
  assert.equal(request.capabilities.length, 2);
  assert.equal(request.capabilities[0].supported, true);
  assert.equal(request.actualMimeType, 'audio/mp4;codecs=mp4a.40.2');
  const saved = JSON.parse(storage.values.get('meeting-recording-attempt:recording-attempt-attempt-uuid'));
  assert.equal(saved.status, 'acknowledged');
  assert.equal(saved.payload.assetVersionId, 'assets-test');
});

test('recording evidence fails closed when local pending storage is unavailable', async () => {
  const client = createMeetingRecordingAttemptEvidenceClient({
    storage: null,
    identity: identity(),
    cryptoImpl: { randomUUID: () => 'no-storage' },
    fetchImpl: async () => { throw new Error('must not upload without local checkpoint'); }
  });
  await assert.rejects(client.submit(runtime()), (error) => error.code === 'AAC_PRE_RECORD_EVIDENCE_LOCAL_STORAGE_UNAVAILABLE');
});

test('recording evidence client retains a precise server rejection without allowing start to continue', async () => {
  const storage = storageHarness();
  const client = createMeetingRecordingAttemptEvidenceClient({
    storage,
    identity: identity(),
    cryptoImpl: { randomUUID: () => 'rejected' },
    fetchImpl: async () => ({ ok: false, async json() { return { ok: false, serverGate: 'AAC_PRIMARY_NOT_ACTIVE', errorCode: 'WEBM_FALLBACK_SELECTED' }; } })
  });
  await assert.rejects(client.submit(runtime({ actualMimeType: 'audio/webm;codecs=opus' })), (error) => error.code === 'WEBM_FALLBACK_SELECTED');
  const saved = JSON.parse(storage.values.get('meeting-recording-attempt:recording-attempt-rejected'));
  assert.equal(saved.status, 'server-rejected');
  assert.equal(saved.errorCode, 'WEBM_FALLBACK_SELECTED');
});

test('recording evidence keeps a pending checkpoint when the authenticated upload fails', async () => {
  const storage = storageHarness();
  const client = createMeetingRecordingAttemptEvidenceClient({
    storage,
    identity: identity(),
    cryptoImpl: { randomUUID: () => 'network-failure' },
    fetchImpl: async () => { throw new Error('network down'); }
  });
  await assert.rejects(client.submit(runtime()), (error) => error.code === 'AAC_PRE_RECORD_EVIDENCE_UPLOAD_FAILED');
  const saved = JSON.parse(storage.values.get('meeting-recording-attempt:recording-attempt-network-failure'));
  assert.equal(saved.status, 'upload-failed');
  assert.equal(saved.errorCode, 'AAC_PRE_RECORD_EVIDENCE_UPLOAD_FAILED');
});

test('client build identity captures loaded hashed assets and Safari profile', () => {
  const identityValue = getMeetingClientBuildIdentity({
    navigatorImpl: { userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 },
    documentImpl: {
      querySelectorAll() {
        return [{ src: '/assets/index-abc.js' }, { href: '/assets/index-def.css' }];
      }
    },
    locationImpl: { origin: 'https://rc.test', pathname: '/' },
    generation: '270', implementationCommit: 'commit', clientBuildId: 'build', assetVersionId: 'asset'
  });
  assert.equal(identityValue.deviceClassification, 'iphone-safari');
  assert.equal(identityValue.isIOS, true);
  assert.equal(identityValue.isSafari, true);
  assert.equal(identityValue.isIphoneProfile, true);
  assert.deepEqual(identityValue.loadedAssetVersion, ['/assets/index-abc.js', '/assets/index-def.css']);
  assert.equal(identityValue.pageUrl, 'https://rc.test/');
});

test('client build identity reports iPhone Chrome truthfully as a verified non-Safari profile', () => {
  const identityValue = getMeetingClientBuildIdentity({
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.7258.76 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5
    },
    documentImpl: { querySelectorAll: () => [] }
  });

  assert.equal(identityValue.deviceClassification, 'iphone-chrome');
  assert.equal(identityValue.isIOS, true);
  assert.equal(identityValue.isSafari, false);
  assert.equal(identityValue.isIphoneProfile, true);
});

test('client build identity never promotes unsupported iOS wrappers or desktop to the iPhone profile', () => {
  const firefoxIdentity = getMeetingClientBuildIdentity({
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/141.0 Mobile/15E148 Safari/605.1.15',
      platform: 'iPhone',
      maxTouchPoints: 5
    },
    documentImpl: { querySelectorAll: () => [] }
  });
  const desktopIdentity = getMeetingClientBuildIdentity({
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
      platform: 'MacIntel',
      maxTouchPoints: 0
    },
    documentImpl: { querySelectorAll: () => [] }
  });

  assert.equal(firefoxIdentity.deviceClassification, 'ios-unsupported');
  assert.equal(firefoxIdentity.isIphoneProfile, false);
  assert.equal(desktopIdentity.deviceClassification, 'desktop');
  assert.equal(desktopIdentity.isIphoneProfile, false);
});
