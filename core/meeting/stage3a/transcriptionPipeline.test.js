import assert from 'node:assert/strict';
import test from 'node:test';

import { createAudioChunkStream } from './audioChunking.js';
import { stitchTranscriptChunks } from './transcriptStitching.js';
import {
  createTranscriptionJob,
  transitionTranscriptionJob
} from './transcriptionJob.js';
import {
  createDeterministicFixtureProvider,
  createMeetingSpeechGateway
} from './meetingSpeechGateway.js';

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test('audio chunking reads incrementally and keeps bounded overlap windows', async () => {
  let consumed = 0;
  async function* source() {
    for (let sequence = 0; sequence < 6; sequence += 1) {
      consumed += 1;
      yield {
        sourceChunkId: `source-chunk-${sequence}`,
        sequence,
        durationMs: 1_000,
        bytes: new Uint8Array([sequence, sequence, sequence])
      };
    }
  }

  const stream = createAudioChunkStream(source(), { maxChunkDurationMs: 2_000, overlapMs: 500 });
  const first = await stream.next();
  assert.equal(first.done, false);
  assert.equal(consumed < 6, true);
  assert.equal(first.value.startMs, 0);
  assert.equal(first.value.endMs, 2_000);
  assert.deepEqual(first.value.sourceChunkRefs, ['source-chunk-0', 'source-chunk-1']);
  const rest = await collect({ async *[Symbol.asyncIterator]() { yield first.value; yield* stream; } });
  assert.equal(rest.at(-1).endMs, 6_000);
  assert.equal(rest.every((chunk) => chunk.bytes.byteLength > 0 && chunk.bytes.byteLength <= 12), true);
});

test('audio chunking preserves source format metadata for the Provider boundary', async () => {
  async function* source() {
    yield {
      sourceChunkId: 'source-chunk-0',
      sequence: 0,
      durationMs: 1_000,
      fileName: 'synthetic-meeting.wav',
      mimeType: 'audio/wav',
      format: 'wav',
      bytes: new Uint8Array([1, 2, 3])
    };
  }

  const result = await createAudioChunkStream(source(), { maxChunkDurationMs: 1_000, overlapMs: 0 }).next();
  assert.equal(result.value.fileName, 'synthetic-meeting.wav');
  assert.equal(result.value.mimeType, 'audio/wav');
  assert.equal(result.value.format, 'wav');
});

test('recorded WebM/Opus chunks keep complete source containers in sequence', async () => {
  async function* source() {
    for (const [sequence, marker] of [[0, 11], [1, 22], [2, 33]]) {
      yield {
        sourceChunkId: `recorded-${sequence}`,
        sequence,
        durationMs: 20_000,
        mimeType: 'audio/webm;codecs=opus',
        format: 'webm-opus',
        bytes: new Uint8Array([marker, marker + 1, marker + 2])
      };
    }
  }

  const chunks = await collect(createAudioChunkStream(source(), { maxChunkDurationMs: 60_000, overlapMs: 5_000 }));
  assert.deepEqual(chunks.map((chunk) => chunk.sequence), [0, 1, 2]);
  assert.deepEqual(chunks.map((chunk) => [...chunk.bytes]), [[11, 12, 13], [22, 23, 24], [33, 34, 35]]);
  assert.equal(chunks.every((chunk) => chunk.format === 'webm-opus'), true);
  assert.equal(chunks.every((chunk) => chunk.mimeType === 'audio/webm;codecs=opus'), true);
  assert.equal(chunks.every((chunk) => chunk.bytes.byteLength === 3), true);
});

test('recorded WebM/Opus source sequence gaps fail closed', async () => {
  async function* source() {
    yield {
      sourceChunkId: 'recorded-0', sequence: 0, durationMs: 20_000,
      mimeType: 'audio/webm;codecs=opus', format: 'webm-opus', bytes: new Uint8Array([1])
    };
    yield {
      sourceChunkId: 'recorded-2', sequence: 2, durationMs: 20_000,
      mimeType: 'audio/webm;codecs=opus', format: 'webm-opus', bytes: new Uint8Array([2])
    };
  }

  await assert.rejects(
    collect(createAudioChunkStream(source(), { maxChunkDurationMs: 60_000, overlapMs: 5_000 })),
    (error) => error.code === 'AUDIO_SOURCE_SEQUENCE_NOT_MONOTONIC'
  );
});

test('recorded WebM continuation chunks receive the verified initialization prefix before grouping', async () => {
  const initialization = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x18, 0x53, 0x80, 0x67]);
  const cluster = (marker) => new Uint8Array([0x1f, 0x43, 0xb6, 0x75, marker, marker + 1]);
  async function* source() {
    yield {
      sourceChunkId: 'recorded-0', sequence: 0, durationMs: 20_000,
      mimeType: 'audio/webm;codecs=opus', format: 'webm-opus',
      bytes: new Uint8Array([...initialization, ...cluster(11)])
    };
    yield {
      sourceChunkId: 'recorded-1', sequence: 1, durationMs: 20_000,
      mimeType: 'audio/webm;codecs=opus', format: 'webm-opus',
      bytes: cluster(22)
    };
  }

  const chunks = await collect(createAudioChunkStream(source(), { maxChunkDurationMs: 60_000, overlapMs: 5_000 }));
  assert.equal(chunks.length, 1);
  assert.deepEqual([...chunks[0].bytes], [...initialization, ...cluster(11), ...cluster(22)]);
  assert.deepEqual(chunks[0].sourceChunkRefs, ['recorded-0', 'recorded-1']);
});

test('recorded WebM continuation chunks preserve valid leading elements before the next Cluster', async () => {
  const initialization = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x18, 0x53, 0x80, 0x67]);
  const cluster = (marker) => new Uint8Array([0x1f, 0x43, 0xb6, 0x75, marker, marker + 1]);
  const voidElement = new Uint8Array([0xec, 0x82, 0x01, 0x02]);
  async function* source() {
    yield {
      sourceChunkId: 'recorded-0', sequence: 0, durationMs: 20_000,
      mimeType: 'audio/webm;codecs=opus', format: 'webm-opus',
      bytes: new Uint8Array([...initialization, ...cluster(11)])
    };
    yield {
      sourceChunkId: 'recorded-1', sequence: 1, durationMs: 20_000,
      mimeType: 'audio/webm;codecs=opus', format: 'webm-opus',
      bytes: new Uint8Array([...voidElement, ...cluster(22)])
    };
  }

  const chunks = await collect(createAudioChunkStream(source(), { maxChunkDurationMs: 60_000, overlapMs: 5_000 }));
  assert.equal(chunks.length, 1);
  assert.deepEqual([...chunks[0].bytes], [...initialization, ...cluster(11), ...voidElement, ...cluster(22)]);
});

test('recorded WebM segments are grouped into bounded valid containers before ASR upload', async () => {
  const initialization = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x18, 0x53, 0x80, 0x67]);
  const cluster = (marker) => new Uint8Array([0x1f, 0x43, 0xb6, 0x75, marker, marker + 1]);
  async function* source() {
    for (let sequence = 0; sequence < 5; sequence += 1) {
      yield {
        sourceChunkId: `recorded-${sequence}`,
        sequence,
        durationMs: 20_000,
        mimeType: 'audio/webm;codecs=opus',
        format: 'webm-opus',
        bytes: sequence === 0 ? new Uint8Array([...initialization, ...cluster(10)]) : cluster(10 + sequence)
      };
    }
  }

  const chunks = await collect(createAudioChunkStream(source(), { maxChunkDurationMs: 60_000, overlapMs: 5_000 }));
  assert.deepEqual(chunks.map((chunk) => [chunk.sequence, chunk.startMs, chunk.endMs]), [
    [0, 0, 60_000],
    [1, 60_000, 100_000]
  ]);
  assert.deepEqual([...chunks[0].bytes], [...initialization, ...cluster(10), ...cluster(11), ...cluster(12)]);
  assert.deepEqual([...chunks[1].bytes], [...initialization, ...cluster(13), ...cluster(14)]);
  assert.deepEqual(chunks.map((chunk) => chunk.sourceChunkRefs), [
    ['recorded-0', 'recorded-1', 'recorded-2'],
    ['recorded-3', 'recorded-4']
  ]);
});

test('stitching removes overlap duplicates and emits monotonic stable segments', () => {
  const result = stitchTranscriptChunks({
    transcriptId: 'transcript-a',
    sourceRevision: 4,
    sourceDurationMs: 5_000,
    expectedChunkCount: 2,
    chunks: [
      {
        sequence: 0,
        startMs: 0,
        endMs: 3_000,
        sourceChunkRefs: ['source-0', 'source-1'],
        segments: [{ startMs: 1_000, endMs: 2_000, text: '今天讨论预算。', confidence: 0.9 }]
      },
      {
        sequence: 1,
        startMs: 2_000,
        endMs: 5_000,
        sourceChunkRefs: ['source-1', 'source-2'],
        segments: [
          { absoluteStartMs: 1_000, absoluteEndMs: 2_000, text: '今天讨论预算。', confidence: 0.9 },
          { absoluteStartMs: 2_100, absoluteEndMs: 2_900, text: '然后确认时间。', confidence: 0.88 }
        ]
      }
    ]
  });
  assert.deepEqual(result.segments.map((segment) => segment.text), ['今天讨论预算。', '然后确认时间。']);
  assert.deepEqual(result.segments.map((segment) => segment.startMs), [1_000, 2_100]);
  assert.equal(result.segments.every((segment) => segment.speakerRef === null), true);
  assert.equal(result.segments[0].segmentId, result.segments[0].segmentId);
  assert.throws(
    () => stitchTranscriptChunks({ transcriptId: 't', sourceRevision: 1, sourceDurationMs: 1_000, expectedChunkCount: 2, chunks: [] }),
    (error) => error.code === 'TRANSCRIPT_CHUNK_MISSING'
  );
});

test('stitching removes partial Chinese overlap without changing timeline order', () => {
  const result = stitchTranscriptChunks({
    transcriptId: 'transcript-cn',
    sourceRevision: 1,
    sourceDurationMs: 4_000,
    expectedChunkCount: 2,
    chunks: [
      { sequence: 0, startMs: 0, endMs: 2_000, sourceChunkRefs: ['source-0'], segments: [{ startMs: 1_000, endMs: 1_800, text: '今天讨论预算，然后', confidence: 0.9 }] },
      { sequence: 1, startMs: 1_500, endMs: 4_000, sourceChunkRefs: ['source-1'], segments: [{ startMs: 0, endMs: 800, text: '预算，然后确认时间。', confidence: 0.88 }] }
    ]
  });
  assert.deepEqual(result.segments.map((segment) => segment.text), ['今天讨论预算，然后', '确认时间。']);
  assert.equal(result.segments[1].startMs, result.segments[0].endMs);
});

test('job state machine bounds provider retries and supports manual resume', () => {
  const created = createTranscriptionJob({
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 4,
    now: '2026-08-07T00:00:00.000Z'
  });
  const preparing = transitionTranscriptionJob(created, { type: 'prepare' }, { now: '2026-08-07T00:00:01.000Z' });
  const transcribing = transitionTranscriptionJob(preparing.state, { type: 'begin_transcribing' }, { now: '2026-08-07T00:00:02.000Z' });
  let current = transcribing.state;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    current = transitionTranscriptionJob(current, { type: 'provider_failed', errorCode: `PROVIDER_${attempt}` }, { now: `2026-08-07T00:00:0${3 + attempt}.000Z` }).state;
    if (attempt < 2) {
      current = transitionTranscriptionJob(current, { type: 'retry' }, { now: `2026-08-07T00:00:1${attempt}.000Z` }).state;
      current = transitionTranscriptionJob(current, { type: 'prepare' }, { now: `2026-08-07T00:00:2${attempt}.000Z` }).state;
      current = transitionTranscriptionJob(current, { type: 'begin_transcribing' }, { now: `2026-08-07T00:00:2${attempt + 1}.000Z` }).state;
    }
  }
  assert.equal(current.status, 'paused_retryable');
  assert.equal(current.attempts, 3);
  const resumed = transitionTranscriptionJob(current, { type: 'manual_resume' }, { now: '2026-08-07T00:12:00.000Z' });
  assert.equal(resumed.state.status, 'queued');
  assert.equal(resumed.state.attempts, 0);
  assert.equal(resumed.state.completedChunkSequences.length, 0);

  let chunked = transcribing.state;
  chunked = transitionTranscriptionJob(chunked, { type: 'chunk_completed', sequence: 0, chunkCount: 1 }, { now: '2026-08-07T00:00:03.000Z' }).state;
  chunked = transitionTranscriptionJob(chunked, { type: 'provider_failed', errorCode: 'PROVIDER_AFTER_PARTIAL' }, { now: '2026-08-07T00:00:04.000Z' }).state;
  const rebuilt = transitionTranscriptionJob(chunked, { type: 'manual_resume', resetChunks: true }, { now: '2026-08-07T00:13:00.000Z' });
  assert.equal(rebuilt.state.nextChunkSequence, 0);
  assert.equal(rebuilt.state.chunkCount, 0);
  assert.deepEqual(rebuilt.state.completedChunkSequences, []);
  assert.equal(rebuilt.state.lease, null);
});

test('meeting gateway is explicit when no real provider exists and fixture is deterministic only', async () => {
  const blocked = createMeetingSpeechGateway();
  await assert.rejects(
    blocked.transcribeChunk({ ownerId: 'owner-a', meetingId: 'meeting-a', sourceId: 'source-a', sourceRevision: 1, chunk: { sequence: 0 } }),
    (error) => error.code === 'REAL_MEETING_ASR_PROVIDER_BLOCKED'
  );
  const fixture = createMeetingSpeechGateway({ provider: createDeterministicFixtureProvider({ text: '合成会议内容。' }) });
  const result = await fixture.transcribeChunk({
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 1,
    requestId: 'request-a',
    attempt: 1,
    chunk: { sequence: 0, startMs: 0, endMs: 1_000, bytes: new Uint8Array([1]) }
  });
  assert.equal(result.provider, 'deterministic-fixture');
  assert.equal(result.segments[0].speakerRef, null);
  assert.equal(result.isDeterministicFixture, true);
});
