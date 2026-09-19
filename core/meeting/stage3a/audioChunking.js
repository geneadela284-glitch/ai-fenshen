function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function bytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError('AUDIO_CHUNK_BYTES_INVALID');
}

function concat(values) {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function inferredFormat(input = {}) {
  const declared = String(input.format || '').trim().toLowerCase();
  if (declared && !['recorded', 'imported', 'unknown'].includes(declared)) return declared;
  const mimeType = String(input.mimeType || '').toLowerCase();
  if (mimeType.includes('webm')) return 'webm-opus';
  if (mimeType.includes('wav') || mimeType.includes('wave')) return 'wav';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('aac')) return 'aac';
  return declared || 'unknown';
}

function inferredFileName(input = {}, format = 'unknown') {
  const current = String(input.fileName || '').trim();
  if (current) return current;
  const extension = format === 'webm-opus' ? 'webm' : format === 'wav' ? 'wav' : format === 'mp3' ? 'mp3' : format === 'm4a' ? 'm4a' : format === 'aac' ? 'aac' : 'audio';
  return `meeting-chunk-${input.sequence ?? 0}.${extension}`;
}

function isContainerFormat(format, mimeType) {
  return format === 'webm-opus' || String(mimeType || '').toLowerCase().includes('webm');
}

const WEBM_EBML_MAGIC = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
const WEBM_CLUSTER_MAGIC = new Uint8Array([0x1f, 0x43, 0xb6, 0x75]);

function startsWithBytes(value, prefix) {
  if (value.byteLength < prefix.byteLength) return false;
  return prefix.every((byte, index) => value[index] === byte);
}

function indexOfBytes(value, pattern, fromIndex = 0) {
  const lastStart = value.byteLength - pattern.byteLength;
  for (let index = Math.max(0, fromIndex); index <= lastStart; index += 1) {
    if (pattern.every((byte, offset) => value[index + offset] === byte)) return index;
  }
  return -1;
}

function webmInitializationPrefix(value) {
  if (!startsWithBytes(value, WEBM_EBML_MAGIC)) throw codedError('AUDIO_WEBM_HEADER_INVALID');
  const clusterOffset = indexOfBytes(value, WEBM_CLUSTER_MAGIC, WEBM_EBML_MAGIC.byteLength);
  if (clusterOffset <= WEBM_EBML_MAGIC.byteLength) throw codedError('AUDIO_WEBM_HEADER_INVALID');
  return value.slice(0, clusterOffset);
}

function splitPiece(piece, fromMs, toMs) {
  const durationMs = piece.endMs - piece.startMs;
  const fromRatio = Math.max(0, Math.min(1, (fromMs - piece.startMs) / durationMs));
  const toRatio = Math.max(fromRatio, Math.min(1, (toMs - piece.startMs) / durationMs));
  const start = Math.floor(fromRatio * piece.bytes.byteLength);
  const end = Math.max(start + 1, Math.ceil(toRatio * piece.bytes.byteLength));
  return {
    sourceChunkId: piece.sourceChunkId,
    sequence: piece.sequence,
    startMs: fromMs,
    endMs: toMs,
    fileName: piece.fileName,
    mimeType: piece.mimeType,
    format: piece.format,
    bytes: piece.bytes.slice(start, Math.min(piece.bytes.byteLength, end))
  };
}

function tailPieces(pieces, endMs, overlapMs) {
  if (!overlapMs) return [];
  const startMs = Math.max(0, endMs - overlapMs);
  return pieces
    .filter((piece) => piece.endMs > startMs)
    .map((piece) => splitPiece(piece, Math.max(piece.startMs, startMs), piece.endMs));
}

function createWindow(sequence, pieces, startMs, endMs) {
  const first = pieces[0] || {};
  return Object.freeze({
    sequence,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    fileName: first.fileName,
    mimeType: first.mimeType,
    format: first.format,
    bytes: concat(pieces.map((piece) => piece.bytes)),
    sourceChunkRefs: [...new Set(pieces.map((piece) => piece.sourceChunkId))]
  });
}

function sameBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function createContainerWindow(sequence, pieces, initialization, startMs, endMs) {
  const first = pieces[0] || {};
  return Object.freeze({
    sequence,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    fileName: first.fileName,
    mimeType: first.mimeType,
    format: first.format,
    bytes: concat([initialization, ...pieces.map((piece) => piece.bytes)]),
    sourceChunkRefs: [...new Set(pieces.map((piece) => piece.sourceChunkId))]
  });
}

export async function* createAudioChunkStream(sourceIterable, {
  maxChunkDurationMs = 60_000,
  overlapMs = 5_000,
  signal
} = {}) {
  if (!sourceIterable?.[Symbol.asyncIterator]) throw codedError('AUDIO_SOURCE_STREAM_REQUIRED');
  if (!Number.isSafeInteger(maxChunkDurationMs) || maxChunkDurationMs <= 0) throw codedError('ASR_CHUNK_DURATION_INVALID');
  if (!Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs >= maxChunkDurationMs) throw codedError('ASR_OVERLAP_INVALID');

  let pending = [];
  let windowStartMs = 0;
  let windowEndMs = 0;
  let sequence = 0;
  let sourceCursorMs = 0;
  let expectedContainerSequence = null;
  let containerMode = null;
  let containerInitialization = null;
  let containerStructureMode = null;
  let containerPending = [];
  let containerWindowStartMs = 0;
  let containerWindowEndMs = 0;

  for await (const input of sourceIterable) {
    if (signal?.aborted) throw codedError('TRANSCRIPTION_CANCELLED');
    const sourceChunkId = required(input?.sourceChunkId || input?.chunkId || input?.assetId, 'AUDIO_SOURCE_CHUNK_ID_REQUIRED');
    const durationMs = Number(input?.durationMs);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw codedError('AUDIO_SOURCE_CHUNK_DURATION_INVALID');
    const sourceBytes = bytes(input.bytes);
    if (!sourceBytes.byteLength) throw codedError('AUDIO_SOURCE_CHUNK_EMPTY');
    const declaredStart = input.startMs === undefined ? sourceCursorMs : Number(input.startMs);
    if (!Number.isSafeInteger(declaredStart) || declaredStart < 0) throw codedError('AUDIO_SOURCE_CHUNK_START_INVALID');
    if (declaredStart < sourceCursorMs) throw codedError('AUDIO_SOURCE_CHUNK_TIME_NOT_MONOTONIC');
    const format = inferredFormat(input);
    const fileName = inferredFileName(input, format);
    const container = isContainerFormat(format, input.mimeType);
    if (containerMode === null) containerMode = container;
    if (containerMode !== container) throw codedError('AUDIO_SOURCE_FORMAT_MIXED');
    let requestBytes = sourceBytes;
    if (container) {
      if (startsWithBytes(sourceBytes, WEBM_EBML_MAGIC)) {
        const initialization = webmInitializationPrefix(sourceBytes);
        if (containerInitialization && !sameBytes(containerInitialization, initialization)) throw codedError('AUDIO_WEBM_HEADER_MISMATCH');
        containerStructureMode = 'segmented-webm';
        containerInitialization = initialization;
        requestBytes = sourceBytes.slice(initialization.byteLength);
      } else if (startsWithBytes(sourceBytes, WEBM_CLUSTER_MAGIC)) {
        if (!containerInitialization) throw codedError('AUDIO_WEBM_INITIALIZATION_MISSING');
        requestBytes = sourceBytes;
      } else if (containerStructureMode === 'segmented-webm') {
        // MediaRecorder continuation blobs may begin with a valid WebM
        // element (for example Void/CRC) before the next Cluster. Preserve
        // that element as part of the continuous stream; only reject a
        // continuation that contains no Cluster at all.
        if (indexOfBytes(sourceBytes, WEBM_CLUSTER_MAGIC) < 0) throw codedError('AUDIO_WEBM_CHUNK_INVALID');
        requestBytes = sourceBytes;
      } else if (containerStructureMode === null) {
        // Keep legacy/deterministic opaque fixtures unchanged; real WebM is
        // activated only after its EBML initialization header is verified.
        containerStructureMode = 'opaque';
      }
    }
    const sourcePiece = {
      sourceChunkId,
      sequence: input.sequence,
      startMs: declaredStart,
      endMs: declaredStart + durationMs,
      fileName,
      mimeType: input.mimeType,
      format,
      bytes: requestBytes
    };
    if (container) {
      const inputSequence = Number(input.sequence);
      if (!Number.isSafeInteger(inputSequence) || (expectedContainerSequence !== null && inputSequence !== expectedContainerSequence)) {
        throw codedError('AUDIO_SOURCE_SEQUENCE_NOT_MONOTONIC');
      }
      if (durationMs > maxChunkDurationMs) throw codedError('AUDIO_CONTAINER_CHUNK_UNSPLITTABLE');
      expectedContainerSequence = inputSequence + 1;
      if (containerStructureMode === 'segmented-webm') {
        if (!containerPending.length) containerWindowStartMs = sourcePiece.startMs;
        containerPending.push(sourcePiece);
        containerWindowEndMs = sourcePiece.endMs;
        if (containerWindowEndMs - containerWindowStartMs >= maxChunkDurationMs) {
          yield createContainerWindow(sequence, containerPending, containerInitialization, containerWindowStartMs, containerWindowEndMs);
          sequence += 1;
          containerPending = [];
          containerWindowStartMs = containerWindowEndMs;
        }
      } else {
        yield createWindow(sequence, [sourcePiece], sourcePiece.startMs, sourcePiece.endMs);
        sequence += 1;
      }
      sourceCursorMs = sourcePiece.endMs;
      continue;
    }
    let cursor = sourcePiece.startMs;
    while (cursor < sourcePiece.endMs) {
      if (!pending.length) windowStartMs = cursor;
      const nextBoundary = Math.min(sourcePiece.endMs, windowStartMs + maxChunkDurationMs);
      const part = splitPiece(sourcePiece, cursor, nextBoundary);
      pending.push(part);
      windowEndMs = nextBoundary;
      cursor = nextBoundary;
      if (windowEndMs - windowStartMs >= maxChunkDurationMs) {
        yield createWindow(sequence, pending, windowStartMs, windowEndMs);
        sequence += 1;
        pending = tailPieces(pending, windowEndMs, overlapMs);
        windowStartMs = Math.max(0, windowEndMs - overlapMs);
      }
    }
    sourceCursorMs = sourcePiece.endMs;
  }

  if (containerPending.length && containerWindowEndMs > containerWindowStartMs) {
    yield createContainerWindow(sequence, containerPending, containerInitialization, containerWindowStartMs, containerWindowEndMs);
  } else if (pending.length && windowEndMs > windowStartMs) {
    yield createWindow(sequence, pending, windowStartMs, windowEndMs);
  }
}

export { codedError };
