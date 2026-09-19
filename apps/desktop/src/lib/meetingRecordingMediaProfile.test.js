import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AAC_PRIMARY_PROFILE,
  WEBM_DESKTOP_PROFILE,
  WEBM_FALLBACK_PROFILE,
  resolveMeetingRecordingMediaProfile,
  validateMeetingRecordingMediaProfile
} from './meetingRecordingMediaProfile.js';

function recorderWith(...supported) {
  return {
    isTypeSupported(mimeType) {
      return supported.includes(mimeType);
    }
  };
}

const iphoneSafari = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5
};

const iphoneChrome = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.7258.76 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5
};

const unsupportedIosBrowsers = [
  {
    name: 'Firefox',
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15',
      platform: 'iPhone',
      maxTouchPoints: 5
    }
  },
  {
    name: 'Edge',
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/139.0 Mobile/15E148 Safari/605.1.15',
      platform: 'iPhone',
      maxTouchPoints: 5
    }
  },
  {
    name: 'Google app',
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/382.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5
    }
  },
  {
    name: 'Opera',
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/5.0 Mobile/15E148 Safari/9537.53',
      platform: 'iPhone',
      maxTouchPoints: 5
    }
  },
  {
    name: 'unknown WebView',
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      platform: 'iPhone',
      maxTouchPoints: 5
    }
  }
];

test('iPhone Safari prefers the verified AAC/MP4 profile when supported', () => {
  const profile = resolveMeetingRecordingMediaProfile({
    navigatorImpl: iphoneSafari,
    MediaRecorderImpl: recorderWith('audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus')
  });

  assert.deepEqual(profile, {
    device: 'iphone-safari',
    profile: AAC_PRIMARY_PROFILE,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    fallback: false,
    reason: 'AAC_SUPPORTED'
  });
});

test('iPhone Safari reports explicit WebM fallback when AAC is unavailable', () => {
  const profile = resolveMeetingRecordingMediaProfile({
    navigatorImpl: iphoneSafari,
    MediaRecorderImpl: recorderWith('audio/webm;codecs=opus')
  });

  assert.deepEqual(profile, {
    device: 'iphone-safari',
    profile: WEBM_FALLBACK_PROFILE,
    preferredMimeType: '',
    recordingCodecExperiment: '',
    fallback: true,
    reason: 'AAC_UNSUPPORTED'
  });
});

test('iPhone Chrome uses a distinct verified AAC/MP4 profile', () => {
  const profile = resolveMeetingRecordingMediaProfile({
    navigatorImpl: iphoneChrome,
    MediaRecorderImpl: recorderWith('audio/mp4;codecs=mp4a.40.2')
  });

  assert.deepEqual(profile, {
    device: 'iphone-chrome',
    profile: AAC_PRIMARY_PROFILE,
    preferredMimeType: 'audio/mp4;codecs=mp4a.40.2',
    recordingCodecExperiment: 'aac-mp4',
    fallback: false,
    reason: 'AAC_SUPPORTED'
  });
});

for (const fixture of unsupportedIosBrowsers) {
  test(`unsupported iOS ${fixture.name} browser fails closed before recording`, () => {
    const profile = resolveMeetingRecordingMediaProfile({
      navigatorImpl: fixture.navigatorImpl,
      MediaRecorderImpl: recorderWith('audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus')
    });

    assert.deepEqual(profile, {
      device: 'ios-unsupported',
      profile: null,
      preferredMimeType: '',
      recordingCodecExperiment: '',
      fallback: false,
      blocked: true,
      errorCode: 'IOS_BROWSER_UNSUPPORTED',
      reason: 'IOS_BROWSER_UNSUPPORTED'
    });
  });
}

test('desktop keeps WebM/Opus as the primary recording profile', () => {
  const profile = resolveMeetingRecordingMediaProfile({
    navigatorImpl: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
      platform: 'MacIntel',
      maxTouchPoints: 0
    },
    MediaRecorderImpl: recorderWith('audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus')
  });

  assert.deepEqual(profile, {
    device: 'desktop',
    profile: WEBM_DESKTOP_PROFILE,
    preferredMimeType: '',
    recordingCodecExperiment: '',
    fallback: false,
    reason: 'DESKTOP_WEBM_PRIMARY'
  });
});

test('AAC primary rejects an actual non-AAC MIME result', () => {
  assert.deepEqual(validateMeetingRecordingMediaProfile({
    profile: AAC_PRIMARY_PROFILE,
    actualMimeType: 'audio/webm;codecs=opus'
  }), { ok: false, errorCode: 'AAC_PRIMARY_MIME_MISMATCH' });
});

test('AAC primary accepts an actual MP4/AAC MIME result', () => {
  assert.deepEqual(validateMeetingRecordingMediaProfile({
    profile: AAC_PRIMARY_PROFILE,
    actualMimeType: 'audio/mp4;codecs=mp4a.40.2'
  }), { ok: true, errorCode: null });
});
