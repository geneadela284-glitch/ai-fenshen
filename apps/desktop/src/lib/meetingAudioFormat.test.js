import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEETING_AUDIO_MAX_BYTES,
  MEETING_AUDIO_MAX_DURATION_MS,
  StreamingSha256,
  streamAudioFile,
  validateAudioFile
} from './meetingAudioFormat.js';

function u32(value) {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u16(value) {
  return Uint8Array.from([(value >>> 8) & 0xff, value & 0xff]);
}

function ascii(value) {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function box(type, payload) {
  return concat(u32(payload.length + 8), ascii(type), payload);
}

function ebml(id, payload) {
  const size = payload.length;
  const sizeBytes = size < 0x7f ? Uint8Array.from([0x80 | size]) : Uint8Array.from([0x40 | ((size >>> 8) & 0x3f), size & 0xff]);
  return concat(id, sizeBytes, payload);
}

function wavBytes() {
  const data = Uint8Array.from({ length: 32 }, (_, index) => index);
  return concat(
    ascii('RIFF'), u32le(36 + data.length), ascii('WAVE'),
    ascii('fmt '), u32le(16), u16le(1), u16le(1), u32le(8000), u32le(16000), u16le(2), u16le(16),
    ascii('data'), u32le(data.length), data
  );
}

function u32le(value) {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function u16le(value) {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]);
}

function f64be(value) {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setFloat64(0, value, false);
  return output;
}

function mp3Bytes() {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return frame;
}

function aacBytes() {
  return Uint8Array.from([
    0xff, 0xf1, 0x50, 0x80, 0x00, 0xe0, 0xfc,
    0xff, 0xf1, 0x50, 0x80, 0x00, 0xe0, 0xfc
  ]);
}

function m4aBytes() {
  const mvhd = concat(
    Uint8Array.from([0, 0, 0, 0]),
    u32(0), u32(0), u32(1000), u32(2000),
    new Uint8Array(80)
  );
  const hdlr = concat(new Uint8Array(8), ascii('soun'), new Uint8Array(12));
  const trak = box('trak', box('mdia', box('hdlr', hdlr)));
  const moov = box('moov', concat(box('mvhd', mvhd), trak));
  return concat(box('ftyp', concat(ascii('M4A '), u32(0), ascii('M4A '))), moov, box('mdat', new Uint8Array(16)));
}

function webmBytes() {
  const doctype = ebml(Uint8Array.from([0x42, 0x82]), ascii('webm'));
  const ebmlHeader = ebml(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), doctype);
  const timecodeScale = ebml(Uint8Array.from([0x2a, 0xd7, 0xb1]), Uint8Array.from([0x0f, 0x42, 0x40]));
  const duration = ebml(Uint8Array.from([0x44, 0x89]), f64be(2000));
  const info = ebml(Uint8Array.from([0x15, 0x49, 0xa9, 0x66]), concat(timecodeScale, duration));
  const codec = ebml(Uint8Array.from([0x86]), ascii('A_OPUS'));
  const tracks = ebml(Uint8Array.from([0x16, 0x54, 0xae, 0x6b]), ebml(Uint8Array.from([0xae]), codec));
  return concat(ebmlHeader, ebml(Uint8Array.from([0x18, 0x53, 0x80, 0x67]), concat(info, tracks, new Uint8Array(8))));
}

function file(bytes, name, type, { size = bytes.length } = {}) {
  const blob = new Blob([bytes], { type });
  Object.defineProperty(blob, 'name', { value: name });
  if (size !== bytes.length) Object.defineProperty(blob, 'size', { value: size });
  return blob;
}

test('preflight accepts M4A, AAC, MP3, WAV and WebM/Opus by header and metadata', async () => {
  const fixtures = [
    [m4aBytes(), 'meeting.m4a', 'audio/mp4', 'm4a'],
    [aacBytes(), 'meeting.aac', 'audio/aac', 'aac'],
    [mp3Bytes(), 'meeting.mp3', 'audio/mpeg', 'mp3'],
    [wavBytes(), 'meeting.wav', 'audio/wav', 'wav'],
    [webmBytes(), 'meeting.webm', 'audio/webm', 'webm-opus']
  ];
  for (const [bytes, name, type, format] of fixtures) {
    let result;
    try {
      result = await validateAudioFile(file(bytes, name, type));
    } catch (error) {
      error.message = `${name}:${error.code || error.message}`;
      throw error;
    }
    assert.equal(result.format, format, name);
    assert.equal(result.byteLength, bytes.length, name);
    assert.equal(result.durationMs, format === 'webm-opus' ? 2000 : result.durationMs, name);
    assert.equal(result.durationMs <= MEETING_AUDIO_MAX_DURATION_MS, true, name);
  }
});

test('preflight rejects forged extensions and corrupt content', async () => {
  await assert.rejects(
    () => validateAudioFile(file(wavBytes(), 'forged.mp3', 'audio/wav')),
    (error) => error.code === 'AUDIO_EXTENSION_MISMATCH'
  );
  await assert.rejects(
    () => validateAudioFile(file(Uint8Array.from([1, 2, 3, 4]), 'broken.wav', 'audio/wav')),
    (error) => error.code === 'AUDIO_HEADER_INVALID'
  );
});

test('preflight rejects files over one GiB and durations over four hours', async () => {
  await assert.rejects(
    () => validateAudioFile(file(mp3Bytes(), 'too-large.mp3', 'audio/mpeg', { size: MEETING_AUDIO_MAX_BYTES + 1 })),
    (error) => error.code === 'AUDIO_FILE_TOO_LARGE'
  );
  await assert.rejects(
    () => validateAudioFile(file(mp3Bytes(), 'too-long.mp3', 'audio/mpeg', { size: MEETING_AUDIO_MAX_BYTES - 1 })),
    (error) => error.code === 'AUDIO_DURATION_TOO_LONG'
  );
});

test('preflight does not call the whole-file arrayBuffer method', async () => {
  const candidate = file(wavBytes(), 'stream-only.wav', 'audio/wav');
  candidate.arrayBuffer = () => { throw new Error('WHOLE_FILE_ARRAY_BUFFER_FORBIDDEN'); };
  const result = await validateAudioFile(candidate);
  assert.equal(result.format, 'wav');
});

test('audio import stream yields bounded chunks and incremental SHA-256', async () => {
  let wholeFileRead = false;
  const source = {
    size: 5,
    name: 'stream.wav',
    type: 'audio/wav',
    slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    arrayBuffer: async () => {
      wholeFileRead = true;
      throw new Error('WHOLE_FILE_ARRAY_BUFFER_FORBIDDEN');
    },
    stream: () => new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4, 5]));
        controller.close();
      }
    })
  };
  const chunks = [];
  for await (const chunk of streamAudioFile(source, { chunkSize: 2 })) chunks.push([...chunk]);
  assert.deepEqual(chunks, [[1, 2], [3, 4], [5]]);
  assert.equal(wholeFileRead, false);

  const digest = new StreamingSha256().update(new TextEncoder().encode('a')).update(new TextEncoder().encode('bc')).digestHex();
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
