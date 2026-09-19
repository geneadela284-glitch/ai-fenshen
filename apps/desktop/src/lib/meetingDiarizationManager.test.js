import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { createMeetingSpeechGateway } from '../../../../core/meeting/stage3a/meetingSpeechGateway.js';
import { createMemoryMeetingBackend } from './browserMeetingStore.js';
import { createMeetingDiarizationStore } from './meetingDiarizationStore.js';
import { createMeetingDiarizationManager } from './meetingDiarizationManager.js';

function owner(ownerId = 'owner-a') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' });
}

function source() {
  return {
    sourceId: 'source-a',
    meetingId: 'meeting-a',
    ownerId: 'owner-a',
    scope: 'meeting',
    origin: 'imported',
    originalFileName: 'meeting.wav',
    mimeType: 'audio/wav',
    format: 'wav',
    byteLength: 4,
    durationMs: 20_000,
    checksum: 'a'.repeat(64),
    chunkCount: 1,
    manifestVersion: 1,
    importState: 'committed',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    retentionExpiresAt: '2026-09-07T00:00:00.000Z',
    revision: 2
  };
}

function transcript() {
  return {
    document: {
      transcriptId: 'transcript-a',
      meetingId: 'meeting-a',
      sourceId: 'source-a',
      sourceRevision: 2,
      ownerId: 'owner-a',
      transcriptRevision: 7,
      status: 'ready'
    },
    currentRevision: {
      transcriptId: 'transcript-a',
      meetingId: 'meeting-a',
      sourceId: 'source-a',
      sourceRevision: 2,
      ownerId: 'owner-a',
      transcriptRevision: 7,
      kind: 'raw_asr',
      segments: [
        { segmentId: 'segment-0', transcriptId: 'transcript-a', transcriptRevision: 7, sequence: 0, startMs: 0, endMs: 8_000, text: '你好，开始会议。', speakerRef: null },
        { segmentId: 'segment-1', transcriptId: 'transcript-a', transcriptRevision: 7, sequence: 1, startMs: 8_000, endMs: 15_000, text: '好的，我来汇报。', speakerRef: null },
        { segmentId: 'segment-2', transcriptId: 'transcript-a', transcriptRevision: 7, sequence: 2, startMs: 15_000, endMs: 20_000, text: '谢谢。', speakerRef: null }
      ]
    }
  };
}

async function keyProvider() {
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { async withOwnerKey(_context, callback) { return callback(key); } };
}

function createAudioStore(audioSource = source()) {
  return {
    async getAudioSource(context, meetingId, sourceId) {
      if (context.ownerId !== 'owner-a' || meetingId !== 'meeting-a' || sourceId !== 'source-a') throw Object.assign(new Error('AUDIO_SOURCE_NOT_FOUND'), { code: 'AUDIO_SOURCE_NOT_FOUND' });
      return audioSource;
    },
    async listMeetings() { return [{ meetingId: 'meeting-a' }]; },
    streamAudioSourceDetailed() {
      return (async function* stream() {
        yield { sourceChunkId: 'segment-0', sequence: 0, durationMs: 20_000, checksum: 'a'.repeat(64), bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'audio/wav', format: 'wav' };
      }());
    }
  };
}

test('diarization preserves independent MP4 layout through source metadata and chunks', async () => {
  const independentSource = {
    ...source(),
    origin: 'recorded',
    originalFileName: 'iphone-recording.m4a',
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    format: 'm4a',
    containerLayout: 'independent-mp4-segments-v1'
  };
  const backend = createMemoryMeetingBackend();
  let sourceRequest = null;
  const pieces = [];
  const diarizationStore = createMeetingDiarizationStore({
    cryptoImpl: webcrypto,
    keyProvider: await keyProvider(),
    backend,
    now: () => '2026-08-08T00:00:00.000Z'
  });
  const speechGateway = createMeetingSpeechGateway({
    provider: {
      providerId: 'independent-diarization-provider',
      model: 'independent-diarization-model',
      supportsDiarization: true,
      async transcribeSource(request) {
        sourceRequest = request;
        for await (const piece of request.sourceChunks) pieces.push(piece);
        return {
          provider: this.providerId,
          model: this.model,
          effectiveDurationMs: 20_000,
          chunks: [{
            sequence: 0,
            startMs: 0,
            endMs: 20_000,
            sourceChunkRefs: ['segment-0'],
            segments: transcript().currentRevision.segments.map((segment, index) => ({
              startMs: segment.startMs,
              endMs: segment.endMs,
              text: segment.text,
              providerRole: (index % 2) + 1
            }))
          }]
        };
      }
    }
  });
  const manager = createMeetingDiarizationManager({
    ownerContext: owner(),
    audioStore: createAudioStore(independentSource),
    transcriptStore: { async getTranscript() { return transcript(); } },
    diarizationStore,
    speechGateway,
    cryptoImpl: webcrypto,
    now: () => '2026-08-08T00:00:00.000Z'
  });

  const started = await manager.startDiarization({ sourceId: 'source-a', transcriptId: 'transcript-a' });
  const completed = await manager.waitForJob(started.job.jobId);

  assert.equal(completed.job.status, 'ready', completed.job.errorCode || 'no-error-code');
  assert.equal(sourceRequest.source.containerLayout, 'independent-mp4-segments-v1');
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].containerLayout, 'independent-mp4-segments-v1');
});

test('diarization manager maps a real-shaped Provider response into encrypted anonymous revision without mutating Raw Transcript', async () => {
  const backend = createMemoryMeetingBackend();
  const ownerContext = owner();
  const rawTranscript = transcript();
  const diagnostics = [];
  const transcriptStore = {
    async getTranscript(contextValue, input) {
      assert.equal(contextValue.ownerId, 'owner-a');
      assert.deepEqual(input, { meetingId: 'meeting-a', transcriptId: 'transcript-a' });
      return structuredClone(rawTranscript);
    }
  };
  const diarizationStore = createMeetingDiarizationStore({
    cryptoImpl: webcrypto,
    keyProvider: await keyProvider(),
    backend,
    now: () => '2026-08-08T00:00:00.000Z'
  });
  const gateway = createMeetingSpeechGateway({
    provider: {
      providerId: 'xfyun_asr_llm',
      model: 'recording_file_transcription_llm',
      supportsDiarization: true,
      async transcribeSource(request) {
        assert.equal(request.mode, 'diarization');
        assert.equal(request.speakerCount, 0);
        assert.equal(request.traceId, 'diarization-backfill-test');
        const pieces = [];
        for await (const piece of request.sourceChunks) pieces.push(piece);
        assert.equal(pieces.length, 1);
        return {
          provider: 'xfyun_asr_llm',
          model: 'recording_file_transcription_llm',
          effectiveDurationMs: 20_000,
          chunks: [{
            sequence: 0,
            startMs: 0,
            endMs: 20_000,
            sourceChunkRefs: ['segment-0'],
            segments: [
              { startMs: 0, endMs: 8_000, text: '你好，开始会议。', providerRole: 2, confidence: null },
              { startMs: 8_000, endMs: 15_000, text: '好的，我来汇报。', providerRole: 1, confidence: null },
              { startMs: 15_000, endMs: 20_000, text: '谢谢。', providerRole: 2, confidence: null }
            ]
          }]
        };
      }
      ,
      async recordDiagnostic(event) {
        diagnostics.push(event);
      }
    }
  });
  const manager = createMeetingDiarizationManager({
    ownerContext,
    audioStore: createAudioStore(),
    transcriptStore,
    diarizationStore,
    speechGateway: gateway,
    cryptoImpl: webcrypto,
    now: () => '2026-08-08T00:00:00.000Z'
  });

  const started = await manager.startDiarization({ sourceId: 'source-a', transcriptId: 'transcript-a', speakerCount: 0, traceId: 'diarization-backfill-test' });
  const completed = await manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'ready', completed.job.errorCode || 'no-error-code');
  const view = await manager.getDiarizationView({ meetingId: 'meeting-a', transcriptId: 'transcript-a' });
  assert.deepEqual(view.revision.segments.map((segment) => segment.speakerRef), ['speaker-1', 'speaker-2', 'speaker-1']);
  assert.deepEqual(view.transcript.currentRevision.segments.map((segment) => segment.speakerRef), [null, null, null]);
  assert.equal(view.revision.speakerRefs.every((speaker) => /^说话人[1-9][0-9]*$/.test(speaker.label)), true);
  assert.equal(backend.dump().diarizationRevisions.length, 1);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].phase, 'diarization_result_summary');
  assert.equal(diagnostics[0].traceId, 'diarization-backfill-test');
  assert.equal(diagnostics[0].roleType, 1);
  assert.equal(diagnostics[0].roleNum, 0);
  assert.equal(diagnostics[0].providerSegmentCount, 3);
  assert.deepEqual(diagnostics[0].providerRoles, [1, 2]);
  assert.equal(diagnostics[0].firstStBg, 0);
  assert.equal(diagnostics[0].lastStEd, 20_000);
  assert.equal(diagnostics[0].transcriptFirstStartMs, 0);
  assert.equal(diagnostics[0].transcriptLastStartMs, 15_000);
  assert.equal(diagnostics[0].transcriptLastEndMs, 20_000);
  assert.equal(diagnostics[0].decodedDurationMs, 20_000);
  assert.equal(diagnostics[0].durationDeltaMs, 0);
  assert.equal(diagnostics[0].diarizationRevision, 1);
  assert.equal(diagnostics[0].revisionPersisted, true);
  assert.equal(diagnostics[0].encryptedPersistence, true);
  assert.match(diagnostics[0].diarizationRevisionIdHash, /^[0-9a-f]{16}$/);
  assert.match(diagnostics[0].transcriptIdHash, /^[0-9a-f]{16}$/);
});

test('diarization manager stops in blocked state when the real Provider capability is unavailable', async () => {
  const backend = createMemoryMeetingBackend();
  const ownerContext = owner();
  const store = createMeetingDiarizationStore({ cryptoImpl: webcrypto, keyProvider: await keyProvider(), backend });
  const manager = createMeetingDiarizationManager({
    ownerContext,
    audioStore: createAudioStore(),
    transcriptStore: { async getTranscript() { return transcript(); } },
    diarizationStore: store,
    speechGateway: createMeetingSpeechGateway({ provider: { providerId: 'transcription-only', model: 'v1', async transcribeSource() { throw new Error('must not call'); } } }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-08T00:00:00.000Z'
  });

  const started = await manager.startDiarization({ sourceId: 'source-a', transcriptId: 'transcript-a' });
  const completed = await manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'blocked');
  await assert.rejects(
    store.getCurrentRevision(ownerContext, { meetingId: 'meeting-a', transcriptId: 'transcript-a' }),
    (error) => error.code === 'DIARIZATION_NOT_FOUND'
  );
});
