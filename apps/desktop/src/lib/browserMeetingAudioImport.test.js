import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import {
  createMemoryMeetingBackend,
  createMeetingPhase1Store
} from './browserMeetingStore.js';

const cryptoImpl = webcrypto;

function context(ownerId = 'owner-a') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' });
}

async function provider() {
  const keys = new Map();
  return {
    keys,
    async enroll(ownerId) {
      keys.set(ownerId, await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    },
    async withOwnerKey(ownerContext, callback) {
      const key = keys.get(ownerContext.ownerId);
      if (!key) {
        const error = new Error('KEY_NOT_FOUND');
        error.code = 'KEY_NOT_FOUND';
        throw error;
      }
      return callback(key);
    }
  };
}

async function checksum(bytes) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function setup() {
  const backend = createMemoryMeetingBackend();
  const keyProvider = await provider();
  await keyProvider.enroll('owner-a');
  await keyProvider.enroll('owner-b');
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider, backend });
  const owner = context();
  await store.createMeeting(owner, { meetingId: 'meeting-a', title: '导入会议' });
  return { backend, keyProvider, store, owner };
}

async function begin(store, owner, overrides = {}) {
  return store.beginAudioImport(owner, {
    meetingId: 'meeting-a',
    importId: 'import-a',
    sourceId: 'source-a',
    originalFileName: 'meeting.wav',
    mimeType: 'audio/wav',
    format: 'wav',
    byteLength: 32,
    durationMs: 1000,
    fileIdentity: '10:0:meeting.wav:audio/wav',
    ...overrides
  });
}

function asset(sequence, assetId = `asset-${sequence}`) {
  return {
    assetId,
    chunkId: `chunk-${sequence}`,
    sequence,
    durationMs: 500,
    mimeType: 'audio/wav'
  };
}

test('imported AudioSource and AudioAsset commit atomically, remain encrypted, and are readable by sourceId', async () => {
  const { backend, store, owner } = await setup();
  const started = await begin(store, owner);
  const firstBytes = new TextEncoder().encode('imported-audio-0');
  const secondBytes = new TextEncoder().encode('imported-audio-1');
  const first = await store.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, asset: asset(0), bytes: firstBytes });
  const duplicate = await store.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, asset: asset(0), bytes: firstBytes });
  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  await assert.rejects(
    () => store.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, asset: asset(2), bytes: secondBytes }),
    (error) => error.code === 'AUDIO_ASSET_OUT_OF_ORDER'
  );
  await store.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, asset: asset(1), bytes: secondBytes });
  const allBytes = new Uint8Array([...firstBytes, ...secondBytes]);
  const completed = await store.completeAudioImport(owner, {
    meetingId: 'meeting-a',
    sourceId: started.source.sourceId,
    checksum: await checksum(allBytes)
  });
  assert.equal(completed.source.importState, 'committed');
  assert.equal(completed.source.chunkCount, 2);
  assert.equal(completed.source.byteLength, allBytes.byteLength);
  assert.equal((await store.getMeeting(owner, 'meeting-a')).audioSources.length, 1);

  const streamed = [];
  for await (const chunk of store.streamAudioSource(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId })) streamed.push(...chunk);
  assert.deepEqual(new Uint8Array(streamed), allBytes);
  const detailed = [];
  for await (const chunk of store.streamAudioSourceDetailed(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId })) detailed.push(chunk);
  assert.deepEqual(detailed.map((chunk) => chunk.sourceChunkId), ['chunk-0', 'chunk-1']);
  assert.deepEqual(new Uint8Array(detailed.flatMap((chunk) => [...chunk.bytes])), allBytes);
  assert.doesNotMatch(JSON.stringify(backend.dump()), /imported-audio-0|imported-audio-1/);
  assert.equal(backend.dump().segments.length, 0);
});

test('imported source owner context, sourceId and importId conflicts fail closed', async () => {
  const { store, owner } = await setup();
  await assert.rejects(
    () => begin(store, owner, { ownerId: 'owner-b' }),
    (error) => error.code === 'OWNER_ID_OVERRIDE_REJECTED'
  );
  const started = await begin(store, owner);
  await assert.rejects(
    () => store.getAudioSource(context('owner-b'), 'meeting-a', started.source.sourceId),
    (error) => error.code === 'AUDIO_SOURCE_NOT_FOUND'
  );
  await assert.rejects(
    () => store.beginAudioImport(owner, { meetingId: 'meeting-a', importId: 'import-a', sourceId: 'source-other', originalFileName: 'other.mp3', mimeType: 'audio/mpeg', format: 'mp3', byteLength: 10, durationMs: 1000, fileIdentity: 'other' }),
    (error) => error.code === 'IMPORT_ID_CONFLICT'
  );
});

test('cancel removes committed partial assets and leaves no Stage 3-readable source', async () => {
  const { backend, store, owner } = await setup();
  const started = await begin(store, owner);
  await store.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, asset: asset(0), bytes: new Uint8Array([1, 2, 3]) });
  const cancelled = await store.cancelAudioImport(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId });
  assert.equal(cancelled.source.importState, 'cancelled');
  assert.equal((await store.getMeeting(owner, 'meeting-a')).audioSources.length, 0);
  await assert.rejects(
    () => store.streamAudioSource(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId }).next(),
    (error) => error.code === 'AUDIO_SOURCE_NOT_AVAILABLE'
  );
  assert.equal(backend.dump().audioAssets.length, 0);
  assert.equal(backend.dump().audioManifests.length, 0);
});

test('delete removes source, manifest and all assets with zero managed residue', async () => {
  const { backend, store, owner } = await setup();
  const started = await begin(store, owner, { byteLength: 3, durationMs: 500 });
  const content = new Uint8Array([4, 5, 6]);
  await store.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, asset: asset(0), bytes: content });
  await store.completeAudioImport(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, checksum: await checksum(content) });
  const deleted = await store.deleteAudioSource(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId });
  assert.equal(deleted, true);
  for (const name of ['audioSources', 'audioManifests', 'audioAssets']) assert.equal(backend.dump()[name].length, 0, name);
});

test('atomic failure, missing asset, ciphertext tamper and wrong key all fail closed', async () => {
  const { backend, keyProvider, store, owner } = await setup();
  const started = await begin(store, owner, { byteLength: 2, durationMs: 500 });
  backend.failNextAtomic(new Error('SIMULATED_IMPORT_ATOMIC_FAILURE'));
  await assert.rejects(
    () => store.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, asset: asset(0), bytes: new Uint8Array([7, 8]) }),
    (error) => error.code === 'AUDIO_ASSET_ATOMIC_COMMIT_FAILED'
  );
  assert.equal(backend.dump().audioAssets.length, 0);
  const content = new Uint8Array([7, 8]);
  await store.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, asset: asset(0), bytes: content });
  await store.completeAudioImport(owner, { meetingId: 'meeting-a', sourceId: started.source.sourceId, checksum: await checksum(content) });
  const assetRow = backend.dump().audioAssets[0];
  backend.deleteDirect('audioAssets', assetRow.id);
  await assert.rejects(() => store.getMeeting(owner, 'meeting-a'), (error) => error.code === 'AUDIO_MANIFEST_ASSET_MISMATCH');

  const cleanBackend = createMemoryMeetingBackend();
  const cleanProvider = await provider();
  await cleanProvider.enroll('owner-a');
  const cleanStore = createMeetingPhase1Store({ cryptoImpl, keyProvider: cleanProvider, backend: cleanBackend });
  await cleanStore.createMeeting(owner, { meetingId: 'meeting-a', title: '导入会议' });
  const cleanStarted = await begin(cleanStore, owner, { byteLength: 2, durationMs: 500 });
  await cleanStore.commitImportedAudioAsset(owner, { meetingId: 'meeting-a', sourceId: cleanStarted.source.sourceId, asset: asset(0), bytes: content });
  await cleanStore.completeAudioImport(owner, { meetingId: 'meeting-a', sourceId: cleanStarted.source.sourceId, checksum: await checksum(content) });
  const cleanRow = cleanBackend.dump().audioAssets[0];
  cleanBackend.mutate('audioAssets', cleanRow.id, (row) => ({ ...row, audioCiphertext: Uint8Array.from(row.audioCiphertext, (value, index) => index === 0 ? value ^ 0xff : value) }));
  await assert.rejects(() => cleanStore.getMeeting(owner, 'meeting-a'), (error) => error.code === 'MEETING_CIPHERTEXT_INVALID');

  const wrongKey = await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyProvider.keys.set('owner-a', wrongKey);
  await assert.rejects(() => store.getMeeting(owner, 'meeting-a'), (error) => error.code === 'MEETING_CIPHERTEXT_INVALID' || error.code === 'AUDIO_MANIFEST_ASSET_MISMATCH');
});
