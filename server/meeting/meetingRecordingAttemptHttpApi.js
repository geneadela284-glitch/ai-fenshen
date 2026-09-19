import { randomUUID } from 'node:crypto';
import {
  classifyUserAgent,
  evaluateRecordingAttemptGate
} from './meetingRecordingAttemptStore.js';

export const MEETING_RECORDING_ATTEMPT_PATH = '/api/meeting/recording-attempt';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function header(req, name) {
  const headers = req?.headers || {};
  const normalized = name.toLowerCase();
  if (Object.hasOwn(headers, normalized)) return headers[normalized];
  const found = Object.keys(headers).find((key) => key.toLowerCase() === normalized);
  return found ? headers[found] : undefined;
}

async function readJson(req, maxBytes = 48 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw codedError('RECORDING_ATTEMPT_PAYLOAD_TOO_LARGE');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw codedError('RECORDING_ATTEMPT_JSON_INVALID'); }
}

function responseStatus(error) {
  if (error?.code === 'AUTH_REQUIRED') return 401;
  if (error?.code === 'RECORDING_ATTEMPT_STORE_CLOSED') return 503;
  if (error?.code === 'RECORDING_ATTEMPT_OWNER_MISMATCH') return 403;
  if (error?.code === 'RECORDING_ATTEMPT_BIND_CONFLICT') return 409;
  if (error?.code === 'RECORDING_ATTEMPT_NOT_FOUND') return 404;
  if (error?.code === 'RECORDING_ATTEMPT_PAYLOAD_TOO_LARGE') return 413;
  return 400;
}

function publicPayload(attempt) {
  return {
    recordingAttemptId: attempt.recordingAttemptId,
    authenticatedUserId: attempt.authenticatedUserId,
    ownerId: attempt.ownerId,
    scope: attempt.scope,
    generation: attempt.generation,
    implementationCommit: attempt.implementationCommit,
    clientBuildId: attempt.clientBuildId,
    assetVersionId: attempt.assetVersionId,
    uaHash: attempt.uaHash,
    normalizedDeviceClassification: attempt.normalizedDeviceClassification,
    isIOS: attempt.isIOS,
    isSafari: attempt.isSafari,
    isIphoneProfile: attempt.isIphoneProfile,
    supportedAacCodecMime: attempt.supportedAacCodecMime,
    supportedAacPlainMime: attempt.supportedAacPlainMime,
    selectedProfile: attempt.selectedProfile,
    selectionReason: attempt.selectionReason,
    capabilities: attempt.capabilities,
    requestedMimeType: attempt.requestedMimeType,
    constructorOptions: attempt.constructorOptions,
    actualMimeType: attempt.actualMimeType,
    fallbackReason: attempt.fallbackReason,
    mismatchCode: attempt.mismatchCode,
    constructorErrorCode: attempt.constructorErrorCode,
    gateResult: attempt.gateResult,
    errorCode: attempt.errorCode,
    meetingId: attempt.meetingId,
    sourceId: attempt.sourceId,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt
  };
}

export async function handleMeetingRecordingAttemptApi({
  req,
  res,
  url,
  session,
  store,
  sendJson,
  expectedGeneration = '',
  expectedImplementationCommit = '',
  expectedClientBuildId = '',
  expectedAssetVersionId = '',
  recordingScope = 'meeting-space'
} = {}) {
  if (![MEETING_RECORDING_ATTEMPT_PATH, `${MEETING_RECORDING_ATTEMPT_PATH}/bind`].includes(url.pathname)) return false;
  if (!session?.user?.id) {
    sendJson(res, 401, { ok: false, code: 'AUTH_REQUIRED', message: '请先登录。' });
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' }, { Allow: 'POST' });
    return true;
  }
  try {
    const body = await readJson(req);
    if (url.pathname.endsWith('/bind')) {
      const attempt = store.bind({
        authenticatedUserId: String(session.user.id),
        recordingAttemptId: body.recordingAttemptId,
        meetingId: body.meetingId,
        sourceId: body.sourceId
      });
      sendJson(res, 200, {
        ok: true,
        idempotent: attempt.idempotent === true,
        recordingAttempt: publicPayload(attempt)
      });
      return true;
    }
    const payload = {
      ...body,
      recordingAttemptId: String(body.recordingAttemptId || `recording-attempt-${randomUUID()}`),
      // Client owner/scope claims are deliberately retained only as non-authoritative input.
      ownerId: undefined,
      scope: undefined
    };
    const provisional = {
      ...payload,
      isIphoneProfile: false,
      actualMimeType: payload.actualMimeType || '',
      selectedProfile: payload.selectedProfile || '',
      supportedAacCodecMime: payload.supportedAacCodecMime === true,
      supportedAacPlainMime: payload.supportedAacPlainMime === true
    };
    const ua = String(header(req, 'user-agent') || '');
    provisional.isIphoneProfile = classifyUserAgent(ua).isIphoneProfile;
    const gate = evaluateRecordingAttemptGate({
      attempt: provisional,
      expectedGeneration,
      expectedImplementationCommit,
      expectedClientBuildId,
      expectedAssetVersionId
    });
    const saved = store.save({
      authenticatedUserId: String(session.user.id),
      scope: recordingScope,
      userAgent: ua,
      payload,
      gate
    });
    const persistedGate = saved.idempotent
      ? {
        ok: saved.attempt.gateResult === 'AAC_PRIMARY_ACTIVE' && !saved.attempt.errorCode,
        serverGate: saved.attempt.gateResult,
        errorCode: saved.attempt.errorCode || null
      }
      : gate;
    const bodyResponse = {
      ok: persistedGate.ok,
      serverGate: persistedGate.serverGate,
      errorCode: persistedGate.errorCode,
      idempotent: saved.idempotent,
      recordingAttempt: publicPayload(saved.attempt)
    };
    sendJson(res, persistedGate.ok ? 200 : 409, bodyResponse);
  } catch (error) {
    sendJson(res, responseStatus(error), { ok: false, code: error?.code || 'RECORDING_ATTEMPT_INVALID' });
  }
  return true;
}
