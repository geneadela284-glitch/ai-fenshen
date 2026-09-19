import { AAC_MP4_EXPERIMENT, AAC_MP4_MIME_TYPES, isAacMp4MimeType } from './meetingRecordingCodecExperiment.js';

export const AAC_PRIMARY_PROFILE = Object.freeze({
  id: 'aac-mp4',
  container: 'MP4',
  codec: 'AAC',
  primary: true
});

export const WEBM_FALLBACK_PROFILE = Object.freeze({
  id: 'webm-opus-fallback',
  container: 'WebM',
  codec: 'Opus',
  primary: false
});

export const WEBM_DESKTOP_PROFILE = Object.freeze({
  id: 'webm-opus-desktop',
  container: 'WebM',
  codec: 'Opus',
  primary: true
});

function isCallable(value) {
  return typeof value === 'function';
}

export function classifyMeetingRecordingDevice(navigatorImpl = globalThis.navigator) {
  const userAgent = String(navigatorImpl?.userAgent || '');
  const platform = String(navigatorImpl?.platform || '');
  const touchPoints = Number(navigatorImpl?.maxTouchPoints || 0);
  const appleMobile = /iPhone|iPad|iPod/i.test(userAgent)
    || (platform === 'MacIntel' && touchPoints > 1);
  const webkit = /AppleWebKit/i.test(userAgent);
  const chrome = appleMobile && webkit && /CriOS\//i.test(userAgent);
  const safari = appleMobile
    && webkit
    && /Version\//i.test(userAgent)
    && /Safari\//i.test(userAgent)
    && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(userAgent);
  const device = chrome
    ? 'iphone-chrome'
    : safari
      ? 'iphone-safari'
      : appleMobile
        ? 'ios-unsupported'
        : 'desktop';
  return Object.freeze({
    device,
    isIOS: appleMobile,
    isSafari: safari,
    isIphoneProfile: device === 'iphone-safari' || device === 'iphone-chrome'
  });
}

export function isVerifiedIosAacRecordingDevice(value) {
  const device = typeof value === 'string' ? value : value?.device;
  return device === 'iphone-safari' || device === 'iphone-chrome';
}

export function isIphoneSafari(navigatorImpl = globalThis.navigator) {
  return classifyMeetingRecordingDevice(navigatorImpl).device === 'iphone-safari';
}

function supported(MediaRecorderImpl, mimeType) {
  if (!isCallable(MediaRecorderImpl?.isTypeSupported)) return false;
  try {
    return MediaRecorderImpl.isTypeSupported(mimeType) === true;
  } catch {
    return false;
  }
}

function supportedAacMimeType(MediaRecorderImpl) {
  return AAC_MP4_MIME_TYPES.find((mimeType) => supported(MediaRecorderImpl, mimeType)) || '';
}

export function resolveMeetingRecordingMediaProfile({
  navigatorImpl = globalThis.navigator,
  MediaRecorderImpl = globalThis.MediaRecorder
} = {}) {
  const classification = classifyMeetingRecordingDevice(navigatorImpl);
  if (classification.device === 'desktop') {
    return Object.freeze({
      device: 'desktop',
      profile: WEBM_DESKTOP_PROFILE,
      preferredMimeType: '',
      recordingCodecExperiment: '',
      fallback: false,
      reason: 'DESKTOP_WEBM_PRIMARY'
    });
  }
  if (!classification.isIphoneProfile) {
    return Object.freeze({
      device: 'ios-unsupported',
      profile: null,
      preferredMimeType: '',
      recordingCodecExperiment: '',
      fallback: false,
      blocked: true,
      errorCode: 'IOS_BROWSER_UNSUPPORTED',
      reason: 'IOS_BROWSER_UNSUPPORTED'
    });
  }
  const preferredMimeType = supportedAacMimeType(MediaRecorderImpl);
  if (preferredMimeType) {
    return Object.freeze({
      device: classification.device,
      profile: AAC_PRIMARY_PROFILE,
      preferredMimeType,
      recordingCodecExperiment: AAC_MP4_EXPERIMENT,
      fallback: false,
      reason: 'AAC_SUPPORTED'
    });
  }
  return Object.freeze({
    device: classification.device,
    profile: WEBM_FALLBACK_PROFILE,
    preferredMimeType: '',
    recordingCodecExperiment: '',
    fallback: true,
    reason: 'AAC_UNSUPPORTED'
  });
}

export function validateMeetingRecordingMediaProfile({ profile, actualMimeType } = {}) {
  if (profile === AAC_PRIMARY_PROFILE || profile?.id === AAC_PRIMARY_PROFILE.id) {
    return isAacMp4MimeType(actualMimeType)
      ? { ok: true, errorCode: null }
      : { ok: false, errorCode: 'AAC_PRIMARY_MIME_MISMATCH' };
  }
  return { ok: true, errorCode: null };
}
