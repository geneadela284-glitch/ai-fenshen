import assert from 'node:assert/strict';
import test from 'node:test';

import { createMp4ContainerValidator } from './mp4Container.js';

function box(type, payload = Buffer.alloc(0)) {
  const value = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const result = Buffer.alloc(8 + value.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, 'ascii');
  value.copy(result, 8);
  return result;
}

function fullBox(type, payload = Buffer.alloc(0), version = 0, flags = 0) {
  const header = Buffer.alloc(4);
  header.writeUInt8(version, 0);
  header.writeUIntBE(flags, 1, 3);
  return box(type, Buffer.concat([header, Buffer.from(payload)]));
}

function mdhd(timescale = 48_000, duration = 10_000) {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 8);
  payload.writeUInt32BE(duration, 12);
  return fullBox('mdhd', payload);
}

function initialization(timescale = 48_000) {
  return Buffer.concat([
    box('ftyp', Buffer.from([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x36, 0x6d, 0x70, 0x34, 0x31])),
    box('moov', box('trak', box('mdia', mdhd(timescale))))
  ]);
}

function fragment(sequence, decodeTime, { includeMdat = true } = {}) {
  const mfhdPayload = Buffer.alloc(4);
  mfhdPayload.writeUInt32BE(sequence, 0);
  const tfdtPayload = Buffer.alloc(4);
  tfdtPayload.writeUInt32BE(decodeTime, 0);
  const moof = box('moof', Buffer.concat([
    fullBox('mfhd', mfhdPayload),
    box('traf', fullBox('tfdt', tfdtPayload))
  ]));
  return includeMdat ? Buffer.concat([moof, box('mdat', Buffer.from([0x01, 0x02, 0x03]))]) : moof;
}

test('fragmented MP4 validator accepts init-only first chunk followed by ordered media fragments', () => {
  const validator = createMp4ContainerValidator();

  const first = validator.acceptChunk(initialization());
  assert.equal(first.initialized, true);
  assert.equal(first.fragmentCount, 0);

  validator.acceptChunk(fragment(1, 0));
  const snapshot = validator.acceptChunk(fragment(2, 9_600));

  assert.deepEqual(snapshot, {
    format: 'fragmented-mp4',
    initialized: true,
    timescale: 48_000,
    fragmentCount: 2,
    lastFragmentSequence: 2,
    lastDecodeTime: 9_600
  });
});

test('fragmented MP4 validator rejects missing or duplicate initialization', () => {
  const missing = createMp4ContainerValidator();
  assert.throws(() => missing.acceptChunk(fragment(1, 0)), (error) => error.code === 'MP4_INITIALIZATION_REQUIRED');

  const duplicate = createMp4ContainerValidator();
  duplicate.acceptChunk(initialization());
  assert.throws(() => duplicate.acceptChunk(initialization()), (error) => error.code === 'MP4_INITIALIZATION_DUPLICATE');
});

test('fragmented MP4 validator rejects sequence gaps, non-monotonic timeline, and missing mdat', () => {
  const sequenceGap = createMp4ContainerValidator();
  sequenceGap.acceptChunk(initialization());
  sequenceGap.acceptChunk(fragment(1, 0));
  assert.throws(() => sequenceGap.acceptChunk(fragment(3, 9_600)), (error) => error.code === 'MP4_FRAGMENT_SEQUENCE_INVALID');

  const timeline = createMp4ContainerValidator();
  timeline.acceptChunk(initialization());
  timeline.acceptChunk(fragment(1, 9_600));
  assert.throws(() => timeline.acceptChunk(fragment(2, 9_500)), (error) => error.code === 'MP4_FRAGMENT_TIMELINE_INVALID');

  const missingMdat = createMp4ContainerValidator();
  missingMdat.acceptChunk(initialization());
  assert.throws(() => missingMdat.acceptChunk(fragment(1, 0, { includeMdat: false })), (error) => error.code === 'MP4_FRAGMENT_MDAT_REQUIRED');
});
