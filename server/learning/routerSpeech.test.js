import test from 'node:test';
import assert from 'node:assert/strict';
import { AIRouter } from '../../core/router/AIRouter.js';
import { SpeechGateway } from './speech.js';
import { encodePcm16Wav } from '../../apps/desktop/src/prototypes/aiFenshen/dictationRecorder.js';

test('speech capability goes through AIRouter and requires a server authenticated owner', async () => {
  const audio = Buffer.from(encodePcm16Wav(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 10) * .1)));
  const speechRuntime = new SpeechGateway({ transcribe: async () => ({ transcript: 'Hello' }), synthesize: async () => audio });
  const router = new AIRouter({ speechRuntime });
  const result = await router.run({ capability: 'TEXT_TO_SPEECH', input: 'Hello' }, { ownerId: 'a' });
  assert.equal(result.contentType, 'audio/wav');
  assert.deepEqual(result.audio, audio);
  await assert.rejects(router.run({ capability: 'SPEECH_TO_TEXT', input: audio }), { code: 'AUTH_REQUIRED' });
});
test('unconfigured speech does not fall through to a text model with audio bytes', async () => {
  const router = new AIRouter();
  await assert.rejects(router.run({ capability: 'TEXT_TO_SPEECH', input: 'Hello' }, { ownerId: 'a' }), { code: 'LEARNING_SPEECH_UNAVAILABLE' });
});
