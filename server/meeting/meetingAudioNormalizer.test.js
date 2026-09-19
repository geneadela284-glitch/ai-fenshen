import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MEETING_AUDIO_NORMALIZATION_FAILED,
  TRANSCRIPTION_CANCELLED,
  cleanupOrphanedNormalizationTemps,
  createMeetingAudioNormalizer
} from './meetingAudioNormalizer.js';

function wavBytes({ channels = 1, sampleRate = 16_000, bitsPerSample = 16, durationMs = 10 } = {}) {
  const frameCount = Math.max(1, Math.round(sampleRate * durationMs / 1000));
  const data = Buffer.alloc(frameCount * channels * (bitsPerSample / 8), 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function spawnThatWritesWav(outputBytes = wavBytes(), calls = []) {
  return (_command, args) => {
    calls.push({ command: _command, args: [...args] });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    queueMicrotask(async () => {
      await writeFile(args.at(-1), outputBytes, { mode: 0o600 });
      child.emit('close', 0, null);
    });
    return child;
  };
}

function mp4Box(type, payload = Buffer.alloc(0)) {
  const value = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const result = Buffer.alloc(8 + value.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, 'ascii');
  value.copy(result, 8);
  return result;
}

function mp4FullBox(type, payload = Buffer.alloc(0)) {
  return mp4Box(type, Buffer.concat([Buffer.alloc(4), Buffer.from(payload)]));
}

function fragmentedMp4Bytes() {
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(48_000, 8);
  const mfhd = Buffer.alloc(4);
  mfhd.writeUInt32BE(1, 0);
  const tfdt = Buffer.alloc(4);
  tfdt.writeUInt32BE(0, 0);
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d])),
    mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4FullBox('mdhd', mdhd)))),
    mp4Box('moof', Buffer.concat([mp4FullBox('mfhd', mfhd), mp4Box('traf', mp4FullBox('tfdt', tfdt))])),
    mp4Box('mdat', Buffer.from([0x01, 0x02, 0x03]))
  ]);
}

async function createTempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'meeting-normalizer-test-'));
}

test('normalizes WebM/Opus to a validated 16kHz 16-bit mono WAV and removes temp files', async () => {
  const tempRoot = await createTempRoot();
  const output = wavBytes();
  try {
    const normalizer = createMeetingAudioNormalizer({
      tempRoot,
      spawnImpl: spawnThatWritesWav(output)
    });
    const result = await normalizer.normalizeChunk({
      bytes: Buffer.from('complete-webm-container'),
      fileName: 'iphone-recording.webm',
      mimeType: 'audio/webm;codecs=opus',
      format: 'webm-opus'
    });

    assert.equal(result.format, 'wav');
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.fileName, 'iphone-recording.wav');
    assert.deepEqual(Buffer.from(result.bytes), output);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('normalization rejects invalid WAV output and leaves no temporary files', async () => {
  const tempRoot = await createTempRoot();
  try {
    const normalizer = createMeetingAudioNormalizer({
      tempRoot,
      spawnImpl: spawnThatWritesWav(wavBytes({ channels: 2 }))
    });
    await assert.rejects(
      normalizer.normalizeChunk({
        bytes: Buffer.from('complete-webm-container'),
        fileName: 'iphone-recording.webm',
        mimeType: 'audio/webm;codecs=opus'
      }),
      (error) => error.code === MEETING_AUDIO_NORMALIZATION_FAILED
    );
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('ffmpeg failure is fail-closed and never leaves a temporary file', async () => {
  const tempRoot = await createTempRoot();
  try {
    const normalizer = createMeetingAudioNormalizer({
      tempRoot,
      spawnImpl: (_command, _args) => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit('close', 1, null));
        return child;
      }
    });
    await assert.rejects(
      normalizer.normalizeChunk({
        bytes: Buffer.from('complete-webm-container'),
        fileName: 'iphone-recording.webm',
        mimeType: 'audio/webm;codecs=opus',
        format: 'webm-opus'
      }),
      (error) => error.code === MEETING_AUDIO_NORMALIZATION_FAILED
    );
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('cancellation removes temporary files and does not become a provider failure', async () => {
  const tempRoot = await createTempRoot();
  const controller = new AbortController();
  try {
    const normalizer = createMeetingAudioNormalizer({
      tempRoot,
      spawnImpl: (_command, _args) => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return child;
      }
    });
    const pending = normalizer.normalizeChunk({
      bytes: Buffer.from('complete-webm-container'),
      fileName: 'iphone-recording.webm',
      mimeType: 'audio/webm;codecs=opus',
      format: 'webm-opus',
      signal: controller.signal
    });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === TRANSCRIPTION_CANCELLED);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('orphan cleanup only removes the normalizer-owned temporary prefix', async () => {
  const tempRoot = await createTempRoot();
  const orphan = path.join(tempRoot, 'meeting-asr-normalize-orphan');
  const unrelated = path.join(tempRoot, 'unrelated');
  try {
    await mkdtemp(`${orphan}-`);
    await mkdtemp(`${unrelated}-`);
    cleanupOrphanedNormalizationTemps({ root: tempRoot });
    const remaining = await readdir(tempRoot);
    assert.equal(remaining.some((name) => name.startsWith('meeting-asr-normalize-')), false);
    assert.equal(remaining.some((name) => name.startsWith('unrelated-')), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('normalizes one continuous WebM source once and cuts validated PCM windows', async () => {
  const tempRoot = await createTempRoot();
  const inputPath = path.join(tempRoot, 'continuous-iphone.webm');
  try {
    await writeFile(inputPath, Buffer.from('continuous-media-recorder-stream'), { mode: 0o600 });
    const normalizer = createMeetingAudioNormalizer({
      tempRoot,
      spawnImpl: spawnThatWritesWav(wavBytes({ durationMs: 100_000 }))
    });

    const normalized = await normalizer.normalizeSourceFile({
      inputPath,
      fileName: 'continuous-iphone.webm',
      mimeType: 'audio/webm;codecs=opus',
      format: 'webm-opus'
    });
    assert.equal(normalized.format, 'wav');
    assert.equal(normalized.metadata.sampleRate, 16_000);
    assert.equal(normalized.metadata.channels, 1);
    assert.equal(normalized.metadata.bitsPerSample, 16);
    assert.equal(normalized.metadata.durationMs, 100_000);

    const windows = await normalizer.splitWavFile({
      normalized,
      maxChunkDurationMs: 60_000,
      overlapMs: 0
    });
    assert.deepEqual(windows.map((window) => [window.sequence, window.startMs, window.endMs]), [
      [0, 0, 60_000],
      [1, 60_000, 100_000]
    ]);
    assert.deepEqual(windows.map((window) => window.metadata.durationMs), [60_000, 40_000]);
    assert.equal(windows.every((window) => window.metadata.sampleRate === 16_000), true);
    assert.equal(windows.every((window) => window.metadata.channels === 1), true);
    assert.equal(windows.every((window) => window.metadata.bitsPerSample === 16), true);
    await normalized.cleanup();
    assert.deepEqual((await readdir(tempRoot)).filter((name) => name !== 'continuous-iphone.webm'), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('normalizes a complete AAC/MP4 chunk through ffmpeg instead of sending container bytes unchanged', async () => {
  const tempRoot = await createTempRoot();
  const calls = [];
  try {
    const normalizer = createMeetingAudioNormalizer({
      tempRoot,
      spawnImpl: spawnThatWritesWav(wavBytes(), calls)
    });
    const result = await normalizer.normalizeChunk({
      bytes: fragmentedMp4Bytes(),
      fileName: 'iphone-recording.m4a',
      mimeType: 'audio/mp4;codecs=mp4a.40.2',
      format: 'm4a'
    });
    assert.equal(result.format, 'wav');
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.normalized, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[calls[0].args.indexOf('-i') + 1].endsWith('input.m4a'), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('normalizes a continuous AAC/MP4 source once before PCM windowing', async () => {
  const tempRoot = await createTempRoot();
  const inputPath = path.join(tempRoot, 'continuous-iphone.m4a');
  const calls = [];
  try {
    await writeFile(inputPath, fragmentedMp4Bytes(), { mode: 0o600 });
    const normalizer = createMeetingAudioNormalizer({
      tempRoot,
      spawnImpl: spawnThatWritesWav(wavBytes({ durationMs: 20_000 }), calls)
    });
    const normalized = await normalizer.normalizeSourceFile({
      inputPath,
      fileName: 'continuous-iphone.m4a',
      mimeType: 'audio/mp4;codecs=mp4a.40.2',
      format: 'm4a'
    });
    assert.equal(normalized.format, 'wav');
    assert.equal(normalized.normalized, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[calls[0].args.indexOf('-i') + 1], inputPath);
    await normalized.cleanup();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('distributes a decoded duration remainder instead of creating an ultra-short final provider window', async () => {
  const tempRoot = await createTempRoot();
  const inputPath = path.join(tempRoot, 'continuous-iphone-tail.webm');
  try {
    await writeFile(inputPath, Buffer.from('continuous-media-recorder-stream'), { mode: 0o600 });
    const normalizer = createMeetingAudioNormalizer({
      tempRoot,
      spawnImpl: spawnThatWritesWav(wavBytes({ durationMs: 120_105 }))
    });

    const normalized = await normalizer.normalizeSourceFile({
      inputPath,
      fileName: 'continuous-iphone-tail.webm',
      mimeType: 'audio/webm;codecs=opus',
      format: 'webm-opus'
    });
    const windows = await normalizer.splitWavFile({
      normalized,
      maxChunkDurationMs: 60_000,
      overlapMs: 0
    });

    assert.deepEqual(windows.map((window) => [window.sequence, window.startMs, window.endMs]), [
      [0, 0, 40_035],
      [1, 40_035, 80_070],
      [2, 80_070, 120_105]
    ]);
    assert.deepEqual(windows.map((window) => window.metadata.durationMs), [40_035, 40_035, 40_035]);
    assert.equal(windows.every((window) => window.durationMs > 1_000 && window.durationMs <= 60_000), true);
    await normalized.cleanup();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
