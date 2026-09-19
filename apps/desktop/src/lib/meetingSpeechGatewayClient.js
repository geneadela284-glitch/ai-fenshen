const PROVIDER_ID = 'xfyun_asr_llm';
const MODEL_ID = 'recording_file_transcription_llm';
const SOURCE_ENDPOINT = '/api/meeting/transcription/source';
const STATUS_ENDPOINT = '/api/meeting/transcription/status';
const DIAGNOSTIC_ENDPOINT = '/api/meeting/transcription/diagnostic';
const BINARY_PROBE_BYTES = 538_970;

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

function diarizationHeaders(request = {}) {
  const mode = String(request.mode || 'transcription').trim() || 'transcription';
  if (!['transcription', 'diarization'].includes(mode)) throw codedError('MEETING_TRANSCRIPTION_MODE_INVALID');
  if (mode !== 'diarization') return Object.freeze({});
  const speakerCount = Number(request.speakerCount ?? 0);
  if (!(speakerCount === 0 || [2, 3, 4].includes(speakerCount))) throw codedError('DIARIZATION_SPEAKER_COUNT_INVALID');
  return Object.freeze({
    'X-Meeting-Transcription-Mode': 'diarization',
    'X-Meeting-Speaker-Count': String(speakerCount)
  });
}

export function encodeMeetingFileNameForHeader(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) throw codedError('TRANSCRIPTION_FILE_NAME_INVALID');
  const encoded = encodeURIComponent(normalized);
  if (!/^[\x00-\x7f]*$/.test(encoded)) throw codedError('TRANSCRIPTION_FILE_NAME_INVALID');
  return encoded;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function browserLocation() {
  return typeof globalThis.location !== 'undefined' && globalThis.location?.href
    ? globalThis.location
    : null;
}

function resolveRequestUrl(endpoint) {
  const location = browserLocation();
  return new URL(String(endpoint), location?.href || 'http://localhost/');
}

function bodyDetails(body) {
  if (body === undefined || body === null) return { type: 'none', byteLength: 0 };
  if (typeof Blob !== 'undefined' && body instanceof Blob) return { type: 'Blob', byteLength: Number(body.size) || 0 };
  if (typeof FormData !== 'undefined' && body instanceof FormData) return { type: 'FormData', byteLength: null };
  if (body instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: body.byteLength };
  if (ArrayBuffer.isView(body)) return { type: body.constructor?.name || 'ArrayBufferView', byteLength: body.byteLength };
  if (typeof body === 'string') return { type: 'string', byteLength: new TextEncoder().encode(body).byteLength };
  return { type: typeof body, byteLength: null };
}

function requestDetails(endpoint, options = {}) {
  const location = browserLocation();
  const resolved = resolveRequestUrl(endpoint);
  const body = bodyDetails(options.body);
  const currentOrigin = location?.origin || '';
  const sameOrigin = currentOrigin ? resolved.origin === currentOrigin : undefined;
  const localTarget = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(resolved.hostname);
  const wrongHostPort = Boolean(location && (resolved.hostname !== location.hostname || resolved.port !== location.port));
  return Object.freeze({
    origin: currentOrigin || resolved.origin,
    resolvedUrl: `${resolved.origin}${resolved.pathname}`,
    endpointPathname: resolved.pathname,
    httpMethod: String(options.method || 'GET').toUpperCase(),
    requestBodyType: body.type,
    requestBodyByteLength: body.byteLength,
    credentialsMode: String(options.credentials || 'same-origin'),
    requestMode: String(options.mode || 'default'),
    signalAborted: Boolean(options.signal?.aborted),
    timeoutConfigured: false,
    navigatorOnLine: typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : undefined,
    sameOrigin,
    protocol: resolved.protocol,
    host: resolved.hostname,
    port: resolved.port ? Number(resolved.port) : (resolved.protocol === 'https:' ? 443 : 80),
    isLocalhostTarget: localTarget,
    isWrongHostPort: wrongHostPort,
    isLegacyApiBase: Boolean(location && resolved.origin !== location.origin)
  });
}

function transportErrorDetails(error, details) {
  const name = String(error?.name || 'Error');
  const message = String(error?.message || '请求失败');
  const cause = error?.cause?.message || error?.cause || '';
  const combined = `${name} ${message} ${String(cause)}`.toLowerCase();
  return {
    ...details,
    phase: 'transport_error',
    errorName: name,
    errorMessage: message,
    errorCause: String(cause || ''),
    isAbortError: name === 'AbortError',
    isTypeError: name === 'TypeError',
    isTimeout: /timeout|timed out|超时/.test(combined),
    isCors: /cors|cross-origin|跨域/.test(combined),
    isMixedContent: /mixed content|insecure|不安全内容/.test(combined),
    isTlsCertificate: /certificate|cert|ssl|tls|secure connection|证书/.test(combined),
    isConnectionRefused: /connection refused|econnrefused|refused|连接被拒绝/.test(combined)
  };
}

function createBinaryBody(bytes) {
  const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!normalized.byteLength) throw codedError('TRANSCRIPTION_AUDIO_EMPTY');
  if (typeof Blob === 'undefined') throw codedError('MEETING_BINARY_BODY_UNAVAILABLE');
  const body = new Blob([normalized], { type: 'application/octet-stream' });
  if (body.size !== normalized.byteLength) throw codedError('MEETING_BINARY_BODY_SIZE_MISMATCH');
  return Object.freeze({ body, byteLength: normalized.byteLength });
}

export function createMeetingSpeechGatewayClient({
  fetchImpl = globalThis.fetch,
  endpoint = '/api/meeting/transcription/chunk'
} = {}) {
  if (typeof fetchImpl !== 'function') throw codedError('MEETING_TRANSCRIPTION_FETCH_UNAVAILABLE');
  const normalizedEndpoint = required(endpoint, 'MEETING_TRANSCRIPTION_ENDPOINT_REQUIRED');
  let capability = Object.freeze({
    available: true,
    sourceAvailable: true,
    diarizationAvailable: true,
    status: 'unverified'
  });

  function describe() {
    return Object.freeze({
      capability: 'meeting_transcription',
      available: capability.available === true,
      sourceAvailable: capability.sourceAvailable === true,
      diarizationAvailable: capability.diarizationAvailable === true,
      providerId: PROVIDER_ID,
      model: MODEL_ID,
      realProvider: true,
      deterministicFixture: false,
      status: capability.status
    });
  }

  async function probeCapability() {
    try {
      const response = await fetchImpl(STATUS_ENDPOINT, { method: 'GET', credentials: 'include', mode: 'same-origin' });
      const body = await readJson(response);
      const verified = response.ok && body?.ok === true && body?.capability === 'meeting_transcription';
      capability = Object.freeze({
        available: verified && body.available === true,
        sourceAvailable: verified && body.sourceAvailable === true,
        diarizationAvailable: verified && body.diarizationAvailable === true,
        status: verified && body.available === true ? String(body.status || 'available') : 'blocked'
      });
    } catch {
      capability = Object.freeze({ available: false, sourceAvailable: false, diarizationAvailable: false, status: 'blocked' });
    }
    return describe();
  }

  async function postDiagnostic(event = {}) {
    try {
      const response = await fetchImpl(DIAGNOSTIC_ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        mode: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Meeting-Trace-Id': required(event.traceId, 'MEETING_TRACE_ID_REQUIRED')
        },
        body: JSON.stringify(event)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function emitBrowserDiagnostic(event = {}) {
    if (!browserLocation()) return false;
    return postDiagnostic(event);
  }

  async function fetchWithTransportDiagnostics(url, options, traceId) {
    const details = requestDetails(url, options);
    await emitBrowserDiagnostic({ traceId, ...details, phase: 'transport_request', status: 'PASS' });
    try {
      const response = await fetchImpl(url, options);
      await emitBrowserDiagnostic({
        traceId,
        ...details,
        httpStatus: response.status,
        phase: 'transport_request',
        status: 'PASS'
      });
      return response;
    } catch (error) {
      await emitBrowserDiagnostic({ traceId, ...transportErrorDetails(error, details), status: 'FAIL' });
      throw error;
    }
  }

  return Object.freeze({
    providerId: PROVIDER_ID,
    model: MODEL_ID,
    supportsDiarization: true,
    isDeterministicFixture: false,
    describe,
    probeCapability,
    async transcribeChunk(request = {}) {
      const chunk = request.chunk || {};
      const bytes = chunk.bytes instanceof Uint8Array ? chunk.bytes : new Uint8Array(chunk.bytes || []);
      if (!bytes.byteLength) throw codedError('TRANSCRIPTION_AUDIO_EMPTY');
      const binary = createBinaryBody(bytes);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'X-Meeting-Id': required(request.meetingId, 'MEETING_ID_REQUIRED'),
        'X-Source-Id': required(request.sourceId, 'SOURCE_ID_REQUIRED'),
        'X-Source-Revision': String(request.sourceRevision),
        'X-Request-Id': required(request.requestId, 'TRANSCRIPTION_REQUEST_ID_REQUIRED'),
        'X-Meeting-Trace-Id': required(request.traceId || request.requestId, 'MEETING_TRACE_ID_REQUIRED'),
        'X-Transcription-Attempt': String(request.attempt || 1),
        'X-Chunk-Sequence': String(chunk.sequence),
        'X-Chunk-Start-Ms': String(chunk.startMs),
        'X-Chunk-End-Ms': String(chunk.endMs),
        'X-Chunk-Duration-Ms': String(chunk.durationMs),
        'X-Chunk-File-Name': encodeMeetingFileNameForHeader(required(chunk.fileName, 'TRANSCRIPTION_FILE_NAME_REQUIRED')),
        'X-Chunk-Mime-Type': required(chunk.mimeType, 'TRANSCRIPTION_MIME_TYPE_REQUIRED'),
        'X-Chunk-Format': required(chunk.format, 'TRANSCRIPTION_FORMAT_REQUIRED'),
        ...diarizationHeaders(request)
      };
      const response = await fetchWithTransportDiagnostics(normalizedEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: binary.body,
        signal: request.signal
      }, required(request.traceId || request.requestId, 'MEETING_TRACE_ID_REQUIRED'));
      const body = await readJson(response);
      if (!response.ok || body?.ok !== true) {
        throw codedError(body?.code || `MEETING_TRANSCRIPTION_HTTP_${response.status}`, {
          providerErrorCode: body?.providerErrorCode || null
        });
      }
      return Object.freeze({
        provider: body.provider || PROVIDER_ID,
        model: body.model || MODEL_ID,
        segments: Array.isArray(body.segments) ? body.segments : [],
        lease: body.lease || null,
        cursor: body.cursor || null,
        cleanupStatus: body.cleanupStatus || 'not_required'
      });
    },
    async transcribeSource(request = {}) {
      const source = request.source || {};
      const sourceChunks = request.sourceChunks;
      if (!sourceChunks?.[Symbol.asyncIterator]) throw codedError('TRANSCRIPTION_SOURCE_STREAM_REQUIRED');
      const assemblyId = required(request.requestId, 'TRANSCRIPTION_REQUEST_ID_REQUIRED');
      const chunkCount = Number(source.chunkCount);
      if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) throw codedError('SOURCE_ASSEMBLY_CHUNK_COUNT_INVALID');
      const sourceFileName = required(source.fileName, 'TRANSCRIPTION_FILE_NAME_REQUIRED');
      const sourceMimeType = required(source.mimeType, 'TRANSCRIPTION_MIME_TYPE_REQUIRED');
      const sourceFormat = required(source.format, 'TRANSCRIPTION_FORMAT_REQUIRED');
      let lastBody = null;
      let expectedSequence = 0;
      const modeHeaders = diarizationHeaders(request);
      function reportProgress(phase) {
        if (request.signal?.aborted) return;
        try { request.onProgress?.({ phase, completedChunks: expectedSequence, totalChunks: chunkCount }); }
        catch { /* Progress observers cannot interrupt the audio transport. */ }
      }
      reportProgress('uploading');
      for await (const input of sourceChunks) {
        const bytes = input?.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input?.bytes || []);
        if (!bytes.byteLength) throw codedError('TRANSCRIPTION_AUDIO_EMPTY');
        const binary = createBinaryBody(bytes);
        const sequence = Number(input?.sequence);
        if (!Number.isSafeInteger(sequence) || sequence !== expectedSequence) throw codedError('SOURCE_ASSEMBLY_SEQUENCE_INVALID');
        const final = sequence === chunkCount - 1;
        const headers = {
          'Content-Type': 'application/octet-stream',
          'X-Meeting-Id': required(request.meetingId, 'MEETING_ID_REQUIRED'),
          'X-Source-Id': required(request.sourceId, 'SOURCE_ID_REQUIRED'),
          'X-Source-Revision': String(request.sourceRevision),
          'X-Request-Id': assemblyId,
          'X-Meeting-Trace-Id': required(request.traceId || assemblyId, 'MEETING_TRACE_ID_REQUIRED'),
          'X-Source-Assembly-Id': assemblyId,
          'X-Transcription-Attempt': String(request.attempt || 1),
          'X-Source-Chunk-Sequence': String(sequence),
          'X-Source-Chunk-Count': String(chunkCount),
          'X-Source-Chunk-Final': final ? '1' : '0',
          'X-Source-Chunk-Id': required(input.sourceChunkId, 'SOURCE_ASSEMBLY_CHUNK_ID_REQUIRED'),
          'X-Source-Chunk-Duration-Ms': String(input.durationMs),
          'X-Source-Chunk-Byte-Length': String(bytes.byteLength),
          'X-Source-Chunk-Checksum': required(input.checksum, 'SOURCE_ASSEMBLY_CHUNK_CHECKSUM_INVALID'),
          'X-Source-File-Name': encodeMeetingFileNameForHeader(sourceFileName),
          'X-Source-Mime-Type': sourceMimeType,
          'X-Source-Format': sourceFormat,
          ...(source.containerLayout
            ? { 'X-Source-Container-Layout': required(source.containerLayout, 'SOURCE_ASSEMBLY_CONTAINER_LAYOUT_REQUIRED') }
            : {}),
          'X-Source-Byte-Length': String(source.byteLength),
          'X-Source-Duration-Ms': String(source.durationMs),
          'X-Source-Checksum': required(source.checksum, 'SOURCE_ASSEMBLY_SOURCE_CHECKSUM_INVALID'),
          ...modeHeaders
        };
        reportProgress(final ? 'recognizing' : 'uploading');
        const response = await fetchWithTransportDiagnostics(SOURCE_ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: binary.body,
          signal: request.signal
        }, required(request.traceId || assemblyId, 'MEETING_TRACE_ID_REQUIRED'));
        lastBody = await readJson(response);
        if (!response.ok || lastBody?.ok !== true) {
          throw codedError(lastBody?.code || `MEETING_TRANSCRIPTION_HTTP_${response.status}`, {
            providerErrorCode: lastBody?.providerErrorCode || null
          });
        }
        expectedSequence += 1;
        if (final) {
          if (!Array.isArray(lastBody.chunks)) throw codedError('TRANSCRIPTION_SOURCE_CHUNKS_EMPTY');
          reportProgress('saving');
          return Object.freeze({
            provider: lastBody.provider || PROVIDER_ID,
            model: lastBody.model || MODEL_ID,
            effectiveDurationMs: lastBody.effectiveDurationMs === undefined || lastBody.effectiveDurationMs === null
              ? null
              : Number(lastBody.effectiveDurationMs),
            chunks: lastBody.chunks,
            lease: lastBody.lease || null,
            cursor: lastBody.cursor || null,
            cleanupStatus: lastBody.cleanupStatus || 'not_required'
          });
        }
        reportProgress('uploading');
      }
      if (expectedSequence !== chunkCount || !lastBody) throw codedError('SOURCE_ASSEMBLY_INCOMPLETE');
      throw codedError('TRANSCRIPTION_SOURCE_CHUNKS_EMPTY');
    },
    async probeBinaryTransport({ traceId: inputTraceId, bytes: inputBytes, meetingId, sourceId, jobId } = {}) {
      const traceId = required(inputTraceId, 'MEETING_TRACE_ID_REQUIRED');
      const binary = createBinaryBody(inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes || []));
      if (binary.byteLength < BINARY_PROBE_BYTES) throw codedError('MEETING_BINARY_TRANSPORT_PROBE_TOO_SMALL');
      const response = await fetchWithTransportDiagnostics(DIAGNOSTIC_ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        mode: 'same-origin',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Meeting-Trace-Id': traceId,
          'X-Meeting-Diagnostic-Binary': '1',
          ...(meetingId ? { 'X-Meeting-Id': String(meetingId) } : {}),
          ...(sourceId ? { 'X-Source-Id': String(sourceId) } : {})
        },
        body: binary.body
      }, traceId);
      const body = await readJson(response);
      const serverReceivedBytes = Number(body?.receivedBytes);
      return Object.freeze({
        supported: true,
        httpStatus: response.status,
        success: response.ok && body?.ok === true && serverReceivedBytes === binary.byteLength,
        clientBlobSize: binary.byteLength,
        serverReceivedBytes: Number.isSafeInteger(serverReceivedBytes) ? serverReceivedBytes : null
      });
    },
    async recordDiagnostic(event = {}) {
      const traceId = required(event.traceId, 'MEETING_TRACE_ID_REQUIRED');
      return postDiagnostic({ ...event, traceId });
    },
    async probeTransport({ traceId: inputTraceId, meetingId, sourceId, jobId } = {}) {
      const traceId = required(inputTraceId, 'MEETING_TRACE_ID_REQUIRED');
      const endpoint = '/healthz';
      const options = { method: 'GET', credentials: 'include', mode: 'same-origin' };
      const details = requestDetails(endpoint, options);
      let getResult;
      try {
        const response = await fetchImpl(endpoint, options);
        getResult = { status: response.status, success: response.ok };
      } catch (error) {
        getResult = { status: null, success: false, error: transportErrorDetails(error, details) };
      }
      await postDiagnostic({
        traceId,
        meetingId,
        sourceId,
        jobId,
        ...details,
        phase: 'transport_probe',
        probeMethod: 'GET',
        probeStatus: getResult.status,
        probeSuccess: getResult.success,
        ...(getResult.error || {}),
        status: getResult.success ? 'PASS' : 'FAIL'
      });
      const postSuccess = await postDiagnostic({
        traceId,
        meetingId,
        sourceId,
        jobId,
        phase: 'transport_probe',
        probeMethod: 'POST',
        probeStatus: 200,
        probeSuccess: true,
        status: 'PASS'
      });
      return Object.freeze({ get: Object.freeze(getResult), post: Object.freeze({ success: postSuccess }) });
    }
  });
}
