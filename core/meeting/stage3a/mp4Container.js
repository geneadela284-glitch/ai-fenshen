function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError('MP4_CONTAINER_BYTES_INVALID');
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function readUInt64(bytes, offset) {
  if (offset + 8 > bytes.byteLength) throw codedError('MP4_CONTAINER_BOX_INVALID');
  const value = (BigInt(bytes[offset]) << 56n)
    | (BigInt(bytes[offset + 1]) << 48n)
    | (BigInt(bytes[offset + 2]) << 40n)
    | (BigInt(bytes[offset + 3]) << 32n)
    | (BigInt(bytes[offset + 4]) << 24n)
    | (BigInt(bytes[offset + 5]) << 16n)
    | (BigInt(bytes[offset + 6]) << 8n)
    | BigInt(bytes[offset + 7]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw codedError('MP4_CONTAINER_INTEGER_INVALID');
  return Number(value);
}

function readUInt32(bytes, offset) {
  if (offset + 4 > bytes.byteLength) throw codedError('MP4_CONTAINER_BOX_INVALID');
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function parseBoxes(bytes, start = 0, end = bytes.byteLength) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw codedError('MP4_CONTAINER_BOX_INVALID');
    const declaredSize = readUInt32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    let size = declaredSize;
    if (declaredSize === 1) {
      size = readUInt64(bytes, offset + 8);
      headerSize = 16;
    } else if (declaredSize === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw codedError('MP4_CONTAINER_BOX_INVALID');
    boxes.push(Object.freeze({
      type,
      offset,
      size,
      headerSize,
      payloadStart: offset + headerSize,
      payloadEnd: offset + size,
      bytes
    }));
    offset += size;
  }
  if (offset !== end) throw codedError('MP4_CONTAINER_BOX_INVALID');
  return boxes;
}

function children(box) {
  return parseBoxes(box.bytes, box.payloadStart, box.payloadEnd);
}

function findBoxes(box, type) {
  const result = [];
  for (const child of children(box)) {
    if (child.type === type) result.push(child);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf'].includes(child.type)) {
      result.push(...findBoxes(child, type));
    }
  }
  return result;
}

function readFullBoxVersion(box) {
  if (box.payloadStart + 4 > box.payloadEnd) throw codedError('MP4_CONTAINER_BOX_INVALID');
  return box.bytes[box.payloadStart];
}

function readTimescale(moov) {
  const mdhd = findBoxes(moov, 'mdhd')[0];
  if (!mdhd) throw codedError('MP4_TIMESCALE_INVALID');
  const version = readFullBoxVersion(mdhd);
  const relativeOffset = version === 1 ? 20 : 12;
  const timescale = readUInt32(mdhd.bytes, mdhd.payloadStart + relativeOffset);
  if (!timescale) throw codedError('MP4_TIMESCALE_INVALID');
  return timescale;
}

function readFragmentMetadata(moof) {
  const childrenOfMoof = children(moof);
  const mfhd = childrenOfMoof.find((child) => child.type === 'mfhd');
  if (!mfhd || mfhd.payloadStart + 8 > mfhd.payloadEnd) throw codedError('MP4_FRAGMENT_SEQUENCE_INVALID');
  const sequence = readUInt32(mfhd.bytes, mfhd.payloadStart + 4);
  if (!sequence) throw codedError('MP4_FRAGMENT_SEQUENCE_INVALID');
  const trafs = childrenOfMoof.filter((child) => child.type === 'traf');
  if (!trafs.length) throw codedError('MP4_FRAGMENT_TIMELINE_INVALID');
  const decodeTimes = [];
  for (const traf of trafs) {
    const tfdt = findBoxes(traf, 'tfdt')[0];
    if (!tfdt) throw codedError('MP4_FRAGMENT_TIMELINE_INVALID');
    const version = readFullBoxVersion(tfdt);
    const relativeOffset = version === 1 ? 4 : 4;
    const value = version === 1
      ? readUInt64(tfdt.bytes, tfdt.payloadStart + relativeOffset)
      : readUInt32(tfdt.bytes, tfdt.payloadStart + relativeOffset);
    decodeTimes.push(value);
  }
  const decodeTime = Math.min(...decodeTimes);
  return Object.freeze({ sequence, decodeTime });
}

function validateInitialization(boxes) {
  const hasFtyp = boxes.some((box) => box.type === 'ftyp');
  const moov = boxes.find((box) => box.type === 'moov');
  if (!hasFtyp || !moov) throw codedError('MP4_INITIALIZATION_REQUIRED');
  return readTimescale(moov);
}

function isIgnorableSegmentBox(type) {
  return ['styp', 'sidx', 'ssix', 'emsg', 'free', 'skip'].includes(type);
}

function validateFragments(boxes, state) {
  let fragmentCount = 0;
  let lastFragmentSequence = state.lastFragmentSequence;
  let lastDecodeTime = state.lastDecodeTime;
  for (let index = 0; index < boxes.length; index += 1) {
    const current = boxes[index];
    if (['ftyp', 'moov'].includes(current.type)) throw codedError('MP4_INITIALIZATION_DUPLICATE');
    if (isIgnorableSegmentBox(current.type)) continue;
    if (current.type === 'mdat') throw codedError('MP4_FRAGMENT_MOOF_REQUIRED');
    if (current.type !== 'moof') throw codedError('MP4_FRAGMENT_BOX_INVALID');
    const next = boxes[index + 1];
    if (!next || next.type !== 'mdat') throw codedError('MP4_FRAGMENT_MDAT_REQUIRED');
    const metadata = readFragmentMetadata(current);
    if (lastFragmentSequence !== null && metadata.sequence !== lastFragmentSequence + 1) {
      throw codedError('MP4_FRAGMENT_SEQUENCE_INVALID');
    }
    if (lastDecodeTime !== null && metadata.decodeTime < lastDecodeTime) {
      throw codedError('MP4_FRAGMENT_TIMELINE_INVALID');
    }
    lastFragmentSequence = metadata.sequence;
    lastDecodeTime = metadata.decodeTime;
    fragmentCount += 1;
    index += 1;
  }
  return Object.freeze({ fragmentCount, lastFragmentSequence, lastDecodeTime });
}

export function createMp4ContainerValidator() {
  let initialized = false;
  let timescale = null;
  let fragmentCount = 0;
  let lastFragmentSequence = null;
  let lastDecodeTime = null;

  function snapshot() {
    return Object.freeze({
      format: 'fragmented-mp4',
      initialized,
      timescale,
      fragmentCount,
      lastFragmentSequence,
      lastDecodeTime
    });
  }

  function acceptChunk(input) {
    const bytes = toBytes(input);
    if (!bytes.byteLength) throw codedError('MP4_CONTAINER_BYTES_INVALID');
    const boxes = parseBoxes(bytes);
    if (!initialized) {
      timescale = validateInitialization(boxes);
      initialized = true;
      const fragmentBoxes = boxes.filter((box) => !['ftyp', 'moov'].includes(box.type));
      const next = validateFragments(fragmentBoxes, { lastFragmentSequence, lastDecodeTime });
      fragmentCount += next.fragmentCount;
      lastFragmentSequence = next.lastFragmentSequence;
      lastDecodeTime = next.lastDecodeTime;
      return snapshot();
    }
    const next = validateFragments(boxes, { lastFragmentSequence, lastDecodeTime });
    fragmentCount += next.fragmentCount;
    lastFragmentSequence = next.lastFragmentSequence;
    lastDecodeTime = next.lastDecodeTime;
    return snapshot();
  }

  return Object.freeze({ acceptChunk, snapshot });
}

export { codedError, parseBoxes };
