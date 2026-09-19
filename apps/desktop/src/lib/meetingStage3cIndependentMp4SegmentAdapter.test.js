import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBoxes } from '../../../../core/meeting/stage3a/mp4Container.js';
import { createStage3cIndependentMp4SegmentAdapter } from './meetingStage3cIndependentMp4SegmentAdapter.js';
import { INDEPENDENT_MP4_SEGMENTS_V1 } from './meetingRecordingContainerLayout.js';

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

const ascii = (value) => Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
const u16 = (value) => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
const u24 = (value) => Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const u32 = (value) => Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
function u64(value) {
  const big = BigInt(value);
  return concat(u32(Number((big >> 32n) & 0xffff_ffffn)), u32(Number(big & 0xffff_ffffn)));
}
const box = (type, payload = new Uint8Array()) => concat(u32(payload.byteLength + 8), ascii(type), payload);
const fullBox = (type, version, flags, payload = new Uint8Array()) => box(type, concat(Uint8Array.of(version), u24(flags), payload));

function independentMp4({ sequence = 1, decodeTime = 0, codec = 0x11 } = {}) {
  const trackId = 1;
  const timescale = 48_000;
  const mp4a = box('mp4a', concat(
    new Uint8Array(6), u16(1), new Uint8Array(8), u16(2), u16(16), u16(0), u16(0),
    u32(48_000 << 16), box('esds', concat(new Uint8Array(4), Uint8Array.of(codec, 0x90)))
  ));
  const tkhd = fullBox('tkhd', 0, 3, concat(u32(0), u32(0), u32(trackId), u32(0), u32(0), new Uint8Array(52)));
  const mdhd = fullBox('mdhd', 0, 0, concat(u32(0), u32(0), u32(timescale), u32(0), u16(0), u16(0)));
  const hdlr = fullBox('hdlr', 0, 0, concat(u32(0), ascii('soun'), new Uint8Array(12), ascii('Audio\0')));
  const stsd = fullBox('stsd', 0, 0, concat(u32(1), mp4a));
  const trak = box('trak', concat(tkhd, box('mdia', concat(mdhd, hdlr, box('minf', box('stbl', stsd))))));
  const trex = fullBox('trex', 0, 0, concat(u32(trackId), u32(1), u32(576_000), u32(0), u32(0)));
  const init = concat(
    box('ftyp', concat(ascii('isom'), u32(0), ascii('isomiso6mp41'))),
    box('moov', concat(trak, box('mvex', trex)))
  );
  const tfhd = fullBox('tfhd', 0, 0, u32(trackId));
  const tfdt = fullBox('tfdt', 1, 0, u64(decodeTime));
  const trun = fullBox('trun', 0, 0x000100, concat(u32(1), u32(576_000)));
  const moof = box('moof', concat(fullBox('mfhd', 0, 0, u32(sequence)), box('traf', concat(tfhd, tfdt, trun))));
  return concat(init, moof, box('mdat', Uint8Array.of(sequence & 0xff, 1, 2, 3)));
}

function source(overrides = {}) {
  return Object.freeze({
    sourceId: 'recorded-independent',
    meetingId: 'meeting-independent',
    format: 'm4a',
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
    ...overrides
  });
}

function entries(start, count) {
  return Array.from({ length: count }, (_, offset) => {
    const sequence = start + offset;
    return Object.freeze({
      sequence,
      sourceChunkId: `segment-${sequence}`,
      startMs: sequence * 12_000,
      endMs: (sequence + 1) * 12_000,
      durationMs: 12_000,
      byteLength: 1,
      checksum: String(sequence % 10).repeat(64),
      mimeType: 'audio/mp4;codecs=mp4a.40.2'
    });
  });
}

function topLevelTypes(bytes) {
  return parseBoxes(bytes).map((candidate) => candidate.type);
}

test('reads only the selected independent MP4 window, strips repeated init, and rebases media', async () => {
  const reads = [];
  const bytesById = new Map(Array.from({ length: 325 }, (_, sequence) => [
    `segment-${sequence}`,
    independentMp4({ sequence: sequence + 100, decodeTime: sequence * 576_000 })
  ]));
  const adapter = createStage3cIndependentMp4SegmentAdapter({
    ownerContext: { trusted: true, ownerId: 'owner' },
    audioStore: {
      async readAudioSegment(_owner, _meetingId, segmentId) {
        reads.push(segmentId);
        return bytesById.get(segmentId);
      }
    }
  });

  for (const selected of [entries(0, 3), entries(50, 3), entries(150, 3), entries(250, 3), entries(322, 3)]) {
    reads.length = 0;
    const result = await adapter.readWindow({
      source: source(),
      window: { startMs: selected[0].startMs, targetMs: selected[0].startMs + 5_000, mediaChunks: selected }
    });
    assert.deepEqual(reads, selected.map((entry) => entry.sourceChunkId));
    assert.deepEqual(topLevelTypes(result.initBytes), ['ftyp', 'moov']);
    assert.equal(result.mediaChunks.every((entry) => topLevelTypes(entry.bytes).join(',') === 'moof,mdat'), true);
    assert.deepEqual(result.loadedFragmentSequences, selected.map((entry) => entry.sequence));
    assert.equal(result.adjacentFragmentCount <= 3, true);
    assert.equal(result.memory.wholeMeetingBlob, false);
  }
});

test('fails closed for incompatible, invalid, unsupported, and over-bound independent MP4 windows', async () => {
  const bytesById = new Map([
    ['segment-0', independentMp4()],
    ['segment-1', independentMp4({ sequence: 2, codec: 0x22 })],
    ['segment-2', Uint8Array.of(1, 2, 3)]
  ]);
  const adapter = createStage3cIndependentMp4SegmentAdapter({
    ownerContext: { trusted: true },
    audioStore: { async readAudioSegment(_owner, _meeting, id) { return bytesById.get(id); } }
  });

  await assert.rejects(
    () => adapter.readWindow({ source: source(), window: { mediaChunks: entries(0, 2) } }),
    (error) => error.code === 'PLAYBACK_INDEPENDENT_INIT_INCOMPATIBLE'
  );
  await assert.rejects(
    () => adapter.readWindow({ source: source(), window: { mediaChunks: entries(2, 1) } }),
    (error) => error.code === 'PLAYBACK_INDEPENDENT_MP4_INVALID'
  );
  await assert.rejects(
    () => adapter.readWindow({ source: source({ containerLayout: 'unknown-layout' }), window: { mediaChunks: entries(0, 1) } }),
    (error) => error.code === 'PLAYBACK_INDEPENDENT_LAYOUT_UNSUPPORTED'
  );
  await assert.rejects(
    () => adapter.readWindow({ source: source(), window: { mediaChunks: entries(0, 4) } }),
    (error) => error.code === 'PLAYBACK_INDEPENDENT_REASSEMBLY_LIMIT_EXCEEDED'
  );
});
