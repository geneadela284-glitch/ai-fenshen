import assert from 'node:assert/strict';
import test from 'node:test';
import { createDictationClient } from './dictationClient.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('uploads canonical WAV with request metadata and Session credentials only', async () => {
  const calls = [];
  const client = createDictationClient({
    hashAudio: async () => 'a'.repeat(64),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        ok: true,
        requestId: 'dictation-request-0001',
        transcript: 'AI分身今天收入5000元',
        durationMs: 1_000,
        latencyMs: 30,
        providerId: 'local_whisper_cpp',
        cleanupStatus: 'cleaned',
        autoSend: false,
        errorCode: null
      });
    }
  });
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
  const result = await client.transcribe({
    audioBlob: audio,
    requestId: 'dictation-request-0001',
    durationMs: 1_000
  });
  assert.equal(result.autoSend, false);
  assert.equal(calls[0].url, '/api/voice/dictation');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers['X-Voice-Audio-Hash'], 'a'.repeat(64));
  assert.equal(calls[0].options.headers['X-Voice-Format'], 'audio/wav');
  assert.equal(calls[0].options.headers['X-Voice-Sample-Rate'], '16000');
  assert.equal(calls[0].options.headers['X-Voice-Duration-Ms'], '1000');
  assert.equal(Object.keys(calls[0].options.headers).some((key) => /owner|user|provider|model|path/i.test(key)), false);
});

test('does not expose provider or path details from an error response', async () => {
  const client = createDictationClient({
    hashAudio: async () => 'b'.repeat(64),
    fetchImpl: async () => jsonResponse({
      ok: false,
      errorCode: 'TRANSCRIPTION_FAILED',
      message: '语音转写失败，请重试。',
      provider: 'local_whisper_cpp',
      path: '/opt/whisper.cpp/models/private.bin'
    }, 502)
  });
  await assert.rejects(
    client.transcribe({
      audioBlob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
      requestId: 'dictation-request-0001',
      durationMs: 1_000
    }),
    (error) => {
      assert.equal(error.code, 'TRANSCRIPTION_FAILED');
      assert.equal(error.message, '语音转写失败，请重试。');
      assert.doesNotMatch(error.message, /provider|whisper|opt|path/i);
      return true;
    }
  );
});
