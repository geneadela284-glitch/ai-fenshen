import {
  MEETING_AUDIO_FORMATS,
  MEETING_AUDIO_MAX_BYTES,
  MEETING_AUDIO_MAX_DURATION_MS
} from './meetingAudioContracts.js';

export { MEETING_AUDIO_MAX_BYTES, MEETING_AUDIO_MAX_DURATION_MS };

export const AUDIO_IMPORT_CHUNK_BYTES = 1024 * 1024;
const HEADER_READ_BYTES = 512 * 1024;
const METADATA_READ_BYTES = 16 * 1024 * 1024;
const AUDIO_MIME_TYPES = Object.freeze({
  m4a: ['audio/mp4', 'audio/x-m4a', 'audio/m4a'],
  aac: ['audio/aac', 'audio/aacp', 'audio/x-aac'],
  mp3: ['audio/mpeg', 'audio/mp3', 'audio/x-mpeg'],
  wav: ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave'],
  'webm-opus': ['audio/webm', 'audio/ogg', 'application/ogg']
});
const AUDIO_EXTENSIONS = Object.freeze({
  m4a: ['m4a'],
  aac: ['aac'],
  mp3: ['mp3'],
  wav: ['wav', 'wave'],
  'webm-opus': ['webm', 'opus']
});

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function bytes(value, code = 'AUDIO_BYTES_INVALID') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError(code);
}

function concat(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function asciiAt(value, offset, text) {
  if (offset < 0 || offset + text.length > value.length) return false;
  for (let index = 0; index < text.length; index += 1) if (value[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}

function ascii(value, start = 0, end = value.length) {
  return String.fromCharCode(...value.slice(start, end));
}

function readU16Le(value, offset) {
  return value[offset] | (value[offset + 1] << 8);
}

function readU16Be(value, offset) {
  return (value[offset] << 8) | value[offset + 1];
}

function readU32Le(value, offset) {
  return (value[offset] | (value[offset + 1] << 8) | (value[offset + 2] << 16) | (value[offset + 3] << 24)) >>> 0;
}

function readU32Be(value, offset) {
  return ((value[offset] << 24) | (value[offset + 1] << 16) | (value[offset + 2] << 8) | value[offset + 3]) >>> 0;
}

function readU64Be(value, offset) {
  const high = BigInt(readU32Be(value, offset));
  const low = BigInt(readU32Be(value, offset + 4));
  return Number((high << 32n) | low);
}

function normalizeFile(file) {
  if (!file || typeof file !== 'object') throw codedError('AUDIO_FILE_REQUIRED');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw codedError('AUDIO_FILE_EMPTY');
  if (typeof file.slice !== 'function') throw codedError('AUDIO_FILE_SLICE_UNAVAILABLE');
  if (typeof file.stream !== 'function') throw codedError('AUDIO_STREAM_UNAVAILABLE');
  return file;
}

async function readRange(file, start, end) {
  const slice = file.slice(start, end);
  if (!slice || typeof slice.arrayBuffer !== 'function') throw codedError('AUDIO_FILE_SLICE_UNAVAILABLE');
  try {
    return bytes(await slice.arrayBuffer(), 'AUDIO_HEADER_READ_FAILED');
  } catch (error) {
    if (error?.code) throw error;
    throw codedError('AUDIO_HEADER_READ_FAILED', error);
  }
}

async function readWindow(file, start, length) {
  const size = Number(file.size);
  const from = Math.max(0, Math.min(size, start));
  const to = Math.min(size, from + length);
  return readRange(file, from, to);
}

function mimeBase(file) {
  return String(file.type || '').split(';', 1)[0].trim().toLowerCase();
}

function fileExtension(file) {
  const name = String(file.name || '').trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

function assertMimeAndExtension(file, format) {
  const mime = mimeBase(file);
  if (mime && mime !== 'application/octet-stream' && !AUDIO_MIME_TYPES[format].includes(mime)) {
    throw codedError('AUDIO_MIME_MISMATCH');
  }
  const extension = fileExtension(file);
  if (extension && !AUDIO_EXTENSIONS[format].includes(extension)) throw codedError('AUDIO_EXTENSION_MISMATCH');
}

function parseWav(prefix, fileSize) {
  if (prefix.length < 12 || !asciiAt(prefix, 0, 'RIFF') || !asciiAt(prefix, 8, 'WAVE')) throw codedError('AUDIO_HEADER_INVALID');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= prefix.length) {
    const id = ascii(prefix, offset, offset + 4);
    const length = readU32Le(prefix, offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (id === 'fmt ' && payloadEnd <= prefix.length && length >= 16) {
      fmt = {
        audioFormat: readU16Le(prefix, payloadStart),
        channels: readU16Le(prefix, payloadStart + 2),
        sampleRate: readU32Le(prefix, payloadStart + 4),
        byteRate: readU32Le(prefix, payloadStart + 8),
        blockAlign: readU16Le(prefix, payloadStart + 12),
        bitsPerSample: readU16Le(prefix, payloadStart + 14)
      };
    }
    if (id === 'data') {
      data = { offset: payloadStart, length };
      break;
    }
    offset = payloadEnd + (length % 2);
  }
  if (!fmt || !data || !fmt.channels || !fmt.sampleRate || !fmt.byteRate || !fmt.blockAlign || !fmt.bitsPerSample) throw codedError('AUDIO_METADATA_INVALID');
  if (![1, 0xfffe].includes(fmt.audioFormat)) throw codedError('AUDIO_CODEC_UNSUPPORTED');
  if (data.offset + data.length > fileSize || data.length <= 0) throw codedError('AUDIO_FILE_TRUNCATED');
  const durationMs = Math.max(1, Math.round((data.length / fmt.byteRate) * 1000));
  return { format: 'wav', durationMs, metadata: { channels: fmt.channels, sampleRate: fmt.sampleRate, bitsPerSample: fmt.bitsPerSample } };
}

const MP3_BITRATES = Object.freeze({
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
});
const MP3_SAMPLE_RATES = Object.freeze({
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000]
});

function parseMp3Frame(value, offset) {
  if (offset + 4 > value.length || value[offset] !== 0xff || (value[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (value[offset + 1] >> 3) & 3;
  const layer = (value[offset + 1] >> 1) & 3;
  const bitrateIndex = (value[offset + 2] >> 4) & 0xf;
  const sampleIndex = (value[offset + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const versionGroup = version === 3 ? 3 : 2;
  const bitrate = MP3_BITRATES[versionGroup][bitrateIndex] * 1000;
  const sampleRate = MP3_SAMPLE_RATES[version][sampleIndex];
  const padding = (value[offset + 2] >> 1) & 1;
  const samplesPerFrame = version === 3 ? 1152 : 576;
  const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + padding;
  if (!Number.isSafeInteger(frameLength) || frameLength < 4) return null;
  return { version, bitrate, sampleRate, samplesPerFrame, frameLength };
}

function findMp3Frame(prefix) {
  for (let offset = 0; offset + 4 <= prefix.length; offset += 1) {
    const frame = parseMp3Frame(prefix, offset);
    if (frame && offset + frame.frameLength <= prefix.length) return { ...frame, offset };
  }
  return null;
}

function readSynchsafe(value, offset) {
  return ((value[offset] & 0x7f) << 21) | ((value[offset + 1] & 0x7f) << 14) | ((value[offset + 2] & 0x7f) << 7) | (value[offset + 3] & 0x7f);
}

function mp3FrameMetadata(prefix, frame) {
  const channelMode = (prefix[frame.offset + 3] >> 6) & 3;
  const sideInfo = frame.version === 3 ? (channelMode === 3 ? 17 : 32) : (channelMode === 3 ? 9 : 17);
  const searchStart = frame.offset + 4 + sideInfo;
  for (let offset = searchStart; offset + 16 <= Math.min(prefix.length, frame.offset + frame.frameLength); offset += 1) {
    if (asciiAt(prefix, offset, 'Xing') || asciiAt(prefix, offset, 'Info')) {
      const flags = readU32Be(prefix, offset + 4);
      if ((flags & 1) && offset + 12 <= prefix.length) return { frames: readU32Be(prefix, offset + 8) };
    }
  }
  if (frame.offset + 50 <= prefix.length && asciiAt(prefix, frame.offset + 36, 'VBRI')) return { frames: readU32Be(prefix, frame.offset + 50) };
  return null;
}

function parseMp3(prefix, fileSize) {
  let frame = findMp3Frame(prefix);
  if (!frame && asciiAt(prefix, 0, 'ID3') && prefix.length >= 10) {
    const skip = 10 + readSynchsafe(prefix, 6);
    const shifted = findMp3Frame(prefix.slice(Math.min(skip, prefix.length)));
    if (shifted) frame = { ...shifted, offset: shifted.offset + Math.min(skip, prefix.length) };
  }
  if (!frame) throw codedError('AUDIO_HEADER_INVALID');
  const metadata = mp3FrameMetadata(prefix, frame);
  const seconds = metadata?.frames
    ? (metadata.frames * frame.samplesPerFrame) / frame.sampleRate
    : ((Math.max(0, fileSize - frame.offset) * 8) / frame.bitrate);
  return {
    format: 'mp3',
    durationMs: Math.max(1, Math.round(seconds * 1000)),
    metadata: { sampleRate: frame.sampleRate, bitrate: frame.bitrate, variableBitrate: Boolean(metadata?.frames) }
  };
}

function parseAdtsFrame(value, offset) {
  if (offset + 7 > value.length || value[offset] !== 0xff || (value[offset + 1] & 0xf6) !== 0xf0) return null;
  const layer = (value[offset + 1] >> 1) & 3;
  const sampleIndex = (value[offset + 2] >> 2) & 0xf;
  const channelConfig = ((value[offset + 2] & 1) << 2) | ((value[offset + 3] >> 6) & 3);
  const frameLength = ((value[offset + 3] & 3) << 11) | (value[offset + 4] << 3) | ((value[offset + 5] >> 5) & 7);
  if (layer !== 0 || sampleIndex === 15 || channelConfig === 0 || frameLength < 7) return null;
  const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const sampleRate = sampleRates[sampleIndex];
  if (!sampleRate) return null;
  const samplesPerFrame = 1024 * ((value[offset + 6] & 3) + 1);
  return { frameLength, sampleRate, samplesPerFrame };
}

async function countAdtsFrames(file, firstFrame) {
  const reader = file.stream().getReader();
  let buffer = new Uint8Array(0);
  let frames = 0;
  let durationMs = 0;
  let readBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = bytes(next.value, 'AUDIO_STREAM_CHUNK_INVALID');
      readBytes += chunk.length;
      buffer = concat(buffer, chunk);
      let offset = 0;
      while (offset + 7 <= buffer.length) {
        const frame = parseAdtsFrame(buffer, offset);
        if (!frame) {
          offset += 1;
          continue;
        }
        if (offset + frame.frameLength > buffer.length) break;
        frames += 1;
        durationMs += Math.round((frame.samplesPerFrame / frame.sampleRate) * 1000);
        offset += frame.frameLength;
      }
      buffer = buffer.slice(offset);
      if (buffer.length > 8192) throw codedError('AUDIO_STREAM_CORRUPT');
    }
  } finally {
    reader.releaseLock?.();
  }
  if (!frames) throw codedError('AUDIO_HEADER_INVALID');
  const estimatedFrames = Math.max(frames, Math.floor(Number(file.size) / firstFrame.frameLength));
  return Math.max(durationMs, Math.round(estimatedFrames * (firstFrame.samplesPerFrame / firstFrame.sampleRate) * 1000));
}

function findBox(buffer, type) {
  for (let typeOffset = 4; typeOffset + 4 <= buffer.length; typeOffset += 1) {
    if (!asciiAt(buffer, typeOffset, type)) continue;
    const start = typeOffset - 4;
    const size32 = readU32Be(buffer, start);
    let size = size32;
    let header = 8;
    if (size32 === 1 && start + 16 <= buffer.length) {
      size = readU64Be(buffer, start + 8);
      header = 16;
    }
    if (size >= header && start >= 0 && start + size <= buffer.length) return { start, size, header, box: buffer.slice(start, start + size), payload: buffer.slice(start + header, start + size) };
  }
  return null;
}

function findM4aBox(buffer, type) {
  let cursor = 0;
  while (cursor + 8 <= buffer.length) {
    const size = readU32Be(buffer, cursor);
    const currentType = ascii(buffer, cursor + 4, cursor + 8);
    if (size >= 8 && cursor + size <= buffer.length) {
      if (currentType === type) return { start: cursor, size, header: 8, box: buffer.slice(cursor, cursor + size), payload: buffer.slice(cursor + 8, cursor + size) };
      cursor += size;
    } else break;
  }
  return findBox(buffer, type);
}

function parseM4a(prefix, tail, fileSize) {
  if (prefix.length < 12 || !asciiAt(prefix, 4, 'ftyp')) throw codedError('AUDIO_HEADER_INVALID');
  const majorBrand = ascii(prefix, 8, 12);
  const brands = [majorBrand];
  for (let offset = 16; offset + 4 <= Math.min(prefix.length, 256); offset += 4) brands.push(ascii(prefix, offset, offset + 4));
  if (!brands.some((brand) => ['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42'].includes(brand))) throw codedError('AUDIO_CONTAINER_UNSUPPORTED');
  const moov = findM4aBox(prefix, 'moov') || findM4aBox(tail, 'moov');
  if (!moov) throw codedError('AUDIO_METADATA_INVALID');
  const handlerBoxes = [];
  let cursor = 0;
  while (cursor + 8 <= moov.payload.length) {
    const nested = findM4aBox(moov.payload.slice(cursor), 'hdlr');
    if (!nested) break;
    handlerBoxes.push(nested);
    cursor += Math.max(8, nested.start + nested.size);
  }
  if (!handlerBoxes.some((boxValue) => asciiAt(boxValue.payload, 8, 'soun')) && !asciiAt(moov.box, 0, 'soun')) throw codedError('AUDIO_CODEC_UNSUPPORTED');
  const mvhd = findBox(moov.box, 'mvhd');
  if (!mvhd || mvhd.payload.length < 20) throw codedError('AUDIO_METADATA_INVALID');
  const version = mvhd.payload[0];
  const timescaleOffset = version === 1 ? 20 : 12;
  const durationOffset = version === 1 ? 24 : 16;
  const timescale = readU32Be(mvhd.payload, timescaleOffset);
  const duration = version === 1 ? readU64Be(mvhd.payload, durationOffset) : readU32Be(mvhd.payload, durationOffset);
  if (!timescale || !duration || !Number.isFinite(duration)) throw codedError('AUDIO_METADATA_INVALID');
  if (moov.start + moov.size > fileSize && fileSize <= METADATA_READ_BYTES) throw codedError('AUDIO_FILE_TRUNCATED');
  return { format: 'm4a', durationMs: Math.max(1, Math.round((duration / timescale) * 1000)), metadata: { timescale, duration } };
}

function readEbmlVint(value, offset, { id = false } = {}) {
  if (offset >= value.length) return null;
  const first = value[offset];
  let width = 1;
  let mask = 0x80;
  while (width <= 8 && !(first & mask)) {
    width += 1;
    mask >>= 1;
  }
  if (width > 8 || offset + width > value.length) return null;
  let number = id ? first : first & (mask - 1);
  for (let index = 1; index < width; index += 1) number = number * 256 + value[offset + index];
  if (!id && number === (2 ** (7 * width)) - 1) return { width, value: -1 };
  return { width, value: number };
}

const EBML_CONTAINERS = new Set([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0x1f43b675]);

function walkEbml(value, start, end, callback) {
  let offset = start;
  while (offset < end) {
    const id = readEbmlVint(value, offset, { id: true });
    if (!id) break;
    const size = readEbmlVint(value, offset + id.width);
    if (!size || size.value < 0 || offset + id.width + size.width + size.value > end) break;
    const payloadStart = offset + id.width + size.width;
    const payloadEnd = payloadStart + size.value;
    callback({ id: id.value, payloadStart, payloadEnd });
    if (EBML_CONTAINERS.has(id.value)) walkEbml(value, payloadStart, payloadEnd, callback);
    offset = payloadEnd;
  }
}

function parseWebm(buffer) {
  if (buffer.length < 8 || readU32Be(buffer, 0) !== 0x1a45dfa3 || !asciiAt(buffer, 0, '\x1a\x45\xdf\xa3')) throw codedError('AUDIO_HEADER_INVALID');
  if (!ascii(buffer).includes('webm')) throw codedError('AUDIO_CONTAINER_UNSUPPORTED');
  let timecodeScale = 1_000_000;
  let duration = null;
  let opus = false;
  walkEbml(buffer, 0, buffer.length, (element) => {
    const payload = buffer.slice(element.payloadStart, element.payloadEnd);
    if (element.id === 0x2ad7b1) {
      let value = 0;
      for (const byte of payload) value = value * 256 + byte;
      timecodeScale = value;
    } else if (element.id === 0x4489 && payload.length === 8) {
      duration = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat64(0, false);
    } else if (element.id === 0x86 && ascii(payload) === 'A_OPUS') {
      opus = true;
    }
  });
  if (!opus) throw codedError('AUDIO_CODEC_UNSUPPORTED');
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(timecodeScale) || timecodeScale <= 0) throw codedError('AUDIO_METADATA_INVALID');
  return { format: 'webm-opus', durationMs: Math.max(1, Math.round(duration * timecodeScale / 1_000_000)), metadata: { timecodeScale, duration } };
}

function detectFormat(prefix) {
  if (prefix.length >= 12 && asciiAt(prefix, 0, 'RIFF') && asciiAt(prefix, 8, 'WAVE')) return 'wav';
  if (prefix.length >= 12 && asciiAt(prefix, 4, 'ftyp')) return 'm4a';
  if (prefix.length >= 4 && readU32Be(prefix, 0) === 0x1a45dfa3) return 'webm-opus';
  if (findMp3Frame(prefix)) return 'mp3';
  if (parseAdtsFrame(prefix, 0)) return 'aac';
  throw codedError('AUDIO_HEADER_INVALID');
}

function canonicalMime(format, provided) {
  return mimeBase({ type: provided }) || ({ m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', 'webm-opus': 'audio/webm' }[format]);
}

export async function validateAudioFile(inputFile) {
  const file = normalizeFile(inputFile);
  const fileSize = Number(file.size);
  if (fileSize > MEETING_AUDIO_MAX_BYTES) throw codedError('AUDIO_FILE_TOO_LARGE');
  const prefix = await readWindow(file, 0, Math.min(fileSize, HEADER_READ_BYTES));
  const format = detectFormat(prefix);
  let parsed;
  if (format === 'wav') parsed = parseWav(prefix, fileSize);
  else if (format === 'mp3') parsed = parseMp3(prefix, fileSize);
  else if (format === 'aac') parsed = { format, durationMs: await countAdtsFrames(file, parseAdtsFrame(prefix, 0)), metadata: {} };
  else if (format === 'm4a') {
    const tail = fileSize > METADATA_READ_BYTES ? await readWindow(file, fileSize - METADATA_READ_BYTES, METADATA_READ_BYTES) : prefix;
    parsed = parseM4a(prefix, tail, fileSize);
  } else {
    const tail = fileSize > HEADER_READ_BYTES ? await readWindow(file, fileSize - HEADER_READ_BYTES, HEADER_READ_BYTES) : prefix;
    const candidate = tail.length > prefix.length && asciiAt(tail, 0, '\x1a\x45\xdf\xa3') ? tail : prefix;
    parsed = parseWebm(candidate);
  }
  assertMimeAndExtension(file, parsed.format);
  if (!Number.isSafeInteger(parsed.durationMs) || parsed.durationMs <= 0) throw codedError('AUDIO_DURATION_INVALID');
  if (parsed.durationMs > MEETING_AUDIO_MAX_DURATION_MS) throw codedError('AUDIO_DURATION_TOO_LONG');
  return Object.freeze({
    format: parsed.format,
    mimeType: canonicalMime(parsed.format, file.type),
    originalFileName: String(file.name || '').trim(),
    byteLength: fileSize,
    durationMs: parsed.durationMs,
    metadata: Object.freeze({ ...(parsed.metadata || {}) }),
    fileIdentity: `${fileSize}:${Number(file.lastModified || 0)}:${String(file.name || '')}:${mimeBase(file)}`
  });
}

export async function* streamAudioFile(fileInput, { chunkSize = AUDIO_IMPORT_CHUNK_BYTES, signal } = {}) {
  const file = normalizeFile(fileInput);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw codedError('AUDIO_CHUNK_SIZE_INVALID');
  const reader = file.stream().getReader();
  let pending = new Uint8Array(0);
  try {
    while (true) {
      if (signal?.aborted) throw codedError('IMPORT_CANCELLED');
      const next = await reader.read();
      if (next.done) break;
      const chunk = bytes(next.value, 'AUDIO_STREAM_CHUNK_INVALID');
      pending = concat(pending, chunk);
      while (pending.length >= chunkSize) {
        if (signal?.aborted) throw codedError('IMPORT_CANCELLED');
        yield pending.slice(0, chunkSize);
        pending = pending.slice(chunkSize);
      }
    }
    if (pending.length) yield pending;
  } finally {
    reader.releaseLock?.();
  }
}

export class StreamingSha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buffer = new Uint8Array(0);
    this.length = 0;
  }

  update(value) {
    const input = bytes(value);
    this.length += input.length;
    this.buffer = concat(this.buffer, input);
    while (this.buffer.length >= 64) {
      this.#process(this.buffer.slice(0, 64));
      this.buffer = this.buffer.slice(64);
    }
    return this;
  }

  #process(block) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) words[index] = readU32Be(block, index * 4);
    for (let index = 16; index < 64; index += 1) {
      const valueA = words[index - 15];
      const valueB = words[index - 2];
      const sigma0 = ((valueA >>> 7) | (valueA << 25)) ^ ((valueA >>> 18) | (valueA << 14)) ^ (valueA >>> 3);
      const sigma1 = ((valueB >>> 17) | (valueB << 15)) ^ ((valueB >>> 19) | (valueB << 13)) ^ (valueB >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + constants[index] + words[index]) >>> 0;
      const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }

  digestHex() {
    const bitLength = this.length * 8;
    const paddedLength = ((this.buffer.length + 9 + 63) >> 6) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(this.buffer);
    padded[this.buffer.length] = 0x80;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    padded[padded.length - 8] = (high >>> 24) & 0xff;
    padded[padded.length - 7] = (high >>> 16) & 0xff;
    padded[padded.length - 6] = (high >>> 8) & 0xff;
    padded[padded.length - 5] = high & 0xff;
    padded[padded.length - 4] = (low >>> 24) & 0xff;
    padded[padded.length - 3] = (low >>> 16) & 0xff;
    padded[padded.length - 2] = (low >>> 8) & 0xff;
    padded[padded.length - 1] = low & 0xff;
    for (let offset = 0; offset < padded.length; offset += 64) this.#process(padded.slice(offset, offset + 64));
    return [...this.h].map((word) => word.toString(16).padStart(8, '0')).join('');
  }
}

export async function checksumAudioFile(file, { signal } = {}) {
  const hasher = new StreamingSha256();
  for await (const chunk of streamAudioFile(file, { signal })) hasher.update(chunk);
  return hasher.digestHex();
}

export { codedError };
