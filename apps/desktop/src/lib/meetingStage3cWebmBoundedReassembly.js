const IDS = Object.freeze({
  EBML: '1a45dfa3',
  SEGMENT: '18538067',
  INFO: '1549a966',
  TRACKS: '1654ae6b',
  CLUSTER: '1f43b675',
  TIMECODE: 'e7',
  TIMECODE_SCALE: '2ad7b1',
  SIMPLE_BLOCK: 'a3',
  BLOCK_GROUP: 'a0'
});

const DEFAULTS = Object.freeze({
  maxFragmentCount: 3,
  maxScanBytes: 8 * 1024 * 1024,
  maxReassemblyBytes: 16 * 1024 * 1024,
  maxMediaUnits: 3
});

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw codedError('PLAYBACK_WEBM_APPEND_UNIT_INVALID');
}

function concatBytes(parts) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function idLength(first) {
  if (first & 0x80) return 1;
  if (first & 0x40) return 2;
  if (first & 0x20) return 3;
  if (first & 0x10) return 4;
  return 0;
}

function idHex(bytes, offset) {
  if (offset >= bytes.byteLength) return null;
  const length = idLength(bytes[offset]);
  if (!length || offset + length > bytes.byteLength) return null;
  return [...bytes.slice(offset, offset + length)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function readVint(bytes, offset) {
  if (offset >= bytes.byteLength) return null;
  const first = bytes[offset];
  let leading = 0;
  for (let bit = 0x80; bit > 0 && !(first & bit); bit >>= 1) leading += 1;
  if (leading >= 8) return null;
  const length = leading + 1;
  if (offset + length > bytes.byteLength) return null;
  const mask = 0xff >>> length;
  let value = first & mask;
  let unknown = value === mask;
  for (let index = 1; index < length; index += 1) {
    value = (value * 256) + bytes[offset + index];
    unknown = unknown && bytes[offset + index] === 0xff;
  }
  return Object.freeze({ length, value, unknown });
}

function readHeader(bytes, offset) {
  const id = idHex(bytes, offset);
  if (!id) return null;
  const idBytes = idLength(bytes[offset]);
  const size = readVint(bytes, offset + idBytes);
  if (!size) return null;
  const payloadOffset = offset + idBytes + size.length;
  const end = size.unknown ? null : payloadOffset + size.value;
  return Object.freeze({
    id,
    offset,
    idLength: idBytes,
    sizeLength: size.length,
    size: size.unknown ? null : size.value,
    unknownSize: size.unknown,
    payloadOffset,
    end,
    complete: size.unknown || end <= bytes.byteLength
  });
}

function readUnsigned(bytes) {
  let value = 0;
  for (const byte of bytes) value = (value * 256) + byte;
  return value;
}

function readSequential(bytes, start, end) {
  const headers = [];
  let offset = start;
  while (offset < end) {
    const header = readHeader(bytes, offset);
    if (!header || header.end === null || header.end > end) break;
    headers.push(header);
    offset = header.end;
  }
  return headers;
}

function findBytePattern(bytes, pattern, start = 0) {
  outer: for (let offset = start; offset + pattern.length <= bytes.byteLength; offset += 1) {
    for (let index = 0; index < pattern.length; index += 1) {
      if (bytes[offset + index] !== pattern[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

const CLUSTER_BYTES = Uint8Array.from([0x1f, 0x43, 0xb6, 0x75]);

function parseInfoScale(bytes, infoHeader) {
  if (!infoHeader || infoHeader.end === null) return 1_000_000;
  const children = readSequential(bytes, infoHeader.payloadOffset, infoHeader.end);
  const scale = children.find((child) => child.id === IDS.TIMECODE_SCALE);
  if (!scale || scale.end === null) return 1_000_000;
  return readUnsigned(bytes.slice(scale.payloadOffset, scale.end)) || 1_000_000;
}

function extractInit(firstBytes) {
  const ebml = readHeader(firstBytes, 0);
  if (!ebml || ebml.id !== IDS.EBML || ebml.end === null || ebml.end > firstBytes.byteLength) {
    throw codedError('PLAYBACK_WEBM_INIT_UNRESOLVED');
  }
  const segment = readHeader(firstBytes, ebml.end);
  if (!segment || segment.id !== IDS.SEGMENT) throw codedError('PLAYBACK_WEBM_INIT_UNRESOLVED');
  let offset = segment.payloadOffset;
  let info = null;
  let tracks = null;
  let firstClusterOffset = -1;
  while (offset < firstBytes.byteLength) {
    const clusterOffset = findBytePattern(firstBytes, CLUSTER_BYTES, offset);
    const header = readHeader(firstBytes, offset);
    if (header?.id === IDS.CLUSTER) {
      firstClusterOffset = offset;
      break;
    }
    if (!header || header.end === null || header.end > firstBytes.byteLength) {
      if (clusterOffset >= 0) {
        firstClusterOffset = clusterOffset;
        break;
      }
      throw codedError('PLAYBACK_WEBM_INIT_UNRESOLVED');
    }
    if (header.id === IDS.INFO) info = header;
    if (header.id === IDS.TRACKS) tracks = header;
    offset = header.end;
  }
  if (!info || !tracks || firstClusterOffset < 0) throw codedError('PLAYBACK_WEBM_INIT_UNRESOLVED');
  return Object.freeze({
    initBytes: firstBytes.slice(0, firstClusterOffset),
    firstClusterOffset,
    timecodeScaleNs: parseInfoScale(firstBytes, info)
  });
}

function isLikelyCluster(bytes, offset) {
  const header = readHeader(bytes, offset);
  if (!header || header.id !== IDS.CLUSTER) return false;
  if (header.unknownSize) return true;
  return header.end !== null && header.end <= bytes.byteLength;
}

function findClusterOffsets(bytes, start = 0) {
  const offsets = [];
  let cursor = start;
  while (cursor < bytes.byteLength) {
    const offset = findBytePattern(bytes, CLUSTER_BYTES, cursor);
    if (offset < 0) break;
    if (isLikelyCluster(bytes, offset)) offsets.push(offset);
    cursor = offset + 1;
  }
  return offsets;
}

function parseCluster(bytes, start, end, timecodeScaleNs) {
  const root = readHeader(bytes, start);
  if (!root || root.id !== IDS.CLUSTER || end <= root.payloadOffset) throw codedError('PLAYBACK_WEBM_APPEND_UNIT_INVALID');
  const children = readSequential(bytes, root.payloadOffset, end);
  if (!children.length) throw codedError('PLAYBACK_WEBM_APPEND_UNIT_INVALID');
  const timecodeElement = children.find((child) => child.id === IDS.TIMECODE);
  const timecode = timecodeElement && timecodeElement.end !== null
    ? readUnsigned(bytes.slice(timecodeElement.payloadOffset, timecodeElement.end))
    : null;
  let simpleBlocks = 0;
  let blockGroups = 0;
  for (const child of children) {
    if (child.id === IDS.SIMPLE_BLOCK) simpleBlocks += 1;
    if (child.id === IDS.BLOCK_GROUP) {
      blockGroups += 1;
      const nested = readSequential(bytes, child.payloadOffset, child.end);
      if (nested.some((item) => item.id === IDS.SIMPLE_BLOCK)) simpleBlocks += 1;
    }
  }
  if (!Number.isFinite(timecode)) throw codedError('PLAYBACK_WEBM_TIMECODE_UNRESOLVED');
  if (simpleBlocks + blockGroups < 1) throw codedError('PLAYBACK_WEBM_APPEND_UNIT_INVALID');
  return Object.freeze({
    bytes: bytes.slice(start, end),
    byteLength: end - start,
    timecodeMs: (timecode * timecodeScaleNs) / 1_000_000,
    simpleBlockCount: simpleBlocks,
    blockGroupCount: blockGroups,
    complete: true
  });
}

function sequenceForOffset(offset, boundaries) {
  for (const boundary of boundaries) {
    if (offset >= boundary.start && offset < boundary.end) return boundary.sequence;
  }
  return boundaries.at(-1)?.sequence ?? 0;
}

export function createStage3cWebmBoundedReassemblyAdapter({
  ownerContext,
  audioStore,
  maxFragmentCount = DEFAULTS.maxFragmentCount,
  maxScanBytes = DEFAULTS.maxScanBytes,
  maxReassemblyBytes = DEFAULTS.maxReassemblyBytes,
  maxMediaUnits = DEFAULTS.maxMediaUnits
} = {}) {
  if (!ownerContext || !audioStore?.readAudioSegment) throw codedError('PLAYBACK_DEPENDENCY_UNAVAILABLE');
  if (!Number.isSafeInteger(maxFragmentCount) || maxFragmentCount < 1 || maxFragmentCount > 3) throw codedError('PLAYBACK_WEBM_REASSEMBLY_LIMIT_EXCEEDED');

  async function readFragment(source, entry) {
    let bytes;
    try {
      bytes = asBytes(await audioStore.readAudioSegment(ownerContext, source.meetingId, entry.sourceChunkId));
    } catch (cause) {
      throw codedError('PLAYBACK_WEBM_APPEND_UNIT_INVALID', cause);
    }
    if (!bytes.byteLength) throw codedError('PLAYBACK_WEBM_APPEND_UNIT_INVALID');
    return bytes;
  }

  async function readWindow({ source, timeline, targetMs = 0 } = {}) {
    if (!source || source.format !== 'webm-opus' && !String(source.mimeType || '').toLowerCase().startsWith('audio/webm')) {
      throw codedError('PLAYBACK_WEBM_INIT_UNRESOLVED');
    }
    const entries = timeline?.entries;
    if (!Array.isArray(entries) || !entries.length || Number(source.chunkCount) !== entries.length) throw codedError('PLAYBACK_WEBM_TIMECODE_UNRESOLVED');
    const target = Math.max(0, Math.min(Number(timeline.durationMs ?? source.durationMs), Number(targetMs) || 0));
    let targetIndex = entries.findIndex((entry) => target >= entry.startMs && target < entry.endMs);
    if (targetIndex < 0) targetIndex = entries.length - 1;
    const maxStart = Math.max(0, entries.length - maxFragmentCount);
    // Start at the target fragment and look forward. The persisted boundary
    // may begin in the middle of a SimpleBlock; if no complete Cluster can be
    // closed within this forward bounded window, fail closed rather than
    // reading an unbounded predecessor/successor chain.
    const startIndex = Math.min(maxStart, Math.max(0, targetIndex));
    const endIndex = Math.min(entries.length - 1, startIndex + maxFragmentCount - 1);
    const selectedEntries = entries.slice(startIndex, endIndex + 1);
    if (!selectedEntries.length || selectedEntries.length > maxFragmentCount) throw codedError('PLAYBACK_WEBM_REASSEMBLY_LIMIT_EXCEEDED');

    const firstEntry = entries[0];
    const firstBytes = await readFragment(source, firstEntry);
    let scannedBytes = firstBytes.byteLength;
    if (scannedBytes > maxScanBytes || firstBytes.byteLength > maxReassemblyBytes) throw codedError('PLAYBACK_WEBM_REASSEMBLY_LIMIT_EXCEEDED');
    const init = extractInit(firstBytes);

    const fragmentParts = [];
    const boundaries = [];
    let offset = 0;
    for (const entry of selectedEntries) {
      const bytes = entry.sequence === 0 ? firstBytes : await readFragment(source, entry);
      scannedBytes += entry.sequence === 0 ? 0 : bytes.byteLength;
      if (scannedBytes > maxScanBytes) throw codedError('PLAYBACK_WEBM_REASSEMBLY_LIMIT_EXCEEDED');
      fragmentParts.push(bytes);
      boundaries.push({ sequence: entry.sequence, start: offset, end: offset + bytes.byteLength });
      offset += bytes.byteLength;
    }
    const mediaBytes = selectedEntries[0].sequence === 0
      ? concatBytes([firstBytes.slice(init.firstClusterOffset), ...fragmentParts.slice(1)])
      : concatBytes(fragmentParts);
    if (mediaBytes.byteLength > maxReassemblyBytes) throw codedError('PLAYBACK_WEBM_REASSEMBLY_LIMIT_EXCEEDED');

    const mediaStartOffset = selectedEntries[0].sequence === 0 ? init.firstClusterOffset : 0;
    const mediaBoundaries = boundaries.map((boundary) => ({
      sequence: boundary.sequence,
      start: Math.max(0, boundary.start - mediaStartOffset),
      end: Math.max(0, boundary.end - mediaStartOffset)
    }));
    const clusterOffsets = findClusterOffsets(mediaBytes);
    if (!clusterOffsets.length) throw codedError('PLAYBACK_WEBM_CLUSTER_BOUNDARY_UNRESOLVED');
    const clusters = [];
    let unresolvedTrailingCluster = false;
    for (let index = 0; index < clusterOffsets.length; index += 1) {
      const start = clusterOffsets[index];
      const next = clusterOffsets[index + 1];
      const end = next ?? mediaBytes.byteLength;
      const isSourceEnd = endIndex === entries.length - 1 && end === mediaBytes.byteLength;
      if (!next && !isSourceEnd) {
        // The final visible cluster may continue into the next persisted
        // fragment. It is not a usable unit for this window yet; discard it
        // unless it is the target cluster, which is checked below.
        unresolvedTrailingCluster = true;
        continue;
      }
      const parsed = parseCluster(mediaBytes, start, end, init.timecodeScaleNs);
      clusters.push(Object.freeze({
        ...parsed,
        sequenceStart: sequenceForOffset(start, mediaBoundaries),
        sequenceEnd: sequenceForOffset(Math.max(start, end - 1), mediaBoundaries),
        spansFragments: sequenceForOffset(start, mediaBoundaries) !== sequenceForOffset(Math.max(start, end - 1), mediaBoundaries)
      }));
    }
    if (!clusters.length) throw codedError('PLAYBACK_WEBM_CLUSTER_BOUNDARY_UNRESOLVED');
    let selectedIndex = clusters.findIndex((cluster, index) => {
      const next = clusters[index + 1];
      return cluster.timecodeMs <= target && (!next || target < next.timecodeMs);
    });
    if (selectedIndex < 0) selectedIndex = target <= clusters[0].timecodeMs ? 0 : clusters.length - 1;
    if (unresolvedTrailingCluster && target > clusters.at(-1).timecodeMs && endIndex < entries.length - 1) {
      throw codedError('PLAYBACK_WEBM_CLUSTER_BOUNDARY_UNRESOLVED');
    }
    const startCluster = Math.max(0, Math.min(clusters.length - maxMediaUnits, selectedIndex));
    const mediaChunks = clusters.slice(startCluster, startCluster + maxMediaUnits);
    if (!mediaChunks.length || mediaChunks.some((chunk) => !chunk.bytes?.byteLength || !chunk.complete)) throw codedError('PLAYBACK_WEBM_APPEND_UNIT_INVALID');
    return Object.freeze({
      classification: 'STORED_WEBM_REQUIRES_BOUNDED_REASSEMBLY_SUPPORTED',
      initBytes: init.initBytes,
      mediaChunks: Object.freeze(mediaChunks),
      targetMs: target,
      boundary: Object.freeze({
        clusterSpansFragments: mediaChunks.some((chunk) => chunk.spansFragments),
        selectedFragmentSequences: Object.freeze(selectedEntries.map((entry) => entry.sequence)),
        initFragmentSequence: 0
      }),
      memory: Object.freeze({
        maxFragmentCount,
        maxScanBytes,
        maxReassemblyBytes,
        maxObservedScanBytes: scannedBytes,
        maxObservedReassemblyBytes: mediaBytes.byteLength,
        wholeMeetingBlob: false,
        retainedRawBytes: 0
      })
    });
  }

  return Object.freeze({ readWindow });
}

export { IDS };
