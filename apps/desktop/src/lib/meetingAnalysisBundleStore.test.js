import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import {
  MEETING_PHASE1_DATABASE_VERSION,
  createIndexedDbMeetingBackend,
  createMemoryMeetingBackend
} from './browserMeetingStore.js';
import {
  createTranscriptRevision,
  createTranscriptSegment,
  stableTranscriptSegmentId
} from '../../../../core/meeting/stage3a/transcriptContracts.js';
import { createEvidenceRef } from '../../../../core/meeting/stage4/meetingEvidenceRefContracts.js';
import { createMeetingActionItem } from '../../../../core/meeting/stage4/meetingActionItemContracts.js';
import { createMeetingAnalysisBundle } from '../../../../core/meeting/stage4/meetingAnalysisBundleContracts.js';
import { createMeetingDecision } from '../../../../core/meeting/stage4/meetingDecisionContracts.js';
import { createMeetingSummary } from '../../../../core/meeting/stage4/meetingSummaryContracts.js';
import { createMeetingAnalysisBundleStore } from './meetingAnalysisBundleStore.js';

const cryptoImpl = webcrypto;
const NOW = '2026-08-16T10:00:00.000Z';
const HASH = 'a'.repeat(64);

function owner(ownerId = 'owner-a') {
  return { trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' };
}

function source(ownerId = 'owner-a', overrides = {}) {
  return {
    sourceId: 'source-a',
    meetingId: 'meeting-a',
    ownerId,
    scope: 'meeting',
    origin: 'recorded',
    importState: 'committed',
    revision: 2,
    checksum: HASH,
    durationMs: 20_000,
    ...overrides
  };
}

function transcriptRevision(revision = 1, text = '李总负责跟进报价，日期需要再次确认。', ownerId = 'owner-a') {
  const segment = createTranscriptSegment({
    transcriptId: 'transcript-a',
    transcriptRevision: revision,
    segmentId: stableTranscriptSegmentId({ transcriptId: 'transcript-a', sequence: 0, startMs: 0, endMs: 2_000 }),
    sequence: 0,
    startMs: 0,
    endMs: 2_000,
    text,
    confidence: 0.95,
    speakerRef: null,
    sourceChunkRefs: ['chunk-0'],
    revision
  });
  return createTranscriptRevision({
    ownerContext: owner(ownerId),
    transcriptId: 'transcript-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 2,
    transcriptRevision: revision,
    segments: [segment],
    createdAt: NOW,
    createdBy: 'system'
  });
}

function evidenceRef({ context = owner(), sourceValue = source(), transcript = transcriptRevision() } = {}) {
  return createEvidenceRef({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    segmentId: transcript.segments[0].segmentId,
    textSpan: {
      startOffset: 0,
      endOffset: transcript.segments[0].text.length,
      quote: transcript.segments[0].text
    },
    createdAt: NOW
  });
}

function phase2Result({ context = owner(), sourceValue = source(context.ownerId), transcript = transcriptRevision(1, undefined, context.ownerId) } = {}) {
  const ref = evidenceRef({ context, sourceValue, transcript });
  const summary = createMeetingSummary({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      summaryId: 'summary-a',
      resultRevisionId: `summary-revision-${transcript.transcriptRevision}`,
      resultRevision: transcript.transcriptRevision,
      status: 'ready',
      topic: { value: '报价跟进', groundingStatus: 'grounded', evidenceRefs: [ref] },
      overview: { value: '会议明确了报价跟进事项。', groundingStatus: 'grounded', evidenceRefs: [ref] },
      keyPoints: [{ keyPointId: 'key-point-a', category: 'fact', content: '报价需要继续跟进。', evidenceRefs: [ref] }],
      conclusions: [],
      openQuestions: [],
      evidenceRefs: [ref]
    }
  });
  const decision = createMeetingDecision({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      decisionId: 'decision-a',
      content: '报价继续跟进。',
      status: 'confirmed',
      confidence: { level: 'high', basis: 'explicit_statement' },
      evidenceRefs: [ref]
    }
  });
  const actionItem = createMeetingActionItem({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    now: NOW,
    value: {
      actionId: 'action-a',
      content: '跟进报价。',
      owner: 'unresolved',
      ownerRef: null,
      dueDate: 'unresolved',
      amount: 'unresolved',
      quantity: 'unresolved',
      status: 'unresolved',
      unresolvedReasons: ['OWNER_NOT_STATED', 'DUE_DATE_NOT_STATED'],
      evidenceRefs: [ref]
    }
  });
  return {
    ok: true,
    status: 'ready',
    data: { summary, decisions: [decision], actionItems: [actionItem], evidenceRefs: [ref] },
    diagnostics: { modelCalls: 1 }
  };
}

function bundle({ context = owner(), sourceValue = source(context.ownerId), transcript = transcriptRevision(1, undefined, context.ownerId), analysisId = 'analysis-a', analysisRevision = transcript.transcriptRevision, idempotencyKey = `request-${analysisId}-${analysisRevision}`, parentAnalysisId = null } = {}) {
  return createMeetingAnalysisBundle({
    ownerContext: context,
    source: sourceValue,
    transcriptRevision: transcript,
    analysisId,
    analysisRevision,
    parentAnalysisId,
    idempotencyKey,
    result: phase2Result({ context, sourceValue, transcript }),
    createdAt: NOW,
    updatedAt: NOW,
    provenance: { capability: 'MEETING_SUMMARY' }
  });
}

async function keyProvider() {
  const keys = new Map();
  return {
    async withOwnerKey(context, callback) {
      if (!keys.has(context.ownerId)) {
        keys.set(context.ownerId, await cryptoImpl.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        ));
      }
      return callback(keys.get(context.ownerId));
    }
  };
}

function currentContext(context = owner(), sourceValue = source(context.ownerId), transcript = transcriptRevision(1, undefined, context.ownerId)) {
  return { source: sourceValue, currentTranscriptRevision: transcript };
}

function storeFixture() {
  const backend = createMemoryMeetingBackend();
  return keyProvider().then((keys) => ({
    backend,
    keyProvider: keys,
    store: createMeetingAnalysisBundleStore({ cryptoImpl, keyProvider: keys, backend, now: () => NOW })
  }));
}

test('extends the existing Meeting IndexedDB schema with analysisBundles without dropping old stores', async () => {
  const priorStores = [
    'meetings', 'manifests', 'segments', 'pendingSegments', 'audioSources', 'audioManifests', 'audioAssets',
    'transcriptDocuments', 'transcriptRevisions', 'transcriptionJobs', 'transcriptionChunks',
    'diarizationDocuments', 'diarizationRevisions', 'diarizationJobs'
  ];
  const stores = new Set(priorStores);
  const created = [];
  let openedVersion = 0;
  let transaction = null;
  const database = {
    objectStoreNames: { contains(name) { return stores.has(name); } },
    createObjectStore(name) { created.push(name); stores.add(name); },
    transaction() {
      transaction = {
        objectStore() {
          return {
            getAll() {
              const result = {};
              queueMicrotask(() => {
                result.result = [];
                result.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return result;
            }
          };
        }
      };
      return transaction;
    }
  };
  const indexedDBImpl = {
    open(_name, version) {
      openedVersion = version;
      const request = { result: database };
      queueMicrotask(() => {
        request.onupgradeneeded?.({ oldVersion: 5, newVersion: version });
        request.onsuccess?.();
      });
      return request;
    }
  };

  const backend = createIndexedDbMeetingBackend({ indexedDBImpl, databaseName: 'phase3-migration-test' });
  await backend.list('meetings');
  await backend.list('analysisBundles');
  assert.equal(MEETING_PHASE1_DATABASE_VERSION, 6);
  assert.deepEqual(created, ['analysisBundles']);
  assert.deepEqual(priorStores.filter((name) => !stores.has(name)), []);
  assert.equal(openedVersion, 6);
});

test('persists one encrypted bundle atomically and reopens it after a fresh store instance', async () => {
  const fixture = await storeFixture();
  const context = owner();
  const value = bundle();
  const saved = await fixture.store.save(context, { bundle: value });
  assert.equal(saved.idempotent, false);
  const raw = fixture.backend.dump().analysisBundles[0];
  assert.equal(Object.hasOwn(raw, 'summary'), false);
  assert.equal(Object.hasOwn(raw, 'transcript'), false);
  assert.doesNotMatch(JSON.stringify(raw), /报价跟进/);
  assert.doesNotMatch(JSON.stringify(raw), /apiKey|password|secret/i);

  const reopenedStore = createMeetingAnalysisBundleStore({
    cryptoImpl,
    keyProvider: fixture.keyProvider,
    backend: fixture.backend,
    now: () => NOW
  });
  const reopened = await reopenedStore.get(context, {
    meetingId: 'meeting-a',
    analysisId: 'analysis-a',
    currentContext: currentContext()
  });
  assert.equal(reopened.status, 'CURRENT');
  assert.equal(reopened.summary.topic.value, '报价跟进');
  assert.equal(reopened.decisions[0].decisionId, 'decision-a');
  assert.equal(reopened.actionItems[0].owner, 'unresolved');
  assert.equal(reopened.evidenceRefResolutions[0].status, 'VALID');
});

test('repeated save is idempotent and conflicting same-revision content is rejected', async () => {
  const fixture = await storeFixture();
  const context = owner();
  const value = bundle();
  assert.equal((await fixture.store.save(context, { bundle: value })).idempotent, false);
  assert.equal((await fixture.store.save(context, { bundle: value })).idempotent, true);

  const conflict = { ...value, updatedAt: '2026-08-16T10:01:00.000Z', provenance: { capability: 'OTHER' } };
  await assert.rejects(
    fixture.store.save(context, { bundle: conflict }),
    (error) => error?.code === 'ANALYSIS_IDEMPOTENCY_CONFLICT'
  );
  assert.equal((await fixture.store.list(context, { meetingId: 'meeting-a' })).length, 1);
});

test('concurrent retries converge to one idempotent bundle', async () => {
  const fixture = await storeFixture();
  const context = owner();
  const value = bundle();
  const results = await Promise.all([
    fixture.store.save(context, { bundle: value }),
    fixture.store.save(context, { bundle: value })
  ]);

  assert.deepEqual(results.map((result) => result.idempotent).sort(), [false, true]);
  assert.equal((await fixture.store.list(context, { meetingId: 'meeting-a' })).length, 1);
});

test('atomic failure rolls back a new bundle and preserves the previous successful bundle', async () => {
  const fixture = await storeFixture();
  const context = owner();
  await fixture.store.save(context, { bundle: bundle() });
  fixture.backend.failNextAtomic(new Error('SIMULATED_TRANSACTION_FAILURE'));
  await assert.rejects(
    fixture.store.save(context, { bundle: bundle({ analysisId: 'analysis-a-v2', analysisRevision: 2, parentAnalysisId: 'analysis-a' }) }),
    (error) => error?.code === 'ANALYSIS_ATOMIC_COMMIT_FAILED'
  );
  const rows = await fixture.store.list(context, { meetingId: 'meeting-a' });
  assert.deepEqual(rows.map((item) => item.analysisId), ['analysis-a']);
});

test('Transcript revision change makes the old bundle stale and the new revision current without overwriting history', async () => {
  const fixture = await storeFixture();
  const context = owner();
  const first = bundle();
  const secondTranscript = transcriptRevision(2);
  const second = bundle({ analysisId: 'analysis-a-v2', analysisRevision: 2, parentAnalysisId: 'analysis-a', transcript: secondTranscript });
  await fixture.store.save(context, { bundle: first });
  await fixture.store.save(context, { bundle: second });

  const old = await fixture.store.get(context, {
    meetingId: 'meeting-a',
    analysisId: 'analysis-a',
    currentContext: currentContext(context, source(), secondTranscript)
  });
  const current = await fixture.store.getCurrent(context, {
    meetingId: 'meeting-a',
    currentContext: currentContext(context, source(), secondTranscript)
  });
  assert.equal(old.status, 'STALE');
  assert.equal(old.evidenceRefResolutions[0].status, 'STALE');
  assert.equal(current.analysisId, 'analysis-a-v2');
  assert.equal(current.status, 'CURRENT');
  assert.equal((await fixture.store.list(context, { meetingId: 'meeting-a' })).length, 2);
});

test('a later analysis revision supersedes an earlier result bound to the same transcript revision', async () => {
  const fixture = await storeFixture();
  const context = owner();
  await fixture.store.save(context, { bundle: bundle() });
  await fixture.store.save(context, {
    bundle: bundle({
      analysisId: 'analysis-a-v2',
      analysisRevision: 2,
      parentAnalysisId: 'analysis-a'
    })
  });

  const values = await fixture.store.list(context, {
    meetingId: 'meeting-a',
    currentContext: currentContext()
  });
  assert.deepEqual(values.map((value) => [value.analysisId, value.status]), [
    ['analysis-a-v2', 'CURRENT'],
    ['analysis-a', 'SUPERSEDED']
  ]);
});

test('invalid EvidenceRef on reopen is not presented as grounded', async () => {
  const fixture = await storeFixture();
  const context = owner();
  await fixture.store.save(context, { bundle: bundle() });
  const changedTranscript = transcriptRevision(1, '文本已经被改写，原始引用不再成立。');
  const reopened = await fixture.store.get(context, {
    meetingId: 'meeting-a',
    analysisId: 'analysis-a',
    currentContext: currentContext(context, source(), changedTranscript)
  });
  assert.equal(reopened.status, 'INVALID');
  assert.equal(reopened.groundingStatus, 'INVALID');
  assert.notEqual(reopened.groundingStatus, 'GROUNDING_SUPPORTED');
});

test('a storage schema mismatch fails closed while preserving the encrypted row', async () => {
  const fixture = await storeFixture();
  const context = owner();
  await fixture.store.save(context, { bundle: bundle() });
  const rowId = fixture.backend.dump().analysisBundles[0].id;
  fixture.backend.mutate('analysisBundles', rowId, (row) => ({ ...row, schemaVersion: 'meeting-analysis-bundle-storage-v999' }));

  await assert.rejects(
    fixture.store.get(context, { meetingId: 'meeting-a', analysisId: 'analysis-a' }),
    (error) => error?.code === 'ANALYSIS_SCHEMA_MISMATCH'
  );
  assert.equal(fixture.backend.dump().analysisBundles.length, 1);
  assert.equal(Object.hasOwn(fixture.backend.dump().analysisBundles[0], 'ciphertext'), true);
});

test('a failed candidate cannot replace an existing successful analysis', async () => {
  const fixture = await storeFixture();
  const context = owner();
  const successful = bundle();
  await fixture.store.save(context, { bundle: successful });
  await assert.rejects(
    fixture.store.save(context, { bundle: { ...successful, status: 'STALE', groundingStatus: 'STALE' } }),
    (error) => error?.code === 'ANALYSIS_BUNDLE_NOT_PERSISTABLE'
  );

  const reopened = await fixture.store.get(context, {
    meetingId: 'meeting-a',
    analysisId: 'analysis-a',
    currentContext: currentContext()
  });
  assert.equal(reopened.status, 'CURRENT');
  assert.equal(reopened.summary.topic.value, '报价跟进');
});

test('a bounded long-transcript result persists without duplicating raw transcript content', async () => {
  const fixture = await storeFixture();
  const context = owner();
  const longText = '长会议讨论报价、交付和后续跟进。'.repeat(2_000);
  const transcript = transcriptRevision(1, longText);
  const value = bundle({
    sourceValue: source(context.ownerId, { durationMs: 3_800_000 }),
    transcript
  });
  await fixture.store.save(context, { bundle: value });

  const raw = fixture.backend.dump().analysisBundles[0];
  assert.doesNotMatch(JSON.stringify(raw), /长会议讨论报价/);
  const reopened = await fixture.store.get(context, {
    meetingId: 'meeting-a',
    analysisId: 'analysis-a',
    currentContext: currentContext(context, source(context.ownerId, { durationMs: 3_800_000 }), transcript)
  });
  assert.equal(reopened.status, 'CURRENT');
  assert.equal(reopened.evidenceRefResolutions[0].status, 'VALID');
});

test('owner isolation fails closed for read, enumerate, write, update, delete, and export', async () => {
  const fixture = await storeFixture();
  const ownerA = owner('owner-a');
  const ownerB = owner('owner-b');
  const ownerABundle = bundle({ context: ownerA, sourceValue: source('owner-a'), transcript: transcriptRevision(1, undefined, 'owner-a') });
  await fixture.store.save(ownerA, { bundle: ownerABundle });

  await assert.rejects(
    fixture.store.save(ownerB, { bundle: { ...ownerABundle, ownerId: 'owner-b' } }),
    (error) => error?.code === 'OWNER_SCOPE_MISMATCH'
  );

  await assert.rejects(
    fixture.store.get(ownerB, { meetingId: 'meeting-a', analysisId: 'analysis-a', currentContext: currentContext(ownerB, source('owner-b'), transcriptRevision(1, undefined, 'owner-b')) }),
    (error) => error?.code === 'ANALYSIS_NOT_FOUND'
  );
  assert.deepEqual(await fixture.store.list(ownerB, { meetingId: 'meeting-a' }), []);
  assert.deepEqual(await fixture.store.exportBundles(ownerB, { meetingId: 'meeting-a' }), []);
  assert.equal(await fixture.store.delete(ownerB, { meetingId: 'meeting-a', analysisId: 'analysis-a' }), 0);
  await assert.rejects(
    fixture.store.save(ownerB, { bundle: bundle({ context: ownerA, sourceValue: source('owner-a'), transcript: transcriptRevision(1, undefined, 'owner-a') }) }),
    (error) => error?.code === 'OWNER_SCOPE_MISMATCH'
  );
  assert.equal((await fixture.store.list(ownerA, { meetingId: 'meeting-a' })).length, 1);
});

test('corrupted ciphertext and schema rows fail closed without affecting other Meeting stores', async () => {
  const fixture = await storeFixture();
  const context = owner();
  await fixture.store.save(context, { bundle: bundle() });
  const rowId = fixture.backend.dump().analysisBundles[0].id;
  fixture.backend.mutate('analysisBundles', rowId, (row) => ({ ...row, ciphertext: new Uint8Array([1, 2, 3]) }));
  await assert.rejects(
    fixture.store.get(context, { meetingId: 'meeting-a', analysisId: 'analysis-a' }),
    (error) => error?.code === 'ANALYSIS_CIPHERTEXT_INVALID'
  );
});

test('delete is owner-scoped and does not delete raw Meeting records', async () => {
  const fixture = await storeFixture();
  const context = owner();
  await fixture.backend.atomicWrite({
    puts: [{ storeName: 'meetings', id: 'raw-meeting-row', value: { id: 'raw-meeting-row', ownerHash: 'raw-owner', entityType: 'meeting' } }]
  });
  await fixture.store.save(context, { bundle: bundle() });
  assert.equal(await fixture.store.delete(context, { meetingId: 'meeting-a', analysisId: 'analysis-a' }), 1);
  assert.ok(await fixture.backend.get('meetings', 'raw-meeting-row'));
  assert.deepEqual(await fixture.store.list(context, { meetingId: 'meeting-a' }), []);
});
