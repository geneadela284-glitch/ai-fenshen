import { parseBoxes } from '../stage3a/mp4Container.js';

const UINT32_MAX = 0xffff_ffff;
const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf']);
const IGNORABLE_MEDIA_BOXES = new Set(['styp', 'sidx', 'ssix', 'emsg', 'free', 'skip']);
const inspectionMetadata = new WeakMap();

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw codedError('INDEPENDENT_MP4_BYTES_INVALID');
}

function readUInt16(bytes, offset, end = bytes.byteLength) {
  if (offset < 0 || offset + 2 > end) throw codedError('INDEPENDENT_MP4_BYTES_INVALID');
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUInt24(bytes, offset, end = bytes.byteLength) {
  if (offset < 0 || offset + 3 > end) throw codedError('INDEPENDENT_MP4_BYTES_INVALID');
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function readUInt32(bytes, offset, end = bytes.byteLength) {
  if (offset < 0 || offset + 4 > end) throw codedError('INDEPENDENT_MP4_BYTES_INVALID');
  return ((bytes[offset] * 0x1000000)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]) >>> 0;
}

function readUInt64(bytes, offset, end = bytes.byteLength) {
  if (offset < 0 || offset + 8 > end) throw codedError('INDEPENDENT_MP4_BYTES_INVALID');
  const value = (BigInt(readUInt32(bytes, offset, end)) << 32n)
    | BigInt(readUInt32(bytes, offset + 4, end));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw codedError('INDEPENDENT_MP4_TIMELINE_OVERFLOW');
  return Number(value);
}

function writeUInt32(bytes, offset, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX || offset + 4 > bytes.byteLength) {
    throw codedError('INDEPENDENT_MP4_TIMELINE_OVERFLOW');
  }
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeUInt64(bytes, offset, value) {
  if (!Number.isSafeInteger(value) || value < 0 || offset + 8 > bytes.byteLength) {
    throw codedError('INDEPENDENT_MP4_TIMELINE_OVERFLOW');
  }
  const big = BigInt(value);
  writeUInt32(bytes, offset, Number((big >> 32n) & 0xffff_ffffn));
  writeUInt32(bytes, offset + 4, Number(big & 0xffff_ffffn));
}

function ascii(bytes, offset, length, end = bytes.byteLength) {
  if (offset < 0 || offset + length > end) throw codedError('INDEPENDENT_MP4_BYTES_INVALID');
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function parseWithin(bytes, start = 0, end = bytes.byteLength, code = 'INDEPENDENT_MP4_BYTES_INVALID') {
  try {
    return parseBoxes(bytes, start, end);
  } catch (error) {
    if (error?.code?.startsWith('INDEPENDENT_MP4_')) throw error;
    throw codedError(code, error);
  }
}

function children(box, code = 'INDEPENDENT_MP4_BYTES_INVALID') {
  return parseWithin(box.bytes, box.payloadStart, box.payloadEnd, code);
}

function descendants(box, type, code) {
  const matches = [];
  for (const child of children(box, code)) {
    if (child.type === type) matches.push(child);
    if (CONTAINER_TYPES.has(child.type)) matches.push(...descendants(child, type, code));
  }
  return matches;
}

function firstChild(box, type, code) {
  return children(box, code).find((candidate) => candidate.type === type) || null;
}

function concatenate(parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function bytesHex(bytes) {
  let output = '';
  for (const value of bytes) output += value.toString(16).padStart(2, '0');
  return output;
}

function parseTrackId(tkhd) {
  const version = tkhd.bytes[tkhd.payloadStart];
  const offset = version === 1 ? tkhd.payloadStart + 20 : tkhd.payloadStart + 12;
  const trackId = readUInt32(tkhd.bytes, offset, tkhd.payloadEnd);
  if (!trackId) throw codedError('INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
  return trackId;
}

function parseTimescale(mdhd) {
  const version = mdhd.bytes[mdhd.payloadStart];
  const offset = version === 1 ? mdhd.payloadStart + 20 : mdhd.payloadStart + 12;
  const timescale = readUInt32(mdhd.bytes, offset, mdhd.payloadEnd);
  if (!timescale) throw codedError('INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
  return timescale;
}

function parseHandler(hdlr) {
  return ascii(hdlr.bytes, hdlr.payloadStart + 8, 4, hdlr.payloadEnd);
}

function parseSampleEntry(stsd) {
  const entryCount = readUInt32(stsd.bytes, stsd.payloadStart + 4, stsd.payloadEnd);
  if (!entryCount) throw codedError('INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
  const entries = parseWithin(
    stsd.bytes,
    stsd.payloadStart + 8,
    stsd.payloadEnd,
    'INDEPENDENT_MP4_AUDIO_TRACK_INVALID'
  );
  const mp4a = entries.find((entry) => entry.type === 'mp4a');
  if (!mp4a) throw codedError('INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
  return new Uint8Array(mp4a.bytes.slice(mp4a.offset, mp4a.offset + mp4a.size));
}

function parseTrex(moov, trackId) {
  const trexBoxes = descendants(moov, 'trex', 'INDEPENDENT_MP4_INITIALIZATION_INVALID');
  for (const trex of trexBoxes) {
    const currentTrackId = readUInt32(trex.bytes, trex.payloadStart + 4, trex.payloadEnd);
    if (currentTrackId !== trackId) continue;
    return Object.freeze({
      trackId,
      defaultSampleDescriptionIndex: readUInt32(trex.bytes, trex.payloadStart + 8, trex.payloadEnd),
      defaultSampleDuration: readUInt32(trex.bytes, trex.payloadStart + 12, trex.payloadEnd),
      defaultSampleSize: readUInt32(trex.bytes, trex.payloadStart + 16, trex.payloadEnd),
      defaultSampleFlags: readUInt32(trex.bytes, trex.payloadStart + 20, trex.payloadEnd)
    });
  }
  throw codedError('INDEPENDENT_MP4_INITIALIZATION_INVALID');
}

function parseAudioTrack(moov) {
  try {
    for (const trak of children(moov, 'INDEPENDENT_MP4_INITIALIZATION_INVALID').filter((box) => box.type === 'trak')) {
      const tkhd = firstChild(trak, 'tkhd', 'INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
      const mdia = firstChild(trak, 'mdia', 'INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
      if (!tkhd || !mdia) continue;
      const hdlr = firstChild(mdia, 'hdlr', 'INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
      if (!hdlr || parseHandler(hdlr) !== 'soun') continue;
      const mdhd = firstChild(mdia, 'mdhd', 'INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
      const stsd = descendants(mdia, 'stsd', 'INDEPENDENT_MP4_AUDIO_TRACK_INVALID')[0];
      if (!mdhd || !stsd) throw codedError('INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
      const trackId = parseTrackId(tkhd);
      const timescale = parseTimescale(mdhd);
      const sampleEntry = parseSampleEntry(stsd);
      const trex = parseTrex(moov, trackId);
      const trackFingerprint = [
        'audio',
        'soun',
        timescale,
        trackId,
        trex.defaultSampleDescriptionIndex,
        trex.defaultSampleDuration,
        trex.defaultSampleSize,
        trex.defaultSampleFlags,
        bytesHex(sampleEntry)
      ].join(':');
      return Object.freeze({
        handler: 'soun',
        trackId,
        timescale,
        sampleEntry,
        trex,
        trackFingerprint
      });
    }
  } catch (error) {
    if (error?.code?.startsWith('INDEPENDENT_MP4_')) throw error;
    throw codedError('INDEPENDENT_MP4_AUDIO_TRACK_INVALID', error);
  }
  throw codedError('INDEPENDENT_MP4_AUDIO_TRACK_INVALID');
}

function parseTfhd(tfhd) {
  const flags = readUInt24(tfhd.bytes, tfhd.payloadStart + 1, tfhd.payloadEnd);
  let cursor = tfhd.payloadStart + 4;
  const trackId = readUInt32(tfhd.bytes, cursor, tfhd.payloadEnd);
  cursor += 4;
  if (flags & 0x000001) cursor += 8;
  if (flags & 0x000002) cursor += 4;
  let defaultSampleDuration = 0;
  if (flags & 0x000008) {
    defaultSampleDuration = readUInt32(tfhd.bytes, cursor, tfhd.payloadEnd);
    cursor += 4;
  }
  if (flags & 0x000010) cursor += 4;
  if (flags & 0x000020) cursor += 4;
  if (cursor > tfhd.payloadEnd) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  return Object.freeze({ trackId, defaultSampleDuration });
}

function parseTfdt(tfdt) {
  const version = tfdt.bytes[tfdt.payloadStart];
  if (![0, 1].includes(version)) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  const valueOffset = tfdt.payloadStart + 4;
  const decodeTime = version === 1
    ? readUInt64(tfdt.bytes, valueOffset, tfdt.payloadEnd)
    : readUInt32(tfdt.bytes, valueOffset, tfdt.payloadEnd);
  return Object.freeze({ version, valueOffset, decodeTime });
}

function parseTrunDuration(trun, defaultSampleDuration) {
  const flags = readUInt24(trun.bytes, trun.payloadStart + 1, trun.payloadEnd);
  const sampleCount = readUInt32(trun.bytes, trun.payloadStart + 4, trun.payloadEnd);
  if (!sampleCount) throw codedError('INDEPENDENT_MP4_DURATION_UNRESOLVED');
  let cursor = trun.payloadStart + 8;
  if (flags & 0x000001) cursor += 4;
  if (flags & 0x000004) cursor += 4;
  let duration = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    let sampleDuration = defaultSampleDuration;
    if (flags & 0x000100) {
      sampleDuration = readUInt32(trun.bytes, cursor, trun.payloadEnd);
      cursor += 4;
    }
    if (!sampleDuration) throw codedError('INDEPENDENT_MP4_DURATION_UNRESOLVED');
    duration += sampleDuration;
    if (!Number.isSafeInteger(duration)) throw codedError('INDEPENDENT_MP4_DURATION_UNRESOLVED');
    if (flags & 0x000200) cursor += 4;
    if (flags & 0x000400) cursor += 4;
    if (flags & 0x000800) cursor += 4;
    if (cursor > trun.payloadEnd) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  }
  if (cursor > trun.payloadEnd) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  return duration;
}

function parseFragment(moof, track) {
  const mfhd = firstChild(moof, 'mfhd', 'INDEPENDENT_MP4_MEDIA_INVALID');
  if (!mfhd) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  const sequence = readUInt32(mfhd.bytes, mfhd.payloadStart + 4, mfhd.payloadEnd);
  if (!sequence) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  const trafs = children(moof, 'INDEPENDENT_MP4_MEDIA_INVALID').filter((box) => box.type === 'traf');
  let selected = null;
  for (const traf of trafs) {
    const tfhd = firstChild(traf, 'tfhd', 'INDEPENDENT_MP4_MEDIA_INVALID');
    if (!tfhd) continue;
    const header = parseTfhd(tfhd);
    if (header.trackId === track.trackId) {
      selected = { traf, tfhd, header };
      break;
    }
  }
  if (!selected) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  const tfdt = firstChild(selected.traf, 'tfdt', 'INDEPENDENT_MP4_MEDIA_INVALID');
  if (!tfdt) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  const timeline = parseTfdt(tfdt);
  const truns = children(selected.traf, 'INDEPENDENT_MP4_MEDIA_INVALID').filter((box) => box.type === 'trun');
  if (!truns.length) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  const defaultSampleDuration = selected.header.defaultSampleDuration || track.trex.defaultSampleDuration;
  const durationTicks = truns.reduce(
    (total, trun) => total + parseTrunDuration(trun, defaultSampleDuration),
    0
  );
  if (!durationTicks) throw codedError('INDEPENDENT_MP4_DURATION_UNRESOLVED');
  return Object.freeze({
    sequence,
    decodeTime: timeline.decodeTime,
    durationTicks
  });
}

function parseMedia(mediaBytes, track) {
  let boxes;
  try {
    boxes = parseWithin(mediaBytes, 0, mediaBytes.byteLength, 'INDEPENDENT_MP4_MEDIA_INVALID');
  } catch (error) {
    if (error?.code === 'INDEPENDENT_MP4_DURATION_UNRESOLVED') throw error;
    throw codedError('INDEPENDENT_MP4_MEDIA_INVALID', error);
  }
  const fragments = [];
  for (let index = 0; index < boxes.length; index += 1) {
    const current = boxes[index];
    if (IGNORABLE_MEDIA_BOXES.has(current.type)) continue;
    if (current.type !== 'moof') throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
    const next = boxes[index + 1];
    if (!next || next.type !== 'mdat') throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
    try {
      fragments.push(parseFragment(current, track));
    } catch (error) {
      if (error?.code === 'INDEPENDENT_MP4_DURATION_UNRESOLVED') throw error;
      if (error?.code === 'INDEPENDENT_MP4_TIMELINE_OVERFLOW') throw error;
      throw codedError('INDEPENDENT_MP4_MEDIA_INVALID', error);
    }
    index += 1;
  }
  if (!fragments.length) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  for (let index = 1; index < fragments.length; index += 1) {
    if (fragments[index].decodeTime < fragments[index - 1].decodeTime) {
      throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
    }
  }
  return Object.freeze(fragments);
}

export function inspectIndependentMp4Segment(input) {
  let bytes;
  let topLevel;
  try {
    bytes = toBytes(input);
    if (!bytes.byteLength) throw codedError('INDEPENDENT_MP4_BYTES_INVALID');
    topLevel = parseWithin(bytes);
  } catch (error) {
    if (error?.code === 'INDEPENDENT_MP4_BYTES_INVALID') throw error;
    throw codedError('INDEPENDENT_MP4_BYTES_INVALID', error);
  }

  const ftypIndex = topLevel.findIndex((box) => box.type === 'ftyp');
  const moovIndex = topLevel.findIndex((box) => box.type === 'moov');
  if (ftypIndex !== 0 || moovIndex <= ftypIndex) {
    throw codedError('INDEPENDENT_MP4_INITIALIZATION_INVALID');
  }
  if (topLevel.filter((box) => box.type === 'ftyp').length !== 1
    || topLevel.filter((box) => box.type === 'moov').length !== 1) {
    throw codedError('INDEPENDENT_MP4_INITIALIZATION_INVALID');
  }
  const moov = topLevel[moovIndex];
  let track;
  try {
    track = parseAudioTrack(moov);
  } catch (error) {
    if (error?.code === 'INDEPENDENT_MP4_AUDIO_TRACK_INVALID') throw error;
    throw codedError('INDEPENDENT_MP4_INITIALIZATION_INVALID', error);
  }
  const mediaStart = moov.offset + moov.size;
  if (mediaStart >= bytes.byteLength) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  const initBytes = new Uint8Array(bytes.slice(0, mediaStart));
  const mediaBytes = new Uint8Array(bytes.slice(mediaStart));
  const fragments = parseMedia(mediaBytes, track);
  const durationTicks = fragments.reduce((total, fragment) => total + fragment.durationTicks, 0);
  if (!durationTicks || !Number.isSafeInteger(durationTicks)) {
    throw codedError('INDEPENDENT_MP4_DURATION_UNRESOLVED');
  }
  const durationMs = Math.round((durationTicks * 1_000) / track.timescale);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw codedError('INDEPENDENT_MP4_DURATION_UNRESOLVED');
  }
  const inspection = Object.freeze({
    initBytes,
    mediaBytes,
    timescale: track.timescale,
    trackId: track.trackId,
    trackFingerprint: track.trackFingerprint,
    fragmentCount: fragments.length,
    firstDecodeTime: fragments[0].decodeTime,
    durationTicks,
    durationMs
  });
  inspectionMetadata.set(inspection, Object.freeze({ track, fragments }));
  return inspection;
}

export function assertCompatibleIndependentMp4(reference, candidate) {
  if (
    !reference
    || !candidate
    || reference.timescale !== candidate.timescale
    || reference.trackId !== candidate.trackId
    || reference.trackFingerprint !== candidate.trackFingerprint
  ) {
    throw codedError('INDEPENDENT_MP4_TRACK_INCOMPATIBLE');
  }
  return true;
}

function metadataFor(inspection) {
  const known = inspectionMetadata.get(inspection);
  if (known) return known;
  if (!inspection?.initBytes || !inspection?.mediaBytes) {
    throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  }
  const reinspection = inspectIndependentMp4Segment(concatenate([
    toBytes(inspection.initBytes),
    toBytes(inspection.mediaBytes)
  ]));
  assertCompatibleIndependentMp4(inspection, reinspection);
  return inspectionMetadata.get(reinspection);
}

export function rebaseIndependentMp4Media({ inspection, firstSequence, firstDecodeTime } = {}) {
  if (!Number.isSafeInteger(firstSequence)
    || firstSequence < 1
    || !Number.isSafeInteger(firstDecodeTime)
    || firstDecodeTime < 0) {
    throw codedError('INDEPENDENT_MP4_TIMELINE_OVERFLOW');
  }
  const metadata = metadataFor(inspection);
  if (firstSequence + inspection.fragmentCount - 1 > UINT32_MAX
    || firstDecodeTime + inspection.durationTicks > Number.MAX_SAFE_INTEGER) {
    throw codedError('INDEPENDENT_MP4_TIMELINE_OVERFLOW');
  }
  const mediaBytes = toBytes(inspection.mediaBytes);
  const boxes = parseWithin(mediaBytes, 0, mediaBytes.byteLength, 'INDEPENDENT_MP4_MEDIA_INVALID');
  const decodeDelta = firstDecodeTime - inspection.firstDecodeTime;
  let fragmentIndex = 0;
  for (const moof of boxes.filter((box) => box.type === 'moof')) {
    const mfhd = firstChild(moof, 'mfhd', 'INDEPENDENT_MP4_MEDIA_INVALID');
    if (!mfhd) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
    writeUInt32(mediaBytes, mfhd.payloadStart + 4, firstSequence + fragmentIndex);
    const tfdtBoxes = descendants(moof, 'tfdt', 'INDEPENDENT_MP4_MEDIA_INVALID');
    if (!tfdtBoxes.length) throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
    for (const tfdt of tfdtBoxes) {
      const parsed = parseTfdt(tfdt);
      const rebased = parsed.decodeTime + decodeDelta;
      if (!Number.isSafeInteger(rebased) || rebased < 0) {
        throw codedError('INDEPENDENT_MP4_TIMELINE_OVERFLOW');
      }
      if (parsed.version === 0) writeUInt32(mediaBytes, parsed.valueOffset, rebased);
      else writeUInt64(mediaBytes, parsed.valueOffset, rebased);
    }
    fragmentIndex += 1;
  }
  if (fragmentIndex !== metadata.fragments.length || fragmentIndex !== inspection.fragmentCount) {
    throw codedError('INDEPENDENT_MP4_MEDIA_INVALID');
  }
  return Object.freeze({
    mediaBytes,
    nextSequence: firstSequence + inspection.fragmentCount,
    nextDecodeTime: firstDecodeTime + inspection.durationTicks
  });
}

export { codedError };
