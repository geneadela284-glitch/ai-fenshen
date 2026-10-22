import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMeetingTranscriptionSourceAssembler } from './meetingTranscriptionSourceAssembler.js';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceMetadata(chunks) {
  return {
    fileName: 'iphone-recording.webm',
    mimeType: 'audio/webm;codecs=opus',
    format: 'webm-opus',
    byteLength: chunks.reduce((total, chunk) => total + chunk.bytes.length, 0),
    durationMs: chunks.reduce((total, chunk) => total + chunk.durationMs, 0),
    chunkCount: chunks.length,
    checksum: digest(JSON.stringify(chunks.map((chunk) => chunk.checksum)))
  };
}

function mp4Box(type, payload = Buffer.alloc(0)) {
  const value = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const result = Buffer.alloc(8 + value.length);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, 'ascii');
  value.copy(result, 8);
  return result;
}

function mp4FullBox(type, payload = Buffer.alloc(0)) {
  return mp4Box(type, Buffer.concat([Buffer.alloc(4), Buffer.from(payload)]));
}

function mp4Initialization() {
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(48_000, 8);
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d])),
    mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4FullBox('mdhd', mdhd))))
  ]);
}

function mp4Fragment(sequence, decodeTime) {
  const mfhd = Buffer.alloc(4);
  mfhd.writeUInt32BE(sequence, 0);
  const tfdt = Buffer.alloc(4);
  tfdt.writeUInt32BE(decodeTime, 0);
  return Buffer.concat([
    mp4Box('moof', Buffer.concat([mp4FullBox('mfhd', mfhd), mp4Box('traf', mp4FullBox('tfdt', tfdt))])),
    mp4Box('mdat', Buffer.from([0x01, 0x02, 0x03]))
  ]);
}

function mp4SourceMetadata(chunks) {
  return {
    fileName: 'iphone-recording.m4a',
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    format: 'm4a',
    byteLength: chunks.reduce((total, chunk) => total + chunk.bytes.length, 0),
    durationMs: chunks.reduce((total, chunk) => total + chunk.durationMs, 0),
    chunkCount: chunks.length,
    checksum: digest(JSON.stringify(chunks.map((chunk) => chunk.checksum)))
  };
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'meeting-source-assembler-test-'));
}

test('assembles ordered encrypted-source output without buffering the full source and finalizes once', async () => {
  const root = await tempRoot();
  const chunks = [
    { sourceChunkId: 'segment-0', sequence: 0, durationMs: 1_000, bytes: Buffer.from('abc') },
    { sourceChunkId: 'segment-1', sequence: 1, durationMs: 1_000, bytes: Buffer.from('def') }
  ].map((chunk) => ({ ...chunk, checksum: digest(chunk.bytes) }));
  const source = sourceMetadata(chunks);
  let finalizeCalls = 0;
  try {
    const assembler = createMeetingTranscriptionSourceAssembler({ tempRoot: root });
    const common = {
      ownerId: 'owner-a',
      meetingId: 'meeting-a',
      sourceId: 'source-a',
      sourceRevision: 1,
      assemblyId: 'assembly-a',
      attempt: 1,
      source,
      signal: new AbortController().signal
    };

    const first = await assembler.acceptChunk({
      ...common,
      chunk: chunks[0],
      body: Readable.from([chunks[0].bytes])
    });
    assert.deepEqual(first, { acknowledged: true, sequence: 0, idempotent: false, completed: false });

    const duplicate = await assembler.acceptChunk({
      ...common,
      chunk: chunks[0],
      body: Readable.from([chunks[0].bytes])
    });
    assert.deepEqual(duplicate, { acknowledged: true, sequence: 0, idempotent: true, completed: false });

    const completed = await assembler.acceptChunk({
      ...common,
      chunk: { ...chunks[1], final: true },
      body: Readable.from([chunks[1].bytes]),
      finalize: async ({ inputPath, source: assembledSource, chunks: assembledChunks }) => {
        finalizeCalls += 1;
        assert.deepEqual(await readFile(inputPath), Buffer.from('abcdef'));
        assert.deepEqual(assembledChunks.map((chunk) => chunk.sourceChunkId), ['segment-0', 'segment-1']);
        assert.deepEqual(assembledSource, source);
        return { provider: 'test-provider', model: 'test-model', chunks: [] };
      }
    });
    assert.equal(completed.completed, true);
    assert.equal(finalizeCalls, 1);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('meeting-transcription-source-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source assembler fails closed on a sequence gap and does not invoke finalization', async () => {
  const root = await tempRoot();
  const bytes = Buffer.from('abc');
  const chunk = { sourceChunkId: 'segment-1', sequence: 1, durationMs: 1_000, bytes, checksum: digest(bytes) };
  const source = { ...sourceMetadata([{ ...chunk, sequence: 0, sourceChunkId: 'segment-0' }]), byteLength: bytes.length, chunkCount: 2, checksum: digest(JSON.stringify([chunk.checksum, chunk.checksum])) };
  let finalized = false;
  try {
    const assembler = createMeetingTranscriptionSourceAssembler({ tempRoot: root });
    await assert.rejects(
      assembler.acceptChunk({
        ownerId: 'owner-a', meetingId: 'meeting-a', sourceId: 'source-a', sourceRevision: 1,
        assemblyId: 'assembly-gap', attempt: 1, source, chunk,
        body: Readable.from([bytes]),
        finalize: async () => { finalized = true; }
      }),
      (error) => error.code === 'SOURCE_ASSEMBLY_SEQUENCE_INVALID'
    );
    assert.equal(finalized, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source assembler reconstructs fragmented AAC/MP4 chunks in order before finalization', async () => {
  const root = await tempRoot();
  const chunks = [
    { sourceChunkId: 'segment-0', sequence: 0, durationMs: 20_000, bytes: mp4Initialization() },
    { sourceChunkId: 'segment-1', sequence: 1, durationMs: 20_000, bytes: mp4Fragment(1, 0) }
  ].map((chunk) => ({ ...chunk, checksum: digest(chunk.bytes) }));
  const source = mp4SourceMetadata(chunks);
  try {
    const assembler = createMeetingTranscriptionSourceAssembler({ tempRoot: root });
    const common = {
      ownerId: 'owner-a', meetingId: 'meeting-mp4', sourceId: 'source-mp4', sourceRevision: 1,
      assemblyId: 'assembly-mp4', attempt: 1, source, signal: new AbortController().signal
    };
    await assembler.acceptChunk({ ...common, chunk: chunks[0], body: Readable.from([chunks[0].bytes]) });
    const completed = await assembler.acceptChunk({
      ...common,
      chunk: { ...chunks[1], final: true },
      body: Readable.from([chunks[1].bytes]),
      finalize: async ({ inputPath, source: assembledSource }) => {
        assert.deepEqual(await readFile(inputPath), Buffer.concat(chunks.map((chunk) => chunk.bytes)));
        assert.equal(assembledSource.format, 'm4a');
        assert.equal(assembledSource.mimeType, 'audio/mp4;codecs=mp4a.40.2');
        return { ok: true };
      }
    });
    assert.equal(completed.completed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source assembler rejects malformed fragmented AAC/MP4 before provider finalization', async () => {
  const root = await tempRoot();
  const chunks = [
    { sourceChunkId: 'segment-0', sequence: 0, durationMs: 20_000, bytes: mp4Initialization() },
    { sourceChunkId: 'segment-1', sequence: 1, durationMs: 20_000, bytes: mp4Fragment(1, 0) },
    { sourceChunkId: 'segment-2', sequence: 2, durationMs: 20_000, bytes: mp4Fragment(3, 9_600) }
  ].map((chunk) => ({ ...chunk, checksum: digest(chunk.bytes) }));
  const source = mp4SourceMetadata(chunks);
  let finalized = false;
  try {
    const assembler = createMeetingTranscriptionSourceAssembler({ tempRoot: root });
    const common = {
      ownerId: 'owner-a', meetingId: 'meeting-mp4-invalid', sourceId: 'source-mp4-invalid', sourceRevision: 1,
      assemblyId: 'assembly-mp4-invalid', attempt: 1, source, signal: new AbortController().signal
    };
    await assembler.acceptChunk({ ...common, chunk: chunks[0], body: Readable.from([chunks[0].bytes]) });
    await assembler.acceptChunk({
      ...common,
      chunk: chunks[1],
      body: Readable.from([chunks[1].bytes])
    });
    await assert.rejects(
      assembler.acceptChunk({
        ...common,
        chunk: { ...chunks[2], final: true },
        body: Readable.from([chunks[2].bytes]),
        finalize: async () => { finalized = true; }
      }),
      (error) => error.code === 'MP4_FRAGMENT_SEQUENCE_INVALID'
    );
    assert.equal(finalized, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('independent MP4 layout routes each complete segment through PCM assembly before provider finalization', async () => {
  const root = await tempRoot();
  const chunks = [
    { sourceChunkId: 'segment-0', sequence: 0, durationMs: 12_000, bytes: Buffer.from('complete-mp4-0') },
    { sourceChunkId: 'segment-1', sequence: 1, durationMs: 12_000, bytes: Buffer.from('complete-mp4-1') }
  ].map((chunk) => ({ ...chunk, checksum: digest(chunk.bytes) }));
  const source = {
    ...mp4SourceMetadata(chunks),
    containerLayout: 'independent-mp4-segments-v1'
  };
  let cleanupCalls = 0;
  const assembledPath = path.join(root, 'assembled.wav');
  try {
    const assembler = createMeetingTranscriptionSourceAssembler({
      tempRoot: root,
      independentMp4Assembler: {
        async assemble({ segments }) {
          assert.deepEqual(segments.map((segment) => segment.sequence), [0, 1]);
          assert.deepEqual(await Promise.all(segments.map((segment) => readFile(segment.inputPath))), chunks.map((chunk) => chunk.bytes));
          await writeFile(assembledPath, Buffer.from('PCM-WAV'));
          return {
            inputPath: assembledPath,
            source: {
              fileName: 'meeting-recording.wav',
              mimeType: 'audio/wav',
              format: 'wav',
              byteLength: 7,
              durationMs: 24_000,
              chunkCount: 2
            },
            async cleanup() { cleanupCalls += 1; }
          };
        }
      }
    });
    const common = {
      ownerId: 'owner-a', meetingId: 'meeting-independent', sourceId: 'source-independent', sourceRevision: 1,
      assemblyId: 'assembly-independent', attempt: 1, source, signal: new AbortController().signal
    };
    await assembler.acceptChunk({ ...common, chunk: chunks[0], body: Readable.from([chunks[0].bytes]) });
    const result = await assembler.acceptChunk({
      ...common,
      chunk: { ...chunks[1], final: true },
      body: Readable.from([chunks[1].bytes]),
      finalize: async ({ inputPath, source: assembledSource, chunks: assembledChunks }) => {
        assert.equal(inputPath, assembledPath);
        assert.equal(assembledSource.format, 'wav');
        assert.equal(assembledSource.containerLayout, 'independent-mp4-segments-v1');
        assert.deepEqual(assembledChunks.map((chunk) => chunk.sourceChunkId), ['segment-0', 'segment-1']);
        return { ok: true };
      }
    });
    assert.equal(result.completed, true);
    assert.equal(cleanupCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
