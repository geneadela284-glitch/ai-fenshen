import { createHash, timingSafeEqual } from 'node:crypto';

export const DICTATION_PROVIDER_ID = 'local_whisper_cpp';
export const DICTATION_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxDurationMs: 30_000,
  timeoutMs: 45_000,
  concurrency: 1,
  maxQueueDepth: 2,
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  format: 'audio/wav'
});

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const AUDIO_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_MESSAGES = Object.freeze({
  VOICE_REQUEST_INVALID: '语音请求格式无效。',
  CLIENT_OWNER_FORBIDDEN: '语音请求不接受客户端身份。',
  AUDIO_EMPTY: '没有收到有效音频。',
  AUDIO_TOO_LARGE: '录音不能超过8MiB。',
  AUDIO_TOO_LONG: '录音不能超过30秒。',
  AUDIO_INVALID: '录音格式无效，请重新录制。',
  AUDIO_HASH_MISMATCH: '音频校验失败，请重新录制。',
  ASR_BUSY: '语音转写繁忙，请稍后重试。',
  TIMEOUT: '语音转写超时，请重试。',
  TRANSCRIPTION_FAILED: '语音转写失败，请重试。',
  ASR_ENGINE_UNAVAILABLE: '本地语音服务暂时不可用。',
  ASR_MODEL_MISSING: '本地语音服务暂时不可用。',
  CANCELLED: '语音转写已取消。'
});

export function voiceError(code, message = PUBLIC_MESSAGES[code] || '语音请求失败。') {
  return Object.assign(new Error(message), { code });
}

export function publicVoiceMessage(code) {
  return PUBLIC_MESSAGES[code] || '语音请求失败。';
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function normalizeFormat(value) {
  const normalized = String(value || '').split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'wav' || normalized === 'audio/x-wav') return DICTATION_LIMITS.format;
  if (normalized === DICTATION_LIMITS.format) return normalized;
  throw voiceError('AUDIO_INVALID');
}

function normalizeRequestId(value) {
  const normalized = String(value || '').trim();
  if (!REQUEST_ID_PATTERN.test(normalized)) throw voiceError('VOICE_REQUEST_INVALID');
  return normalized;
}

function normalizeAudioHash(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!AUDIO_HASH_PATTERN.test(normalized)) throw voiceError('VOICE_REQUEST_INVALID');
  return normalized;
}

function normalizePositiveNumber(value, code = 'VOICE_REQUEST_INVALID') {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw voiceError(code);
  return number;
}

export function sha256Hex(audioBytes) {
  const buffer = asBuffer(audioBytes);
  if (!buffer) throw voiceError('AUDIO_EMPTY');
  return createHash('sha256').update(buffer).digest('hex');
}

function equalHash(expected, actual) {
  const expectedBytes = Buffer.from(expected, 'ascii');
  const actualBytes = Buffer.from(actual, 'ascii');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function parsePcmWav(audioBytes) {
  const buffer = asBuffer(audioBytes);
  if (!buffer || buffer.length < 44) throw voiceError('AUDIO_INVALID');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw voiceError('AUDIO_INVALID');
  }

  let offset = 12;
  let formatChunk = null;
  let dataChunk = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) throw voiceError('AUDIO_INVALID');
    if (chunkId === 'fmt ' && chunkSize >= 16 && !formatChunk) {
      formatChunk = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        byteRate: buffer.readUInt32LE(chunkStart + 8),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    }
    if (chunkId === 'data' && !dataChunk) {
      dataChunk = { offset: chunkStart, byteLength: chunkSize };
    }
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!formatChunk || !dataChunk || dataChunk.byteLength === 0) throw voiceError('AUDIO_INVALID');
  const expectedByteRate = DICTATION_LIMITS.sampleRate * DICTATION_LIMITS.channels * (DICTATION_LIMITS.bitsPerSample / 8);
  const expectedBlockAlign = DICTATION_LIMITS.channels * (DICTATION_LIMITS.bitsPerSample / 8);
  if (
    formatChunk.audioFormat !== 1 ||
    formatChunk.channels !== DICTATION_LIMITS.channels ||
    formatChunk.sampleRate !== DICTATION_LIMITS.sampleRate ||
    formatChunk.bitsPerSample !== DICTATION_LIMITS.bitsPerSample ||
    formatChunk.byteRate !== expectedByteRate ||
    formatChunk.blockAlign !== expectedBlockAlign ||
    dataChunk.byteLength % expectedBlockAlign !== 0
  ) {
    throw voiceError('AUDIO_INVALID');
  }

  const durationMs = (dataChunk.byteLength / expectedByteRate) * 1_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw voiceError('AUDIO_EMPTY');
  if (durationMs > DICTATION_LIMITS.maxDurationMs) throw voiceError('AUDIO_TOO_LONG');
  return Object.freeze({
    format: DICTATION_LIMITS.format,
    sampleRate: DICTATION_LIMITS.sampleRate,
    channels: DICTATION_LIMITS.channels,
    bitsPerSample: DICTATION_LIMITS.bitsPerSample,
    durationMs,
    dataBytes: dataChunk.byteLength
  });
}

export function validateDictationRequest({
  ownerId,
  requestId,
  audioBytes,
  audioHash,
  format,
  sampleRate,
  durationMs
} = {}) {
  const trustedOwnerId = String(ownerId || '').trim();
  if (!trustedOwnerId || trustedOwnerId.length > 256) throw voiceError('VOICE_REQUEST_INVALID');
  const buffer = asBuffer(audioBytes);
  if (!buffer || buffer.length === 0) throw voiceError('AUDIO_EMPTY');
  if (buffer.length > DICTATION_LIMITS.maxBytes) throw voiceError('AUDIO_TOO_LARGE');

  const normalizedRequestId = normalizeRequestId(requestId);
  const normalizedHash = normalizeAudioHash(audioHash);
  const normalizedFormat = normalizeFormat(format);
  const normalizedSampleRate = normalizePositiveNumber(sampleRate);
  const clientDurationMs = normalizePositiveNumber(durationMs);
  const parsed = parsePcmWav(buffer);
  const actualHash = sha256Hex(buffer);
  if (!equalHash(normalizedHash, actualHash)) throw voiceError('AUDIO_HASH_MISMATCH');
  if (normalizedSampleRate !== parsed.sampleRate) throw voiceError('AUDIO_INVALID');
  if (Math.abs(clientDurationMs - parsed.durationMs) > 500) throw voiceError('AUDIO_INVALID');

  return Object.freeze({
    ownerId: trustedOwnerId,
    requestId: normalizedRequestId,
    audioBytes: buffer,
    audioHash: normalizedHash,
    format: normalizedFormat,
    sampleRate: parsed.sampleRate,
    durationMs: parsed.durationMs,
    autoSend: false
  });
}

export function isClientOwnerHeaderPresent(headers = {}) {
  return ['x-owner-id', 'owner-id', 'x-user-id', 'x-account-id'].some((name) => (
    Object.hasOwn(headers, name)
  ));
}

export function requestIdEcho(value) {
  const normalized = String(value || '').trim();
  return REQUEST_ID_PATTERN.test(normalized) ? normalized : null;
}
