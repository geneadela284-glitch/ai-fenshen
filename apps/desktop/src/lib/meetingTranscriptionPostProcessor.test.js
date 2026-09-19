import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureMeetingDiarization } from './meetingTranscriptionPostProcessor.js';

test('runs anonymous diarization after a ready Transcript and waits for its encrypted revision', async () => {
  const calls = [];
  const source = { sourceId: 'source-a', meetingId: 'meeting-a' };
  const transcript = {
    document: {
      status: 'ready',
      transcriptId: 'transcript-source-a-1',
      transcriptRevision: 1
    }
  };
  const transcriptionManager = {
    async getTranscriptView(input) {
      calls.push(['getTranscriptView', input]);
      return { transcript };
    }
  };
  const diarizationManager = {
    revision: null,
    async getDiarizationView(input) {
      calls.push(['getDiarizationView', input]);
      return { revision: this.revision };
    },
    async startDiarization(input) {
      calls.push(['startDiarization', input]);
      return { job: { jobId: 'diarization-source-a-1-1' } };
    },
    async waitForJob(jobId) {
      calls.push(['waitForJob', jobId]);
      this.revision = { revision: 1, transcriptRevision: 1 };
      return { job: { jobId, status: 'ready' } };
    }
  };

  const result = await ensureMeetingDiarization({ source, transcriptionManager, diarizationManager });

  assert.equal(result.job.status, 'ready');
  assert.deepEqual(calls, [
    ['getTranscriptView', { sourceId: 'source-a', meetingId: 'meeting-a' }],
    ['getDiarizationView', { meetingId: 'meeting-a', transcriptId: 'transcript-source-a-1' }],
    ['startDiarization', {
      sourceId: 'source-a',
      meetingId: 'meeting-a',
      transcriptId: 'transcript-source-a-1',
      speakerCount: 0
    }],
    ['waitForJob', 'diarization-source-a-1-1'],
    ['getDiarizationView', { meetingId: 'meeting-a', transcriptId: 'transcript-source-a-1' }]
  ]);
});

test('records Generation 218 backfill gates and carries one safe trace into the manager', async () => {
  const diagnostics = [];
  const transcript = {
    document: {
      status: 'ready',
      transcriptId: 'transcript-source-a-1',
      transcriptRevision: 1
    }
  };
  const transcriptionManager = {
    async getTranscriptView() { return { transcript }; },
    async recordDiagnostic(event) { diagnostics.push(event); }
  };
  const diarizationManager = {
    getSnapshot() { return { jobs: [] }; },
    async getDiarizationView() { return { revision: null }; },
    async startDiarization(input) {
      assert.equal(input.traceId, 'diarization-backfill-test');
      return { job: { jobId: 'diarization-source-a-1-1' } };
    },
    async waitForJob(jobId) {
      return { job: { jobId, status: 'ready' } };
    }
  };
  diarizationManager.getDiarizationView = (() => {
    let calls = 0;
    return async () => ({ revision: calls++ === 0 ? null : { revision: 1, transcriptRevision: 1 } });
  })();

  const result = await ensureMeetingDiarization({
    source: { sourceId: 'source-a', meetingId: 'meeting-a', revision: 1 },
    transcriptionManager,
    diarizationManager,
    diagnosticTraceId: 'diarization-backfill-test',
    diagnosticMetadata: {
      ownerId: 'owner-a',
      generation: '218',
      buildMarker: 'stage3b-a-review-generation-218',
      sourceBaseCommit: '90bae01a6f4156a5abb84b870f7ed587484d073f'
    }
  });

  assert.equal(result.job.status, 'ready');
  assert.deepEqual(diagnostics.map((event) => ({ phase: event.phase, gate: event.gate, status: event.status })), [
    { phase: 'diarization_backfill', gate: 'G1', status: 'PASS' },
    { phase: 'diarization_backfill', gate: 'G2', status: 'PASS' },
    { phase: 'diarization_backfill', gate: 'G3', status: 'PASS' },
    { phase: 'diarization_backfill', gate: 'G4', status: 'PASS' },
    { phase: 'diarization_backfill', gate: 'G7', status: 'PASS' },
    { phase: 'diarization_backfill', gate: 'G8', status: 'PASS' }
  ]);
  assert.equal(new Set(diagnostics.map((event) => event.traceId)).size, 1);
  assert.equal(diagnostics.every((event) => event.generation === '218'), true);
});
