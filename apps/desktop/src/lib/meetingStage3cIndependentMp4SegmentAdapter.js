import {
  assertCompatibleIndependentMp4,
  inspectIndependentMp4Segment,
  rebaseIndependentMp4Media
} from '../../../../core/meeting/stage3c/independentMp4.js';
import { INDEPENDENT_MP4_SEGMENTS_V1 } from './meetingRecordingContainerLayout.js';

const DEFAULT_MAX_SEGMENT_COUNT = 3;
const DEFAULT_MAX_REASSEMBLY_BYTES = 8 * 1024 * 1024;

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw codedError('PLAYBACK_INDEPENDENT_MP4_INVALID');
}

function normalizeEntry(entry) {
  const sequence = Number(entry?.sequence);
  const sourceChunkId = String(entry?.sourceChunkId || '').trim();
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !sourceChunkId) {
    throw codedError('PLAYBACK_INDEPENDENT_WINDOW_INVALID');
  }
  return Object.freeze({ ...entry, sequence, sourceChunkId });
}

function mapInspectionError(error) {
  if (error?.code === 'INDEPENDENT_MP4_TRACK_INCOMPATIBLE') {
    return codedError('PLAYBACK_INDEPENDENT_INIT_INCOMPATIBLE', error);
  }
  if (error?.code === 'INDEPENDENT_MP4_DURATION_UNRESOLVED'
    || error?.code === 'INDEPENDENT_MP4_TIMELINE_OVERFLOW') {
    return codedError('PLAYBACK_INDEPENDENT_TIMELINE_INVALID', error);
  }
  return codedError('PLAYBACK_INDEPENDENT_MP4_INVALID', error);
}

export function createStage3cIndependentMp4SegmentAdapter({
  ownerContext,
  audioStore,
  maxSegmentCount = DEFAULT_MAX_SEGMENT_COUNT,
  maxReassemblyBytes = DEFAULT_MAX_REASSEMBLY_BYTES,
  inspectSegment = inspectIndependentMp4Segment,
  assertCompatible = assertCompatibleIndependentMp4,
  rebaseMedia = rebaseIndependentMp4Media
} = {}) {
  if (!ownerContext || !audioStore?.readAudioSegment) {
    throw codedError('PLAYBACK_INDEPENDENT_DEPENDENCY_UNAVAILABLE');
  }
  if (!Number.isSafeInteger(maxSegmentCount) || maxSegmentCount < 1 || maxSegmentCount > 3
    || !Number.isSafeInteger(maxReassemblyBytes) || maxReassemblyBytes < 1) {
    throw codedError('PLAYBACK_INDEPENDENT_REASSEMBLY_LIMIT_EXCEEDED');
  }

  async function readWindow({ source, window } = {}) {
    if (source?.containerLayout !== INDEPENDENT_MP4_SEGMENTS_V1) {
      throw codedError('PLAYBACK_INDEPENDENT_LAYOUT_UNSUPPORTED');
    }
    const entries = [...(window?.mediaChunks || [])].map(normalizeEntry);
    if (!entries.length || entries.length > maxSegmentCount) {
      throw codedError('PLAYBACK_INDEPENDENT_REASSEMBLY_LIMIT_EXCEEDED');
    }

    let totalBytes = 0;
    const inspected = [];
    for (const entry of entries) {
      const bytes = asBytes(await audioStore.readAudioSegment(ownerContext, source.meetingId, entry.sourceChunkId));
      totalBytes += bytes.byteLength;
      if (!bytes.byteLength) throw codedError('PLAYBACK_INDEPENDENT_MP4_INVALID');
      if (totalBytes > maxReassemblyBytes) {
        throw codedError('PLAYBACK_INDEPENDENT_REASSEMBLY_LIMIT_EXCEEDED');
      }
      try {
        inspected.push(Object.freeze({ entry, inspection: inspectSegment(bytes) }));
      } catch (error) {
        throw mapInspectionError(error);
      }
    }

    const reference = inspected[0].inspection;
    let nextSequence = 1;
    let nextDecodeTime = Math.max(0, Math.round(Number(window?.startMs || 0) * reference.timescale / 1_000));
    const mediaChunks = [];
    for (const item of inspected) {
      try {
        assertCompatible(reference, item.inspection);
        const rebased = rebaseMedia({
          inspection: item.inspection,
          firstSequence: nextSequence,
          firstDecodeTime: nextDecodeTime
        });
        nextSequence = rebased.nextSequence;
        nextDecodeTime = rebased.nextDecodeTime;
        mediaChunks.push(Object.freeze({ ...item.entry, bytes: rebased.mediaBytes }));
      } catch (error) {
        throw mapInspectionError(error);
      }
    }

    const reassemblyBytes = reference.initBytes.byteLength
      + mediaChunks.reduce((total, entry) => total + entry.bytes.byteLength, 0);
    if (reassemblyBytes > maxReassemblyBytes) {
      throw codedError('PLAYBACK_INDEPENDENT_REASSEMBLY_LIMIT_EXCEEDED');
    }
    return Object.freeze({
      classification: 'STORED_AAC_INDEPENDENT_MP4_SEGMENTS_SUPPORTED',
      initBytes: new Uint8Array(reference.initBytes),
      mediaChunks: Object.freeze(mediaChunks),
      targetMs: Number(window?.targetMs || 0),
      loadedFragmentSequences: Object.freeze(entries.map((entry) => entry.sequence)),
      adjacentFragmentCount: entries.length,
      memory: Object.freeze({
        initBytes: reference.initBytes.byteLength,
        mediaBytes: reassemblyBytes - reference.initBytes.byteLength,
        reassemblyBytes,
        wholeMeetingBlob: false
      })
    });
  }

  return Object.freeze({ readWindow });
}

export { codedError };
