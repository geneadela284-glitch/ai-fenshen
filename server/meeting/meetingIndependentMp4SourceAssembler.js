import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertCompatibleIndependentMp4,
  inspectIndependentMp4Segment
} from '../../core/meeting/stage3c/independentMp4.js';
import { createMeetingAudioNormalizer, parseWavMetadata } from './meetingAudioNormalizer.js';

export const MEETING_INDEPENDENT_MP4_ASSEMBLY_TEMP_PREFIX = 'meeting-independent-mp4-';
export const INDEPENDENT_MP4_SEGMENTS_V1 = 'independent-mp4-segments-v1';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function wavHeader(dataLength) {
  if (!Number.isSafeInteger(dataLength) || dataLength <= 0 || dataLength > 0xffff_ffff - 36) {
    throw codedError('INDEPENDENT_MP4_PCM_SIZE_INVALID');
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

async function segmentBytes(segment) {
  if (segment?.bytes instanceof Uint8Array || Buffer.isBuffer(segment?.bytes)) return Buffer.from(segment.bytes);
  const inputPath = String(segment?.inputPath || '').trim();
  if (!inputPath) throw codedError('INDEPENDENT_MP4_SEGMENT_BYTES_REQUIRED');
  return readFile(inputPath);
}

export function createMeetingIndependentMp4SourceAssembler({
  tempRoot = os.tmpdir(),
  audioNormalizer = createMeetingAudioNormalizer({ tempRoot }),
  inspectSegment = inspectIndependentMp4Segment,
  assertCompatible = assertCompatibleIndependentMp4
} = {}) {
  if (typeof audioNormalizer?.normalizeChunk !== 'function') {
    throw codedError('INDEPENDENT_MP4_NORMALIZER_REQUIRED');
  }

  async function assemble({ segments, signal } = {}) {
    if (!Array.isArray(segments) || !segments.length) throw codedError('INDEPENDENT_MP4_SEGMENTS_REQUIRED');
    const ordered = [...segments].sort((left, right) => Number(left.sequence) - Number(right.sequence));
    for (let index = 0; index < ordered.length; index += 1) {
      if (Number(ordered[index].sequence) !== index) throw codedError('INDEPENDENT_MP4_SEQUENCE_INVALID');
    }
    const directory = await mkdtemp(path.join(tempRoot, MEETING_INDEPENDENT_MP4_ASSEMBLY_TEMP_PREFIX));
    const inputPath = path.join(directory, 'assembled.wav');
    let handle = null;
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    };
    try {
      handle = await open(inputPath, 'w+', 0o600);
      await handle.write(Buffer.alloc(44), 0, 44, 0);
      let pcmOffset = 44;
      let dataLength = 0;
      let reference = null;
      const sourceChunkRefs = [];
      for (const segment of ordered) {
        if (signal?.aborted) throw codedError('TRANSCRIPTION_CANCELLED');
        const bytes = await segmentBytes(segment);
        const expectedChecksum = String(segment.checksum || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expectedChecksum) || digest(bytes) !== expectedChecksum) {
          throw codedError('INDEPENDENT_MP4_CHECKSUM_MISMATCH');
        }
        let inspection;
        try {
          inspection = inspectSegment(bytes);
          if (reference) assertCompatible(reference, inspection);
          else reference = inspection;
        } catch (error) {
          if (error?.code === 'INDEPENDENT_MP4_TRACK_INCOMPATIBLE') {
            throw codedError('INDEPENDENT_MP4_FORMAT_MISMATCH', error);
          }
          throw codedError('INDEPENDENT_MP4_CONTAINER_INVALID', error);
        }
        if (signal?.aborted) throw codedError('TRANSCRIPTION_CANCELLED');
        const normalized = await audioNormalizer.normalizeChunk({
          sequence: segment.sequence,
          bytes,
          fileName: `meeting-segment-${segment.sequence}.m4a`,
          mimeType: 'audio/mp4;codecs=mp4a.40.2',
          format: 'm4a',
          durationMs: segment.durationMs,
          signal
        });
        if (signal?.aborted) throw codedError('TRANSCRIPTION_CANCELLED');
        const wavBytes = Buffer.from(normalized?.bytes || []);
        const metadata = parseWavMetadata(wavBytes);
        if (!metadata
          || metadata.audioFormat !== 1
          || metadata.channels !== 1
          || metadata.sampleRate !== 16_000
          || metadata.bitsPerSample !== 16
          || metadata.blockAlign !== 2
          || metadata.dataOffset + metadata.dataLength > wavBytes.length) {
          throw codedError('INDEPENDENT_MP4_PCM_FORMAT_MISMATCH');
        }
        const pcm = wavBytes.subarray(metadata.dataOffset, metadata.dataOffset + metadata.dataLength);
        await handle.write(pcm, 0, pcm.length, pcmOffset);
        pcmOffset += pcm.length;
        dataLength += pcm.length;
        sourceChunkRefs.push(String(segment.sourceChunkId));
      }
      await handle.write(wavHeader(dataLength), 0, 44, 0);
      await handle.close();
      handle = null;
      return Object.freeze({
        inputPath,
        source: Object.freeze({
          fileName: 'meeting-recording.wav',
          mimeType: 'audio/wav',
          format: 'wav',
          byteLength: 44 + dataLength,
          durationMs: Math.round((dataLength / 2 / 16_000) * 1_000),
          chunkCount: ordered.length,
          sourceChunkRefs: Object.freeze(sourceChunkRefs)
        }),
        sourceChunkRefs: Object.freeze(sourceChunkRefs),
        cleanup
      });
    } catch (error) {
      await handle?.close?.().catch(() => {});
      await cleanup();
      throw error?.code ? error : codedError('INDEPENDENT_MP4_ASSEMBLY_FAILED', error);
    }
  }

  return Object.freeze({ assemble });
}

export { codedError, wavHeader };
