export const DICTATION_ENDPOINT = '/api/voice/dictation';

function clientError(code, message) {
  return Object.assign(new Error(message || '语音转写失败，请重试。'), { code });
}

async function defaultHashAudio(audioBlob) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw clientError('AUDIO_INVALID', '当前设备不支持音频校验。');
  const digest = await subtle.digest('SHA-256', await audioBlob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export function createDictationClient({
  fetchImpl = globalThis.fetch,
  hashAudio = defaultHashAudio,
  endpoint = DICTATION_ENDPOINT
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  return Object.freeze({
    async transcribe({ audioBlob, requestId, durationMs, signal } = {}) {
      if (!(audioBlob instanceof Blob) || audioBlob.size === 0) throw clientError('AUDIO_EMPTY', '没有录到声音，请重试。');
      if (audioBlob.type && audioBlob.type !== 'audio/wav' && audioBlob.type !== 'audio/x-wav') {
        throw clientError('AUDIO_INVALID', '录音格式无效，请重试。');
      }
      const normalizedRequestId = String(requestId || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(normalizedRequestId)) {
        throw clientError('VOICE_REQUEST_INVALID', '语音请求无效，请重试。');
      }
      const normalizedDuration = Number(durationMs);
      if (!Number.isFinite(normalizedDuration) || normalizedDuration <= 0) {
        throw clientError('AUDIO_INVALID', '录音时长无效，请重试。');
      }
      const audioHash = await hashAudio(audioBlob);
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'audio/wav',
          'X-Voice-Request-Id': normalizedRequestId,
          'X-Voice-Audio-Hash': audioHash,
          'X-Voice-Format': 'audio/wav',
          'X-Voice-Sample-Rate': '16000',
          'X-Voice-Duration-Ms': String(Math.round(normalizedDuration))
        },
        body: audioBlob,
        signal
      });
      const payload = await readJson(response);
      if (!response.ok || payload.ok !== true) {
        throw clientError(
          payload.errorCode || payload.code || 'TRANSCRIPTION_FAILED',
          payload.message || '语音转写失败，请重试。'
        );
      }
      return payload;
    }
  });
}

export { defaultHashAudio };
