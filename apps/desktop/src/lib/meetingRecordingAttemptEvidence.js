import {
  AAC_PRIMARY_PROFILE,
  classifyMeetingRecordingDevice
} from './meetingRecordingMediaProfile.js';

const VITE_ENV = import.meta.env || {};
export const MEETING_CLIENT_GENERATION = String(VITE_ENV.VITE_MEETING_GENERATION || '270');
export const MEETING_IMPLEMENTATION_COMMIT = String(VITE_ENV.VITE_MEETING_IMPLEMENTATION_COMMIT || 'development');
export const MEETING_CLIENT_BUILD_ID = String(VITE_ENV.VITE_MEETING_BUILD_ID || 'gen270-aac-primary-local');
export const MEETING_ASSET_VERSION_ID = String(VITE_ENV.VITE_MEETING_ASSET_VERSION_ID || MEETING_CLIENT_BUILD_ID);
const STORAGE_PREFIX = 'meeting-recording-attempt:';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function safeStorage(storage = globalThis.localStorage) {
  try {
    return storage && typeof storage.setItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

function randomAttemptId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return `recording-attempt-${cryptoImpl.randomUUID()}`;
  const values = cryptoImpl?.getRandomValues ? cryptoImpl.getRandomValues(new Uint8Array(12)) : new Uint8Array();
  const suffix = [...values].map((value) => value.toString(16).padStart(2, '0')).join('') || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `recording-attempt-${suffix}`;
}

function loadedAssetVersion(documentImpl = globalThis.document) {
  const assets = [];
  for (const node of documentImpl?.querySelectorAll?.('script[src],link[rel="stylesheet"][href]') || []) {
    const value = node.src || node.href || node.getAttribute?.('src') || node.getAttribute?.('href') || '';
    if (value) assets.push(String(value));
  }
  return Object.freeze([...new Set(assets)].sort());
}

export function getMeetingClientBuildIdentity({
  navigatorImpl = globalThis.navigator,
  documentImpl = globalThis.document,
  locationImpl = globalThis.location,
  generation = MEETING_CLIENT_GENERATION,
  implementationCommit = MEETING_IMPLEMENTATION_COMMIT,
  clientBuildId = MEETING_CLIENT_BUILD_ID,
  assetVersionId = MEETING_ASSET_VERSION_ID
} = {}) {
  const userAgent = String(navigatorImpl?.userAgent || '');
  const assets = loadedAssetVersion(documentImpl);
  const device = classifyMeetingRecordingDevice(navigatorImpl);
  return Object.freeze({
    generation: String(generation),
    implementationCommit: String(implementationCommit),
    clientBuildId: String(clientBuildId),
    assetVersionId: String(assetVersionId),
    loadedAssetVersion: assets,
    userAgent,
    pageUrl: locationImpl ? `${locationImpl.origin || ''}${locationImpl.pathname || ''}` : '',
    deviceClassification: device.device,
    isIOS: device.isIOS,
    isSafari: device.isSafari,
    isIphoneProfile: device.isIphoneProfile
  });
}

function profileId(runtime) {
  const id = runtime?.mediaProfile?.profile?.id || runtime?.mediaProfile?.id || '';
  return id === AAC_PRIMARY_PROFILE.id ? 'AAC_MP4_PRIMARY' : id || 'WEBM_FALLBACK';
}

function capabilityValue(runtime, mimeType) {
  return Boolean(runtime?.capabilities?.find((item) => item.requestedMimeType === mimeType)?.supported);
}

function persist(storage, attemptId, value) {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(`${STORAGE_PREFIX}${attemptId}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function createMeetingRecordingAttemptEvidenceClient({
  fetchImpl = globalThis.fetch,
  storage = safeStorage(),
  identity = getMeetingClientBuildIdentity(),
  endpoint = '/api/meeting/recording-attempt',
  bindEndpoint = '/api/meeting/recording-attempt/bind',
  cryptoImpl = globalThis.crypto
} = {}) {
  async function submit(runtime = {}) {
    const recordingAttemptId = String(runtime.recordingAttemptId || randomAttemptId(cryptoImpl));
    const payload = Object.freeze({
      recordingAttemptId,
      ...identity,
      selectedProfile: profileId(runtime),
      selectionReason: runtime.mediaProfile?.reason || '',
      supportedAacCodecMime: capabilityValue(runtime, 'audio/mp4;codecs=mp4a.40.2'),
      supportedAacPlainMime: capabilityValue(runtime, 'audio/mp4'),
      capabilities: Array.isArray(runtime.capabilities)
        ? runtime.capabilities.map((item) => Object.freeze({
          requestedMimeType: String(item?.requestedMimeType || ''),
          supported: item?.supported === true
        }))
        : [],
      requestedMimeType: runtime.requestedMimeType || '',
      constructorOptions: runtime.constructorOptions || {},
      actualMimeType: runtime.actualMimeType || '',
      fallbackReason: runtime.fallbackReason || '',
      mismatchCode: runtime.mismatchCode || '',
      constructorErrorCode: runtime.constructorErrorCode || '',
      isIphoneProfile: identity.isIphoneProfile
    });
    if (!persist(storage, recordingAttemptId, { status: 'pending', payload, savedAt: new Date().toISOString() })) {
      throw codedError('AAC_PRE_RECORD_EVIDENCE_LOCAL_STORAGE_UNAVAILABLE');
    }
    if (typeof fetchImpl !== 'function') throw codedError('AAC_PRE_RECORD_EVIDENCE_UPLOAD_UNAVAILABLE');
    let response;
    let result = null;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      result = await response.json().catch(() => null);
    } catch (error) {
      persist(storage, recordingAttemptId, { status: 'upload-failed', payload, errorCode: 'AAC_PRE_RECORD_EVIDENCE_UPLOAD_FAILED', savedAt: new Date().toISOString() });
      throw codedError('AAC_PRE_RECORD_EVIDENCE_UPLOAD_FAILED', error);
    }
    if (!response?.ok || result?.ok !== true) {
      const code = result?.errorCode || result?.code || 'AAC_PRIMARY_NOT_ACTIVE';
      persist(storage, recordingAttemptId, { status: 'server-rejected', payload, result, errorCode: code, savedAt: new Date().toISOString() });
      const error = codedError(code);
      error.recordingAttemptId = recordingAttemptId;
      error.serverResult = result;
      throw error;
    }
    persist(storage, recordingAttemptId, { status: 'acknowledged', payload, result, savedAt: new Date().toISOString() });
    return Object.freeze({
      ...result,
      recordingAttemptId: result.recordingAttempt?.recordingAttemptId || recordingAttemptId
    });
  }

  async function bind({ recordingAttemptId, meetingId, sourceId } = {}) {
    if (!recordingAttemptId || typeof fetchImpl !== 'function') return false;
    const response = await fetchImpl(bindEndpoint, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingAttemptId, meetingId, sourceId })
    });
    return response.ok;
  }

  return Object.freeze({ submit, bind });
}

export { loadedAssetVersion, randomAttemptId };
