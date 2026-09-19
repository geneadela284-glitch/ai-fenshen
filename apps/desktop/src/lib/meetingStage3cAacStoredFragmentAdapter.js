import { parseBoxes } from '../../../../core/meeting/stage3a/mp4Container.js';

const DEFAULT_MAX_FRAGMENT_COUNT = 3;
const DEFAULT_MAX_REASSEMBLY_BYTES = 8 * 1024 * 1024;
const IGNORABLE_MEDIA_BOXES = new Set(['styp', 'sidx', 'ssix', 'emsg', 'free', 'skip', 'mfra']);

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError('PLAYBACK_AAC_BYTES_INVALID');
}

function readBoxes(bytes) {
  try {
    return parseBoxes(bytes);
  } catch (cause) {
    throw codedError('PLAYBACK_AAC_APPEND_UNIT_INVALID', cause);
  }
}

function extractInitialization(bytes) {
  const boxes = readBoxes(bytes);
  const first = boxes[0];
  const second = boxes[1];
  if (!first || first.type !== 'ftyp' || !second || second.type !== 'moov') {
    throw codedError('PLAYBACK_AAC_INIT_UNRESOLVED');
  }
  const initEnd = second.offset + second.size;
  if (initEnd > bytes.byteLength) throw codedError('PLAYBACK_AAC_INIT_UNRESOLVED');
  return Object.freeze({
    initBytes: bytes.slice(0, initEnd),
    mediaBytes: bytes.slice(initEnd),
    initEnd,
    boxes
  });
}

function validateMediaFragment(bytes) {
  if (!bytes.byteLength) throw codedError('PLAYBACK_AAC_MEDIA_UNRESOLVED');
  const boxes = readBoxes(bytes);
  let fragmentCount = 0;
  for (let index = 0; index < boxes.length; index += 1) {
    const current = boxes[index];
    if (IGNORABLE_MEDIA_BOXES.has(current.type)) continue;
    if (current.type !== 'moof') throw codedError('PLAYBACK_AAC_APPEND_UNIT_INVALID');
    const next = boxes[index + 1];
    if (!next || next.type !== 'mdat') throw codedError('PLAYBACK_AAC_APPEND_UNIT_INVALID');
    fragmentCount += 1;
    index += 1;
  }
  if (!fragmentCount) throw codedError('PLAYBACK_AAC_MEDIA_UNRESOLVED');
  return Object.freeze({ fragmentCount, boxes });
}

function normalizeEntry(entry) {
  if (!entry || !Number.isSafeInteger(Number(entry.sequence)) || !String(entry.sourceChunkId || '').trim()) {
    throw codedError('PLAYBACK_AAC_WINDOW_INVALID');
  }
  return entry;
}

export function createStage3cAacStoredFragmentAdapter({
  ownerContext,
  audioStore,
  maxFragmentCount = DEFAULT_MAX_FRAGMENT_COUNT,
  maxReassemblyBytes = DEFAULT_MAX_REASSEMBLY_BYTES
} = {}) {
  if (!ownerContext || !audioStore?.readAudioSegment) throw codedError('PLAYBACK_AAC_DEPENDENCY_UNAVAILABLE');
  if (!Number.isSafeInteger(maxFragmentCount) || maxFragmentCount < 1 || maxFragmentCount > 3) {
    throw codedError('PLAYBACK_AAC_REASSEMBLY_LIMIT_EXCEEDED');
  }
  if (!Number.isSafeInteger(maxReassemblyBytes) || maxReassemblyBytes < 1) {
    throw codedError('PLAYBACK_AAC_REASSEMBLY_LIMIT_EXCEEDED');
  }

  async function readSegment(source, entry) {
    const bytes = await audioStore.readAudioSegment(ownerContext, source.meetingId, entry.sourceChunkId);
    const result = asBytes(bytes);
    if (!result.byteLength) throw codedError('PLAYBACK_AAC_MEDIA_UNRESOLVED');
    return result;
  }

  async function resolveFirstEntry(source, selectedEntries) {
    const explicitId = String(source?.playbackInitSegmentId || source?.initSegmentId || '').trim();
    if (explicitId) return { entry: { sourceChunkId: explicitId, sequence: 0 }, explicit: true };
    const selectedFirst = selectedEntries.find((entry) => Number(entry.sequence) === 0);
    if (selectedFirst) return { entry: selectedFirst, explicit: false };
    if (typeof audioStore.getMeeting !== 'function') throw codedError('PLAYBACK_AAC_INIT_UNRESOLVED');
    const meeting = await audioStore.getMeeting(ownerContext, source.meetingId);
    const first = [...(meeting?.segments || [])].find((entry) => Number(entry.sequence) === 0);
    if (!first) throw codedError('PLAYBACK_AAC_INIT_UNRESOLVED');
    return { entry: { sourceChunkId: first.segmentId, sequence: 0 }, explicit: false };
  }

  async function readWindow({ source, window } = {}) {
    const selectedEntries = [...(window?.mediaChunks || [])].map(normalizeEntry);
    if (selectedEntries.length < 1 || selectedEntries.length > maxFragmentCount) {
      throw codedError('PLAYBACK_AAC_REASSEMBLY_LIMIT_EXCEEDED');
    }

    const first = await resolveFirstEntry(source, selectedEntries);
    const firstBytes = await readSegment(source, first.entry);
    const initialization = first.explicit
      ? extractInitialization(firstBytes)
      : extractInitialization(firstBytes);
    let totalBytes = initialization.initBytes.byteLength;
    const loadedFragmentSequences = new Set([0]);
    const mediaChunks = [];

    for (const entry of selectedEntries) {
      const bytes = Number(entry.sequence) === Number(first.entry.sequence) && entry.sourceChunkId === first.entry.sourceChunkId
        ? firstBytes
        : await readSegment(source, entry);
      let mediaBytes = bytes;
      if (!first.explicit && Number(entry.sequence) === 0 && entry.sourceChunkId === first.entry.sourceChunkId) {
        mediaBytes = initialization.mediaBytes;
      }
      if (!mediaBytes.byteLength) {
        loadedFragmentSequences.add(Number(entry.sequence));
        continue;
      }
      validateMediaFragment(mediaBytes);
      totalBytes += mediaBytes.byteLength;
      if (totalBytes > maxReassemblyBytes) throw codedError('PLAYBACK_AAC_REASSEMBLY_LIMIT_EXCEEDED');
      loadedFragmentSequences.add(Number(entry.sequence));
      mediaChunks.push(Object.freeze({ ...entry, bytes: mediaBytes }));
    }
    if (!mediaChunks.length) throw codedError('PLAYBACK_AAC_MEDIA_UNRESOLVED');

    return Object.freeze({
      classification: 'STORED_AAC_STORED_FRAGMENTS_SUPPORTED',
      initBytes: initialization.initBytes,
      mediaChunks: Object.freeze(mediaChunks),
      targetMs: Number(window?.targetMs || 0),
      loadedFragmentSequences: Object.freeze([...loadedFragmentSequences].sort((left, right) => left - right)),
      adjacentFragmentCount: selectedEntries.length,
      memory: Object.freeze({
        initBytes: initialization.initBytes.byteLength,
        mediaBytes: totalBytes - initialization.initBytes.byteLength,
        reassemblyBytes: totalBytes,
        wholeMeetingBlob: false
      })
    });
  }

  return Object.freeze({ readWindow });
}

export { extractInitialization, validateMediaFragment };
