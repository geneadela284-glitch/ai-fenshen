import assert from 'node:assert/strict';
import test from 'node:test';

import { createStage3cWebmBoundedReassemblyAdapter } from './meetingStage3cWebmBoundedReassembly.js';
import { REAL_IPHONE_WEBM_BOUNDARY_EVIDENCE, buildBoundaryShapedFragments } from './meetingStage3cWebmBoundaryEvidenceFixture.js';

const WEBM_MIME = 'audio/webm;codecs=opus';

function source(fragmentCount = 5) {
  return {
    sourceId: 'recorded-meeting-real-webm',
    meetingId: 'meeting-real-webm',
    format: 'webm-opus',
    mimeType: WEBM_MIME,
    revision: 9,
    chunkCount: fragmentCount,
    durationMs: 3_000,
    committedDurationMs: 3_000,
    byteLength: 0,
    committedByteLength: 0,
    checksum: 'source-checksum'
  };
}

function timeline(fragmentCount = 5) {
  return { entries: Array.from({ length: fragmentCount }, (_, sequence) => ({ sequence, sourceChunkId: `segment-${sequence}`, startMs: sequence * 600, endMs: (sequence + 1) * 600, durationMs: 600 })) };
}

function storeFor(fragments, { sourceOverride = {} } = {}) {
  const bytes = new Map(fragments.map((value, sequence) => [`segment-${sequence}`, value]));
  const base = source(fragments.length);
  const sourceValue = { ...base, byteLength: fragments.reduce((total, value) => total + value.byteLength, 0), committedByteLength: fragments.reduce((total, value) => total + value.byteLength, 0), ...sourceOverride };
  return {
    sourceValue,
    audioStore: {
      async readAudioSegment(_owner, _meetingId, sourceChunkId) {
        return bytes.get(sourceChunkId);
      }
    }
  };
}

test('fixture records real iPhone evidence metadata without pretending raw bytes are available', () => {
  assert.equal(REAL_IPHONE_WEBM_BOUNDARY_EVIDENCE.evidenceSha256, 'b72f7274005081e7af7df3d0c0aa3015b59bb7eae4a0d8e18409b0d7dc2ceb69');
  assert.equal(REAL_IPHONE_WEBM_BOUNDARY_EVIDENCE.rawBytesAvailable, false);
  assert.equal(REAL_IPHONE_WEBM_BOUNDARY_EVIDENCE.chunkCount, 5);
});

test('reassembles unknown-size clusters across two and three persisted fragments', async () => {
  const fixture = buildBoundaryShapedFragments();
  const { audioStore, sourceValue } = storeFor(fixture.fragments);
  const adapter = createStage3cWebmBoundedReassemblyAdapter({ audioStore, ownerContext: { trusted: true }, maxFragmentCount: 3 });
  const result = await adapter.readWindow({ source: sourceValue, timeline: timeline(fixture.fragments.length), targetMs: 900 });
  assert.equal(result.classification, 'STORED_WEBM_REQUIRES_BOUNDED_REASSEMBLY_SUPPORTED');
  assert.equal(result.initBytes.byteLength, fixture.init.byteLength);
  assert.equal(result.mediaChunks.length, 1);
  assert.deepEqual(result.mediaChunks.map((chunk) => chunk.timecodeMs), [1_000]);
  assert.equal(result.boundary.clusterSpansFragments, true);
  assert.ok(result.memory.maxObservedReassemblyBytes <= result.memory.maxReassemblyBytes);
});

test('reassembles the final cluster whose last fragment contains only a SimpleBlock tail', async () => {
  const fixture = buildBoundaryShapedFragments();
  const { audioStore, sourceValue } = storeFor(fixture.fragments);
  const adapter = createStage3cWebmBoundedReassemblyAdapter({ audioStore, ownerContext: { trusted: true }, maxFragmentCount: 3 });
  const result = await adapter.readWindow({ source: sourceValue, timeline: timeline(fixture.fragments.length), targetMs: 2_500 });
  assert.equal(result.mediaChunks.at(-1).timecodeMs, 2_000);
  assert.ok(result.mediaChunks.length <= 3);
  assert.ok(result.mediaChunks.every((chunk) => chunk.complete === true));
});

test('scans BlockGroup media units without treating persisted boundaries as Cluster boundaries', async () => {
  const fixture = buildBoundaryShapedFragments({ blockGroupAt: 1 });
  const { audioStore, sourceValue } = storeFor(fixture.fragments);
  const adapter = createStage3cWebmBoundedReassemblyAdapter({ audioStore, ownerContext: { trusted: true }, maxFragmentCount: 3 });
  const result = await adapter.readWindow({ source: sourceValue, timeline: timeline(fixture.fragments.length), targetMs: 900 });
  assert.equal(result.mediaChunks.length, 1);
  assert.equal(result.mediaChunks[0].timecodeMs, 1_000);
  assert.equal(result.mediaChunks[0].blockGroupCount, 1);
  assert.equal(result.mediaChunks[0].simpleBlockCount, 1);
});

test('fails closed when init, timecode, cluster boundary, or limits are unresolved', async () => {
  const fixture = buildBoundaryShapedFragments();
  const { audioStore, sourceValue } = storeFor(fixture.fragments);
  const badInit = createStage3cWebmBoundedReassemblyAdapter({ audioStore: storeFor([fixture.fragments[1]]).audioStore, ownerContext: { trusted: true }, maxFragmentCount: 1 });
  await assert.rejects(() => badInit.readWindow({ source: { ...sourceValue, chunkCount: 1 }, timeline: timeline(1), targetMs: 0 }), (error) => error.code === 'PLAYBACK_WEBM_INIT_UNRESOLVED');
  const limited = createStage3cWebmBoundedReassemblyAdapter({ audioStore, ownerContext: { trusted: true }, maxFragmentCount: 1, maxScanBytes: 8, maxReassemblyBytes: 8 });
  await assert.rejects(() => limited.readWindow({ source: sourceValue, timeline: timeline(fixture.fragments.length), targetMs: 1_500 }), (error) => error.code === 'PLAYBACK_WEBM_REASSEMBLY_LIMIT_EXCEEDED');
  const boundaryLimited = createStage3cWebmBoundedReassemblyAdapter({ audioStore, ownerContext: { trusted: true }, maxFragmentCount: 1 });
  await assert.rejects(() => boundaryLimited.readWindow({ source: sourceValue, timeline: timeline(fixture.fragments.length), targetMs: 900 }), (error) => error.code === 'PLAYBACK_WEBM_CLUSTER_BOUNDARY_UNRESOLVED');
  const malformed = storeFor([Uint8Array.from([0x01, 0x02, 0x03])]);
  const malformedAdapter = createStage3cWebmBoundedReassemblyAdapter({ audioStore: malformed.audioStore, ownerContext: { trusted: true }, maxFragmentCount: 1 });
  await assert.rejects(() => malformedAdapter.readWindow({ source: { ...malformed.sourceValue, chunkCount: 1 }, timeline: timeline(1), targetMs: 0 }), (error) => error.code === 'PLAYBACK_WEBM_INIT_UNRESOLVED');

  const noTimecode = buildBoundaryShapedFragments();
  const noTimecodeFirst = new Uint8Array(noTimecode.fragments[0]);
  const timecodeOffset = noTimecodeFirst.findIndex((value, index) => value === 0xe7 && noTimecodeFirst[index + 1] === 0x82);
  assert.ok(timecodeOffset >= 0);
  noTimecodeFirst[timecodeOffset] = 0xe8;
  const noTimecodeFragments = [noTimecodeFirst, ...noTimecode.fragments.slice(1)];
  const noTimecodeStore = storeFor(noTimecodeFragments);
  const noTimecodeAdapter = createStage3cWebmBoundedReassemblyAdapter({ audioStore: noTimecodeStore.audioStore, ownerContext: { trusted: true } });
  await assert.rejects(() => noTimecodeAdapter.readWindow({ source: noTimecodeStore.sourceValue, timeline: timeline(noTimecodeFragments.length), targetMs: 0 }), (error) => error.code === 'PLAYBACK_WEBM_TIMECODE_UNRESOLVED');

  const noBlock = buildBoundaryShapedFragments();
  const noBlockFirst = new Uint8Array(noBlock.fragments[0]);
  const blockOffset = noBlockFirst.findIndex((value, index) => index > 50 && value === 0xa3);
  assert.ok(blockOffset >= 0);
  noBlockFirst[blockOffset] = 0xa2;
  const noBlockFragments = [noBlockFirst, ...noBlock.fragments.slice(1)];
  const noBlockStore = storeFor(noBlockFragments);
  const noBlockAdapter = createStage3cWebmBoundedReassemblyAdapter({ audioStore: noBlockStore.audioStore, ownerContext: { trusted: true } });
  await assert.rejects(() => noBlockAdapter.readWindow({ source: noBlockStore.sourceValue, timeline: timeline(noBlockFragments.length), targetMs: 0 }), (error) => error.code === 'PLAYBACK_WEBM_APPEND_UNIT_INVALID');
});

test('does not construct a whole-meeting Blob and reports append-unit validation failures', async () => {
  const fixture = buildBoundaryShapedFragments();
  const { audioStore, sourceValue } = storeFor(fixture.fragments);
  const adapter = createStage3cWebmBoundedReassemblyAdapter({ audioStore, ownerContext: { trusted: true } });
  const result = await adapter.readWindow({ source: sourceValue, timeline: timeline(fixture.fragments.length), targetMs: 0 });
  assert.equal(result.memory.wholeMeetingBlob, false);
  assert.equal(result.memory.retainedRawBytes, 0);
  assert.ok(result.mediaChunks.every((chunk) => chunk.bytes instanceof Uint8Array));
  assert.ok(result.mediaChunks.every((chunk) => chunk.byteLength > 0));
});
