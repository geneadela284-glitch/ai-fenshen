import { randomUUID } from 'node:crypto';
import { createMeetingTranscriptionSourceAssembler } from './meetingTranscriptionSourceAssembler.js';

const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const MEETING_TRANSCRIPTION_CHUNK_PATH = '/api/meeting/transcription/chunk';
export const MEETING_TRANSCRIPTION_SOURCE_PATH = '/api/meeting/transcription/source';
export const MEETING_TRANSCRIPTION_DIAGNOSTIC_PATH = '/api/meeting/transcription/diagnostic';
export const MEETING_TRANSCRIPTION_STATUS_PATH = '/api/meeting/transcription/status';
const defaultSourceAssembler = createMeetingTranscriptionSourceAssembler();

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

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function traceId(value) {
  const normalized = String(value ?? '').trim();
  return normalized || `meeting-trace-${randomUUID()}`;
}

function safeInteger(value, code, { minimum = 0, allowZero = true } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || (!allowZero && normalized === 0)) throw codedError(code);
  return normalized;
}

function safeFileName(value) {
  const normalized = required(value, 'TRANSCRIPTION_FILE_NAME_REQUIRED');
  if (normalized.includes('/') || normalized.includes('\\') || normalized === '.' || normalized === '..') throw codedError('TRANSCRIPTION_FILE_NAME_INVALID');
  return normalized.slice(0, 240);
}

function transcriptionModeMetadata(req) {
  const mode = String(header(req, 'x-meeting-transcription-mode') || 'transcription').trim() || 'transcription';
  if (!['transcription', 'diarization'].includes(mode)) throw codedError('MEETING_TRANSCRIPTION_MODE_INVALID');
  if (mode === 'transcription') return Object.freeze({ mode, speakerCount: 0 });
  const speakerCount = safeInteger(header(req, 'x-meeting-speaker-count') || 0, 'DIARIZATION_SPEAKER_COUNT_INVALID');
  if (!(speakerCount === 0 || [2, 3, 4].includes(speakerCount))) throw codedError('DIARIZATION_SPEAKER_COUNT_INVALID');
  return Object.freeze({ mode, speakerCount });
}

export function decodeMeetingFileNameHeader(value) {
  const normalized = required(value, 'TRANSCRIPTION_FILE_NAME_REQUIRED');
  if (!/^[\x00-\x7f]*$/.test(normalized)) throw codedError('TRANSCRIPTION_FILE_NAME_INVALID');
  let decoded;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    throw codedError('TRANSCRIPTION_FILE_NAME_INVALID');
  }
  if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) throw codedError('TRANSCRIPTION_FILE_NAME_INVALID');
  return decoded;
}

export async function readMeetingTranscriptionBody(req, maxBytes = DEFAULT_MAX_CHUNK_BYTES) {
  const limit = Number.isSafeInteger(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_CHUNK_BYTES;
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limit) throw codedError('TRANSCRIPTION_CHUNK_TOO_LARGE');
      chunks.push(buffer);
    }
  } catch (error) {
    if (error?.code) throw error;
    throw codedError('TRANSCRIPTION_AUDIO_READ_FAILED');
  }
  if (!total) throw codedError('TRANSCRIPTION_AUDIO_EMPTY');
  return Buffer.concat(chunks, total);
}

function requestMetadata(req, audioBytes) {
  const mode = transcriptionModeMetadata(req);
  const durationMs = safeInteger(header(req, 'x-chunk-duration-ms'), 'TRANSCRIPTION_CHUNK_DURATION_INVALID', { minimum: 1, allowZero: false });
  const startMs = safeInteger(header(req, 'x-chunk-start-ms'), 'TRANSCRIPTION_CHUNK_START_INVALID');
  const endMs = safeInteger(header(req, 'x-chunk-end-ms'), 'TRANSCRIPTION_CHUNK_END_INVALID', { minimum: 1, allowZero: false });
  if (endMs <= startMs || durationMs !== endMs - startMs) throw codedError('TRANSCRIPTION_CHUNK_TIMELINE_INVALID');
  return Object.freeze({
    meetingId: required(header(req, 'x-meeting-id'), 'MEETING_ID_REQUIRED'),
    sourceId: required(header(req, 'x-source-id'), 'SOURCE_ID_REQUIRED'),
    sourceRevision: safeInteger(header(req, 'x-source-revision'), 'TRANSCRIPTION_SOURCE_REVISION_INVALID', { minimum: 1, allowZero: false }),
    requestId: required(header(req, 'x-request-id'), 'TRANSCRIPTION_REQUEST_ID_REQUIRED'),
    traceId: traceId(header(req, 'x-meeting-trace-id') || header(req, 'x-request-id')),
    attempt: safeInteger(header(req, 'x-transcription-attempt') || 1, 'TRANSCRIPTION_ATTEMPT_INVALID', { minimum: 1, allowZero: false }),
    ...mode,
    chunk: Object.freeze({
      sequence: safeInteger(header(req, 'x-chunk-sequence'), 'TRANSCRIPTION_CHUNK_SEQUENCE_INVALID'),
      startMs,
      endMs,
      durationMs,
      bytes: audioBytes,
      fileName: safeFileName(decodeMeetingFileNameHeader(header(req, 'x-chunk-file-name'))),
      mimeType: required(header(req, 'x-chunk-mime-type') || header(req, 'content-type'), 'TRANSCRIPTION_MIME_TYPE_REQUIRED'),
      format: required(header(req, 'x-chunk-format'), 'TRANSCRIPTION_FORMAT_REQUIRED')
    })
  });
}

function sourceRequestMetadata(req) {
  const mode = transcriptionModeMetadata(req);
  const chunkCount = safeInteger(header(req, 'x-source-chunk-count'), 'TRANSCRIPTION_SOURCE_CHUNK_COUNT_INVALID', { minimum: 1, allowZero: false });
  const sequence = safeInteger(header(req, 'x-source-chunk-sequence'), 'TRANSCRIPTION_SOURCE_CHUNK_SEQUENCE_INVALID');
  if (sequence >= chunkCount) throw codedError('TRANSCRIPTION_SOURCE_CHUNK_SEQUENCE_INVALID');
  const chunkDurationMs = safeInteger(header(req, 'x-source-chunk-duration-ms'), 'TRANSCRIPTION_SOURCE_CHUNK_DURATION_INVALID', { minimum: 1, allowZero: false });
  const chunkByteLength = safeInteger(header(req, 'x-source-chunk-byte-length'), 'TRANSCRIPTION_SOURCE_CHUNK_BYTE_LENGTH_INVALID', { minimum: 1, allowZero: false });
  const containerLayout = String(header(req, 'x-source-container-layout') || '').trim();
  if (containerLayout && !['continuous-fragment-stream-v1', 'independent-mp4-segments-v1'].includes(containerLayout)) {
    throw codedError('TRANSCRIPTION_SOURCE_CONTAINER_LAYOUT_UNSUPPORTED');
  }
  return Object.freeze({
    meetingId: required(header(req, 'x-meeting-id'), 'MEETING_ID_REQUIRED'),
    sourceId: required(header(req, 'x-source-id'), 'SOURCE_ID_REQUIRED'),
    sourceRevision: safeInteger(header(req, 'x-source-revision'), 'TRANSCRIPTION_SOURCE_REVISION_INVALID', { minimum: 1, allowZero: false }),
    assemblyId: required(header(req, 'x-source-assembly-id') || header(req, 'x-request-id'), 'TRANSCRIPTION_SOURCE_ASSEMBLY_ID_REQUIRED'),
    traceId: traceId(header(req, 'x-meeting-trace-id') || header(req, 'x-source-assembly-id') || header(req, 'x-request-id')),
    attempt: safeInteger(header(req, 'x-transcription-attempt') || 1, 'TRANSCRIPTION_ATTEMPT_INVALID', { minimum: 1, allowZero: false }),
    ...mode,
    source: Object.freeze({
      fileName: safeFileName(decodeMeetingFileNameHeader(header(req, 'x-source-file-name'))),
      mimeType: required(header(req, 'x-source-mime-type') || header(req, 'content-type'), 'TRANSCRIPTION_SOURCE_MIME_TYPE_REQUIRED'),
      format: required(header(req, 'x-source-format'), 'TRANSCRIPTION_SOURCE_FORMAT_REQUIRED'),
      ...(containerLayout ? { containerLayout } : {}),
      byteLength: safeInteger(header(req, 'x-source-byte-length'), 'TRANSCRIPTION_SOURCE_BYTE_LENGTH_INVALID', { minimum: 1, allowZero: false }),
      durationMs: safeInteger(header(req, 'x-source-duration-ms'), 'TRANSCRIPTION_SOURCE_DURATION_INVALID', { minimum: 1, allowZero: false }),
      chunkCount,
      checksum: required(header(req, 'x-source-checksum'), 'TRANSCRIPTION_SOURCE_CHECKSUM_REQUIRED')
    }),
    chunk: Object.freeze({
      sourceChunkId: required(header(req, 'x-source-chunk-id'), 'TRANSCRIPTION_SOURCE_CHUNK_ID_REQUIRED'),
      sequence,
      durationMs: chunkDurationMs,
      byteLength: chunkByteLength,
      checksum: required(header(req, 'x-source-chunk-checksum'), 'TRANSCRIPTION_SOURCE_CHUNK_CHECKSUM_REQUIRED'),
      final: String(header(req, 'x-source-chunk-final') || '').trim() === '1'
    })
  });
}

function publicError(error) {
  const code = String(error?.code || 'MEETING_TRANSCRIPTION_FAILED');
  return {
    ok: false,
    code,
    providerErrorCode: error?.providerErrorCode || null,
    message: code === 'STAGE3B_REAL_DIARIZATION_PROVIDER_BLOCKED'
      ? '当前录音转写 Provider 未提供可靠的说话人区分能力。'
      : code === 'REAL_MEETING_ASR_PROVIDER_BLOCKED'
      ? '云端长音频转写 Provider 尚未就绪。'
      : code === 'TRANSCRIPTION_CANCELLED'
        ? '转写已取消。'
        : '云端语音转写未完成。'
  };
}

function statusForError(error) {
  if (error?.code === 'AUTH_REQUIRED') return 401;
  if (error?.code === 'CLIENT_OWNER_FORBIDDEN') return 400;
  if (error?.code === 'DIAGNOSTIC_OWNER_MISMATCH'
    || error?.code === 'DIAGNOSTIC_SCOPE_OWNER_MISMATCH'
    || error?.code === 'DIAGNOSTIC_SCOPE_MISMATCH'
    || error?.code === 'DIAGNOSTIC_SCOPE_UNVERIFIED') return 403;
  if (error?.code === 'REAL_MEETING_ASR_PROVIDER_BLOCKED') return 503;
  if (error?.code === 'STAGE3B_REAL_DIARIZATION_PROVIDER_BLOCKED') return 503;
  if (error?.code === 'TRANSCRIPTION_CANCELLED') return 499;
  if (error?.code === 'XFYUN_PROVIDER_ERROR' || error?.code === 'XFYUN_SIGNATURE_GENERATION_FAILED') return 502;
  if (error?.code === 'TRANSCRIPTION_CHUNK_TOO_LARGE') return 413;
  return 400;
}

async function diagnosticLog(logger, event) {
  try {
    return await logger?.log?.(event);
  } catch {
    // Candidate diagnostics are best effort and must never change ASR behavior.
    return false;
  }
}

async function diagnosticCheckpointLog(logger, event) {
  try {
    if (typeof logger?.logRecordingCheckpoint === 'function') {
      return await logger.logRecordingCheckpoint(event);
    }
    const accepted = await logger?.log?.(event);
    return Object.freeze({ accepted: accepted !== false, duplicate: false });
  } catch {
    return Object.freeze({ accepted: false, duplicate: false });
  }
}

async function readDiagnosticBody(req) {
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (raw.length > 32 * 1024) throw codedError('MEETING_TRANSCRIPTION_DIAGNOSTIC_TOO_LARGE');
    }
    if (!raw) return Object.freeze({});
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : Object.freeze({});
  } catch (error) {
    if (error?.code) throw error;
    throw codedError('MEETING_TRANSCRIPTION_DIAGNOSTIC_INVALID');
  }
}

async function resolveTrustedDiagnosticScope({ resolveDiagnosticScope, recordingAttemptResolver, ownerId, payload, req }) {
  const claimedOwnerId = String(payload?.ownerId ?? '').trim();
  const claimedRecordingAttemptId = String(payload?.recordingAttemptId ?? '').trim();
  if (claimedOwnerId && claimedOwnerId !== ownerId) throw codedError('DIAGNOSTIC_OWNER_MISMATCH');
  const claims = Object.freeze({
    meetingId: String(payload?.meetingId ?? '').trim(),
    sourceId: String(payload?.sourceId ?? '').trim(),
    jobId: String(payload?.jobId ?? '').trim()
  });
  const hasScopeClaim = Object.values(claims).some(Boolean) || Boolean(claimedRecordingAttemptId);
  if (!hasScopeClaim) return Object.freeze({ ownerId, recordingAttemptCreatedAt: '' });
  if (typeof resolveDiagnosticScope !== 'function') throw codedError('DIAGNOSTIC_SCOPE_UNVERIFIED');
  const resolved = await resolveDiagnosticScope({ ownerId, recordingAttemptId: claimedRecordingAttemptId, ...claims, req });
  if (!resolved || String(resolved.ownerId ?? '').trim() !== ownerId) throw codedError('DIAGNOSTIC_SCOPE_OWNER_MISMATCH');
  for (const key of Object.keys(claims)) {
    if (claims[key] && String(resolved[key] ?? '').trim() !== claims[key]) throw codedError('DIAGNOSTIC_SCOPE_MISMATCH');
  }
  const recordingAttempt = await resolveRecordingAttempt({
    resolver: recordingAttemptResolver,
    ownerId,
    recordingAttemptId: claimedRecordingAttemptId,
    meetingId: resolved.meetingId || claims.meetingId,
    sourceId: resolved.sourceId || claims.sourceId,
    req
  });
  if (claimedRecordingAttemptId
    && (!recordingAttempt || String(recordingAttempt.recordingAttemptId || '').trim() !== claimedRecordingAttemptId)) {
    throw codedError('DIAGNOSTIC_SCOPE_MISMATCH');
  }
  if (recordingAttempt) {
    if (String(recordingAttempt.ownerId || '').trim() !== ownerId) throw codedError('DIAGNOSTIC_SCOPE_OWNER_MISMATCH');
    if (String(recordingAttempt.meetingId || '').trim() !== String(resolved.meetingId || claims.meetingId).trim()
      || String(recordingAttempt.sourceId || '').trim() !== String(resolved.sourceId || claims.sourceId).trim()) {
      throw codedError('DIAGNOSTIC_SCOPE_MISMATCH');
    }
    if (String(resolved.scope || '').trim()
      && String(recordingAttempt.scope || '').trim()
      && String(resolved.scope).trim() !== String(recordingAttempt.scope).trim()) {
      throw codedError('DIAGNOSTIC_SCOPE_MISMATCH');
    }
  }
  return Object.freeze({
    ownerId,
    // Always replace any client-supplied creation timestamp, including when
    // the trusted attempt has no creation time and collection must decline.
    recordingAttemptCreatedAt: String(recordingAttempt?.createdAt || ''),
    ...(resolved.scope ? { scope: String(resolved.scope) } : {}),
    ...(recordingAttempt?.scope && !resolved.scope ? { scope: String(recordingAttempt.scope) } : {}),
    ...(resolved.meetingId ? { meetingId: String(resolved.meetingId) } : {}),
    ...(resolved.sourceId ? { sourceId: String(resolved.sourceId) } : {}),
    ...(resolved.jobId ? { jobId: String(resolved.jobId) } : {}),
    ...(recordingAttempt?.recordingAttemptId ? { recordingAttemptId: String(recordingAttempt.recordingAttemptId) } : {})
  });
}

async function resolveRecordingAttempt({ resolver, ownerId, recordingAttemptId, meetingId, sourceId, req } = {}) {
  if (typeof resolver !== 'function' || (!meetingId && !sourceId && !recordingAttemptId)) return null;
  try {
    const resolved = await resolver({ ownerId, recordingAttemptId, meetingId, sourceId, req });
    return resolved?.recordingAttemptId ? resolved : null;
  } catch {
    return null;
  }
}

function safeGatewayDescription(speechGateway) {
  const description = speechGateway?.describe?.() || { available: false, status: 'blocked' };
  return Object.freeze({
    capability: 'meeting_transcription',
    available: description.available === true,
    sourceAvailable: description.sourceAvailable === true,
    realProvider: description.realProvider === true,
    providerId: description.providerId || null,
    model: description.model || null,
    diarizationAvailable: description.diarizationAvailable === true,
    status: description.status || 'blocked'
  });
}

export async function handleMeetingTranscriptionApi({
  req,
  res,
  url,
  session,
  speechGateway,
  sendJson,
  diagnosticLogger = null,
  resolveDiagnosticScope = null,
  recordingAttemptResolver = null,
  sourceAssembler = defaultSourceAssembler,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES
}) {
  if (![MEETING_TRANSCRIPTION_CHUNK_PATH, MEETING_TRANSCRIPTION_SOURCE_PATH, MEETING_TRANSCRIPTION_DIAGNOSTIC_PATH, MEETING_TRANSCRIPTION_STATUS_PATH].includes(url.pathname)) return false;
  if (!session?.user?.id) {
    sendJson(res, 401, { ok: false, code: 'AUTH_REQUIRED', message: '请先登录。' });
    return true;
  }
  if (header(req, 'x-owner-id') || header(req, 'x-client-owner-id')) {
    sendJson(res, 400, { ok: false, code: 'CLIENT_OWNER_FORBIDDEN', message: '请求身份无效。' });
    return true;
  }
  const description = safeGatewayDescription(speechGateway);
  if (url.pathname === MEETING_TRANSCRIPTION_DIAGNOSTIC_PATH) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' }, { Allow: 'POST' });
      return true;
    }
    try {
      const binaryProbe = String(header(req, 'x-meeting-diagnostic-binary') || '').trim() === '1'
        && String(header(req, 'content-type') || '').toLowerCase().startsWith('application/octet-stream');
      if (binaryProbe) {
        const bytes = await readMeetingTranscriptionBody(req);
        const probeTraceId = traceId(header(req, 'x-meeting-trace-id'));
        const scope = await resolveTrustedDiagnosticScope({
          resolveDiagnosticScope,
          recordingAttemptResolver,
          ownerId: String(session.user.id),
          payload: {
            meetingId: header(req, 'x-meeting-id'),
            sourceId: header(req, 'x-source-id')
          },
          req
        });
        await diagnosticLog(diagnosticLogger, {
          ...scope,
          traceId: probeTraceId,
          phase: 'transport_probe',
          endpoint: MEETING_TRANSCRIPTION_DIAGNOSTIC_PATH,
          requestBodyType: 'Blob',
          requestBodyByteLength: bytes.length,
          probeMethod: 'POST',
          probeStatus: 200,
          probeSuccess: true,
          status: 'PASS'
        });
        sendJson(res, 200, { ok: true, receivedBytes: bytes.length });
        return true;
      }
      const payload = await readDiagnosticBody(req);
      const scope = await resolveTrustedDiagnosticScope({
        resolveDiagnosticScope,
        recordingAttemptResolver,
        ownerId: String(session.user.id),
        payload,
        req
      });
      const {
        ownerId: _clientOwnerId,
        meetingId: _clientMeetingId,
        sourceId: _clientSourceId,
        jobId: _clientJobId,
        blob: _clientBlob,
        data: _clientData,
        audioBytes: _clientAudioBytes,
        bytes: _clientBytes,
        ...safePayload
      } = payload;
      const event = {
        ...safePayload,
        ...scope,
        traceId: traceId(header(req, 'x-meeting-trace-id') || payload.traceId),
        endpoint: MEETING_TRANSCRIPTION_DIAGNOSTIC_PATH,
        phase: String(payload.phase || 'job_state').trim()
      };
      if (event.phase === 'recording_checkpoint') {
        if (!event.recordingAttemptId || !event.meetingId || !event.sourceId) {
          sendJson(res, 403, { ok: false, code: 'DIAGNOSTIC_SCOPE_UNVERIFIED' });
          return true;
        }
        if (typeof diagnosticLogger?.logRecordingCheckpoint !== 'function'
          && typeof diagnosticLogger?.log !== 'function') {
          sendJson(res, 503, { ok: false, code: 'DIAGNOSTIC_LOG_UNAVAILABLE' });
          return true;
        }
        const result = await diagnosticCheckpointLog(diagnosticLogger, event);
        if (result?.accepted !== true) {
          sendJson(res, 503, { ok: false, code: 'DIAGNOSTIC_LOG_WRITE_FAILED' });
          return true;
        }
        sendJson(res, 200, {
          ok: true,
          code: result.ignored ? 'TRACE_COLLECTION_NOT_SELECTED' : result.duplicate ? 'TRACE_ALREADY_PRESENT' : 'TRACE_BACKFILL_ACCEPTED'
        });
        return true;
      }
      await diagnosticLog(diagnosticLogger, event);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, statusForError(error), { ok: false, code: error?.code || 'MEETING_TRANSCRIPTION_DIAGNOSTIC_INVALID' });
    }
    return true;
  }
  if (url.pathname === MEETING_TRANSCRIPTION_STATUS_PATH) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' }, { Allow: 'GET' });
      return true;
    }
    sendJson(res, 200, { ok: true, ...description });
    return true;
  }
  if (url.pathname === MEETING_TRANSCRIPTION_SOURCE_PATH) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' }, { Allow: 'POST' });
      return true;
    }
    if (description.available !== true || typeof speechGateway?.transcribeSource !== 'function') {
      sendJson(res, 503, publicError(codedError('REAL_MEETING_ASR_PROVIDER_BLOCKED')));
      return true;
    }
    let controller = new AbortController();
    let metadata = null;
    let recordingAttempt = null;
    const abort = () => controller.abort();
    req.once?.('aborted', abort);
    res.once?.('close', abort);
    try {
      metadata = sourceRequestMetadata(req);
      const requestTraceId = metadata.traceId;
      recordingAttempt = await resolveRecordingAttempt({
        resolver: recordingAttemptResolver,
        ownerId: String(session.user.id),
        meetingId: metadata.meetingId,
        sourceId: metadata.sourceId,
        req
      });
      await diagnosticLog(diagnosticLogger, {
        traceId: requestTraceId,
        phase: 'request_received',
        endpoint: MEETING_TRANSCRIPTION_SOURCE_PATH,
        meetingId: metadata.meetingId,
        sourceId: metadata.sourceId,
        recordingAttemptId: recordingAttempt?.recordingAttemptId,
        sourceAssembler: true,
        status: 'PASS'
      });
      const requestDiagnostic = {
        traceId: metadata.traceId,
        log: (event) => diagnosticLog(diagnosticLogger, {
          ...event,
          traceId: metadata.traceId,
          endpoint: MEETING_TRANSCRIPTION_SOURCE_PATH,
          meetingId: metadata.meetingId,
          sourceId: metadata.sourceId,
          recordingAttemptId: recordingAttempt?.recordingAttemptId
        })
      };
      const result = await sourceAssembler.acceptChunk({
        ownerId: String(session.user.id),
        meetingId: metadata.meetingId,
        sourceId: metadata.sourceId,
        sourceRevision: metadata.sourceRevision,
        assemblyId: metadata.assemblyId,
        attempt: metadata.attempt,
        traceId: metadata.traceId,
        source: metadata.source,
        chunk: metadata.chunk,
        body: req,
        signal: controller.signal,
        diagnosticLogger: requestDiagnostic,
        finalize: ({ inputPath, source, chunks, signal }) => speechGateway.transcribeSource({
          ownerId: String(session.user.id),
          meetingId: metadata.meetingId,
          sourceId: metadata.sourceId,
          sourceRevision: metadata.sourceRevision,
          requestId: metadata.assemblyId,
          attempt: metadata.attempt,
          traceId: metadata.traceId,
          diagnostic: requestDiagnostic,
          source: {
            ...source,
            originalFileName: source.fileName,
            sourceChunkRefs: chunks.map((chunk) => chunk.sourceChunkId)
          },
          sourcePath: inputPath,
          sourceChunks: chunks,
          mode: metadata.mode,
          speakerCount: metadata.speakerCount,
          signal
        })
      });
      const finalResult = result.result || {};
      sendJson(res, 200, {
        ok: true,
        acknowledged: result.acknowledged === true,
        sequence: result.sequence,
        idempotent: result.idempotent === true,
        completed: result.completed === true,
        ...(result.completed === true ? {
          provider: finalResult.provider,
          model: finalResult.model,
          effectiveDurationMs: finalResult.effectiveDurationMs || null,
          chunks: finalResult.chunks || [],
          lease: finalResult.lease || null,
          cursor: finalResult.cursor || null,
          cleanupStatus: finalResult.cleanupStatus || 'completed'
        } : {})
      });
      await diagnosticLog(diagnosticLogger, {
        traceId: requestTraceId,
        phase: 'cleanup',
        endpoint: MEETING_TRANSCRIPTION_SOURCE_PATH,
        meetingId: metadata.meetingId,
        sourceId: metadata.sourceId,
        recordingAttemptId: recordingAttempt?.recordingAttemptId,
        cleanup: 'PASS',
        status: 'PASS'
      });
    } catch (error) {
      const requestTraceId = traceId(header(req, 'x-meeting-trace-id') || header(req, 'x-source-assembly-id') || header(req, 'x-request-id'));
      await diagnosticLog(diagnosticLogger, {
        traceId: requestTraceId,
        phase: 'failed',
        endpoint: MEETING_TRANSCRIPTION_SOURCE_PATH,
        meetingId: metadata?.meetingId,
        sourceId: metadata?.sourceId,
        recordingAttemptId: recordingAttempt?.recordingAttemptId,
        providerErrorCode: error?.providerErrorCode,
        errorCode: error?.code,
        status: 'FAIL',
        cleanup: 'PASS'
      });
      sendJson(res, statusForError(error), publicError(error));
    } finally {
      req.off?.('aborted', abort);
      res.off?.('close', abort);
    }
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持。' }, { Allow: 'POST' });
    return true;
  }
  if (description.available !== true) {
    sendJson(res, 503, publicError(codedError('REAL_MEETING_ASR_PROVIDER_BLOCKED')));
    return true;
  }

  let controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.('aborted', abort);
  res.once?.('close', abort);
  const requestTraceId = traceId(header(req, 'x-meeting-trace-id') || header(req, 'x-request-id'));
  try {
    const audioBytes = await readMeetingTranscriptionBody(req, maxChunkBytes);
    const metadata = requestMetadata(req, audioBytes);
    const recordingAttempt = await resolveRecordingAttempt({
      resolver: recordingAttemptResolver,
      ownerId: String(session.user.id),
      meetingId: metadata.meetingId,
      sourceId: metadata.sourceId,
      req
    });
    const requestDiagnostic = {
      traceId: metadata.traceId,
      log: (event) => diagnosticLog(diagnosticLogger, {
        ...event,
        traceId: metadata.traceId,
        endpoint: MEETING_TRANSCRIPTION_CHUNK_PATH,
        meetingId: metadata.meetingId,
        sourceId: metadata.sourceId,
        recordingAttemptId: recordingAttempt?.recordingAttemptId
      })
    };
    await diagnosticLog(diagnosticLogger, {
      traceId: metadata.traceId,
      phase: 'request_received',
      endpoint: MEETING_TRANSCRIPTION_CHUNK_PATH,
      meetingId: metadata.meetingId,
      sourceId: metadata.sourceId,
      recordingAttemptId: recordingAttempt?.recordingAttemptId,
      transcriptionRequestId: metadata.requestId,
      segmentCount: 1,
      sequences: [metadata.chunk.sequence],
      totalBytes: audioBytes.length,
      status: 'PASS'
    });
    const result = await speechGateway.transcribeChunk({
      ownerId: String(session.user.id),
      meetingId: metadata.meetingId,
      sourceId: metadata.sourceId,
      sourceRevision: metadata.sourceRevision,
      requestId: metadata.requestId,
      traceId: metadata.traceId,
      attempt: metadata.attempt,
      diagnostic: requestDiagnostic,
      mode: metadata.mode,
      speakerCount: metadata.speakerCount,
      chunk: metadata.chunk,
      signal: controller.signal
    });
    await diagnosticLog(diagnosticLogger, {
      traceId: metadata.traceId,
      phase: 'cleanup',
      endpoint: MEETING_TRANSCRIPTION_CHUNK_PATH,
      meetingId: metadata.meetingId,
      sourceId: metadata.sourceId,
      recordingAttemptId: recordingAttempt?.recordingAttemptId,
      cleanup: result.cleanupStatus === 'not_required' || result.cleanupStatus === 'completed' ? 'PASS' : 'FAIL',
      status: 'PASS'
    });
    sendJson(res, 200, {
      ok: true,
      provider: result.provider,
      model: result.model,
      segments: result.segments,
      lease: result.lease || null,
      cursor: result.cursor || null,
      cleanupStatus: result.cleanupStatus || 'not_required'
    });
  } catch (error) {
    await diagnosticLog(diagnosticLogger, {
      traceId: requestTraceId,
      phase: 'failed',
      endpoint: MEETING_TRANSCRIPTION_CHUNK_PATH,
      providerErrorCode: error?.providerErrorCode,
      errorCode: error?.code,
      status: 'FAIL'
    });
    sendJson(res, statusForError(error), publicError(error));
  } finally {
    req.off?.('aborted', abort);
    res.off?.('close', abort);
  }
  return true;
}
