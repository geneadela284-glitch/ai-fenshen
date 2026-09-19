import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  createDeterministicFixtureProvider,
  createMeetingSpeechGateway
} from '../../../../core/meeting/stage3a/meetingSpeechGateway.js';
import { createTranscriptionJob, transitionTranscriptionJob } from '../../../../core/meeting/stage3a/transcriptionJob.js';
import { createMemoryMeetingBackend } from './browserMeetingStore.js';
import { createMeetingTranscriptStore } from './meetingTranscriptStore.js';
import { createMeetingTranscriptionManager } from './meetingTranscriptionManager.js';

function owner(ownerId = 'owner-a') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' });
}

function source(sourceId, origin = 'imported', revision = 4) {
  return {
    sourceId,
    meetingId: 'meeting-a',
    ownerId: 'owner-a',
    scope: 'meeting',
    origin,
    originalFileName: `${sourceId}.wav`,
    mimeType: 'audio/wav',
    format: 'wav',
    byteLength: 8,
    durationMs: 2_000,
    checksum: 'b'.repeat(64),
    chunkCount: 2,
    manifestVersion: 1,
    importState: 'committed',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    retentionExpiresAt: '2026-09-06T00:00:00.000Z',
    revision
  };
}

function keyProvider() {
  return webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']).then((key) => ({
    async withOwnerKey(_context, callback) {
      return callback(key);
    }
  }));
}

function createAudioStore(audioSource, { delayed = false } = {}) {
  return {
    async listMeetings() {
      return [{ meetingId: 'meeting-a' }];
    },
    async getAudioSource(_context, meetingId, sourceId) {
      if (meetingId !== audioSource.meetingId || sourceId !== audioSource.sourceId) throw Object.assign(new Error('AUDIO_SOURCE_NOT_FOUND'), { code: 'AUDIO_SOURCE_NOT_FOUND' });
      return audioSource;
    },
    streamAudioSourceDetailed() {
      return (async function* stream() {
        if (delayed) await new Promise((resolve) => { delayed.resolve = resolve; });
        yield { sourceChunkId: `${audioSource.sourceId}-chunk-0`, sequence: 0, durationMs: 1_000, bytes: new Uint8Array([1, 2, 3, 4]) };
        yield { sourceChunkId: `${audioSource.sourceId}-chunk-1`, sequence: 1, durationMs: 1_000, bytes: new Uint8Array([5, 6, 7, 8]) };
      }());
    }
  };
}

async function createManager(audioSource, { provider = createDeterministicFixtureProvider({ text: '合成中文会议内容。' }), delayed = false } = {}) {
  const backend = createMemoryMeetingBackend();
  const transcriptStore = createMeetingTranscriptStore({ cryptoImpl: webcrypto, keyProvider: await keyProvider(), backend, now: () => '2026-08-07T00:00:00.000Z' });
  const manager = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore: createAudioStore(audioSource, { delayed }),
    transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:00:00.000Z',
    chunkOptions: { maxChunkDurationMs: 1_000, overlapMs: 0 }
  });
  return { backend, transcriptStore, manager };
}

test('recorded and imported committed sources produce one encrypted, editable raw transcript', async () => {
  for (const origin of ['recorded', 'imported']) {
    const { transcriptStore, manager } = await createManager(source(`source-${origin}`, origin));
    const started = await manager.startTranscription({ sourceId: `source-${origin}` });
    const completed = await manager.waitForJob(started.job.jobId);
    assert.equal(completed.job.status, 'ready');
    const transcript = await transcriptStore.getTranscript(owner(), { meetingId: 'meeting-a', transcriptId: started.job.transcriptId });
    assert.equal(transcript.document.status, 'ready');
    assert.equal(transcript.revisions.length, 1);
    assert.equal(transcript.currentRevision.segments.length, 2);
    assert.equal(transcript.currentRevision.segments.every((item) => item.speakerRef === null), true);
  }
});

test('transcription initialization probes a runtime Provider before publishing capability state', async () => {
  let ready = false;
  let probeCalls = 0;
  const provider = {
    providerId: 'runtime-probe-provider',
    model: 'runtime-probe-model',
    describe() {
      return { available: ready, sourceAvailable: ready, diarizationAvailable: false, status: ready ? 'available' : 'blocked' };
    },
    async probeCapability() {
      probeCalls += 1;
      ready = true;
      return this.describe();
    },
    async transcribeChunk() {
      return { provider: 'runtime-probe-provider', model: 'runtime-probe-model', segments: [{ startMs: 0, endMs: 1_000, text: '探测完成。' }] };
    }
  };
  const active = await createManager(source('source-runtime-probe'), { provider });
  let published = null;
  active.manager.subscribe((snapshot) => { published = snapshot; });
  await active.manager.initialize();
  assert.equal(probeCalls, 1);
  assert.equal(published.provider.sourceAvailable, true);
});

test('transcription diagnostics retain the concrete provider request id and provider state', async () => {
  const diagnostics = [];
  const requests = [];
  const provider = {
    providerId: 'trace-provider',
    model: 'trace-model',
    async recordDiagnostic(event) {
      diagnostics.push(event);
    },
    async transcribeChunk(request) {
      requests.push(request);
      return {
        provider: 'trace-provider',
        model: 'trace-model',
        requestId: request.requestId,
        segments: [{ startMs: 0, endMs: 1_000, text: '可追踪内容。' }],
        cursor: { status: 'completed' }
      };
    }
  };
  const { manager } = await createManager(source('source-trace'), { provider });
  const started = await manager.startTranscription({ sourceId: 'source-trace' });
  const completed = await manager.waitForJob(started.job.jobId);

  assert.equal(completed.job.status, 'ready');
  assert.ok(requests[0]?.requestId);
  assert.equal(diagnostics.some((event) => event.transcriptionRequestId === requests[0].requestId), true);
  assert.equal(diagnostics.some((event) => event.providerId === 'trace-provider'), true);
});

test('ready transcript stays readable and editable when its AudioSource is unavailable', async () => {
  const original = source('source-transcript-only');
  const active = await createManager(original);
  const started = await active.manager.startTranscription({ sourceId: original.sourceId });
  const completed = await active.manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'ready');

  const unavailableAudioStore = {
    async getAudioSource() {
      throw Object.assign(new Error('AUDIO_SOURCE_NOT_FOUND'), { code: 'AUDIO_SOURCE_NOT_FOUND' });
    },
    async listMeetings() {
      return [{ meetingId: original.meetingId }];
    },
    streamAudioSourceDetailed() {
      return (async function* stream() {})();
    }
  };
  const recovered = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore: unavailableAudioStore,
    transcriptStore: active.transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider: createDeterministicFixtureProvider() }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:00:00.000Z'
  });

  const view = await recovered.getTranscriptView({
    sourceId: original.sourceId,
    meetingId: original.meetingId,
    transcriptId: completed.job.transcriptId
  });
  assert.equal(view.mode, 'transcript_only');
  assert.equal(view.transcript.document.status, 'ready');
  assert.equal(view.transcript.currentRevision.segments.length, 2);

  const updated = await recovered.saveCorrection({
    sourceId: original.sourceId,
    meetingId: original.meetingId,
    transcriptId: completed.job.transcriptId,
    actorId: 'owner-a',
    edits: [{ segmentId: view.transcript.currentRevision.segments[0].segmentId, text: '音频不可用但仍可校正。' }]
  });
  assert.equal(updated.document.transcriptRevision, 2);
  assert.equal(updated.currentRevision.segments[0].text, '音频不可用但仍可校正。');
  const refreshed = await recovered.getTranscriptView({
    sourceId: original.sourceId,
    meetingId: original.meetingId,
    transcriptId: completed.job.transcriptId
  });
  assert.equal(refreshed.mode, 'transcript_only');
  assert.equal(refreshed.transcript.document.transcriptRevision, 2);
  assert.equal(refreshed.transcript.currentRevision.segments[0].text, '音频不可用但仍可校正。');
});

test('state evidence records encrypted transcript and source relationships without raw identifiers or content', async () => {
  const original = source('source-state-evidence');
  const active = await createManager(original);
  const started = await active.manager.startTranscription({ sourceId: original.sourceId });
  await active.manager.waitForJob(started.job.jobId);

  const evidence = await active.manager.collectStateEvidence();
  const steps = evidence.events.map((event) => event.stateStep);
  assert.deepEqual(steps, ['meetingLookup', 'transcriptLookup', 'revisionLookup', 'sourceLookup', 'modeDecision']);
  assert.equal(evidence.events.find((event) => event.stateStep === 'meetingLookup').meetingRecordFound, true);
  assert.equal(evidence.events.find((event) => event.stateStep === 'transcriptLookup').transcriptFound, true);
  assert.equal(evidence.events.find((event) => event.stateStep === 'revisionLookup').latestRevisionDecryptable, true);
  assert.equal(evidence.events.find((event) => event.stateStep === 'sourceLookup').audioSourceFound, true);
  assert.equal(evidence.events.find((event) => event.stateStep === 'modeDecision').computedMode, 'NORMAL');
  assert.equal(evidence.events.filter((event) => event.stateStep !== 'meetingLookup').every((event) => /^[0-9a-f]{16}$/.test(event.meetingIdHash || event.transcriptMeetingIdHash || '')), true);
  assert.doesNotMatch(JSON.stringify(evidence), /meeting-a|source-state-evidence|合成中文会议内容/);

  const unavailable = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore: {
      async listMeetings() { return [{ meetingId: original.meetingId }]; },
      async getAudioSource() { throw Object.assign(new Error('AUDIO_SOURCE_NOT_FOUND'), { code: 'AUDIO_SOURCE_NOT_FOUND' }); },
      streamAudioSourceDetailed() { return (async function* stream() {})(); }
    },
    transcriptStore: active.transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider: createDeterministicFixtureProvider() }),
    cryptoImpl: webcrypto
  });
  const unavailableEvidence = await unavailable.collectStateEvidence();
  assert.equal(unavailableEvidence.events.find((event) => event.stateStep === 'sourceLookup').audioSourceFound, false);
  assert.equal(unavailableEvidence.events.find((event) => event.stateStep === 'modeDecision').computedMode, 'TRANSCRIPT_ONLY');
});

test('ready transcript refresh loads transcript metadata before checking AudioSource availability', async () => {
  const original = source('source-refresh-order');
  const active = await createManager(original);
  const started = await active.manager.startTranscription({ sourceId: original.sourceId });
  const completed = await active.manager.waitForJob(started.job.jobId);
  const order = [];
  const transcriptStore = {
    ...active.transcriptStore,
    async getTranscript(...args) {
      order.push('transcript');
      return active.transcriptStore.getTranscript(...args);
    }
  };
  const audioStore = {
    ...createAudioStore(original),
    async getAudioSource(...args) {
      order.push('audio');
      throw Object.assign(new Error('AUDIO_SOURCE_NOT_FOUND'), { code: 'AUDIO_SOURCE_NOT_FOUND' });
    }
  };
  const recovered = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore,
    transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider: createDeterministicFixtureProvider() }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:00:00.000Z'
  });

  const view = await recovered.getTranscriptView({
    sourceId: original.sourceId,
    meetingId: original.meetingId,
    transcriptId: completed.job.transcriptId
  });

  assert.equal(view.mode, 'transcript_only');
  assert.deepEqual(order, ['transcript', 'audio']);
});

test('initialization keeps a ready transcript-only job from blocking the Meeting page', async () => {
  const original = source('source-refresh-initialization');
  const active = await createManager(original);
  const started = await active.manager.startTranscription({ sourceId: original.sourceId });
  const completed = await active.manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'ready');

  await active.transcriptStore.deleteTranscriptionArtifacts(owner(), { jobId: completed.job.jobId });
  let activeJob = createTranscriptionJob({
    ownerId: original.ownerId,
    meetingId: original.meetingId,
    sourceId: original.sourceId,
    sourceRevision: original.revision,
    transcriptId: completed.job.transcriptId,
    jobId: 'transcription-refresh-initialization-retry',
    now: '2026-08-07T00:00:00.000Z'
  });
  activeJob = transitionTranscriptionJob(activeJob, { type: 'prepare' }, { now: '2026-08-07T00:00:01.000Z' }).state;
  activeJob = transitionTranscriptionJob(activeJob, { type: 'begin_transcribing' }, { now: '2026-08-07T00:00:02.000Z' }).state;
  await active.transcriptStore.saveJob(owner(), { job: activeJob });
  let retryableJob = createTranscriptionJob({
    ownerId: original.ownerId,
    meetingId: original.meetingId,
    sourceId: original.sourceId,
    sourceRevision: original.revision,
    transcriptId: completed.job.transcriptId,
    jobId: 'transcription-refresh-initialization-failed-retryable',
    now: '2026-08-07T00:00:00.000Z'
  });
  retryableJob = transitionTranscriptionJob(retryableJob, { type: 'prepare' }, { now: '2026-08-07T00:00:01.000Z' }).state;
  retryableJob = transitionTranscriptionJob(retryableJob, { type: 'begin_transcribing' }, { now: '2026-08-07T00:00:02.000Z' }).state;
  retryableJob = transitionTranscriptionJob(retryableJob, { type: 'provider_failed', retryable: true, errorCode: 'TRANSCRIPTION_PROVIDER_FAILED' }, { now: '2026-08-07T00:00:03.000Z' }).state;
  await active.transcriptStore.saveJob(owner(), { job: retryableJob });

  const unavailableAudioStore = {
    async getAudioSource() {
      throw Object.assign(new Error('AUDIO_SOURCE_NOT_FOUND'), { code: 'AUDIO_SOURCE_NOT_FOUND' });
    },
    async listMeetings() {
      return [{ meetingId: original.meetingId }];
    },
    streamAudioSourceDetailed() {
      return (async function* stream() {})();
    }
  };
  const recovered = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore: unavailableAudioStore,
    transcriptStore: active.transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider: createDeterministicFixtureProvider() }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:00:00.000Z'
  });

  await assert.doesNotReject(recovered.initialize());
  const snapshot = recovered.getSnapshot();
  assert.deepEqual([...snapshot.transcriptOnlyJobIds].sort(), [activeJob.jobId, retryableJob.jobId].sort());
  assert.equal(snapshot.activeJob, null);

  const view = await recovered.getTranscriptView({
    sourceId: original.sourceId,
    meetingId: original.meetingId,
    transcriptId: completed.job.transcriptId
  });
  assert.equal(view.mode, 'transcript_only');
  assert.equal(view.transcript.document.status, 'ready');
});

test('missing AudioSource without a ready Transcript remains AUDIO_SOURCE_NOT_FOUND', async () => {
  const original = source('source-without-transcript');
  const active = await createManager(original);
  const unavailableAudioStore = {
    async getAudioSource() {
      throw Object.assign(new Error('AUDIO_SOURCE_NOT_FOUND'), { code: 'AUDIO_SOURCE_NOT_FOUND' });
    },
    async listMeetings() {
      return [{ meetingId: original.meetingId }];
    },
    streamAudioSourceDetailed() {
      return (async function* stream() {})();
    }
  };
  const recovered = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore: unavailableAudioStore,
    transcriptStore: active.transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider: createDeterministicFixtureProvider() }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:00:00.000Z'
  });

  await assert.rejects(
    recovered.getTranscriptView({ sourceId: original.sourceId }),
    (error) => error.code === 'AUDIO_SOURCE_NOT_FOUND'
  );
});

test('recorded WebM/Opus sources use one continuous source transcription request instead of raw WebM windows', async () => {
  const recorded = {
    ...source('source-recorded-webm', 'recorded'),
    originalFileName: 'iphone-recording.webm',
    mimeType: 'audio/webm;codecs=opus',
    format: 'webm-opus'
  };
  let sourceCalls = 0;
  let receivedBytes = [];
  const provider = {
    providerId: 'source-provider',
    model: 'source-model',
    async transcribeSource(request) {
      sourceCalls += 1;
      for await (const chunk of request.sourceChunks) receivedBytes.push([...chunk.bytes]);
      return {
        provider: 'source-provider',
        model: 'source-model',
        effectiveDurationMs: 2_073,
        chunks: [
          { sequence: 0, startMs: 0, endMs: 1_000, sourceChunkRefs: ['source-recorded-webm-chunk-0'], segments: [{ startMs: 0, endMs: 500, text: '连续开头。' }] },
          { sequence: 1, startMs: 1_000, endMs: 2_073, sourceChunkRefs: ['source-recorded-webm-chunk-1'], segments: [{ startMs: 0, endMs: 500, text: '连续结尾。' }] }
        ]
      };
    }
  };
  const active = await createManager(recorded, { provider });
  const started = await active.manager.startTranscription({ sourceId: recorded.sourceId });
  const completed = await active.manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'ready');
  assert.equal(sourceCalls, 1);
  assert.deepEqual(receivedBytes, [[1, 2, 3, 4], [5, 6, 7, 8]]);
  const transcript = await active.transcriptStore.getTranscript(owner(), { meetingId: 'meeting-a', transcriptId: started.job.transcriptId });
  assert.deepEqual(transcript.currentRevision.segments.map((segment) => segment.text), ['连续开头。', '连续结尾。']);
});

test('recorded AAC/MP4 sources use one continuous source transcription request instead of byte-sliced MP4 fragments', async () => {
  const recorded = {
    ...source('source-recorded-mp4', 'recorded'),
    originalFileName: 'iphone-recording.m4a',
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    format: 'm4a'
  };
  let sourceCalls = 0;
  const provider = {
    providerId: 'mp4-source-provider',
    model: 'mp4-source-model',
    async transcribeSource(request) {
      sourceCalls += 1;
      for await (const _chunk of request.sourceChunks) {}
      return {
        provider: 'mp4-source-provider',
        model: 'mp4-source-model',
        effectiveDurationMs: 2_000,
        chunks: [{
          sequence: 0,
          startMs: 0,
          endMs: 2_000,
          sourceChunkRefs: ['source-recorded-mp4-chunk-0', 'source-recorded-mp4-chunk-1'],
          segments: [{ startMs: 0, endMs: 1_000, text: 'AAC连续内容。' }]
        }]
      };
    }
  };
  const active = await createManager(recorded, { provider });
  const started = await active.manager.startTranscription({ sourceId: recorded.sourceId });
  const completed = await active.manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'ready');
  assert.equal(sourceCalls, 1);
  const transcript = await active.transcriptStore.getTranscript(owner(), { meetingId: 'meeting-a', transcriptId: started.job.transcriptId });
  assert.equal(transcript.currentRevision.segments[0].text, 'AAC连续内容。');
});

test('recorded independent MP4 segments preserve their layout through the transcription source request', async () => {
  const recorded = {
    ...source('source-independent-mp4', 'recorded'),
    originalFileName: 'iphone-recording.m4a',
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    format: 'm4a',
    containerLayout: 'independent-mp4-segments-v1'
  };
  let sourceRequest = null;
  const sourcePieces = [];
  const provider = {
    providerId: 'independent-mp4-source-provider',
    model: 'independent-mp4-source-model',
    async transcribeSource(request) {
      sourceRequest = request;
      for await (const piece of request.sourceChunks) sourcePieces.push(piece);
      return {
        provider: this.providerId,
        model: this.model,
        effectiveDurationMs: 2_000,
        chunks: [{
          sequence: 0,
          startMs: 0,
          endMs: 2_000,
          sourceChunkRefs: sourcePieces.map((piece) => piece.sourceChunkId),
          segments: [{ startMs: 0, endMs: 1_000, text: '独立分段内容。' }]
        }]
      };
    }
  };

  const active = await createManager(recorded, { provider });
  const started = await active.manager.startTranscription({ sourceId: recorded.sourceId });
  const completed = await active.manager.waitForJob(started.job.jobId);

  assert.equal(completed.job.status, 'ready');
  assert.equal(sourceRequest.source.containerLayout, 'independent-mp4-segments-v1');
  assert.equal(sourcePieces.length, 2);
  assert.equal(sourcePieces.every((piece) => piece.containerLayout === 'independent-mp4-segments-v1'), true);
});

test('manual resume discards persisted derived WebM results and rebuilds the source plan', async () => {
  const recorded = {
    ...source('source-recorded-webm-resume', 'recorded'),
    originalFileName: 'iphone-recording.webm',
    mimeType: 'audio/webm;codecs=opus',
    format: 'webm-opus'
  };
  let sourceCalls = 0;
  const sourceSequences = [];
  const provider = {
    providerId: 'source-resume-provider',
    model: 'source-resume-model',
    async transcribeSource(request) {
      sourceCalls += 1;
      for await (const chunk of request.sourceChunks) sourceSequences.push(chunk.sequence);
      return {
        provider: 'source-resume-provider',
        model: 'source-resume-model',
        chunks: [
          { sequence: 0, startMs: 0, endMs: 1_000, sourceChunkRefs: ['source-recorded-webm-resume-chunk-0'], segments: [{ startMs: 0, endMs: 500, text: '重建后的开头。' }] },
          { sequence: 1, startMs: 1_000, endMs: 2_000, sourceChunkRefs: ['source-recorded-webm-resume-chunk-1'], segments: [{ startMs: 0, endMs: 500, text: '重建后的结尾。' }] }
        ]
      };
    }
  };
  const prepared = await createManager(recorded, { provider });
  let failedJob = createTranscriptionJob({
    ownerId: 'owner-a',
    meetingId: recorded.meetingId,
    sourceId: recorded.sourceId,
    sourceRevision: recorded.revision,
    transcriptId: `transcript-${recorded.sourceId}-${recorded.revision}`,
    jobId: `transcription-${recorded.sourceId}-${recorded.revision}`,
    now: '2026-08-07T00:00:00.000Z'
  });
  failedJob = transitionTranscriptionJob(failedJob, { type: 'prepare' }, { now: '2026-08-07T00:00:01.000Z' }).state;
  failedJob = transitionTranscriptionJob(failedJob, { type: 'begin_transcribing' }, { now: '2026-08-07T00:00:02.000Z' }).state;
  failedJob = transitionTranscriptionJob(failedJob, { type: 'chunk_completed', sequence: 0, chunkCount: 5 }, { now: '2026-08-07T00:00:03.000Z' }).state;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    failedJob = transitionTranscriptionJob(failedJob, { type: 'provider_failed', errorCode: 'TRANSCRIPTION_PROVIDER_FAILED' }, { now: `2026-08-07T00:00:0${4 + attempt}.000Z` }).state;
    if (failedJob.status === 'failed_retryable') {
      failedJob = transitionTranscriptionJob(failedJob, { type: 'retry' }, { now: `2026-08-07T00:00:1${attempt}.000Z` }).state;
      failedJob = transitionTranscriptionJob(failedJob, { type: 'prepare' }, { now: `2026-08-07T00:00:2${attempt}.000Z` }).state;
      failedJob = transitionTranscriptionJob(failedJob, { type: 'begin_transcribing' }, { now: `2026-08-07T00:00:3${attempt}.000Z` }).state;
    }
  }
  assert.equal(failedJob.status, 'paused_retryable');
  await prepared.transcriptStore.saveJob(owner(), { job: failedJob });
  await prepared.transcriptStore.saveChunkResult(owner(), {
    job: failedJob,
    sequence: 0,
    result: {
      provider: 'old-provider',
      model: 'old-model',
      startMs: 0,
      endMs: 1_000,
      sourceChunkRefs: ['source-recorded-webm-resume-chunk-0'],
      segments: [{ startMs: 0, endMs: 1_000, text: '旧派生结果。', speakerRef: null }]
    }
  });

  const resumedManager = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore: createAudioStore(recorded),
    transcriptStore: prepared.transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:01:00.000Z'
  });
  const resumed = await resumedManager.resumeTranscription({ sourceId: recorded.sourceId });
  assert.equal(resumed.job.status, 'ready');
  assert.equal(sourceCalls, 1);
  assert.deepEqual(sourceSequences, [0, 1]);
  assert.equal(prepared.backend.dump().transcriptionChunks.filter((row) => row.jobId === failedJob.jobId).length, 2);
  const transcript = await prepared.transcriptStore.getTranscript(owner(), { meetingId: recorded.meetingId, transcriptId: failedJob.transcriptId });
  assert.deepEqual(transcript.currentRevision.segments.map((segment) => segment.text), ['重建后的开头。', '重建后的结尾。']);
});

test('transcription manager carries committed AudioSource format metadata into the Provider chunk contract', async () => {
  let received = null;
  const provider = {
    providerId: 'metadata-provider',
    model: 'metadata-model',
    async transcribeChunk(request) {
      received = request;
      return { provider: 'metadata-provider', model: 'metadata-model', segments: [{ startMs: 0, endMs: 1_000, text: '元数据。' }] };
    }
  };
  const active = await createManager(source('source-metadata'), { provider });
  const started = await active.manager.startTranscription({ sourceId: 'source-metadata' });
  const completed = await active.manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'ready');
  assert.equal(received.chunk.fileName, 'source-metadata.wav');
  assert.equal(received.chunk.mimeType, 'audio/wav');
  assert.equal(received.chunk.format, 'wav');
});

test('provider retries are bounded and blocked capability never creates a final transcript', async () => {
  let calls = 0;
  const flaky = {
    providerId: 'test-provider',
    model: 'test-model',
    async transcribeChunk(request) {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('TEMPORARY_PROVIDER_FAILURE'), { code: 'TEMPORARY_PROVIDER_FAILURE' });
      return { provider: 'test-provider', model: 'test-model', segments: [{ startMs: 0, endMs: 1_000, text: '重试后完成。' }] };
    }
  };
  const retryable = await createManager(source('source-retry'), { provider: flaky });
  const retryStarted = await retryable.manager.startTranscription({ sourceId: 'source-retry' });
  const retryCompleted = await retryable.manager.waitForJob(retryStarted.job.jobId);
  assert.equal(retryCompleted.job.status, 'ready');
  assert.equal(calls, 4);

  const blocked = await createManager(source('source-blocked'), { provider: null });
  const blockedManager = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore: createAudioStore(source('source-blocked')),
    transcriptStore: blocked.transcriptStore,
    speechGateway: createMeetingSpeechGateway(),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:00:00.000Z'
  });
  const blockedStarted = await blockedManager.startTranscription({ sourceId: 'source-blocked' });
  const blockedCompleted = await blockedManager.waitForJob(blockedStarted.job.jobId);
  assert.equal(blockedCompleted.job.status, 'failed_terminal');
  assert.equal(blockedCompleted.job.errorCode, 'REAL_MEETING_ASR_PROVIDER_BLOCKED');
  await assert.rejects(
    blocked.transcriptStore.getTranscript(owner(), { meetingId: 'meeting-a', transcriptId: blockedStarted.job.transcriptId }),
    (error) => error.code === 'TRANSCRIPT_NOT_FOUND'
  );
});

test('manual resume waits for the prior failed run before scheduling a new run', async () => {
  let providerCalls = 0;
  let resumePromise = null;
  let resumed = false;
  const provider = {
    providerId: 'resume-race-provider',
    model: 'resume-race-model',
    async transcribeChunk() {
      providerCalls += 1;
      if (providerCalls <= 3) throw Object.assign(new Error('TEMPORARY_PROVIDER_FAILURE'), { code: 'TEMPORARY_PROVIDER_FAILURE' });
      return { provider: 'resume-race-provider', model: 'resume-race-model', segments: [{ startMs: 0, endMs: 1_000, text: '恢复成功。' }] };
    }
  };
  const active = await createManager(source('source-resume-race'), { provider });
  active.manager.subscribe((snapshot) => {
    const job = snapshot.jobs.find((item) => item.sourceId === 'source-resume-race');
    if (!resumed && job?.status === 'paused_retryable') {
      resumed = true;
      resumePromise = active.manager.resumeTranscription({ sourceId: 'source-resume-race' });
    }
  });

  const started = await active.manager.startTranscription({ sourceId: 'source-resume-race' });
  while (!resumePromise) await new Promise((resolve) => setTimeout(resolve, 0));
  await resumePromise;
  const completed = await active.manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'ready');
  assert.equal(providerCalls, 5);
});

test('cancel removes partial chunk results and source gates are fail-closed', async () => {
  const deferred = {};
  const provider = {
    providerId: 'slow-provider',
    model: 'slow-model',
    async transcribeChunk() {
      await new Promise((resolve) => { deferred.resolve = resolve; });
      return { provider: 'slow-provider', model: 'slow-model', segments: [{ startMs: 0, endMs: 1_000, text: '不会完成。' }] };
    }
  };
  const active = await createManager(source('source-cancel'), { provider });
  const started = await active.manager.startTranscription({ sourceId: 'source-cancel' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await active.manager.cancelTranscription({ jobId: started.job.jobId });
  deferred.resolve?.();
  const cancelled = await active.manager.waitForJob(started.job.jobId);
  assert.equal(cancelled.job.status, 'cancelled');
  assert.equal(active.backend.dump().transcriptionChunks.length, 0);
  await assert.rejects(
    active.transcriptStore.getTranscript(owner(), { meetingId: 'meeting-a', transcriptId: started.job.transcriptId }),
    (error) => error.code === 'TRANSCRIPT_NOT_FOUND'
  );

  const invalid = await createManager({ ...source('source-invalid'), importState: 'failed_retryable' });
  await assert.rejects(
    invalid.manager.startTranscription({ sourceId: 'source-invalid' }),
    (error) => error.code === 'AUDIO_SOURCE_NOT_COMMITTED'
  );
});

test('initialize resumes a job after a process boundary without reprocessing a saved chunk', async () => {
  let providerCalls = 0;
  const provider = {
    providerId: 'resume-provider',
    model: 'resume-model',
    async transcribeChunk() {
      providerCalls += 1;
      return { provider: 'resume-provider', model: 'resume-model', segments: [{ startMs: 0, endMs: 1_000, text: '恢复后的第二段。' }] };
    }
  };
  const prepared = await createManager(source('source-resume'), { provider });
  let job = createTranscriptionJob({ ownerId: 'owner-a', meetingId: 'meeting-a', sourceId: 'source-resume', sourceRevision: 4, transcriptId: 'transcript-source-resume-4', jobId: 'transcription-source-resume-4', now: '2026-08-07T00:00:00.000Z' });
  job = transitionTranscriptionJob(job, { type: 'prepare' }, { now: '2026-08-07T00:00:01.000Z' }).state;
  job = transitionTranscriptionJob(job, { type: 'begin_transcribing' }, { now: '2026-08-07T00:00:02.000Z' }).state;
  await prepared.transcriptStore.saveJob(owner(), { job });
  await prepared.transcriptStore.saveChunkResult(owner(), {
    job,
    sequence: 0,
    result: { provider: 'resume-provider', model: 'resume-model', startMs: 0, endMs: 1_000, sourceChunkRefs: ['source-resume-chunk-0'], segments: [{ startMs: 0, endMs: 1_000, text: '已经保存的第一段。', speakerRef: null }] }
  });

  const resumed = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore: createAudioStore(source('source-resume')),
    transcriptStore: prepared.transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:00:00.000Z',
    chunkOptions: { maxChunkDurationMs: 1_000, overlapMs: 0 }
  });
  await resumed.initialize();
  const completed = await resumed.waitForJob('transcription-source-resume-4');
  assert.equal(completed.job.status, 'ready');
  assert.equal(providerCalls, 1);
  const transcript = await prepared.transcriptStore.getTranscript(owner(), { meetingId: 'meeting-a', transcriptId: 'transcript-source-resume-4' });
  assert.deepEqual(transcript.currentRevision.segments.map((segment) => segment.text), ['已经保存的第一段。', '恢复后的第二段。']);
});

test('source revision changes fail closed before a stale transcript can be committed', async () => {
  const original = source('source-revision');
  const backend = createMemoryMeetingBackend();
  const transcriptStore = createMeetingTranscriptStore({ cryptoImpl: webcrypto, keyProvider: await keyProvider(), backend });
  let reads = 0;
  const audioStore = {
    async listMeetings() { return [{ meetingId: 'meeting-a' }]; },
    async getAudioSource() {
      reads += 1;
      return reads === 1 ? original : { ...original, revision: 5, checksum: 'c'.repeat(64) };
    },
    streamAudioSourceDetailed() {
      return (async function* stream() {
        yield { sourceChunkId: 'source-revision-chunk-0', sequence: 0, durationMs: 2_000, bytes: new Uint8Array([1, 2]) };
      }());
    }
  };
  const manager = createMeetingTranscriptionManager({
    ownerContext: owner(),
    audioStore,
    transcriptStore,
    speechGateway: createMeetingSpeechGateway({ provider: createDeterministicFixtureProvider({ text: '不应提交。' }) }),
    cryptoImpl: webcrypto,
    now: () => '2026-08-07T00:00:00.000Z'
  });
  const started = await manager.startTranscription({ sourceId: original.sourceId });
  const completed = await manager.waitForJob(started.job.jobId);
  assert.equal(completed.job.status, 'failed_terminal');
  assert.equal(completed.job.errorCode, 'SOURCE_REVISION_MISMATCH');
  await assert.rejects(
    transcriptStore.getTranscript(owner(), { meetingId: original.meetingId, transcriptId: started.job.transcriptId }),
    (error) => error.code === 'TRANSCRIPT_NOT_FOUND'
  );
});
