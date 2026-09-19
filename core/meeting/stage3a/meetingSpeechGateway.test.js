import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeetingSpeechGateway } from './meetingSpeechGateway.js';

test('meeting_transcription Gateway accepts a source-level result with ordered windows', async () => {
  const gateway = createMeetingSpeechGateway({
    provider: {
      providerId: 'source-provider',
      model: 'source-model',
      async transcribeSource() {
        return {
          provider: 'source-provider',
          model: 'source-model',
          effectiveDurationMs: 100_073,
          chunks: [
            { sequence: 0, startMs: 0, endMs: 60_000, sourceChunkRefs: ['segment-0'], segments: [{ startMs: 1_000, endMs: 2_000, text: '开头。' }] },
            { sequence: 1, startMs: 60_000, endMs: 100_073, sourceChunkRefs: ['segment-1'], segments: [{ startMs: 2_000, endMs: 3_000, text: '结尾。' }] }
          ]
        };
      }
    }
  });

  assert.equal(gateway.describe().available, true);
  const result = await gateway.transcribeSource({
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 1,
    requestId: 'request-a',
    attempt: 1,
    source: { durationMs: 100_000 }
  });
  assert.deepEqual(result.chunks.map((chunk) => [chunk.sequence, chunk.startMs, chunk.endMs]), [[0, 0, 60_000], [1, 60_000, 100_073]]);
  assert.equal(result.effectiveDurationMs, 100_073);
  assert.deepEqual(result.chunks.flatMap((chunk) => chunk.segments.map(({ startMs, endMs, text, speakerRef }) => ({ startMs, endMs, text, speakerRef }))), [
    { startMs: 1_000, endMs: 2_000, text: '开头。', speakerRef: null },
    { startMs: 2_000, endMs: 3_000, text: '结尾。', speakerRef: null }
  ]);
});

test('meeting_transcription Gateway exposes provider roles only in explicit diarization mode', async () => {
  const gateway = createMeetingSpeechGateway({
    provider: {
      providerId: 'diarization-provider',
      model: 'diarization-model',
      supportsDiarization: true,
      async transcribeSource(request) {
        assert.equal(request.mode, 'diarization');
        assert.equal(request.speakerCount, 3);
        return {
          provider: 'diarization-provider',
          model: 'diarization-model',
          effectiveDurationMs: 8_000,
          chunks: [{
            sequence: 0,
            startMs: 0,
            endMs: 8_000,
            sourceChunkRefs: ['segment-0'],
            segments: [{ startMs: 0, endMs: 8_000, text: '多人会议。', providerRole: 2 }]
          }]
        };
      }
    }
  });

  assert.equal(gateway.describe().diarizationAvailable, true);
  const result = await gateway.transcribeSource({
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 1,
    requestId: 'request-a',
    attempt: 1,
    mode: 'diarization',
    speakerCount: 3,
    source: { durationMs: 8_000 }
  });

  assert.equal(result.mode, 'diarization');
  assert.equal(result.speakerCount, 3);
  assert.equal(result.chunks[0].segments[0].providerRole, 2);
  assert.equal(result.chunks[0].segments[0].speakerRef, undefined);
});

test('meeting_transcription Gateway fail-closes diarization when the Provider has no declared capability', async () => {
  const gateway = createMeetingSpeechGateway({
    provider: {
      providerId: 'transcription-only-provider',
      model: 'transcription-only-model',
      async transcribeSource() {
        throw new Error('must not be called');
      }
    }
  });

  await assert.rejects(
    gateway.transcribeSource({
      ownerId: 'owner-a',
      meetingId: 'meeting-a',
      sourceId: 'source-a',
      sourceRevision: 1,
      requestId: 'request-a',
      attempt: 1,
      mode: 'diarization',
      source: { durationMs: 8_000 }
    }),
    (error) => error.code === 'STAGE3B_REAL_DIARIZATION_PROVIDER_BLOCKED'
  );
});

test('meeting_transcription Gateway honors a runtime Provider capability and does not call a blocked source', async () => {
  let ready = false;
  let calls = 0;
  const gateway = createMeetingSpeechGateway({
    provider: {
      providerId: 'runtime-provider',
      model: 'runtime-model',
      describe() {
        return { available: ready, sourceAvailable: ready, diarizationAvailable: false, status: ready ? 'available' : 'blocked' };
      },
      async transcribeSource() {
        calls += 1;
        return {
          provider: 'runtime-provider',
          model: 'runtime-model',
          effectiveDurationMs: 1_000,
          chunks: [{ sequence: 0, startMs: 0, endMs: 1_000, segments: [{ startMs: 0, endMs: 1_000, text: '运行时能力。' }] }]
        };
      }
    }
  });

  assert.equal(gateway.describe().sourceAvailable, false);
  await assert.rejects(
    gateway.transcribeSource({
      ownerId: 'owner-a',
      meetingId: 'meeting-a',
      sourceId: 'source-a',
      sourceRevision: 1,
      requestId: 'request-a',
      attempt: 1,
      source: { durationMs: 1_000 }
    }),
    (error) => error.code === 'REAL_MEETING_ASR_PROVIDER_BLOCKED'
  );
  assert.equal(calls, 0);

  ready = true;
  assert.equal(gateway.describe().sourceAvailable, true);
  const result = await gateway.transcribeSource({
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 1,
    requestId: 'request-a',
    attempt: 1,
    source: { durationMs: 1_000 }
  });
  assert.equal(result.chunks[0].segments[0].text, '运行时能力。');
  assert.equal(calls, 1);
});
