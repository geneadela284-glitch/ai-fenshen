import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DICTATION_LIMITS,
  isClientOwnerHeaderPresent,
  parsePcmWav,
  sha256Hex,
  validateDictationRequest
} from './audioContract.js';

function wav({ durationMs = 1_000, sampleRate = DICTATION_LIMITS.sampleRate } = {}) {
  const bytesPerSample = 2;
  const dataBytes = Math.max(2, Math.round((sampleRate * durationMs) / 1_000) * bytesPerSample);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function validRequest(overrides = {}) {
  const audioBytes = overrides.audioBytes || wav();
  return {
    ownerId: 'acct-owner-a',
    requestId: 'dictation-request-0001',
    audioBytes,
    audioHash: sha256Hex(audioBytes),
    format: 'audio/wav',
    sampleRate: 16_000,
    durationMs: 1_000,
    ...overrides
  };
}

test('validates the exact 16kHz mono PCM WAV contract and computes duration from bytes', () => {
  const audioBytes = wav({ durationMs: 1_250 });
  const parsed = parsePcmWav(audioBytes);
  assert.equal(parsed.sampleRate, 16_000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.durationMs, 1_250);
  const result = validateDictationRequest(validRequest({ audioBytes, audioHash: sha256Hex(audioBytes), durationMs: 1_250 }));
  assert.equal(result.autoSend, false);
  assert.equal(result.ownerId, 'acct-owner-a');
  assert.equal(result.durationMs, 1_250);
});

test('rejects empty, corrupted, mismatched hash, wrong sample rate, and overlong audio', () => {
  assert.throws(() => validateDictationRequest(validRequest({ audioBytes: Buffer.alloc(0) })), { code: 'AUDIO_EMPTY' });
  assert.throws(() => validateDictationRequest(validRequest({ audioBytes: Buffer.from('not-wav'), audioHash: sha256Hex(Buffer.from('not-wav')) })), { code: 'AUDIO_INVALID' });
  assert.throws(() => validateDictationRequest(validRequest({ audioHash: 'a'.repeat(64) })), { code: 'AUDIO_HASH_MISMATCH' });
  const wrongRate = wav({ durationMs: 1_000, sampleRate: 8_000 });
  assert.throws(() => validateDictationRequest(validRequest({ audioBytes: wrongRate, audioHash: sha256Hex(wrongRate), sampleRate: 8_000 })), { code: 'AUDIO_INVALID' });
  const longAudio = wav({ durationMs: 30_001 });
  assert.throws(() => validateDictationRequest(validRequest({ audioBytes: longAudio, audioHash: sha256Hex(longAudio), durationMs: 30_001 })), { code: 'AUDIO_TOO_LONG' });
});

test('rejects client identity headers while allowing only the server-supplied owner', () => {
  assert.equal(isClientOwnerHeaderPresent({ 'x-owner-id': 'forged-owner' }), true);
  assert.equal(isClientOwnerHeaderPresent({ 'x-user-id': 'forged-owner' }), true);
  assert.equal(isClientOwnerHeaderPresent({ 'content-type': 'audio/wav' }), false);
  assert.throws(() => validateDictationRequest(validRequest({ ownerId: '' })), { code: 'VOICE_REQUEST_INVALID' });
});

test('limits the raw payload to 8MiB before parsing its WAV structure', () => {
  const audioBytes = Buffer.alloc(DICTATION_LIMITS.maxBytes + 1);
  assert.throws(() => validateDictationRequest(validRequest({ audioBytes, audioHash: sha256Hex(audioBytes) })), { code: 'AUDIO_TOO_LARGE' });
});
