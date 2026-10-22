import { randomUUID } from 'node:crypto';
import {
  DICTATION_LIMITS,
  isClientOwnerHeaderPresent,
  publicVoiceMessage,
  requestIdEcho,
  validateDictationRequest,
  voiceError
} from './audioContract.js';
import { getDictationDiagnosticLogger } from './runtime.js';

function header(req, name) {
  const headers = req?.headers || {};
  const normalized = name.toLowerCase();
  if (Object.hasOwn(headers, normalized)) return headers[normalized];
  const found = Object.keys(headers).find((key) => key.toLowerCase() === normalized);
  return found ? headers[found] : undefined;
}

export async function readAudioBody(req, maxBytes = DICTATION_LIMITS.maxBytes) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw voiceError('AUDIO_TOO_LARGE');
      chunks.push(buffer);
    }
  } catch (error) {
    if (error && typeof error === 'object') error.bytes = total;
    if (error?.code) throw error;
    const invalid = voiceError('AUDIO_INVALID');
    invalid.bytes = total;
    throw invalid;
  }
  return Buffer.concat(chunks, total);
}

function statusForError(code) {
  if (code === 'ACCOUNT_CONTEXT_MISMATCH' || code === 'ACCOUNT_ACCESS_DISABLED') return 403;
  if (code === 'ACCESS_CONTROL_UNAVAILABLE') return 503;
  if (code?.startsWith('ACCOUNT_')) return 429;
  if (code === 'AUDIO_NO_SPEECH') return 422;
  if (code === 'ASR_BUSY') return 429;
  if (code === 'TIMEOUT') return 504;
  if (code === 'ASR_ENGINE_UNAVAILABLE' || code === 'ASR_MODEL_MISSING') return 503;
  if (code === 'TRANSCRIPTION_FAILED' || code === 'CLEANUP_FAILED') return 502;
  if (code === 'CANCELLED') return 499;
  if (code === 'AUDIO_TOO_LARGE') return 413;
  if (code === 'AUDIO_TOO_LONG') return 413;
  return 400;
}

function errorBody({ error, requestId = null, durationMs = null, cleanupStatus = 'not_started' } = {}) {
  const code = String(error?.code || 'VOICE_REQUEST_INVALID');
  return {
    ok: false,
    requestId,
    transcript: '',
    durationMs,
    latencyMs: Number.isFinite(error?.latencyMs) ? error.latencyMs : 0,
    providerId: null,
    cleanupStatus: error?.cleanupStatus || cleanupStatus,
    autoSend: false,
    errorCode: code,
    message: publicVoiceMessage(code)
  };
}

function requestHeaders(req) {
  const contentType = String(header(req, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
  return {
    requestId: header(req, 'x-voice-request-id'),
    audioHash: header(req, 'x-voice-audio-hash'),
    contentType,
    format: header(req, 'x-voice-format') || contentType,
    sampleRate: header(req, 'x-voice-sample-rate'),
    durationMs: header(req, 'x-voice-duration-ms')
  };
}

function newDiagnosticRequestId(value) {
  return requestIdEcho(value) || `dictation-${randomUUID()}`;
}

function diagnosticAudioFields({ metadata, audioBytes = null, request = null } = {}) {
  const hash = String(request?.audioHash || metadata?.audioHash || '').trim();
  const bytes = audioBytes?.length ?? (
    Number.isSafeInteger(Number(metadata?.contentLength)) ? Number(metadata.contentLength) : null
  );
  return {
    contentType: metadata?.contentType || request?.contentType || request?.format || null,
    bytes,
    durationMs: Number.isFinite(Number(request?.durationMs || metadata?.durationMs))
      ? Number(request?.durationMs || metadata.durationMs)
      : null,
    sampleRate: Number.isFinite(Number(request?.sampleRate || metadata?.sampleRate))
      ? Number(request?.sampleRate || metadata.sampleRate)
      : null,
    audioHashPrefix: hash ? hash.slice(0, 8) : null
  };
}

async function recordHttpPhase(logger, phase, requestId, fields = {}) {
  try {
    await Promise.resolve(logger?.log?.({ phase, requestId, ...fields }));
  } catch {
    // Diagnostics must never change the request outcome.
  }
}

export async function handleVoiceDictationApi({
  req,
  res,
  url,
  session,
  runtime,
  sendJson,
  logger = getDictationDiagnosticLogger()
}) {
  if (url.pathname !== '/api/voice/dictation') return false;
  const metadata = requestHeaders(req);
  const requestId = newDiagnosticRequestId(metadata.requestId);
  await recordHttpPhase(logger, 'request_received', requestId, {
    httpStatus: null,
    ...diagnosticAudioFields({ metadata })
  });

  const sendLogged = async (status, body, headers = {}) => {
    sendJson(res, status, body, headers);
    await recordHttpPhase(logger, 'response_sent', requestId, {
      httpStatus: status,
      errorCode: body?.errorCode || body?.code || null,
      cleanupStatus: body?.cleanupStatus || 'not_started'
    });
  };

  if (req.method !== 'POST') {
    await sendLogged(405, { ok: false, errorCode: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' }, { Allow: 'POST' });
    return true;
  }
  if (!session?.user) {
    await recordHttpPhase(logger, 'session_failed', requestId, { httpStatus: 401, errorCode: 'AUTH_REQUIRED' });
    await sendLogged(401, errorBody({ error: voiceError('AUTH_REQUIRED'), requestId }));
    return true;
  }
  await recordHttpPhase(logger, 'session_validated', requestId, { httpStatus: 200 });
  if (isClientOwnerHeaderPresent(req.headers || {})) {
    await recordHttpPhase(logger, 'owner_failed', requestId, {
      httpStatus: 400,
      errorCode: 'CLIENT_OWNER_FORBIDDEN'
    });
    await sendLogged(400, errorBody({ error: voiceError('CLIENT_OWNER_FORBIDDEN'), requestId }));
    return true;
  }
  if (!String(session.user.id || '').trim()) {
    await recordHttpPhase(logger, 'owner_failed', requestId, { httpStatus: 400, errorCode: 'VOICE_REQUEST_INVALID' });
    await sendLogged(400, errorBody({ error: voiceError('VOICE_REQUEST_INVALID'), requestId }));
    return true;
  }
  await recordHttpPhase(logger, 'owner_resolved', requestId, { httpStatus: 200 });

  const contentLength = Number(header(req, 'content-length'));
  await recordHttpPhase(logger, 'audio_metadata_received', requestId, {
    ...diagnosticAudioFields({ metadata }),
    bytes: Number.isFinite(contentLength) ? contentLength : null,
  });
  if (Number.isFinite(contentLength) && contentLength > DICTATION_LIMITS.maxBytes) {
    await recordHttpPhase(logger, 'audio_invalid', requestId, {
      ...diagnosticAudioFields({ metadata }),
      httpStatus: 413,
      errorCode: 'AUDIO_TOO_LARGE'
    });
    await sendLogged(413, errorBody({ error: voiceError('AUDIO_TOO_LARGE'), requestId }));
    return true;
  }

  let audioBytes;
  try {
    audioBytes = await readAudioBody(req);
  } catch (error) {
    const status = statusForError(error?.code);
    await recordHttpPhase(logger, 'audio_invalid', requestId, {
      ...diagnosticAudioFields({ metadata, audioBytes: { length: error?.bytes || 0 } }),
      httpStatus: status,
      errorCode: error?.code || 'AUDIO_INVALID'
    });
    await sendLogged(status, errorBody({ error, requestId }));
    return true;
  }

  let request;
  try {
    request = Object.freeze({ ...validateDictationRequest({
      ownerId: session.user.id,
      audioBytes,
      ...metadata
    }), contentType: metadata.contentType });
    await recordHttpPhase(logger, 'audio_validated', request.requestId, {
      ...diagnosticAudioFields({ metadata, audioBytes, request }),
      httpStatus: 200
    });
  } catch (error) {
    const status = statusForError(error?.code);
    await recordHttpPhase(logger, 'audio_invalid', requestId, {
      ...diagnosticAudioFields({ metadata, audioBytes }),
      httpStatus: status,
      errorCode: error?.code || 'VOICE_REQUEST_INVALID'
    });
    await sendLogged(status, errorBody({ error, requestId }));
    return true;
  }

  let disconnected = false;
  let responseFinished = false;
  const onClose = () => {
    if (responseFinished || disconnected) return;
    disconnected = true;
    runtime.cancel({
      ownerId: request.ownerId,
      requestId: request.requestId,
      audioHash: request.audioHash
    });
  };
  res.once?.('close', onClose);
  try {
    const result = await runtime.transcribe(request, {subject: session.subject});
    if (!disconnected) {
      responseFinished = true;
      await sendLogged(200, { ok: true, ...result });
    }
  } catch (error) {
    if (!disconnected) {
      responseFinished = true;
      await sendLogged(statusForError(error?.code), errorBody({
        error,
        requestId: request.requestId,
        durationMs: request.durationMs,
        cleanupStatus: 'pending'
      }));
    }
  } finally {
    res.off?.('close', onClose);
  }
  return true;
}
