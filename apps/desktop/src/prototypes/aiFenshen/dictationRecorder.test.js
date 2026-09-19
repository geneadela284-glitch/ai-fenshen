import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DICTATION_AUDIO_FORMAT,
  DICTATION_SAMPLE_RATE,
  createDictationRecorder,
  downsampleMonoFloat32,
  encodePcm16Wav
} from './dictationRecorder.js';

test('downsamples mono audio and emits a canonical 16kHz 16-bit WAV', () => {
  const input = Float32Array.from({ length: 48_000 }, (_, index) => (index % 20) / 20 - 0.5);
  const downsampled = downsampleMonoFloat32(input, 48_000);
  assert.equal(downsampled.length, 16_000);
  const wav = encodePcm16Wav(downsampled);
  const view = new DataView(wav);
  assert.equal(new TextDecoder().decode(new Uint8Array(wav.slice(0, 4))), 'RIFF');
  assert.equal(new TextDecoder().decode(new Uint8Array(wav.slice(8, 12))), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), DICTATION_SAMPLE_RATE);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(wav.byteLength, 44 + (16_000 * 2));
});

test('records from AudioContext input without MediaRecorder containers', async () => {
  const states = [];
  const ready = [];
  let processor;
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = {};
    async resume() {}
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      return processor;
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    async close() {}
  }
  const stream = { getTracks: () => [{ stop() {} }] };
  const recorder = createDictationRecorder({
    mediaDevices: { getUserMedia: async () => stream },
    AudioContextClass: FakeAudioContext,
    onStateChange: (state) => states.push(state),
    onAudioReady: (value) => ready.push(value)
  });
  await recorder.start();
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(48_000).fill(0.2) } });
  assert.equal(recorder.stop(), true);
  assert.deepEqual(states.slice(0, 3), ['requesting_permission', 'recording', 'processing']);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].format, DICTATION_AUDIO_FORMAT);
  assert.equal(ready[0].sampleRate, 16_000);
  assert.equal(ready[0].channels, 1);
  assert.equal(ready[0].bitsPerSample, 16);
  assert.equal(ready[0].blob.type, DICTATION_AUDIO_FORMAT);
});

test('reports recording duration and input level while audio is being captured', async () => {
  const progress = [];
  let processor;
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = {};
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      return processor;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  const recorder = createDictationRecorder({
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    AudioContextClass: FakeAudioContext,
    onProgress: (value) => progress.push(value)
  });
  try {
    await recorder.start();
    processor.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.4) }
    });
    assert.equal(progress.at(-1).durationMs, 100);
    assert.ok(progress.at(-1).level > 0);
  } finally {
    recorder.cancel();
  }
});

test('maps microphone permission denial and cancel to explicit failure states', async () => {
  const states = [];
  const recorder = createDictationRecorder({
    mediaDevices: {
      getUserMedia: async () => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); }
    },
    AudioContextClass: class FakeAudioContext {}
  , onStateChange: (state) => states.push(state)
  });
  await recorder.start();
  assert.equal(states.at(-1), 'permission_denied');

  const cancelled = [];
  const other = createDictationRecorder({
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    AudioContextClass: class FakeAudioContext {},
    onStateChange: (state) => cancelled.push(state)
  });
  other.cancel();
  assert.equal(cancelled.at(-1), 'cancelled');
});

test('cancelling active recording stops every track, emits no audio, and can repeat three times', async () => {
  let processor;
  let readyCalls = 0;
  let stoppedTracks = 0;
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = {};
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      return processor;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() {}
  }
  const recorder = createDictationRecorder({
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() { stoppedTracks += 1; } }, { stop() { stoppedTracks += 1; } }] })
    },
    AudioContextClass: FakeAudioContext,
    onAudioReady: () => { readyCalls += 1; }
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await recorder.start();
    processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4_800).fill(0.2) } });
    assert.equal(recorder.cancel(), true);
    assert.equal(recorder.state, 'cancelled');
    assert.equal(recorder.active, false);
  }

  assert.equal(stoppedTracks, 6);
  assert.equal(readyCalls, 0);
});
