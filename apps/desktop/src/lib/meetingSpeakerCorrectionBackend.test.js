import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEETING_SPEAKER_CORRECTION_DATABASE_NAME,
  MEETING_SPEAKER_CORRECTION_DATABASE_VERSION,
  MEETING_SPEAKER_CORRECTION_INDEXES,
  MEETING_SPEAKER_CORRECTION_STORES,
  createIndexedDbMeetingSpeakerCorrectionBackend,
  createMemoryMeetingSpeakerCorrectionBackend
} from './meetingSpeakerCorrectionBackend.js';

const opaque = (character) => character.repeat(64);

function revisionRow({ revision = 1, mutation = opaque('4'), fingerprint = opaque('5') } = {}) {
  return {
    id: opaque(String(revision + 5)),
    ownerHash: opaque('1'),
    spaceHash: opaque('2'),
    documentLocator: opaque('3'),
    bindingFingerprint: opaque('b'),
    transcriptRevision: 7,
    baseDiarizationRevision: 1,
    correctionRevision: revision,
    parentRevisionLocator: revision === 1 ? '' : opaque(String(revision + 4)),
    correctionIdHash: opaque('c'),
    parentCorrectionIdHash: revision === 1 ? '' : opaque('c'),
    mutationLocator: mutation,
    requestFingerprint: fingerprint,
    keyVersion: 1,
    nonce: new Uint8Array(12),
    ciphertext: new Uint8Array([1, 2, 3])
  };
}

function documentRow(revision = 1) {
  return {
    id: opaque('3'),
    ownerHash: opaque('1'),
    spaceHash: opaque('2'),
    documentLocator: opaque('3'),
    bindingFingerprint: opaque('b'),
    transcriptRevision: 7,
    baseDiarizationRevision: 1,
    headCorrectionRevision: revision,
    headRevisionLocator: opaque(String(revision + 5)),
    headCorrectionIdHash: opaque('c'),
    keyVersion: 1,
    nonce: new Uint8Array(12),
    ciphertext: new Uint8Array([4, 5, 6])
  };
}

function commitInput({ expected = 0, revision = 1, mutation, fingerprint } = {}) {
  const revisionValue = revisionRow({ revision, mutation, fingerprint });
  return {
    ownerHash: revisionValue.ownerHash,
    spaceHash: revisionValue.spaceHash,
    documentLocator: revisionValue.documentLocator,
    bindingFingerprint: revisionValue.bindingFingerprint,
    expectedCorrectionRevision: expected,
    documentRow: documentRow(revision),
    revisionRow: revisionValue
  };
}

test('backend fixes the exact independent v1 database, two stores, and unique indexes', () => {
  const backend = createMemoryMeetingSpeakerCorrectionBackend();
  assert.equal(MEETING_SPEAKER_CORRECTION_DATABASE_NAME, 'ai-fenshen-meeting-speaker-management-v1');
  assert.equal(MEETING_SPEAKER_CORRECTION_DATABASE_VERSION, 1);
  assert.deepEqual(MEETING_SPEAKER_CORRECTION_STORES, [
    'speakerCorrectionDocuments',
    'speakerCorrectionRevisions'
  ]);
  assert.deepEqual(backend.schema(), {
    name: MEETING_SPEAKER_CORRECTION_DATABASE_NAME,
    version: 1,
    stores: MEETING_SPEAKER_CORRECTION_STORES,
    indexes: MEETING_SPEAKER_CORRECTION_INDEXES
  });
  assert.equal(MEETING_SPEAKER_CORRECTION_INDEXES.speakerCorrectionRevisions.byOwnerMutation.unique, true);
  assert.equal(MEETING_SPEAKER_CORRECTION_INDEXES.speakerCorrectionRevisions.byOwnerDocumentFingerprint.unique, true);
  assert.equal(MEETING_SPEAKER_CORRECTION_INDEXES.speakerCorrectionRevisions.byOwnerDocumentRevision.unique, true);
});

test('memory commit is append-only, head-CASed, mutation-idempotent, and fingerprint-conflict aware', async () => {
  const backend = createMemoryMeetingSpeakerCorrectionBackend();
  const first = commitInput();
  assert.equal((await backend.commitRevision(first)).status, 'committed');
  assert.equal((await backend.commitRevision(first)).status, 'replay');

  await assert.rejects(
    () => backend.commitRevision(commitInput({ mutation: first.revisionRow.mutationLocator, fingerprint: opaque('9') })),
    { code: 'SPEAKER_CORRECTION_MUTATION_REQUEST_CONFLICT' }
  );
  await assert.rejects(
    () => backend.commitRevision(commitInput({ mutation: opaque('8'), fingerprint: first.revisionRow.requestFingerprint })),
    { code: 'SPEAKER_CORRECTION_FINGERPRINT_CONFLICT' }
  );
  await assert.rejects(
    () => backend.commitRevision(commitInput({ expected: 0, revision: 1, mutation: opaque('7'), fingerprint: opaque('6') })),
    { code: 'SPEAKER_CORRECTION_CAS_CONFLICT' }
  );

  assert.equal((await backend.listRevisions({
    ownerHash: first.ownerHash,
    spaceHash: first.spaceHash,
    documentLocator: first.documentLocator
  })).length, 1);
});

test('document head CAS binds the exact parent revision locator and correction id hash', async () => {
  for (const mutate of [
    (input) => { input.revisionRow.parentRevisionLocator = opaque('e'); },
    (input) => { input.revisionRow.parentCorrectionIdHash = opaque('f'); }
  ]) {
    const backend = createMemoryMeetingSpeakerCorrectionBackend();
    await backend.commitRevision(commitInput());
    const second = commitInput({
      expected: 1,
      revision: 2,
      mutation: opaque('7'),
      fingerprint: opaque('8')
    });
    mutate(second);
    await assert.rejects(() => backend.commitRevision(second), { code: 'SPEAKER_CORRECTION_CAS_CONFLICT' });
    assert.equal((await backend.list('speakerCorrectionRevisions')).length, 1);
  }
});

test('document head identity must match the appended revision identity', async () => {
  const backend = createMemoryMeetingSpeakerCorrectionBackend();
  const input = commitInput();
  input.documentRow.headCorrectionIdHash = opaque('e');
  await assert.rejects(() => backend.commitRevision(input), { code: 'SPEAKER_CORRECTION_COMMIT_INVALID' });
  assert.deepEqual(await backend.list('speakerCorrectionDocuments'), []);
  assert.deepEqual(await backend.list('speakerCorrectionRevisions'), []);
});

test('two concurrent writers produce one commit, while an identical concurrent request replays', async () => {
  const distinctBackend = createMemoryMeetingSpeakerCorrectionBackend();
  const results = await Promise.allSettled([
    distinctBackend.commitRevision(commitInput({ mutation: opaque('6'), fingerprint: opaque('7') })),
    distinctBackend.commitRevision(commitInput({ mutation: opaque('8'), fingerprint: opaque('9') }))
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'SPEAKER_CORRECTION_CAS_CONFLICT').length, 1);
  assert.equal((await distinctBackend.list('speakerCorrectionRevisions')).length, 1);

  const sameBackend = createMemoryMeetingSpeakerCorrectionBackend();
  const same = commitInput({ mutation: opaque('a'), fingerprint: opaque('c') });
  const identical = await Promise.all([
    sameBackend.commitRevision(same),
    sameBackend.commitRevision(structuredClone(same))
  ]);
  assert.deepEqual(identical.map((result) => result.status).sort(), ['committed', 'replay']);
  assert.equal((await sameBackend.list('speakerCorrectionRevisions')).length, 1);
});

test('fault after revision add rolls back both stores and reopen preserves only committed state', async () => {
  const backend = createMemoryMeetingSpeakerCorrectionBackend();
  backend.failNextCommit(Object.assign(new Error('SIMULATED_ATOMIC_FAILURE'), { code: 'SIMULATED_ATOMIC_FAILURE' }), {
    at: 'afterRevisionAdd'
  });
  await assert.rejects(() => backend.commitRevision(commitInput()), { code: 'SIMULATED_ATOMIC_FAILURE' });
  assert.deepEqual(await backend.list('speakerCorrectionDocuments'), []);
  assert.deepEqual(await backend.list('speakerCorrectionRevisions'), []);

  await backend.commitRevision(commitInput());
  const reopened = backend.reopen();
  assert.equal((await reopened.list('speakerCorrectionDocuments')).length, 1);
  assert.equal((await reopened.list('speakerCorrectionRevisions')).length, 1);
});

test('backend rejects extra cleartext fields before either store can persist them', async () => {
  for (const mutate of [
    (input) => { input.documentRow.ownerId = 'owner-raw'; },
    (input) => { input.revisionRow.meetingId = 'meeting-raw'; }
  ]) {
    const backend = createMemoryMeetingSpeakerCorrectionBackend();
    const input = commitInput();
    mutate(input);
    await assert.rejects(
      () => backend.commitRevision(input),
      (error) => ['SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID', 'SPEAKER_CORRECTION_REVISION_ROW_INVALID'].includes(error.code)
    );
    assert.deepEqual(await backend.list('speakerCorrectionDocuments'), []);
    assert.deepEqual(await backend.list('speakerCorrectionRevisions'), []);
  }
});

function createUpgradeOnlyIndexedDb({ extraStore = false, blocked = false, failRuntimeTransaction = false } = {}) {
  const calls = { open: [], stores: new Map(), closed: 0 };
  let transactionCalls = 0;
  const database = {
    version: 1,
    objectStoreNames: {
      contains: (name) => calls.stores.has(name),
      [Symbol.iterator]: function* iterateStores() { yield* calls.stores.keys(); }
    },
    createObjectStore(name, options) {
      const indexes = new Map();
      const store = {
        keyPath: options.keyPath,
        autoIncrement: options.autoIncrement === true,
        indexNames: {
          contains: (indexName) => indexes.has(indexName),
          [Symbol.iterator]: function* iterateIndexes() { yield* indexes.keys(); }
        },
        createIndex(indexName, keyPath, indexOptions) {
          const index = { keyPath, ...indexOptions };
          indexes.set(indexName, index);
          return index;
        },
        index(indexName) { return indexes.get(indexName); }
      };
      calls.stores.set(name, { options, indexes, store });
      return store;
    },
    transaction() {
      transactionCalls += 1;
      if (failRuntimeTransaction && transactionCalls > 1) {
        const error = new Error('database closed between open and transaction');
        error.name = 'InvalidStateError';
        throw error;
      }
      return { objectStore(storeName) { return calls.stores.get(storeName).store; } };
    },
    close() { calls.closed += 1; }
  };
  if (extraStore) database.createObjectStore('unexpectedStore', { keyPath: 'id' });
  return {
    calls,
    implementation: {
      open(name, version) {
        calls.open.push({ name, version });
        const request = {};
        queueMicrotask(() => {
          request.result = database;
          if (blocked) request.onblocked?.();
          request.transaction = {
            objectStore(storeName) { return calls.stores.get(storeName).store; }
          };
          request.onupgradeneeded?.({ oldVersion: 0, newVersion: version });
          request.onsuccess?.();
        });
        return request;
      }
    }
  };
}

test('IndexedDB open uses the exact name/version, creates only declared indexes, and closes on versionchange', async () => {
  const fake = createUpgradeOnlyIndexedDb();
  const backend = createIndexedDbMeetingSpeakerCorrectionBackend({ indexedDBImpl: fake.implementation });
  const database = await backend.open();
  assert.deepEqual(fake.calls.open, [{ name: MEETING_SPEAKER_CORRECTION_DATABASE_NAME, version: 1 }]);
  assert.deepEqual([...fake.calls.stores.keys()].sort(), [...MEETING_SPEAKER_CORRECTION_STORES].sort());
  for (const [storeName, definitions] of Object.entries(MEETING_SPEAKER_CORRECTION_INDEXES)) {
    const actual = fake.calls.stores.get(storeName);
    assert.ok(actual);
    assert.deepEqual(
      Object.fromEntries([...actual.indexes.entries()]),
      Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, definition]))
    );
  }
  database.onversionchange();
  assert.equal(fake.calls.closed, 1);
  backend.close();
});

test('IndexedDB open fails closed for an extra v1 store and closes a late success after blocked', async () => {
  const invalid = createUpgradeOnlyIndexedDb({ extraStore: true });
  await assert.rejects(
    () => createIndexedDbMeetingSpeakerCorrectionBackend({ indexedDBImpl: invalid.implementation }).open(),
    { code: 'SPEAKER_CORRECTION_IDB_SCHEMA_INVALID' }
  );
  assert.equal(invalid.calls.closed, 1);

  const blocked = createUpgradeOnlyIndexedDb({ blocked: true });
  await assert.rejects(
    () => createIndexedDbMeetingSpeakerCorrectionBackend({ indexedDBImpl: blocked.implementation }).open(),
    { code: 'SPEAKER_CORRECTION_IDB_BLOCKED' }
  );
  await Promise.resolve();
  assert.equal(blocked.calls.closed, 1);
});

test('IndexedDB maps synchronous transaction creation failures to stable read and commit errors', async () => {
  const read = createUpgradeOnlyIndexedDb({ failRuntimeTransaction: true });
  const readBackend = createIndexedDbMeetingSpeakerCorrectionBackend({ indexedDBImpl: read.implementation });
  await assert.rejects(
    () => readBackend.getDocument({ documentLocator: opaque('3') }),
    { code: 'SPEAKER_CORRECTION_IDB_READ_FAILED' }
  );

  const write = createUpgradeOnlyIndexedDb({ failRuntimeTransaction: true });
  const writeBackend = createIndexedDbMeetingSpeakerCorrectionBackend({ indexedDBImpl: write.implementation });
  await assert.rejects(
    () => writeBackend.commitRevision(commitInput()),
    { code: 'SPEAKER_CORRECTION_COMMIT_FAILED' }
  );
});
