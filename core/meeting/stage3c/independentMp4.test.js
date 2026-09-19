import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBoxes } from '../stage3a/mp4Container.js';
import {
  assertCompatibleIndependentMp4,
  inspectIndependentMp4Segment,
  rebaseIndependentMp4Media
} from './independentMp4.js';

function concat(...parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function ascii(value) {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

function u16(value) {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u24(value) {
  return Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32(value) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  );
}

function u64(value) {
  const big = BigInt(value);
  return Uint8Array.of(
    Number((big >> 56n) & 0xffn),
    Number((big >> 48n) & 0xffn),
    Number((big >> 40n) & 0xffn),
    Number((big >> 32n) & 0xffn),
    Number((big >> 24n) & 0xffn),
    Number((big >> 16n) & 0xffn),
    Number((big >> 8n) & 0xffn),
    Number(big & 0xffn)
  );
}

function box(type, payload = new Uint8Array()) {
  return concat(u32(payload.byteLength + 8), ascii(type), payload);
}

function fullBox(type, version, flags, payload = new Uint8Array()) {
  return box(type, concat(Uint8Array.of(version), u24(flags), payload));
}

function makeMp4a({ codecConfigByte = 0x11 } = {}) {
  const sampleEntry = concat(
    new Uint8Array(6),
    u16(1),
    new Uint8Array(8),
    u16(2),
    u16(16),
    u16(0),
    u16(0),
    u32(48_000 << 16),
    box('esds', concat(Uint8Array.of(0, 0, 0, 0), Uint8Array.of(codecConfigByte, 0x90)))
  );
  return box('mp4a', sampleEntry);
}

function makeMoov({
  trackId,
  timescale,
  handler,
  codecConfigByte,
  trexDefaultDuration,
  metadataDuration = 0
}) {
  const tkhd = fullBox('tkhd', 0, 0x000003, concat(
    u32(0),
    u32(0),
    u32(trackId),
    u32(0),
    u32(metadataDuration),
    new Uint8Array(52)
  ));
  const mdhd = fullBox('mdhd', 0, 0, concat(
    u32(0),
    u32(0),
    u32(timescale),
    u32(metadataDuration),
    u16(0),
    u16(0)
  ));
  const hdlr = fullBox('hdlr', 0, 0, concat(
    u32(0),
    ascii(handler),
    new Uint8Array(12),
    ascii('Synthetic\0')
  ));
  const stsd = fullBox('stsd', 0, 0, concat(u32(1), makeMp4a({ codecConfigByte })));
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const mdia = box('mdia', concat(mdhd, hdlr, minf));
  const trak = box('trak', concat(tkhd, mdia));
  const trex = fullBox('trex', 0, 0, concat(
    u32(trackId),
    u32(1),
    u32(trexDefaultDuration),
    u32(0),
    u32(0)
  ));
  return box('moov', concat(trak, box('mvex', trex)));
}

function makeFragment({
  trackId,
  sequence,
  decodeTime,
  tfdtVersion,
  sampleDurations,
  tfhdDefaultDuration
}) {
  const tfhdFlags = tfhdDefaultDuration ? 0x000008 : 0;
  const tfhd = fullBox('tfhd', 0, tfhdFlags, concat(
    u32(trackId),
    ...(tfhdDefaultDuration ? [u32(tfhdDefaultDuration)] : [])
  ));
  const tfdt = fullBox('tfdt', tfdtVersion, 0, tfdtVersion === 1 ? u64(decodeTime) : u32(decodeTime));
  const trunFlags = sampleDurations ? 0x000100 : 0;
  const trun = fullBox('trun', 0, trunFlags, concat(
    u32(sampleDurations?.length || 2),
    ...(sampleDurations || []).map((duration) => u32(duration))
  ));
  const moof = box('moof', concat(
    fullBox('mfhd', 0, 0, u32(sequence)),
    box('traf', concat(tfhd, tfdt, trun))
  ));
  return concat(moof, box('mdat', Uint8Array.of(sequence & 0xff, 1, 2, 3)));
}

function buildIndependentMp4({
  trackId = 1,
  timescale = 48_000,
  handler = 'soun',
  codecConfigByte = 0x11,
  trexDefaultDuration = 0,
  tfhdDefaultDuration = 0,
  fragments = [[24_000, 24_000], [48_000]],
  firstSequence = 7,
  firstDecodeTime = 1_000,
  tfdtVersion = 1,
  metadataDuration = 0,
  includeInitialization = true,
  includeMedia = true
} = {}) {
  const init = includeInitialization
    ? concat(
        box('ftyp', concat(ascii('isom'), u32(0), ascii('isomiso6mp41'))),
        makeMoov({
          trackId,
          timescale,
          handler,
          codecConfigByte,
          trexDefaultDuration,
          metadataDuration
        })
      )
    : new Uint8Array();
  if (!includeMedia) return init;
  let decodeTime = firstDecodeTime;
  const media = fragments.map((sampleDurations, index) => {
    const fragment = makeFragment({
      trackId,
      sequence: firstSequence + index,
      decodeTime,
      tfdtVersion,
      sampleDurations,
      tfhdDefaultDuration
    });
    const resolvedDurations = sampleDurations
      || Array.from({ length: 2 }, () => tfhdDefaultDuration || trexDefaultDuration);
    decodeTime += resolvedDurations.reduce((total, duration) => total + duration, 0);
    return fragment;
  });
  return concat(init, ...media);
}

function readU32(bytes, offset) {
  return ((bytes[offset] * 0x1000000)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]) >>> 0;
}

function readU64(bytes, offset) {
  return Number(
    (BigInt(readU32(bytes, offset)) << 32n)
    | BigInt(readU32(bytes, offset + 4))
  );
}

function childBoxes(boxValue) {
  return parseBoxes(boxValue.bytes, boxValue.payloadStart, boxValue.payloadEnd);
}

function findDescendant(boxValue, type) {
  for (const child of childBoxes(boxValue)) {
    if (child.type === type) return child;
    if (['moof', 'traf'].includes(child.type)) {
      const nested = findDescendant(child, type);
      if (nested) return nested;
    }
  }
  return null;
}

function readRebasedMetadata(mediaBytes) {
  return parseBoxes(mediaBytes)
    .filter((candidate) => candidate.type === 'moof')
    .map((moof) => {
      const mfhd = findDescendant(moof, 'mfhd');
      const tfdt = findDescendant(moof, 'tfdt');
      const version = tfdt.bytes[tfdt.payloadStart];
      return {
        sequence: readU32(mfhd.bytes, mfhd.payloadStart + 4),
        decodeTime: version === 1
          ? readU64(tfdt.bytes, tfdt.payloadStart + 4)
          : readU32(tfdt.bytes, tfdt.payloadStart + 4)
      };
    });
}

test('inspects one complete independent fragmented MP4 and resolves exact audio duration', () => {
  const bytes = buildIndependentMp4();
  const inspection = inspectIndependentMp4Segment(bytes);

  assert.equal(inspection.timescale, 48_000);
  assert.equal(inspection.trackId, 1);
  assert.equal(inspection.fragmentCount, 2);
  assert.equal(inspection.firstDecodeTime, 1_000);
  assert.equal(inspection.durationTicks, 96_000);
  assert.equal(inspection.durationMs, 2_000);
  assert.match(inspection.trackFingerprint, /^audio:/);
  assert.deepEqual(
    parseBoxes(inspection.initBytes).map((candidate) => candidate.type),
    ['ftyp', 'moov']
  );
  assert.deepEqual(
    parseBoxes(inspection.mediaBytes).map((candidate) => candidate.type),
    ['moof', 'mdat', 'moof', 'mdat']
  );
  assert.equal(inspection.initBytes.byteLength + inspection.mediaBytes.byteLength, bytes.byteLength);
});

test('resolves trun duration with tfhd then trex fallback', () => {
  const fromTfhd = inspectIndependentMp4Segment(buildIndependentMp4({
    fragments: [null],
    tfhdDefaultDuration: 24_000
  }));
  assert.equal(fromTfhd.durationTicks, 48_000);

  const fromTrex = inspectIndependentMp4Segment(buildIndependentMp4({
    fragments: [null],
    trexDefaultDuration: 12_000
  }));
  assert.equal(fromTrex.durationTicks, 24_000);
});

test('compatibility ignores mutable duration metadata but rejects track contract drift', () => {
  const reference = inspectIndependentMp4Segment(buildIndependentMp4({ metadataDuration: 48_000 }));
  const compatible = inspectIndependentMp4Segment(buildIndependentMp4({ metadataDuration: 96_000 }));
  assert.equal(assertCompatibleIndependentMp4(reference, compatible), true);

  for (const candidateBytes of [
    buildIndependentMp4({ trackId: 2 }),
    buildIndependentMp4({ timescale: 44_100 }),
    buildIndependentMp4({ codecConfigByte: 0x22 })
  ]) {
    const candidate = inspectIndependentMp4Segment(candidateBytes);
    assert.throws(
      () => assertCompatibleIndependentMp4(reference, candidate),
      (error) => error?.code === 'INDEPENDENT_MP4_TRACK_INCOMPATIBLE'
    );
  }
});

test('rebases every fragment sequence and decode time without mutating input', () => {
  const bytes = buildIndependentMp4();
  const inputBefore = new Uint8Array(bytes);
  const inspection = inspectIndependentMp4Segment(bytes);
  const mediaBefore = new Uint8Array(inspection.mediaBytes);

  const first = rebaseIndependentMp4Media({
    inspection,
    firstSequence: 101,
    firstDecodeTime: 960_000
  });
  const second = rebaseIndependentMp4Media({
    inspection,
    firstSequence: 101,
    firstDecodeTime: 960_000
  });

  assert.deepEqual(readRebasedMetadata(first.mediaBytes), [
    { sequence: 101, decodeTime: 960_000 },
    { sequence: 102, decodeTime: 1_008_000 }
  ]);
  assert.equal(first.nextSequence, 103);
  assert.equal(first.nextDecodeTime, 1_056_000);
  assert.deepEqual(first, second);
  assert.deepEqual(bytes, inputBefore);
  assert.deepEqual(inspection.mediaBytes, mediaBefore);
});

test('fails closed with exact independent-MP4 structural and duration errors', () => {
  const cases = [
    {
      bytes: Uint8Array.of(1, 2, 3),
      code: 'INDEPENDENT_MP4_BYTES_INVALID'
    },
    {
      bytes: buildIndependentMp4({ includeInitialization: false }),
      code: 'INDEPENDENT_MP4_INITIALIZATION_INVALID'
    },
    {
      bytes: buildIndependentMp4({ handler: 'vide' }),
      code: 'INDEPENDENT_MP4_AUDIO_TRACK_INVALID'
    },
    {
      bytes: buildIndependentMp4({ includeMedia: false }),
      code: 'INDEPENDENT_MP4_MEDIA_INVALID'
    },
    {
      bytes: buildIndependentMp4({ fragments: [null] }),
      code: 'INDEPENDENT_MP4_DURATION_UNRESOLVED'
    }
  ];

  for (const fixture of cases) {
    assert.throws(
      () => inspectIndependentMp4Segment(fixture.bytes),
      (error) => error?.code === fixture.code,
      fixture.code
    );
  }
});

test('rejects sequence and version-0 decode-time overflow during rebasing', () => {
  const twoFragments = inspectIndependentMp4Segment(buildIndependentMp4());
  assert.throws(
    () => rebaseIndependentMp4Media({
      inspection: twoFragments,
      firstSequence: 0xffff_ffff,
      firstDecodeTime: 0
    }),
    (error) => error?.code === 'INDEPENDENT_MP4_TIMELINE_OVERFLOW'
  );

  const versionZero = inspectIndependentMp4Segment(buildIndependentMp4({
    fragments: [[48_000]],
    tfdtVersion: 0
  }));
  assert.throws(
    () => rebaseIndependentMp4Media({
      inspection: versionZero,
      firstSequence: 1,
      firstDecodeTime: 0x1_0000_0000
    }),
    (error) => error?.code === 'INDEPENDENT_MP4_TIMELINE_OVERFLOW'
  );
});
