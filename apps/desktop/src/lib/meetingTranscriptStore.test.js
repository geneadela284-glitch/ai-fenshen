import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  createMemoryMeetingBackend
} from './browserMeetingStore.js';
import {
  createCorrectionRevision,
  createTranscriptDocument,
  createTranscriptRevision,
  createTranscriptSegment,
  stableTranscriptSegmentId
} from '../../../../core/meeting/stage3a/transcriptContracts.js';
import { createMeetingTranscriptStore } from './meetingTranscriptStore.js';

function owner(ownerId = 'owner-a') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' });
}

function segment(revision = 1) {
  return createTranscriptSegment({
    transcriptId: 'transcript-a',
    transcriptRevision: revision,
    segmentId: stableTranscriptSegmentId({ transcriptId: 'transcript-a', sequence: 0, startMs: 0, endMs: 1000 }),
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    text: revision === 1 ? '原始会议内容。' : '校正后的会议内容。',
    confidence: 0.9,
    speakerRef: null,
    sourceChunkRefs: ['chunk-0'],
    revision
  });
}

function source(ownerId = 'owner-a') {
  return {
    sourceId: 'source-a',
    meetingId: 'meeting-a',
    ownerId,
    scope: 'meeting',
    origin: 'imported',
    importState: 'committed',
    revision: 4,
    checksum: 'b'.repeat(64)
  };
}

async function keyProvider(keys) {
  for (const ownerId of Object.keys(keys)) {
    keys[ownerId] = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  return {
    async withOwnerKey(context, callback) {
      const key = keys[context.ownerId];
      if (!key) throw Object.assign(new Error('KEY_NOT_FOUND'), { code: 'KEY_NOT_FOUND' });
      return callback(key);
    }
  };
}

function rawDocument(context = owner()) {
  return createTranscriptDocument({
    ownerContext: context,
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 4,
    language: 'zh-CN',
    provider: 'deterministic-fixture',
    model: 'fixture-v1',
    status: 'ready',
    sourceChecksum: 'b'.repeat(64),
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z'
  });
}

function rawRevision(context = owner()) {
  return createTranscriptRevision({
    ownerContext: context,
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 4,
    transcriptRevision: 1,
    kind: 'raw_asr',
    segments: [segment(1)],
    createdAt: '2026-08-07T00:00:00.000Z'
  });
}

test('transcript documents and revisions are encrypted, owner-scoped and raw-preserving', async () => {
  const backend = createMemoryMeetingBackend();
  const keys = { 'owner-a': null, 'owner-b': null };
  const provider = await keyProvider(keys);
  const store = createMeetingTranscriptStore({ cryptoImpl: webcrypto, keyProvider: provider, backend });
  const context = owner('owner-a');
  await store.createRawTranscript(context, { source: source(), document: rawDocument(context), revision: rawRevision(context) });
  const loaded = await store.getTranscript(context, { meetingId: 'meeting-a', transcriptId: 'transcript-a' });
  assert.equal(loaded.document.status, 'ready');
  assert.equal(loaded.revisions[0].segments[0].text, '原始会议内容。');
  const corrected = createCorrectionRevision({ ownerContext: context, parent: loaded.revisions[0], actorId: 'owner-a', edits: [{ segmentId: loaded.revisions[0].segments[0].segmentId, text: '校正后的会议内容。' }] });
  await store.appendRevision(context, { revision: corrected });
  const after = await store.getTranscript(context, { meetingId: 'meeting-a', transcriptId: 'transcript-a' });
  assert.equal(after.document.transcriptRevision, 2);
  assert.equal(after.currentRevision.segments[0].text, '校正后的会议内容。');
  assert.equal(after.revisions[0].segments[0].text, '原始会议内容。');
  assert.doesNotMatch(JSON.stringify(backend.dump()), /原始会议内容|校正后的会议内容/);
  assert.equal(Object.keys(keys).length, 2);
});

test('transcript reads fail closed across owners, wrong keys and tampering', async () => {
  const backend = createMemoryMeetingBackend();
  const keys = { 'owner-a': null, 'owner-b': null };
  const provider = await keyProvider(keys);
  const store = createMeetingTranscriptStore({ cryptoImpl: webcrypto, keyProvider: provider, backend });
  const contextA = owner('owner-a');
  await store.createRawTranscript(contextA, { source: source(), document: rawDocument(contextA), revision: rawRevision(contextA) });
  await assert.rejects(
    store.getTranscript(owner('owner-b'), { meetingId: 'meeting-a', transcriptId: 'transcript-a' }),
    (error) => error.code === 'TRANSCRIPT_NOT_FOUND'
  );
  const originalKey = keys['owner-a'];
  keys['owner-a'] = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await assert.rejects(
    store.getTranscript(contextA, { meetingId: 'meeting-a', transcriptId: 'transcript-a' }),
    (error) => error.code === 'TRANSCRIPT_CIPHERTEXT_INVALID'
  );
  keys['owner-a'] = originalKey;
  const revisionRow = backend.dump().transcriptRevisions[0];
  backend.mutate('transcriptRevisions', revisionRow.id, (record) => ({
    ...record,
    ciphertext: Uint8Array.from(record.ciphertext, (value, index) => index === 0 ? value ^ 0xff : value)
  }));
  await assert.rejects(
    store.getTranscript(contextA, { meetingId: 'meeting-a', transcriptId: 'transcript-a' }),
    (error) => error.code === 'TRANSCRIPT_CIPHERTEXT_INVALID'
  );
});

test('jobs and chunk results are idempotent and source-revision bound', async () => {
  const backend = createMemoryMeetingBackend();
  const provider = await keyProvider({ 'owner-a': null });
  const store = createMeetingTranscriptStore({ cryptoImpl: webcrypto, keyProvider: provider, backend });
  const context = owner('owner-a');
  const job = {
    schemaVersion: 1,
    jobId: 'job-a',
    transcriptId: 'transcript-a',
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 4,
    status: 'transcribing',
    attempts: 1,
    retryWindowStartedAt: '2026-08-07T00:00:00.000Z',
    nextChunkSequence: 0,
    chunkCount: 1,
    completedChunkSequences: [],
    requestId: 'request-a',
    lease: null,
    cursor: null,
    errorCode: '',
    transcriptRevision: 1,
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    revision: 1
  };
  const first = await store.saveJob(context, { job });
  const duplicate = await store.saveJob(context, { job });
  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  await store.saveChunkResult(context, {
    job,
    sequence: 0,
    result: { provider: 'deterministic-fixture', model: 'fixture-v1', segments: [{ startMs: 0, endMs: 1000, text: '加密分块结果。', confidence: 0.8, speakerRef: null }] }
  });
  const chunks = await store.listChunkResults(context, { jobId: 'job-a', meetingId: 'meeting-a', sourceId: 'source-a', transcriptId: 'transcript-a', transcriptRevision: 1 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].result.segments[0].speakerRef, null);
  await assert.rejects(
    store.listChunkResults(context, { jobId: 'job-a', meetingId: 'meeting-a', sourceId: 'source-a', transcriptId: 'transcript-a', transcriptRevision: 2 }),
    (error) => error.code === 'TRANSCRIPTION_CHUNK_SCOPE_MISMATCH'
  );
});

test('transcript document and revision writes are atomic and failed correction leaves raw revision intact', async () => {
  const backend = createMemoryMeetingBackend();
  const provider = await keyProvider({ 'owner-a': null });
  const store = createMeetingTranscriptStore({ cryptoImpl: webcrypto, keyProvider: provider, backend });
  const context = owner('owner-a');
  backend.failNextAtomic(new Error('SIMULATED_TRANSCRIPT_ATOMIC_FAILURE'));
  await assert.rejects(
    store.createRawTranscript(context, { source: source(), document: rawDocument(context), revision: rawRevision(context) }),
    (error) => error.message === 'SIMULATED_TRANSCRIPT_ATOMIC_FAILURE'
  );
  assert.equal(backend.dump().transcriptDocuments.length, 0);
  assert.equal(backend.dump().transcriptRevisions.length, 0);
  await store.createRawTranscript(context, { source: source(), document: rawDocument(context), revision: rawRevision(context) });
  const loaded = await store.getTranscript(context, { meetingId: 'meeting-a', transcriptId: 'transcript-a' });
  const corrected = createCorrectionRevision({ ownerContext: context, parent: loaded.currentRevision, actorId: 'owner-a', edits: [{ segmentId: loaded.currentRevision.segments[0].segmentId, text: '不会写入。' }] });
  backend.failNextAtomic(new Error('SIMULATED_CORRECTION_ATOMIC_FAILURE'));
  await assert.rejects(
    store.appendRevision(context, { revision: corrected }),
    (error) => error.message === 'SIMULATED_CORRECTION_ATOMIC_FAILURE'
  );
  const after = await store.getTranscript(context, { meetingId: 'meeting-a', transcriptId: 'transcript-a' });
  assert.equal(after.revisions.length, 1);
  assert.equal(after.currentRevision.segments[0].text, '原始会议内容。');
});
