import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import {
  createBaseSpeakerCorrectionSnapshot
} from '../../../../core/meeting/stage3b/speakerCorrectionContracts.js';
import { applySpeakerCorrection } from '../../../../core/meeting/stage3b/speakerCorrectionOperations.js';
import { createMemoryMeetingSpeakerCorrectionBackend } from './meetingSpeakerCorrectionBackend.js';
import { createMeetingSpeakerCorrectionStore } from './meetingSpeakerCorrectionStore.js';

const BASE_HASH = 'a'.repeat(64);
const BASE_TIME = '2026-08-09T00:00:00.000Z';

function owner(ownerId = 'owner-a', spaceId = 'meeting-space') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}-${spaceId}`, spaceId });
}

function diarizationRevision(context = owner()) {
  return {
    schemaVersion: 1,
    diarizationRevisionId: 'diarization-1',
    ownerId: context.ownerId,
    meetingId: 'meeting-1',
    transcriptId: 'transcript-1',
    transcriptRevision: 7,
    source: 'provider_role_separation',
    status: 'ready',
    speakerRefs: [
      { schemaVersion: 1, speakerId: 'speaker-1', ownerId: context.ownerId, meetingId: 'meeting-1', label: '说话人1', source: 'provider_role_separation', createdAt: BASE_TIME, updatedAt: BASE_TIME, revision: 1 },
      { schemaVersion: 1, speakerId: 'speaker-2', ownerId: context.ownerId, meetingId: 'meeting-1', label: '说话人2', source: 'provider_role_separation', createdAt: BASE_TIME, updatedAt: BASE_TIME, revision: 1 }
    ],
    segments: [
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-1', startMs: 0, endMs: 1_000, speakerRef: 'speaker-1', confidence: null, source: 'provider_role_separation', revision: 1 },
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-2', startMs: 1_000, endMs: 2_000, speakerRef: 'speaker-2', confidence: null, source: 'provider_role_separation', revision: 1 },
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-3', startMs: 2_000, endMs: 3_000, speakerRef: 'unknown', confidence: null, source: 'unknown', revision: 1 }
    ],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    revision: 1
  };
}

function base(context = owner()) {
  return createBaseSpeakerCorrectionSnapshot({
    ownerContext: context,
    diarizationRevision: diarizationRevision(context),
    baseDiarizationSnapshotHash: BASE_HASH,
    now: BASE_TIME
  });
}

function correction(context, parent, {
  requestId = 'mutation-1',
  revisionId = `correction-${requestId}`,
  label = '主持人',
  speakerId = 'speaker-1',
  operation = 'rename',
  targetSpeakerId,
  transcriptSegmentIds,
  now = '2026-08-09T00:01:00.000Z'
} = {}) {
  return applySpeakerCorrection({
    ownerContext: context,
    currentRevision: parent,
    correctionRevisionId: revisionId,
    mutationRequestId: requestId,
    operation,
    speakerId,
    targetSpeakerId,
    transcriptSegmentIds,
    displayLabel: label,
    now
  });
}

async function createKeyProvider() {
  const keys = new Map();
  const versions = new Map();
  const calls = [];
  const scope = (context) => `${context.ownerId}\u0000${context.spaceId}`;
  async function ensure(context, version = 1) {
    const id = `${scope(context)}\u0000${version}`;
    if (!keys.has(id)) {
      keys.set(id, webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    }
    if (!versions.has(scope(context))) versions.set(scope(context), version);
    return keys.get(id);
  }
  return {
    calls,
    describe() { return { provider: 'test-existing-production-key-provider', exportsKeys: false, available: true }; },
    async getKeyVersion(context) {
      await ensure(context);
      return versions.get(scope(context));
    },
    async withOwnerKey(context, callback) {
      const version = context.keyVersion ?? versions.get(scope(context)) ?? 1;
      const key = await ensure(context, version);
      calls.push({ ownerId: context.ownerId, spaceId: context.spaceId, keyVersion: version, extractable: key.extractable });
      return callback(key);
    },
    async rotate(context) {
      await ensure(context);
      const next = versions.get(scope(context)) + 1;
      versions.set(scope(context), next);
      await ensure(context, next);
      return next;
    }
  };
}

function appendInput(context, parent, revision, overrides = {}) {
  return {
    ownerContext: context,
    meetingId: parent.meetingId,
    transcriptId: parent.transcriptId,
    expectedTranscriptRevision: parent.transcriptRevision,
    baseDiarizationRevisionId: parent.baseDiarizationRevisionId,
    expectedCorrectionRevision: parent.correctionRevision,
    mutationRequestId: revision.audit.mutationRequestId,
    revision,
    ...(parent.correctionRevision === 0 ? { parentRevision: parent } : {}),
    ...overrides
  };
}

function readInput(context, snapshot = base(context)) {
  return {
    ownerContext: context,
    meetingId: snapshot.meetingId,
    transcriptId: snapshot.transcriptId,
    expectedTranscriptRevision: snapshot.transcriptRevision,
    baseDiarizationRevisionId: snapshot.baseDiarizationRevisionId
  };
}

async function fixture(context = owner()) {
  const backend = createMemoryMeetingSpeakerCorrectionBackend();
  const keyProvider = await createKeyProvider();
  const store = createMeetingSpeakerCorrectionStore({ backend, keyProvider, cryptoImpl: webcrypto });
  return { backend, keyProvider, store, context, baseRevision: base(context) };
}

test('first append atomically creates an encrypted document but never persists correction base revision 0', async () => {
  const { backend, store, context, baseRevision } = await fixture();
  const revision = correction(context, baseRevision);
  const result = await store.appendRevision(appendInput(context, baseRevision, revision));

  assert.equal(result.replayed, false);
  assert.equal(result.revision.correctionRevision, 1);
  const document = await store.readDocument(readInput(context, baseRevision));
  assert.equal(document.currentCorrectionRevision, 1);
  assert.equal(document.currentCorrectionRevisionId, revision.correctionRevisionId);
  assert.deepEqual((await store.listRevisions(readInput(context, baseRevision))).map((item) => item.correctionRevision), [1]);
  assert.equal((await backend.list('speakerCorrectionRevisions')).some((row) => row.correctionRevision === 0), false);
});

test('mutation API requires every binding, rejects owner/fingerprint overrides, and derives its own fingerprint', async () => {
  const { store, context, baseRevision } = await fixture();
  const revision = correction(context, baseRevision);
  for (const field of ['meetingId', 'transcriptId', 'expectedTranscriptRevision', 'baseDiarizationRevisionId', 'expectedCorrectionRevision', 'mutationRequestId']) {
    const input = appendInput(context, baseRevision, revision);
    delete input[field];
    await assert.rejects(() => store.appendRevision(input), (error) => String(error.code).includes('SPEAKER_CORRECTION'));
  }
  await assert.rejects(
    () => store.appendRevision({ ...appendInput(context, baseRevision, revision), ownerId: context.ownerId }),
    { code: 'SPEAKER_CORRECTION_REQUEST_SHAPE_INVALID' }
  );
  await assert.rejects(
    () => store.appendRevision({ ...appendInput(context, baseRevision, revision), fingerprint: 'f'.repeat(64) }),
    { code: 'SPEAKER_CORRECTION_REQUEST_SHAPE_INVALID' }
  );
  await assert.rejects(
    () => store.appendRevision({ ...appendInput(context, baseRevision, revision), ownerContext: { ...context, trusted: false } }),
    { code: 'OWNER_CONTEXT_UNTRUSTED' }
  );
});

test('same mutation retries and concurrent duplicates replay despite regenerated IDs/timestamps', async () => {
  const { backend, store, context, baseRevision } = await fixture();
  const firstCandidate = correction(context, baseRevision, { revisionId: 'correction-attempt-1' });
  const retryCandidate = correction(context, baseRevision, {
    revisionId: 'correction-attempt-2',
    now: '2026-08-09T00:02:00.000Z'
  });
  const results = await Promise.all([
    store.appendRevision(appendInput(context, baseRevision, firstCandidate)),
    store.appendRevision(appendInput(context, baseRevision, retryCandidate))
  ]);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(results[0].revision.correctionRevisionId, results[1].revision.correctionRevisionId);
  assert.equal((await backend.list('speakerCorrectionRevisions')).length, 1);

  const replay = await store.appendRevision(appendInput(context, baseRevision, retryCandidate));
  assert.equal(replay.replayed, true);
  assert.equal((await backend.list('speakerCorrectionRevisions')).length, 1);
});

test('same mutation ID with different intent conflicts, and a duplicate fingerprint under another mutation ID conflicts', async () => {
  const { store, context, baseRevision } = await fixture();
  await store.appendRevision(appendInput(context, baseRevision, correction(context, baseRevision, { label: '主持人' })));

  const changedIntent = correction(context, baseRevision, { label: '记录人', revisionId: 'changed-intent' });
  await assert.rejects(
    () => store.appendRevision(appendInput(context, baseRevision, changedIntent)),
    { code: 'SPEAKER_CORRECTION_MUTATION_REQUEST_CONFLICT' }
  );

  const duplicateIntent = correction(context, baseRevision, {
    requestId: 'mutation-2',
    revisionId: 'duplicate-intent',
    label: '主持人'
  });
  await assert.rejects(
    () => store.appendRevision(appendInput(context, baseRevision, duplicateIntent)),
    { code: 'SPEAKER_CORRECTION_FINGERPRINT_CONFLICT' }
  );
});

test('different concurrent writers on one expected head yield one commit and one CAS conflict without orphan rows', async () => {
  const { backend, store, context, baseRevision } = await fixture();
  const candidates = [
    correction(context, baseRevision, { requestId: 'mutation-a', label: '主持人A' }),
    correction(context, baseRevision, { requestId: 'mutation-b', label: '主持人B' })
  ];
  const results = await Promise.allSettled(candidates.map((revision) => store.appendRevision(appendInput(context, baseRevision, revision))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'SPEAKER_CORRECTION_CAS_CONFLICT').length, 1);
  assert.equal((await backend.list('speakerCorrectionDocuments')).length, 1);
  assert.equal((await backend.list('speakerCorrectionRevisions')).length, 1);
});

test('fault after revision add rolls back revision and document head, then a clean retry succeeds', async () => {
  const { backend, store, context, baseRevision } = await fixture();
  const revision = correction(context, baseRevision);
  backend.failNextCommit(Object.assign(new Error('SIMULATED_ATOMIC_FAILURE'), { code: 'SIMULATED_ATOMIC_FAILURE' }), { at: 'afterRevisionAdd' });
  await assert.rejects(() => store.appendRevision(appendInput(context, baseRevision, revision)), { code: 'SIMULATED_ATOMIC_FAILURE' });
  assert.deepEqual(await backend.list('speakerCorrectionDocuments'), []);
  assert.deepEqual(await backend.list('speakerCorrectionRevisions'), []);
  assert.equal((await store.appendRevision(appendInput(context, baseRevision, revision))).replayed, false);
});

test('owner and space locators isolate identical logical meeting IDs without raw-scope collisions', async () => {
  const backend = createMemoryMeetingSpeakerCorrectionBackend();
  const keyProvider = await createKeyProvider();
  const store = createMeetingSpeakerCorrectionStore({ backend, keyProvider, cryptoImpl: webcrypto });
  const contexts = [owner('owner-a', 'space-1'), owner('owner-b', 'space-1'), owner('owner-a', 'space-2')];
  for (const [index, context] of contexts.entries()) {
    const snapshot = base(context);
    const revision = correction(context, snapshot, { requestId: `mutation-${index}`, label: `角色${index}` });
    await store.appendRevision(appendInput(context, snapshot, revision));
  }
  assert.equal((await backend.list('speakerCorrectionDocuments')).length, 3);
  for (const [index, context] of contexts.entries()) {
    const current = await store.listRevisions(readInput(context, base(context)));
    assert.equal(current[0].speakerRefs[0].displayLabel, `角色${index}`);
  }

  await assert.rejects(
    () => store.readDocument(readInput(owner('owner-c'), base(owner('owner-c')))),
    { code: 'SPEAKER_CORRECTION_DOCUMENT_NOT_FOUND' }
  );
});

test('raw database rows contain only opaque authenticated envelopes and tampering fails closed', async () => {
  const { backend, store, context, baseRevision } = await fixture();
  const revision = correction(context, baseRevision);
  await store.appendRevision(appendInput(context, baseRevision, revision));
  const dump = backend.dump();
  const serialized = JSON.stringify(dump);
  for (const secret of ['owner-a', 'meeting-space', 'meeting-1', 'transcript-1', 'diarization-1', '主持人', 'segment-1', 'mutation-1', 'correction-mutation-1']) {
    assert.equal(serialized.includes(secret), false, `raw storage leaked ${secret}`);
  }
  const rows = [...dump.speakerCorrectionDocuments, ...dump.speakerCorrectionRevisions];
  assert.equal(rows.every((row) => row.nonce.byteLength === 12 && row.ciphertext.byteLength > 0), true);

  const revisionRow = dump.speakerCorrectionRevisions[0];
  backend.replace('speakerCorrectionRevisions', revisionRow.id, { ...revisionRow, requestFingerprint: 'f'.repeat(64) });
  await assert.rejects(
    () => store.readRevision({ ...readInput(context, baseRevision), correctionRevision: 1 }),
    { code: 'SPEAKER_CORRECTION_CIPHERTEXT_INVALID' }
  );
});

test('ciphertext, clear head metadata, and invalid keyVersion cannot bypass AES-GCM authentication', async () => {
  for (const mutate of [
    (row) => { row.ciphertext[0] ^= 1; },
    (row) => { row.headCorrectionRevision = 2; },
    (row) => { row.keyVersion = 0; }
  ]) {
    const { backend, store, context, baseRevision } = await fixture();
    await store.appendRevision(appendInput(context, baseRevision, correction(context, baseRevision)));
    const row = backend.dump().speakerCorrectionDocuments[0];
    mutate(row);
    backend.replace('speakerCorrectionDocuments', row.id, row);
    await assert.rejects(
      () => store.readDocument(readInput(context, baseRevision)),
      (error) => ['SPEAKER_CORRECTION_CIPHERTEXT_INVALID', 'SPEAKER_CORRECTION_KEY_VERSION_INVALID'].includes(error.code)
    );
  }
});

test('key rotation writes new rows at the new keyVersion and reopen recovers old and new revisions', async () => {
  const { backend, keyProvider, store, context, baseRevision } = await fixture();
  const revision1 = correction(context, baseRevision, { requestId: 'mutation-1', speakerId: 'speaker-1', label: '主持人' });
  await store.appendRevision(appendInput(context, baseRevision, revision1));
  await keyProvider.rotate(context);
  const revision2 = correction(context, revision1, { requestId: 'mutation-2', speakerId: 'speaker-2', label: '记录人', now: '2026-08-09T00:02:00.000Z' });
  await store.appendRevision(appendInput(context, revision1, revision2));

  const raw = backend.dump();
  assert.deepEqual(raw.speakerCorrectionRevisions.map((row) => row.keyVersion).sort(), [1, 2]);
  assert.equal(raw.speakerCorrectionDocuments[0].keyVersion, 2);
  const reopened = createMeetingSpeakerCorrectionStore({ backend: backend.reopen(), keyProvider, cryptoImpl: webcrypto });
  const revisions = await reopened.listRevisions(readInput(context, baseRevision));
  assert.deepEqual(revisions.map((revision) => revision.correctionRevision), [1, 2]);
  assert.equal(revisions[1].speakerRefs.find((speaker) => speaker.speakerId === 'speaker-2').displayLabel, '记录人');
  assert.equal(keyProvider.calls.some((call) => call.keyVersion === 1), true);
  assert.equal(keyProvider.calls.every((call) => call.extractable === false), true);
});

test('unknown remains a legal persisted assignment and missing head revision fails integrity recovery', async () => {
  const { backend, store, context, baseRevision } = await fixture();
  const revision = correction(context, baseRevision, {
    requestId: 'mutation-unknown',
    operation: 'reassign',
    targetSpeakerId: 'unknown',
    transcriptSegmentIds: ['segment-1']
  });
  await store.appendRevision(appendInput(context, baseRevision, revision));
  assert.equal((await store.readRevision({ ...readInput(context, baseRevision), correctionRevision: 1 })).assignments[0].speakerRef, 'unknown');

  const row = backend.dump().speakerCorrectionRevisions[0];
  backend.deleteDirect('speakerCorrectionRevisions', row.id);
  await assert.rejects(() => store.listRevisions(readInput(context, baseRevision)), { code: 'SPEAKER_CORRECTION_STORED_CHAIN_INVALID' });
});
