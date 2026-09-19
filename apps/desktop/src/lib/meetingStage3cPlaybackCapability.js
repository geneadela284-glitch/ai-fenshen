export const AAC_PLAYBACK_MIME = 'audio/mp4;codecs=mp4a.40.2';
export const WEBM_PLAYBACK_MIME = 'audio/webm;codecs=opus';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function isCallable(value) {
  return typeof value === 'function';
}

function supports(Ctor, mimeType) {
  if (!isCallable(Ctor) || typeof Ctor.isTypeSupported !== 'function') return false;
  try {
    return Ctor.isTypeSupported(mimeType) === true;
  } catch {
    return false;
  }
}

export function detectStage3cPlaybackCapability({ globalObject = globalThis, mimeType } = {}) {
  const exactMime = String(mimeType || '').trim();
  if (![AAC_PLAYBACK_MIME, WEBM_PLAYBACK_MIME].includes(exactMime)) {
    return { supported: false, errorCode: 'PLAYBACK_MIME_UNSUPPORTED', mimeType: exactMime };
  }
  if (globalObject?.isSecureContext !== true) {
    return { supported: false, errorCode: 'PLAYBACK_UNSUPPORTED', reason: 'SECURE_CONTEXT_REQUIRED', mimeType: exactMime };
  }
  const ManagedMediaSource = globalObject?.ManagedMediaSource;
  if (isCallable(ManagedMediaSource) && supports(ManagedMediaSource, exactMime)) {
    return { supported: true, engine: 'managed-media-source', mimeType: exactMime };
  }
  const MediaSource = globalObject?.MediaSource;
  if (isCallable(MediaSource) && supports(MediaSource, exactMime)) {
    return { supported: true, engine: 'media-source', mimeType: exactMime };
  }
  return { supported: false, errorCode: 'PLAYBACK_UNSUPPORTED', reason: 'MEDIA_SOURCE_UNAVAILABLE', mimeType: exactMime };
}

export function assertStage3cPlaybackCapability(capability) {
  if (!capability?.supported) throw codedError(capability?.errorCode || 'PLAYBACK_UNSUPPORTED');
  return capability;
}

export function playbackMimeForSource(source) {
  const mime = String(source?.mimeType || '').trim().toLowerCase();
  if (mime.startsWith('audio/mp4') || mime.startsWith('audio/aac') || ['m4a', 'aac'].includes(source?.format)) return AAC_PLAYBACK_MIME;
  if (mime.startsWith('audio/webm') || source?.format === 'webm-opus' || source?.format === 'recorded') return WEBM_PLAYBACK_MIME;
  throw codedError('PLAYBACK_MIME_UNSUPPORTED');
}
