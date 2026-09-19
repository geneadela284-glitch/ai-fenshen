import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  createMeetingAudioNormalizer,
  inferMeetingAudioFormat
} from './meetingAudioNormalizer.js';

export const XFYUN_ASR_LLM_PROVIDER_ID = 'xfyun_asr_llm';
export const XFYUN_ASR_LLM_MODEL_ID = 'recording_file_transcription_llm';
export const XFYUN_ASR_LLM_BASE_URL = 'https://office-api-ist-dx.iflyaisol.com';
export const MEETING_SOURCE_DURATION_DRIFT_MIN_TOLERANCE_MS = 250;
export const MEETING_SOURCE_DURATION_DRIFT_MAX_RATIO = 0.005;
export const MEETING_AAC_MP4_POSITIVE_DRIFT_TOLERANCE_MS = 1_500;

function isAacMp4Source({ sourceFormat, sourceMimeType } = {}) {
  const format = String(sourceFormat || '').trim().toLowerCase();
  const mimeType = String(sourceMimeType || '').trim().toLowerCase();
  return format === 'm4a'
    && (mimeType.includes('audio/mp4') || mimeType.includes('audio/m4a'))
    && (mimeType.includes('mp4a.40.2') || mimeType.includes('aac') || mimeType.includes('audio/mp4'));
}

function codedError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

export function resolveMeetingSourceDuration({ declaredDurationMs, decodedDurationMs, sourceFormat, sourceMimeType } = {}) {
  const declared = Number(declaredDurationMs);
  const decoded = Number(decodedDurationMs);
  if (!Number.isSafeInteger(declared) || declared <= 0 || !Number.isSafeInteger(decoded) || decoded <= 0) {
    throw codedError('TRANSCRIPTION_SOURCE_DURATION_INVALID');
  }
  const codecAware = isAacMp4Source({ sourceFormat, sourceMimeType });
  const durationDifferenceMs = Math.abs(decoded - declared);
  const driftDirection = decoded === declared ? 'none' : decoded > declared ? 'positive' : 'negative';
  const toleranceMs = Math.max(
    MEETING_SOURCE_DURATION_DRIFT_MIN_TOLERANCE_MS,
    decoded * MEETING_SOURCE_DURATION_DRIFT_MAX_RATIO
  );
  const appliedToleranceMs = codecAware && driftDirection === 'positive'
    ? MEETING_AAC_MP4_POSITIVE_DRIFT_TOLERANCE_MS
    : toleranceMs;
  if (durationDifferenceMs > appliedToleranceMs) {
    throw codedError('TRANSCRIPTION_SOURCE_DURATION_DRIFT_TOO_LARGE', {
      declaredDurationMs: declared,
      decodedDurationMs: decoded,
      durationDifferenceMs,
      toleranceMs: appliedToleranceMs,
      codecAware: codecAware ? 'aac-mp4' : 'strict',
      driftDirection
    });
  }
  return Object.freeze({
    declaredDurationMs: declared,
    decodedDurationMs: decoded,
    effectiveDurationMs: decoded,
    durationDifferenceMs,
    toleranceMs: appliedToleranceMs,
    codecAware: codecAware ? 'aac-mp4' : 'strict',
    driftDirection,
    durationToleranceApplied: codecAware && appliedToleranceMs !== toleranceMs && durationDifferenceMs > toleranceMs
  });
}

export function validateMeetingSourceWindows({ windows, decodedDurationMs } = {}) {
  const duration = Number(decodedDurationMs);
  if (!Number.isSafeInteger(duration) || duration <= 0) throw codedError('TRANSCRIPTION_SOURCE_DURATION_INVALID');
  if (!Array.isArray(windows) || windows.length === 0) {
    throw codedError('TRANSCRIPTION_SOURCE_WINDOW_INVALID', { failedCondition: 'windows_nonempty' });
  }
  let previousEndMs = 0;
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index] || {};
    const sequence = Number(window.sequence);
    const startMs = Number(window.startMs);
    const endMs = Number(window.endMs);
    const durationMs = Number(window.durationMs ?? (endMs - startMs));
    const checks = [
      ['sequence_contiguous', sequence === index],
      ['start_contiguous', startMs === previousEndMs],
      ['start_integer', Number.isSafeInteger(startMs)],
      ['start_nonnegative', startMs >= 0],
      ['end_integer', Number.isSafeInteger(endMs)],
      ['end_after_start', endMs > startMs],
      ['end_within_decoded_duration', endMs <= duration],
      ['duration_integer', Number.isSafeInteger(durationMs)],
      ['duration_matches_bounds', durationMs === endMs - startMs]
    ];
    const failed = checks.find(([, valid]) => !valid);
    if (failed) {
      throw codedError('TRANSCRIPTION_SOURCE_WINDOW_INVALID', {
        failedCondition: failed[0],
        windowIndex: index,
        sequence,
        startMs,
        endMs,
        durationMs,
        decodedDurationMs: duration
      });
    }
    previousEndMs = endMs;
  }
  if (previousEndMs !== duration) {
    throw codedError('TRANSCRIPTION_SOURCE_WINDOW_INVALID', {
      failedCondition: 'final_end_matches_decoded_duration',
      previousEndMs,
      decodedDurationMs: duration
    });
  }
  return Object.freeze({ decodedDurationMs: duration, endMs: previousEndMs });
}

function nonEmptyCredentials(credentials = {}) {
  return Object.freeze({
    appId: required(credentials.appId, 'XFYUN_APP_ID_MISSING'),
    accessKeyId: required(credentials.accessKeyId, 'XFYUN_ACCESS_KEY_ID_MISSING'),
    accessKeySecret: required(credentials.accessKeySecret, 'XFYUN_ACCESS_KEY_SECRET_MISSING')
  });
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function signedBaseString(parameters = {}) {
  return Object.entries(parameters)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join('&');
}

export function createXfyunSignature(parameters = {}, accessKeySecret = '') {
  const secret = required(accessKeySecret, 'XFYUN_ACCESS_KEY_SECRET_MISSING');
  return createHmac('sha1', secret).update(signedBaseString(parameters), 'utf8').digest('base64');
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw codedError('XFYUN_DATETIME_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+0800`;
}

function defaultRandomString() {
  return randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(16, 'A');
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function redact(value, credentials) {
  let result = String(value || '');
  for (const secret of Object.values(credentials)) {
    if (secret) result = result.split(secret).join('[REDACTED]');
  }
  return result.slice(0, 240);
}

function xfyunProviderError({ code, reason, stage, credentials, status = null, failType = null }) {
  return codedError('XFYUN_PROVIDER_ERROR', {
    providerErrorCode: String(code || 'XFYUN_UNKNOWN_ERROR'),
    reason: redact(reason || '讯飞服务请求失败', credentials),
    stage,
    httpStatus: Number.isInteger(status) ? status : null,
    ...(failType === null ? {} : { providerFailType: failType })
  });
}

async function readResponse(response) {
  try {
    return await response.json();
  } catch {
    const text = await response.text().catch(() => '');
    return { descInfo: text };
  }
}

async function diagnosticLog(logger, event) {
  try {
    await logger?.log?.(event);
  } catch {
    // Candidate diagnostics are best effort and must never change provider behavior.
  }
}

async function requestJson({ fetchImpl, url, options, credentials, stage, diagnostic = null, traceId = '', uploadIndex, getResultIndex, roleType, roleNum }) {
  let response;
  let body;
  try {
    response = await fetchImpl(url, options);
    body = await readResponse(response);
  } catch (error) {
    if (error?.code === 'XFYUN_PROVIDER_ERROR') throw error;
    throw xfyunProviderError({
      code: error?.name === 'AbortError' ? 'REQUEST_ABORTED' : 'NETWORK_ERROR',
      reason: error?.message || 'network request failed',
      stage,
      credentials
    });
  }
  const providerCode = String(body?.code ?? '');
  await diagnosticLog(diagnostic, {
    traceId,
    phase: stage === 'upload' ? 'xfyun_upload' : 'xfyun_get_result',
    ...(stage === 'upload' ? { uploadIndex } : { getResultIndex }),
    httpStatus: response.status,
    providerCode: providerCode || null,
    providerErrorCode: providerCode || null,
    descInfo: body?.descInfo || response.statusText || '',
    ...(roleType === undefined ? {} : { roleType }),
    ...(roleNum === undefined ? {} : { roleNum }),
    ...(roleType === 1 ? { gate: 'G5', providerInvoked: true } : {}),
    ...(stage === 'upload' && body?.content?.orderId ? { orderIdHash: sha256(body.content.orderId) } : {}),
    status: response.ok && (!providerCode || providerCode === '000000') ? 'PASS' : 'FAIL'
  });
  if (!response.ok || (providerCode && providerCode !== '000000')) {
    throw xfyunProviderError({
      code: providerCode || `HTTP_${response.status}`,
      reason: body?.descInfo || response.statusText || '讯飞服务请求失败',
      stage,
      credentials,
      status: response.status
    });
  }
  return body;
}

function signedRequest({ baseUrl, pathname, parameters, credentials, signatureImpl = createXfyunSignature }) {
  const url = new URL(pathname, baseUrl);
  const signature = signatureImpl(parameters, credentials.accessKeySecret);
  if (typeof signature !== 'string' || signature.trim() === '') throw codedError('XFYUN_SIGNATURE_GENERATION_FAILED');
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
  }
  return Object.freeze({ url, signature });
}

function chunkRequestDetails(chunk = {}) {
  const bytes = chunk.bytes instanceof Uint8Array
    ? Buffer.from(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength)
    : Buffer.isBuffer(chunk.bytes) ? chunk.bytes : null;
  if (!bytes || bytes.length === 0) throw codedError('XFYUN_AUDIO_BYTES_REQUIRED');
  const startMs = Number(chunk.startMs);
  const endMs = Number(chunk.endMs);
  const durationMs = Number(chunk.durationMs ?? (endMs - startMs));
  if (!Number.isSafeInteger(startMs) || startMs < 0 || !Number.isSafeInteger(endMs) || endMs <= startMs) throw codedError('XFYUN_AUDIO_TIMESTAMP_INVALID');
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw codedError('XFYUN_AUDIO_DURATION_INVALID');
  const format = inferMeetingAudioFormat(chunk);
  const extension = format === 'webm-opus' ? 'webm' : format === 'wav' ? 'wav' : format === 'mp3' ? 'mp3' : format === 'm4a' ? 'm4a' : format === 'aac' ? 'aac' : 'audio';
  const fileName = String(chunk.fileName || `meeting-chunk-${chunk.sequence ?? 0}.${extension}`).trim();
  if (!fileName) throw codedError('XFYUN_AUDIO_FILENAME_REQUIRED');
  return Object.freeze({
    bytes,
    startMs,
    endMs,
    durationMs,
    fileName,
    mimeType: String(chunk.mimeType || '').trim(),
    format,
    sequence: chunk.sequence,
    sourceChunkRefs: Array.isArray(chunk.sourceChunkRefs) ? [...chunk.sourceChunkRefs] : []
  });
}

function diarizationOptions(request = {}) {
  const mode = String(request.mode || 'transcription').trim() || 'transcription';
  if (!['transcription', 'diarization'].includes(mode)) throw codedError('MEETING_TRANSCRIPTION_MODE_INVALID');
  if (mode === 'transcription') return Object.freeze({ mode, diarizationMode: false, speakerCount: 0 });
  const speakerCount = Number(request.speakerCount ?? 0);
  if (!(speakerCount === 0 || [2, 3, 4].includes(speakerCount))) throw codedError('DIARIZATION_SPEAKER_COUNT_INVALID');
  return Object.freeze({ mode, diarizationMode: true, speakerCount });
}

function providerRole(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function parseOrderResult(orderResult, { includeSpeakerRole = false } = {}) {
  let parsed = orderResult;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw codedError('XFYUN_RESULT_INVALID');
    }
  }
  const lattice = Array.isArray(parsed?.lattice) && parsed.lattice.length
    ? parsed.lattice
    : Array.isArray(parsed?.lattice2) ? parsed.lattice2 : [];
  const segments = [];
  for (const entry of lattice) {
    let sentence = entry?.json_1best;
    if (typeof sentence === 'string') {
      try {
        sentence = JSON.parse(sentence);
      } catch {
        throw codedError('XFYUN_RESULT_INVALID');
      }
    }
    const st = sentence?.st;
    const startMs = Number(st?.bg);
    const endMs = Number(st?.ed);
    const text = (Array.isArray(st?.rt) ? st.rt : [])
      .flatMap((part) => Array.isArray(part?.ws) ? part.ws : [])
      .flatMap((word) => Array.isArray(word?.cw) ? word.cw : [])
      .map((candidate) => String(candidate?.w ?? ''))
      .join('')
      .trim();
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) throw codedError('XFYUN_RESULT_TIMESTAMP_INVALID');
    if (!text) continue;
    segments.push({
      startMs,
      endMs,
      text,
      confidence: null,
      ...(includeSpeakerRole ? { providerRole: providerRole(st?.rl) } : {})
    });
  }
  if (!segments.length) throw codedError('XFYUN_RESULT_EMPTY');
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startMs < segments[index - 1].endMs) throw codedError('XFYUN_RESULT_TIMESTAMP_NOT_MONOTONIC');
  }
  return segments;
}

function orderFailure(body, credentials) {
  const orderInfo = body?.content?.orderInfo || {};
  if (Number(orderInfo.status) !== -1 && Number(orderInfo.failType || 0) === 0) return null;
  const failType = Number(orderInfo.failType || 0);
  if (!failType && Number(orderInfo.status) !== -1) return null;
  return xfyunProviderError({
    code: failType ? `FAIL_TYPE_${failType}` : 'ORDER_FAILED',
    reason: body?.descInfo || '讯飞订单转写失败',
    stage: 'getResult',
    credentials,
    failType
  });
}

function sourceChunkRefsForWindow(window, sourceChunks = []) {
  let cursorMs = 0;
  const refs = [];
  for (let index = 0; index < sourceChunks.length; index += 1) {
    const sourceChunk = sourceChunks[index] || {};
    if (Number(sourceChunk.sequence) !== index) throw codedError('SOURCE_ASSEMBLY_SEQUENCE_INVALID');
    const durationMs = Number(sourceChunk.durationMs);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw codedError('SOURCE_ASSEMBLY_CHUNK_DURATION_INVALID');
    const endMs = cursorMs + durationMs;
    if (endMs > Number(window.startMs) && cursorMs < Number(window.endMs)) {
      refs.push(required(sourceChunk.sourceChunkId, 'SOURCE_ASSEMBLY_CHUNK_ID_REQUIRED'));
    }
    cursorMs = endMs;
  }
  if (!refs.length) throw codedError('SOURCE_ASSEMBLY_CHUNK_REFS_EMPTY');
  return Object.freeze(refs);
}

export function createXfyunAsrLlmMeetingProvider({
  credentials: inputCredentials,
  baseUrl = XFYUN_ASR_LLM_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date(),
  randomString = defaultRandomString,
  signatureImpl = createXfyunSignature,
  audioNormalizer = null,
  pollIntervalMs = 5_000,
  maxPollAttempts = 120
} = {}) {
  const credentials = nonEmptyCredentials(inputCredentials);
  const normalizedBaseUrl = required(baseUrl, 'XFYUN_BASE_URL_REQUIRED').replace(/\/+$/, '');
  if (typeof fetchImpl !== 'function') throw codedError('XFYUN_FETCH_UNAVAILABLE');
  if (typeof sleepImpl !== 'function') throw codedError('XFYUN_SLEEP_UNAVAILABLE');
  if (!Number.isSafeInteger(Number(pollIntervalMs)) || Number(pollIntervalMs) < 0) throw codedError('XFYUN_POLL_INTERVAL_INVALID');
  if (!Number.isSafeInteger(Number(maxPollAttempts)) || Number(maxPollAttempts) < 1) throw codedError('XFYUN_POLL_ATTEMPTS_INVALID');
  const normalizer = audioNormalizer || createMeetingAudioNormalizer();
  if (typeof normalizer?.normalizeChunk !== 'function') throw codedError('MEETING_AUDIO_NORMALIZER_UNAVAILABLE');

  async function transcribeNormalizedChunk(request = {}, chunk, { normalized = false, diarizationMode = false, speakerCount = 0 } = {}) {
    const uploadDetails = chunkRequestDetails(chunk);
    const signatureRandom = required(randomString(), 'XFYUN_SIGNATURE_RANDOM_REQUIRED');
    const uploadParameters = {
      appId: credentials.appId,
      accessKeyId: credentials.accessKeyId,
      dateTime: formatDateTime(now()),
      signatureRandom,
      fileSize: uploadDetails.bytes.length,
      fileName: uploadDetails.fileName,
      ...(normalized === true
        ? { durationCheckDisable: true }
        : { duration: uploadDetails.durationMs }),
      language: 'autodialect',
      roleType: diarizationMode ? 1 : 0,
      ...(diarizationMode ? { roleNum: speakerCount } : {}),
      audioMode: 'fileStream',
      eng_smoothproc: false,
      eng_colloqproc: false
    };
    const uploadRequest = signedRequest({
      baseUrl: normalizedBaseUrl,
      pathname: '/v2/upload',
      parameters: uploadParameters,
      credentials,
      signatureImpl
    });
    const upload = await requestJson({
      fetchImpl,
      url: uploadRequest.url,
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(uploadDetails.bytes.length),
          signature: uploadRequest.signature
        },
        body: uploadDetails.bytes,
        signal: request.signal
      },
      credentials,
      stage: 'upload',
        diagnostic: request.diagnostic,
        traceId: request.traceId,
        uploadIndex: uploadDetails.sequence,
        roleType: diarizationMode ? 1 : 0,
        roleNum: diarizationMode ? speakerCount : undefined
    });
    const orderId = required(upload?.content?.orderId, 'XFYUN_ORDER_ID_MISSING');

    for (let attempt = 0; attempt < Number(maxPollAttempts); attempt += 1) {
      if (request.signal?.aborted) throw codedError('TRANSCRIPTION_CANCELLED');
      const queryParameters = {
        accessKeyId: credentials.accessKeyId,
        dateTime: formatDateTime(now()),
        signatureRandom,
        orderId,
        resultType: 'transfer'
      };
      const resultRequest = signedRequest({
        baseUrl: normalizedBaseUrl,
        pathname: '/v2/getResult',
        parameters: queryParameters,
        credentials,
        signatureImpl
      });
      const result = await requestJson({
        fetchImpl,
        url: resultRequest.url,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', signature: resultRequest.signature },
          body: '{}',
          signal: request.signal
        },
        credentials,
        stage: 'getResult',
        diagnostic: request.diagnostic,
        traceId: request.traceId,
        getResultIndex: attempt,
        roleType: diarizationMode ? 1 : 0,
        roleNum: diarizationMode ? speakerCount : undefined
      }).catch((error) => {
        if (error?.providerErrorCode === '100013') return null;
        throw error;
      });
      if (result === null) {
        await sleepImpl(Number(pollIntervalMs));
        continue;
      }
      const failed = orderFailure(result, credentials);
      if (failed) throw failed;
      const status = Number(result?.content?.orderInfo?.status);
      if (status === 3 || status === 0) {
        await sleepImpl(Number(pollIntervalMs));
        continue;
      }
      if (status !== 4) throw xfyunProviderError({
        code: `ORDER_STATUS_${Number.isFinite(status) ? status : 'UNKNOWN'}`,
        reason: '讯飞订单状态异常',
        stage: 'getResult',
        credentials
      });
      return Object.freeze({
        provider: XFYUN_ASR_LLM_PROVIDER_ID,
        model: XFYUN_ASR_LLM_MODEL_ID,
        segments: parseOrderResult(result?.content?.orderResult, { includeSpeakerRole: diarizationMode }),
        lease: Object.freeze({
          provider: XFYUN_ASR_LLM_PROVIDER_ID,
          orderIdHash: sha256(orderId),
          status: 'completed'
        }),
        cursor: Object.freeze({ status: 'completed' }),
        cleanupStatus: 'not_required'
      });
    }
    throw xfyunProviderError({
      code: 'POLL_TIMEOUT',
      reason: '讯飞转写结果轮询超时',
      stage: 'getResult',
      credentials
    });
  }

  async function transcribeChunk(request = {}) {
    const options = diarizationOptions(request);
    const details = chunkRequestDetails(request.chunk);
    const normalized = await normalizer.normalizeChunk({ ...details, signal: request.signal });
    return transcribeNormalizedChunk(request, normalized, {
      normalized: normalized.normalized === true,
      diarizationMode: options.diarizationMode,
      speakerCount: options.speakerCount
    });
  }

  async function transcribeSource(request = {}) {
    const options = diarizationOptions(request);
    if (typeof normalizer.normalizeSourceFile !== 'function'
      || (!options.diarizationMode && typeof normalizer.splitWavFile !== 'function')) {
      throw codedError('MEETING_AUDIO_NORMALIZER_SOURCE_UNAVAILABLE');
    }
    const source = request.source || {};
    const sourcePath = required(request.sourcePath, 'SOURCE_ASSEMBLY_INPUT_PATH_REQUIRED');
    const declaredSourceDurationMs = Number(source.durationMs);
    if (!Number.isSafeInteger(declaredSourceDurationMs) || declaredSourceDurationMs <= 0) throw codedError('TRANSCRIPTION_SOURCE_DURATION_INVALID');
    let normalized = null;
    try {
      normalized = await normalizer.normalizeSourceFile({
        inputPath: sourcePath,
        fileName: source.fileName,
        mimeType: source.mimeType,
        format: source.format,
        signal: request.signal
      });
      await diagnosticLog(request.diagnostic, {
        traceId: request.traceId,
        phase: 'source_normalized',
        ffmpegExitCode: normalized.ffmpegExitCode ?? 0,
        wavDurationMs: normalized.metadata?.durationMs,
        status: 'PASS'
      });
    } catch (error) {
      await diagnosticLog(request.diagnostic, {
        traceId: request.traceId,
        phase: 'source_normalized',
        ffmpegExitCode: error?.ffmpegExitCode,
        status: 'FAIL',
        errorCode: error?.code || 'MEETING_AUDIO_NORMALIZATION_FAILED'
      });
      throw error;
    }
    try {
      const decodedDurationMs = Number(normalized.metadata?.durationMs);
      const durationContract = resolveMeetingSourceDuration({
        declaredDurationMs: declaredSourceDurationMs,
        decodedDurationMs,
        sourceFormat: source.format,
        sourceMimeType: source.mimeType
      });
      const windows = options.diarizationMode
        ? [{
            sequence: 0,
            startMs: 0,
            endMs: durationContract.effectiveDurationMs,
            durationMs: durationContract.effectiveDurationMs,
            path: required(normalized.path, 'MEETING_AUDIO_NORMALIZATION_SOURCE_REQUIRED'),
            fileName: normalized.fileName || 'meeting-diarization.wav',
            mimeType: normalized.mimeType || 'audio/wav',
            format: normalized.format || 'wav'
          }]
        : await normalizer.splitWavFile({ normalized, maxChunkDurationMs: 60_000, overlapMs: 0 });
      validateMeetingSourceWindows({ windows, decodedDurationMs: durationContract.effectiveDurationMs });
      await diagnosticLog(request.diagnostic, {
        traceId: request.traceId,
        phase: 'source_windows_created',
        wavDurationMs: normalized.metadata?.durationMs,
        windowCount: windows.length,
        windowDurationsMs: windows.map((window) => Number(window.durationMs ?? Number(window.endMs) - Number(window.startMs))),
        status: 'PASS'
      });
      const chunks = [];
      const leases = [];
      for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index] || {};
        const sequence = Number(window.sequence);
        const startMs = Number(window.startMs);
        const endMs = Number(window.endMs);
        const durationMs = Number(window.durationMs ?? (endMs - startMs));
        let bytes;
        try {
          bytes = await readFile(required(window.path, 'MEETING_AUDIO_NORMALIZATION_WINDOW_REQUIRED'));
        } catch (error) {
          if (error?.code === 'TRANSCRIPTION_CANCELLED') throw error;
          throw codedError('MEETING_AUDIO_NORMALIZATION_FAILED');
        }
        if (!bytes.length) throw codedError('MEETING_AUDIO_NORMALIZATION_FAILED');
        const sourceChunkRefs = sourceChunkRefsForWindow(window, request.sourceChunks);
        const result = await transcribeNormalizedChunk(request, {
          sequence,
          startMs,
          endMs,
          durationMs,
          bytes,
          fileName: window.fileName || `meeting-window-${sequence}.wav`,
          mimeType: window.mimeType || 'audio/wav',
          format: window.format || 'wav',
          sourceChunkRefs
        }, {
          normalized: true,
          diarizationMode: options.diarizationMode,
          speakerCount: options.speakerCount
        });
        chunks.push(Object.freeze({
          sequence,
          startMs,
          endMs,
          sourceChunkRefs,
          segments: result.segments
        }));
        if (result.lease) leases.push(result.lease);
      }
      return Object.freeze({
        provider: XFYUN_ASR_LLM_PROVIDER_ID,
        model: XFYUN_ASR_LLM_MODEL_ID,
        ...(options.diarizationMode ? { mode: options.mode, speakerCount: options.speakerCount } : {}),
        effectiveDurationMs: durationContract.effectiveDurationMs,
        chunks: Object.freeze(chunks),
        lease: Object.freeze({
          provider: XFYUN_ASR_LLM_PROVIDER_ID,
          status: 'completed',
          orderIdHashes: Object.freeze(leases.map((lease) => lease.orderIdHash).filter(Boolean))
        }),
        cursor: Object.freeze({ status: 'completed', chunkCount: chunks.length }),
        cleanupStatus: 'completed'
      });
    } finally {
      try {
        await normalized.cleanup?.();
        await diagnosticLog(request.diagnostic, { traceId: request.traceId, phase: 'cleanup', cleanup: 'PASS', status: 'PASS' });
      } catch (error) {
        await diagnosticLog(request.diagnostic, { traceId: request.traceId, phase: 'cleanup', cleanup: 'FAIL', errorCode: error?.code || 'MEETING_AUDIO_CLEANUP_FAILED', status: 'FAIL' });
        throw error;
      }
    }
  }

  return Object.freeze({
    providerId: XFYUN_ASR_LLM_PROVIDER_ID,
    model: XFYUN_ASR_LLM_MODEL_ID,
    isDeterministicFixture: false,
    supportsDiarization: true,
    transcribeChunk,
    transcribeSource
  });
}

export { codedError, formatDateTime, parseOrderResult };
