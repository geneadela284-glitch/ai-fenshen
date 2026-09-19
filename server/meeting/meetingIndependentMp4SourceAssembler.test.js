import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createMeetingIndependentMp4SourceAssembler,
  MEETING_INDEPENDENT_MP4_ASSEMBLY_TEMP_PREFIX
} from './meetingIndependentMp4SourceAssembler.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function wav(pcm, { sampleRate = 16_000, channels = 1, bitsPerSample = 16, audioFormat = 1 } = {}) {
  const data = Buffer.from(pcm);
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function segments(values) {
  return values.map((bytes, sequence) => ({
    sourceChunkId: `segment-${sequence}`,
    sequence,
    durationMs: 12_000,
    bytes,
    checksum: digest(bytes)
  }));
}

function inspector(bytes) {
  return Object.freeze({
    trackFingerprint: `audio:${bytes[0]}`,
    timescale: 48_000,
    trackId: 1,
    durationMs: 12_000
  });
}

function compatible(reference, candidate) {
  if (reference.trackFingerprint !== candidate.trackFingerprint) {
    const error = new Error('INDEPENDENT_MP4_TRACK_INCOMPATIBLE');
    error.code = 'INDEPENDENT_MP4_TRACK_INCOMPATIBLE';
    throw error;
  }
  return true;
}

test('normalizes each complete MP4 independently and appends only ordered PCM frames', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'independent-mp4-source-test-'));
  const calls = [];
  const assembler = createMeetingIndependentMp4SourceAssembler({
    tempRoot: root,
    inspectSegment: inspector,
    assertCompatible: compatible,
    audioNormalizer: {
      async normalizeChunk(chunk) {
        calls.push(chunk.sequence);
        return { bytes: wav(Buffer.from([chunk.sequence + 1, 0, chunk.sequence + 2, 0])) };
      }
    }
  });
  try {
    const result = await assembler.assemble({
      segments: segments([Buffer.from([7, 1]), Buffer.from([7, 2]), Buffer.from([7, 3])])
    });
    const output = await readFile(result.inputPath);
    assert.deepEqual(calls, [0, 1, 2]);
    assert.deepEqual([...output.subarray(44)], [1, 0, 2, 0, 2, 0, 3, 0, 3, 0, 4, 0]);
    assert.deepEqual(result.sourceChunkRefs, ['segment-0', 'segment-1', 'segment-2']);
    assert.equal(result.source.format, 'wav');
    await result.cleanup();
    await result.cleanup();
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(MEETING_INDEPENDENT_MP4_ASSEMBLY_TEMP_PREFIX)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checksum, format, PCM, and cancellation failures clean every temporary artifact', async () => {
  const cases = [
    {
      expected: 'INDEPENDENT_MP4_CHECKSUM_MISMATCH',
      make({ root }) {
        const values = segments([Buffer.from([7, 1])]);
        values[0].checksum = '0'.repeat(64);
        return { root, segments: values, audioNormalizer: { async normalizeChunk() { return { bytes: wav(Buffer.from([1, 0])) }; } } };
      }
    },
    {
      expected: 'INDEPENDENT_MP4_FORMAT_MISMATCH',
      make({ root }) {
        return { root, segments: segments([Buffer.from([7, 1]), Buffer.from([8, 2])]), audioNormalizer: { async normalizeChunk() { return { bytes: wav(Buffer.from([1, 0])) }; } } };
      }
    },
    {
      expected: 'INDEPENDENT_MP4_PCM_FORMAT_MISMATCH',
      make({ root }) {
        return { root, segments: segments([Buffer.from([7, 1])]), audioNormalizer: { async normalizeChunk() { return { bytes: wav(Buffer.from([1, 0]), { sampleRate: 8_000 }) }; } } };
      }
    },
    {
      expected: 'TRANSCRIPTION_CANCELLED',
      make({ root, controller }) {
        return {
          root,
          signal: controller.signal,
          segments: segments([Buffer.from([7, 1]), Buffer.from([7, 2])]),
          audioNormalizer: {
            async normalizeChunk() {
              controller.abort();
              return { bytes: wav(Buffer.from([1, 0])) };
            }
          }
        };
      }
    }
  ];

  for (const fixture of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'independent-mp4-source-failure-'));
    const controller = new AbortController();
    try {
      const input = fixture.make({ root, controller });
      const assembler = createMeetingIndependentMp4SourceAssembler({
        tempRoot: root,
        inspectSegment: inspector,
        assertCompatible: compatible,
        audioNormalizer: input.audioNormalizer
      });
      await assert.rejects(
        () => assembler.assemble({ segments: input.segments, signal: input.signal }),
        (error) => error.code === fixture.expected,
        fixture.expected
      );
      assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(MEETING_INDEPENDENT_MP4_ASSEMBLY_TEMP_PREFIX)), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
