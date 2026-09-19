import { AI_CAPABILITIES } from '../../aiGateway/protocol/capability.js';

export const MEETING_TRANSCRIPTION_CAPABILITY = AI_CAPABILITIES.includes('meeting_transcription')
  ? 'meeting_transcription'
  : 'meeting_transcription';

function codedError(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function positiveInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw codedError(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw codedError(code);
  return normalized;
}

function normalizeSegment(raw, chunk) {
  const relativeStartMs = Number(raw?.startMs ?? 0);
  const relativeEndMs = Number(raw?.endMs ?? chunk.durationMs ?? (Number(chunk.endMs) - Number(chunk.startMs)));
  if (!Number.isSafeInteger(relativeStartMs) || !Number.isSafeInteger(relativeEndMs) || relativeStartMs < 0 || relativeEndMs <= relativeStartMs) throw codedError('TRANSCRIPT_PROVIDER_TIMESTAMP_INVALID');
  if (relativeEndMs > Number(chunk.endMs) - Number(chunk.startMs)) throw codedError('TRANSCRIPT_PROVIDER_TIMESTAMP_OUT_OF_BOUNDS');
  const text = String(raw?.text ?? '').trim();
  if (!text) throw codedError('TRANSCRIPT_PROVIDER_TEXT_EMPTY');
  const confidence = raw?.confidence === undefined || raw?.confidence === null ? null : Number(raw.confidence);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw codedError('TRANSCRIPT_PROVIDER_CONFIDENCE_INVALID');
  return Object.freeze({
    startMs: relativeStartMs,
    endMs: relativeEndMs,
    text,
    confidence,
    speakerRef: null,
    sourceChunkRefs: [...new Set([...(chunk.sourceChunkRefs || []), ...(raw?.sourceChunkRefs || [])].map((value) => String(value || '').trim()).filter(Boolean))]
  });
}

function transcriptionMode(request = {}) {
  const mode = String(request?.mode || 'transcription').trim() || 'transcription';
  if (!['transcription', 'diarization'].includes(mode)) throw codedError('MEETING_TRANSCRIPTION_MODE_INVALID');
  if (mode === 'transcription') return Object.freeze({ mode, speakerCount: 0 });
  const speakerCount = Number(request?.speakerCount ?? 0);
  if (!(speakerCount === 0 || [2, 3, 4].includes(speakerCount))) throw codedError('DIARIZATION_SPEAKER_COUNT_INVALID');
  return Object.freeze({ mode, speakerCount });
}

function normalizeDiarizationSegment(raw, chunk) {
  const relativeStartMs = Number(raw?.startMs ?? 0);
  const relativeEndMs = Number(raw?.endMs ?? chunk.durationMs ?? (Number(chunk.endMs) - Number(chunk.startMs)));
  if (!Number.isSafeInteger(relativeStartMs) || !Number.isSafeInteger(relativeEndMs) || relativeStartMs < 0 || relativeEndMs <= relativeStartMs) throw codedError('DIARIZATION_PROVIDER_TIMESTAMP_INVALID');
  if (relativeEndMs > Number(chunk.endMs) - Number(chunk.startMs)) throw codedError('DIARIZATION_PROVIDER_TIMESTAMP_OUT_OF_BOUNDS');
  const text = String(raw?.text ?? '').trim();
  if (!text) throw codedError('DIARIZATION_PROVIDER_TEXT_EMPTY');
  const confidence = raw?.confidence === undefined || raw?.confidence === null ? null : Number(raw.confidence);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw codedError('DIARIZATION_PROVIDER_CONFIDENCE_INVALID');
  const providerRole = raw?.providerRole === undefined || raw?.providerRole === null || raw?.providerRole === ''
    ? null
    : Number(raw.providerRole);
  if (providerRole !== null && (!Number.isSafeInteger(providerRole) || providerRole < 1)) throw codedError('DIARIZATION_PROVIDER_ROLE_INVALID');
  return Object.freeze({
    startMs: relativeStartMs,
    endMs: relativeEndMs,
    text,
    confidence,
    providerRole,
    sourceChunkRefs: [...new Set([...(chunk.sourceChunkRefs || []), ...(raw?.sourceChunkRefs || [])].map((value) => String(value || '').trim()).filter(Boolean))]
  });
}

function requestFields(request) {
  return Object.freeze({
    ownerId: required(request?.ownerId, 'OWNER_REQUIRED'),
    meetingId: required(request?.meetingId, 'MEETING_ID_REQUIRED'),
    sourceId: required(request?.sourceId, 'SOURCE_ID_REQUIRED'),
    sourceRevision: positiveInteger(request?.sourceRevision, 'TRANSCRIPTION_SOURCE_REVISION_INVALID'),
    requestId: required(request?.requestId, 'TRANSCRIPTION_REQUEST_ID_REQUIRED'),
    attempt: positiveInteger(request?.attempt || 1, 'TRANSCRIPTION_ATTEMPT_INVALID')
  });
}

function normalizeSourceChunk(raw, sourceDurationMs, { diarizationMode = false } = {}) {
  const sequence = nonNegativeInteger(raw?.sequence, 'TRANSCRIPTION_SOURCE_CHUNK_SEQUENCE_INVALID');
  const startMs = nonNegativeInteger(raw?.startMs, 'TRANSCRIPTION_SOURCE_CHUNK_START_INVALID');
  const endMs = positiveInteger(raw?.endMs, 'TRANSCRIPTION_SOURCE_CHUNK_END_INVALID');
  if (endMs <= startMs) throw codedError('TRANSCRIPTION_SOURCE_CHUNK_TIMELINE_INVALID');
  if (sourceDurationMs !== null && endMs > sourceDurationMs) throw codedError('TRANSCRIPTION_SOURCE_CHUNK_OUT_OF_BOUNDS');
  const chunk = Object.freeze({
    sequence,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    sourceChunkRefs: [...new Set((Array.isArray(raw?.sourceChunkRefs) ? raw.sourceChunkRefs : []).map((value) => String(value || '').trim()).filter(Boolean))]
  });
  const segments = (Array.isArray(raw?.segments) ? raw.segments : []).map((segment) => diarizationMode
    ? normalizeDiarizationSegment(segment, chunk)
    : normalizeSegment(segment, chunk));
  return Object.freeze({ ...chunk, segments });
}

export function createMeetingSpeechGateway({ provider = null } = {}) {
  const available = Boolean(provider && (typeof provider.transcribeChunk === 'function' || typeof provider.transcribeSource === 'function'));
  const sourceAvailable = Boolean(provider && typeof provider.transcribeSource === 'function');
  const diarizationAvailable = Boolean(sourceAvailable && provider?.supportsDiarization === true);
  const providerId = String(provider?.providerId || '').trim();
  const model = String(provider?.model || '').trim();
  const localDescription = Object.freeze({
    capability: MEETING_TRANSCRIPTION_CAPABILITY,
    available,
    sourceAvailable,
    diarizationAvailable,
    providerId: providerId || null,
    model: model || null,
    realProvider: available && provider?.isDeterministicFixture !== true,
    deterministicFixture: provider?.isDeterministicFixture === true,
    status: available ? 'available' : 'blocked'
  });

  function describe() {
    if (typeof provider?.describe !== 'function') return localDescription;
    try {
      const runtime = provider.describe();
      if (!runtime || typeof runtime !== 'object') return localDescription;
      return Object.freeze({
        ...localDescription,
        available: runtime.available === undefined ? available : runtime.available === true,
        sourceAvailable: runtime.sourceAvailable === undefined ? sourceAvailable : runtime.sourceAvailable === true,
        diarizationAvailable: runtime.diarizationAvailable === undefined ? diarizationAvailable : runtime.diarizationAvailable === true,
        realProvider: runtime.realProvider === undefined ? localDescription.realProvider : runtime.realProvider === true,
        deterministicFixture: runtime.deterministicFixture === undefined ? localDescription.deterministicFixture : runtime.deterministicFixture === true,
        status: typeof runtime.status === 'string' && runtime.status.trim()
          ? runtime.status.trim()
          : (runtime.available === true ? 'available' : 'blocked')
      });
    } catch {
      return Object.freeze({
        ...localDescription,
        available: false,
        sourceAvailable: false,
        diarizationAvailable: false,
        status: 'blocked'
      });
    }
  }

  return Object.freeze({
    capability: MEETING_TRANSCRIPTION_CAPABILITY,
    describe,
    async probeCapability() {
      if (typeof provider?.probeCapability !== 'function') return describe();
      await provider.probeCapability();
      return describe();
    },
    async recordDiagnostic(event = {}) {
      if (typeof provider?.recordDiagnostic !== 'function') return Object.freeze({ recorded: false });
      await provider.recordDiagnostic(event);
      return Object.freeze({ recorded: true });
    },
    async probeTransport(request = {}) {
      if (typeof provider?.probeTransport !== 'function') return Object.freeze({ supported: false });
      return provider.probeTransport(request);
    },
    async probeBinaryTransport(request = {}) {
      if (typeof provider?.probeBinaryTransport !== 'function') return Object.freeze({ supported: false });
      return provider.probeBinaryTransport(request);
    },
    supportsBinaryTransportProbe() {
      return typeof provider?.probeBinaryTransport === 'function';
    },
    async transcribeChunk(request = {}) {
      if (!describe().available) throw codedError('REAL_MEETING_ASR_PROVIDER_BLOCKED');
      if (typeof provider?.transcribeChunk !== 'function') throw codedError('MEETING_TRANSCRIPTION_CHUNK_UNSUPPORTED');
      const fields = requestFields(request);
      const options = transcriptionMode(request);
      if (options.mode === 'diarization' && provider?.supportsDiarization !== true) throw codedError('STAGE3B_REAL_DIARIZATION_PROVIDER_BLOCKED');
      if (!request.chunk || !Number.isSafeInteger(Number(request.chunk.sequence)) || Number(request.chunk.sequence) < 0) throw codedError('TRANSCRIPTION_CHUNK_INVALID');
      const raw = await provider.transcribeChunk({ ...request, ...fields, ...(options.mode === 'diarization' ? options : {}) });
      const segments = (Array.isArray(raw?.segments) ? raw.segments : []).map((segment) => options.mode === 'diarization'
        ? normalizeDiarizationSegment(segment, request.chunk)
        : normalizeSegment(segment, request.chunk));
      return Object.freeze({
        ...fields,
        ...(options.mode === 'diarization' ? { mode: options.mode, speakerCount: options.speakerCount } : {}),
        chunkSequence: nonNegativeInteger(request.chunk.sequence, 'TRANSCRIPTION_CHUNK_SEQUENCE_INVALID'),
        lease: raw?.lease || null,
        cursor: raw?.cursor || null,
        cleanupStatus: raw?.cleanupStatus || 'not_required',
        provider: String(raw?.provider || providerId || 'unknown'),
        model: String(raw?.model || model || 'unknown'),
        segments,
        isDeterministicFixture: provider?.isDeterministicFixture === true
      });
    },
    async transcribeSource(request = {}) {
      const capability = describe();
      if (!capability.available) throw codedError('REAL_MEETING_ASR_PROVIDER_BLOCKED');
      if (typeof provider?.transcribeSource !== 'function') throw codedError('MEETING_TRANSCRIPTION_SOURCE_UNSUPPORTED');
      const fields = requestFields(request);
      const options = transcriptionMode(request);
      if (options.mode === 'diarization' && !capability.diarizationAvailable) throw codedError('STAGE3B_REAL_DIARIZATION_PROVIDER_BLOCKED');
      const sourceDurationMs = request?.source?.durationMs === undefined || request?.source?.durationMs === null
        ? null
        : positiveInteger(request.source.durationMs, 'TRANSCRIPTION_SOURCE_DURATION_INVALID');
      const raw = await provider.transcribeSource({ ...request, ...fields, ...(options.mode === 'diarization' ? options : {}) });
      const rawChunks = Array.isArray(raw?.chunks) ? raw.chunks : [];
      if (!rawChunks.length) throw codedError('TRANSCRIPTION_SOURCE_CHUNKS_EMPTY');
      const effectiveDurationMs = raw?.effectiveDurationMs === undefined || raw?.effectiveDurationMs === null
        ? sourceDurationMs
        : positiveInteger(raw.effectiveDurationMs, 'TRANSCRIPTION_SOURCE_DURATION_INVALID');
      const chunks = rawChunks.map((chunk) => normalizeSourceChunk(chunk, effectiveDurationMs, { diarizationMode: options.mode === 'diarization' }));
      for (let index = 0; index < chunks.length; index += 1) {
        if (chunks[index].sequence !== index) throw codedError('TRANSCRIPTION_SOURCE_CHUNK_OUT_OF_ORDER');
        if (index > 0 && chunks[index].startMs < chunks[index - 1].endMs) throw codedError('TRANSCRIPTION_SOURCE_CHUNK_OVERLAP_INVALID');
      }
      return Object.freeze({
        ...fields,
        ...(options.mode === 'diarization' ? { mode: options.mode, speakerCount: options.speakerCount } : {}),
        provider: String(raw?.provider || providerId || 'unknown'),
        model: String(raw?.model || model || 'unknown'),
        effectiveDurationMs,
        chunks,
        lease: raw?.lease || null,
        cursor: raw?.cursor || null,
        cleanupStatus: raw?.cleanupStatus || 'not_required',
        isDeterministicFixture: provider?.isDeterministicFixture === true
      });
    }
  });
}

export function createDeterministicFixtureProvider({ text = '确定性会议测试内容。', script = null } = {}) {
  return Object.freeze({
    providerId: 'deterministic-fixture',
    model: 'fixture-v1',
    isDeterministicFixture: true,
    async transcribeChunk(request) {
      const value = typeof script === 'function' ? await script(request) : null;
      const segments = Array.isArray(value) ? value : [{ startMs: 0, endMs: Number(request.chunk.endMs) - Number(request.chunk.startMs), text }];
      return Object.freeze({
        provider: 'deterministic-fixture',
        model: 'fixture-v1',
        segments
      });
    }
  });
}

export { codedError };
