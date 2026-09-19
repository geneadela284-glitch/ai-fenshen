import assert from 'node:assert/strict';
import test from 'node:test';
import { AAC_PRIMARY_PROFILE, WEBM_DESKTOP_PROFILE } from './meetingRecordingMediaProfile.js';
import {
  configureMeetingRecordingRuntime,
  DEFAULT_SEGMENT_ROTATION_WRITES_ENABLED,
  resolveDefaultSegmentRotationWritesEnabled
} from './meetingRecordingRuntimeProfile.js';

test('legacy Stage4 UI RC flag keeps the accepted native pause/resume path protected', () => {
  assert.equal(resolveDefaultSegmentRotationWritesEnabled({
    VITE_MEETING_STAGE4_UI_RC: '1',
    VITE_MEETING_IOS_AAC_SEGMENT_ROTATION: '1'
  }), false);
  assert.equal(resolveDefaultSegmentRotationWritesEnabled({ VITE_MEETING_IOS_AAC_SEGMENT_ROTATION: '1' }), true);
});

test('normal Meeting V1 runtime keeps the accepted native pause/resume path by default', () => {
  assert.equal(DEFAULT_SEGMENT_ROTATION_WRITES_ENABLED, false);
  const result = configureMeetingRecordingRuntime({
    mediaProfile: verifiedProfile('iphone-safari'),
    recorderOptions: { checkpointIntervalMs: 12_000 },
    recordingAttemptEvidenceClient: { submit() {} },
    checkpointTraceClient: { record() {} }
  });

  assert.equal(result.recorderOptions.checkpointMode, 'passive-native-timeslice');
  assert.equal(result.recorderOptions.nativeTimesliceMs, 12_000);
  assert.equal('captureUnitMs' in result.recorderOptions, false);
});

function verifiedProfile(device) {
  return Object.freeze({
    device,
    profile: AAC_PRIMARY_PROFILE,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    fallback: false,
    reason: 'AAC_SUPPORTED'
  });
}

for (const device of ['iphone-safari', 'iphone-chrome']) {
  test(`${device} receives the authenticated AAC and checkpoint runtime`, () => {
    const attemptEvidenceClient = { submit() {}, bind() {} };
    const checkpointTraceClient = { record() {}, flushPending() {} };
    let attemptFactoryCalls = 0;
    let traceFactoryCalls = 0;
    const result = configureMeetingRecordingRuntime({
      mediaProfile: verifiedProfile(device),
      recorderOptions: { checkpointIntervalMs: 12_000 },
      indexedDBImpl: { name: 'indexed-db' },
      createAttemptEvidenceClient() {
        attemptFactoryCalls += 1;
        return attemptEvidenceClient;
      },
      createCheckpointTraceClient({ indexedDBImpl }) {
        traceFactoryCalls += 1;
        assert.deepEqual(indexedDBImpl, { name: 'indexed-db' });
        return checkpointTraceClient;
      }
    });

    assert.equal(attemptFactoryCalls, 1);
    assert.equal(traceFactoryCalls, 1);
    assert.equal(result.attemptEvidenceClient, attemptEvidenceClient);
    assert.equal(result.durableCheckpointTraceClient, checkpointTraceClient);
    assert.deepEqual(result.recorderOptions, {
      checkpointIntervalMs: 12_000,
      checkpointMode: 'passive-native-timeslice',
      nativeTimesliceMs: 12_000,
      preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
      recordingCodecExperiment: 'aac-mp4',
      mediaProfile: verifiedProfile(device),
      requireAacPrimaryGate: true,
      recordingAttemptEvidence: attemptEvidenceClient.submit
    });
  });

  test(`${device} routes verified AAC writes to independent CaptureUnit rotation only when enabled`, () => {
    const attemptEvidenceClient = { submit() {}, bind() {} };
    const checkpointTraceClient = { record() {}, flushPending() {} };
    const result = configureMeetingRecordingRuntime({
      mediaProfile: verifiedProfile(device),
      recorderOptions: { checkpointIntervalMs: 12_000 },
      segmentRotationWritesEnabled: true,
      recordingAttemptEvidenceClient: attemptEvidenceClient,
      checkpointTraceClient
    });

    assert.equal(result.recorderOptions.checkpointMode, 'rotating-independent-mp4');
    assert.equal(result.recorderOptions.captureUnitMs, 12_000);
    assert.equal(result.recorderOptions.requireAacPrimaryGate, true);
    assert.equal(result.recorderOptions.recordingAttemptEvidence, attemptEvidenceClient.submit);
    assert.equal('nativeTimesliceMs' in result.recorderOptions, false);
  });
}

test('the rotation flag does not route an iOS WebM fallback profile into the AAC coordinator', () => {
  const mediaProfile = Object.freeze({
    device: 'iphone-safari',
    profile: { id: 'webm-opus-fallback' },
    preferredMimeType: '',
    recordingCodecExperiment: '',
    fallback: true,
    reason: 'AAC_UNSUPPORTED'
  });
  const result = configureMeetingRecordingRuntime({
    mediaProfile,
    segmentRotationWritesEnabled: true,
    recordingAttemptEvidenceClient: { submit() {} },
    checkpointTraceClient: { record() {} }
  });

  assert.equal(result.recorderOptions.checkpointMode, 'passive-native-timeslice');
  assert.equal('captureUnitMs' in result.recorderOptions, false);
});

test('unsupported iOS fails closed without creating evidence or trace clients', () => {
  let factoryCalls = 0;
  const mediaProfile = Object.freeze({
    device: 'ios-unsupported',
    profile: null,
    blocked: true,
    errorCode: 'IOS_BROWSER_UNSUPPORTED'
  });
  const result = configureMeetingRecordingRuntime({
    mediaProfile,
    recorderOptions: { checkpointIntervalMs: 12_000 },
    createAttemptEvidenceClient() {
      factoryCalls += 1;
      return {};
    },
    createCheckpointTraceClient() {
      factoryCalls += 1;
      return {};
    }
  });

  assert.equal(factoryCalls, 0);
  assert.equal(result.attemptEvidenceClient, null);
  assert.equal(result.durableCheckpointTraceClient, null);
  assert.deepEqual(result.recorderOptions, {
    checkpointIntervalMs: 12_000,
    mediaProfile,
    preRecordErrorCode: 'IOS_BROWSER_UNSUPPORTED'
  });
});

test('desktop retains its exact recorder options and does not create iOS clients', () => {
  const recorderOptions = { preferredMimeType: 'audio/webm;codecs=opus' };
  let factoryCalls = 0;
  const result = configureMeetingRecordingRuntime({
    mediaProfile: {
      device: 'desktop',
      profile: WEBM_DESKTOP_PROFILE,
      reason: 'DESKTOP_WEBM_PRIMARY'
    },
    recorderOptions,
    createAttemptEvidenceClient() {
      factoryCalls += 1;
      return {};
    },
    createCheckpointTraceClient() {
      factoryCalls += 1;
      return {};
    }
  });

  assert.equal(factoryCalls, 0);
  assert.equal(result.recorderOptions, recorderOptions);
  assert.equal(result.attemptEvidenceClient, null);
  assert.equal(result.durableCheckpointTraceClient, null);
});
