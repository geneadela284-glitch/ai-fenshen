import assert from 'node:assert/strict';
import test from 'node:test';

import { createStage3cAacStoredFragmentAdapter } from './meetingStage3cAacStoredFragmentAdapter.js';
import { AAC_PLAYBACK_MIME } from './meetingStage3cPlaybackCapability.js';

function box(type, payload = []) {
  const value = Uint8Array.from(payload);
  const bytes = new Uint8Array(8 + value.byteLength);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = type.charCodeAt(index);
  bytes.set(value, 8);
  return bytes;
}

function concat(...parts) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function initBytes() {
  return concat(
    box('ftyp', [0x69, 0x73, 0x6f, 0x6d]),
    box('moov', box('mvex', box('trex', [0, 0, 0, 1])))
  );
}

function mediaFragment(sequence) {
  return concat(
    box('moof', box('mfhd', [0, 0, 0, sequence])),
    box('mdat', [sequence, sequence + 1, sequence + 2])
  );
}

function entries(count = 3) {
  return Array.from({ length: count }, (_, sequence) => ({
    sequence,
    segmentId: `segment-${sequence}`,
    sourceChunkId: `segment-${sequence}`,
    durationMs: 1_000,
    byteLength: 1,
    checksum: String(sequence).repeat(64),
    mimeType: AAC_PLAYBACK_MIME
  }));
}

function source(overrides = {}) {
  return {
    sourceId: 'recorded-meeting',
    meetingId: 'meeting-aac',
    origin: 'recorded',
    format: 'm4a',
    mimeType: AAC_PLAYBACK_MIME,
    chunkCount: 3,
    ...overrides
  };
}

function store(bytesById, segments = entries()) {
  return {
    async readAudioSegment(_owner, _meetingId, segmentId) {
      return bytesById.get(segmentId);
    },
    async getMeeting() {
      return { segments };
    }
  };
}

test('derives fMP4 init from the first recorded AAC fragment and strips it from media', async () => {
  const first = concat(initBytes(), mediaFragment(1));
  const second = mediaFragment(2);
  const third = mediaFragment(3);
  const bytesById = new Map([
    ['segment-0', first],
    ['segment-1', second],
    ['segment-2', third]
  ]);
  const adapter = createStage3cAacStoredFragmentAdapter({
    ownerContext: { trusted: true, ownerId: 'owner-a' },
    audioStore: store(bytesById)
  });

  const result = await adapter.readWindow({ source: source(), window: { targetMs: 2_000, mediaChunks: entries() } });

  assert.equal(result.classification, 'STORED_AAC_STORED_FRAGMENTS_SUPPORTED');
  assert.deepEqual(Array.from(result.initBytes), Array.from(initBytes()));
  assert.deepEqual(result.mediaChunks.map((entry) => entry.sequence), [0, 1, 2]);
  assert.deepEqual(Array.from(result.mediaChunks[0].bytes), Array.from(mediaFragment(1)));
  assert.deepEqual(result.loadedFragmentSequences, [0, 1, 2]);
});

test('middle and end windows reuse bounded init and only selected AAC media fragments', async () => {
  const allEntries = entries(6);
  const first = concat(initBytes(), mediaFragment(1));
  const bytesById = new Map([['segment-0', first]]);
  for (let sequence = 1; sequence < allEntries.length; sequence += 1) bytesById.set(`segment-${sequence}`, mediaFragment(sequence + 1));
  const adapter = createStage3cAacStoredFragmentAdapter({
    ownerContext: { trusted: true, ownerId: 'owner-a' },
    audioStore: store(bytesById, allEntries),
    maxFragmentCount: 3
  });

  const result = await adapter.readWindow({
    source: source({ chunkCount: allEntries.length }),
    window: { targetMs: 4_500, mediaChunks: allEntries.slice(4, 6) }
  });

  assert.deepEqual(result.mediaChunks.map((entry) => entry.sequence), [4, 5]);
  assert.deepEqual(result.loadedFragmentSequences, [0, 4, 5]);
  assert.equal(result.adjacentFragmentCount, 2);
});

test('malformed AAC initialization and oversized windows fail closed', async () => {
  const malformed = new Map([['segment-0', mediaFragment(1)]]);
  const adapter = createStage3cAacStoredFragmentAdapter({
    ownerContext: { trusted: true, ownerId: 'owner-a' },
    audioStore: store(malformed),
    maxFragmentCount: 3
  });
  await assert.rejects(
    () => adapter.readWindow({ source: source(), window: { targetMs: 0, mediaChunks: entries() } }),
    (error) => error.code === 'PLAYBACK_AAC_INIT_UNRESOLVED'
  );

  const bytesById = new Map(entries().map((entry) => [entry.sourceChunkId, mediaFragment(entry.sequence + 1)]));
  const limited = createStage3cAacStoredFragmentAdapter({
    ownerContext: { trusted: true, ownerId: 'owner-a' },
    audioStore: store(bytesById),
    maxFragmentCount: 2
  });
  await assert.rejects(
    () => limited.readWindow({ source: source(), window: { targetMs: 0, mediaChunks: entries() } }),
    (error) => error.code === 'PLAYBACK_AAC_REASSEMBLY_LIMIT_EXCEEDED'
  );
});
