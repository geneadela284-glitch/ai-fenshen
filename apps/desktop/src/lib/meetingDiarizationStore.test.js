import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

import { createMemoryMeetingBackend } from './browserMeetingStore.js';
import { createDiarizationRevision, createDiarizationSegment, createSpeakerRef } from '../../../../core/meeting/stage3b/diarizationContracts.js';
import { createMeetingDiarizationStore } from './meetingDiarizationStore.js';

const cryptoImpl = webcrypto;

function ownerContext(ownerId) {
  return Object.freeze({
    trusted: true,
    ownerId,
    sessionId: `session-${ownerId}`,
    spaceId: 'meeting-space'
  });
}

async function createKeyProvider() {
  const key = await cryptoImpl.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return {
    async withOwnerKey(_context, callback) {
      return callback(key);
    }
  };
}

function revisionFor(ownerContext, transcriptRevision = 7) {
  const speaker = createSpeakerRef({
    ownerContext,
    meetingId: 'meeting-a',
    speakerId: 'speaker-1',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  });
  const segment = createDiarizationSegment({
    meetingId: 'meeting-a',
    transcriptId: 'transcript-a',
    transcriptRevision,
    transcriptSegmentId: 'segment-0',
    startMs: 0,
    endMs: 8_000,
    speakerRef: 'speaker-1',
    confidence: null,
    source: 'provider_role_separation',
    revision: 1
  });
  return createDiarizationRevision({
    ownerContext,
    diarizationRevisionId: `diarization-revision-${transcriptRevision}`,
    meetingId: 'meeting-a',
    transcriptId: 'transcript-a',
    transcriptRevision,
    source: 'provider_role_separation',
    speakerRefs: [speaker],
    segments: [segment],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  });
}

function job() {
  return {
    schemaVersion: 1,
    jobId: 'diarization-job-a',
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    transcriptId: 'transcript-a',
    transcriptRevision: 7,
    mode: 'diarization',
    speakerCount: 2,
    status: 'queued',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    revision: 1,
    attempts: 0,
    errorCode: null
  };
}

test('Diarization Store uses Owner DEK/AES-GCM, owner scoping, revision binding, and encrypted payloads', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingDiarizationStore({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const ownerA = ownerContext('owner-a');
  const ownerB = ownerContext('owner-b');
  const revision = revisionFor(ownerA);

  const saved = await store.saveRevision(ownerA, revision);
  assert.equal(saved.idempotent, false);
  const loaded = await store.getCurrentRevision(ownerA, {
    meetingId: 'meeting-a',
    transcriptId: 'transcript-a',
    transcriptRevision: 7
  });
  assert.deepEqual(loaded.revision, revision);

  await assert.rejects(
    store.getCurrentRevision(ownerB, { meetingId: 'meeting-a', transcriptId: 'transcript-a' }),
    (error) => error.code === 'DIARIZATION_NOT_FOUND'
  );
  await assert.rejects(
    store.getCurrentRevision(ownerA, { meetingId: 'meeting-a', transcriptId: 'transcript-a', transcriptRevision: 8 }),
    (error) => error.code === 'DIARIZATION_TRANSCRIPT_REVISION_MISMATCH'
  );

  const persisted = JSON.stringify(backend.dump());
  assert.doesNotMatch(persisted, /说话人1|segment-0/);
  assert.match(persisted, /ciphertext|nonce/);
});

test('Diarization Store protects ciphertext integrity and scopes jobs to the owner', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingDiarizationStore({ cryptoImpl, keyProvider: await createKeyProvider(), backend });
  const ownerA = ownerContext('owner-a');
  await store.saveRevision(ownerA, revisionFor(ownerA));
  await store.saveJob(ownerA, job());

  const jobView = await store.getJob(ownerA, 'diarization-job-a');
  assert.equal(jobView.jobId, 'diarization-job-a');
  await assert.rejects(
    store.getJob(ownerContext('owner-b'), 'diarization-job-a'),
    (error) => error.code === 'DIARIZATION_JOB_NOT_FOUND'
  );

  const revisionRow = backend.dump().diarizationRevisions[0];
  backend.mutate('diarizationRevisions', revisionRow.id, (row) => ({
    ...row,
    ciphertext: Uint8Array.from(row.ciphertext, (value, index) => index === 0 ? value ^ 0xff : value)
  }));
  await assert.rejects(
    store.getCurrentRevision(ownerA, { meetingId: 'meeting-a', transcriptId: 'transcript-a' }),
    (error) => error.code === 'DIARIZATION_CIPHERTEXT_INVALID'
  );
});
