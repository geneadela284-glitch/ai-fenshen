import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLearningAudio, SpeechGateway } from './speech.js';
import { encodePcm16Wav } from '../../apps/desktop/src/prototypes/aiFenshen/dictationRecorder.js';

function wav(seconds = 1, silent = false) {
  return Buffer.from(encodePcm16Wav(Float32Array.from({ length: seconds * 16000 }, (_, i) => silent ? 0 : Math.sin(i / 8) * 0.2)));
}
test('learning accepts longer spoken turns but rejects silence, corrupted audio and false duration metadata', () => {
  assert.equal(validateLearningAudio(wav(31)).durationMs, 31000);
  assert.throws(() => validateLearningAudio(wav(1, true)), { code: 'AUDIO_SILENT' });
  assert.throws(() => validateLearningAudio(Buffer.from('not an audio')), { code: 'AUDIO_INVALID' });
  assert.throws(() => validateLearningAudio(wav(121)), { code: 'AUDIO_TOO_LONG' });
});
test('cancellation rejects immediately but retains the slot until the underlying operation settles', async () => {
  let complete;
  const gateway = new SpeechGateway({ transcribe: () => new Promise(resolve => { complete = resolve; }), synthesize: async () => wav() });
  const c = new AbortController();
  const p = gateway.run({ capability: 'SPEECH_TO_TEXT', input: wav() }, { ownerId: 'owner-a', signal: c.signal });
  await new Promise(resolve => setImmediate(resolve));
  c.abort();
  await assert.rejects(p, { code: 'CANCELLED' });
  await assert.rejects(gateway.run({ capability: 'TEXT_TO_SPEECH', input: 'Hello' }, { ownerId: 'owner-b' }), { code: 'LEARNING_SPEECH_BUSY' });
  complete({ transcript: 'Hello' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok((await gateway.run({ capability: 'TEXT_TO_SPEECH', input: 'Hello' }, { ownerId: 'owner-b' })).audio.length > 44);
  assert.throws(() => gateway.assertOwner({}), { code: 'AUTH_REQUIRED' });
});
test('synthesis does not report a zero-frame wav as successful speech', async () => {
  const gateway = new SpeechGateway({ transcribe: async () => ({ transcript: 'Hello' }), synthesize: async () => Buffer.alloc(44) });
  await assert.rejects(gateway.run({ capability: 'TEXT_TO_SPEECH', input: 'Hello', language: 'en' }, { ownerId: 'owner-a' }), { code: 'AUDIO_INVALID' });
});
