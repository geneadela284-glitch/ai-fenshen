import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAudioAsset,
  createAudioSource,
  validateAudioAsset,
  validateAudioSource
} from './meetingAudioContracts.js';
import {
  CONTINUOUS_FRAGMENT_STREAM_V1,
  INDEPENDENT_MP4_SEGMENTS_V1,
  resolveRecordedContainerLayout
} from './meetingRecordingContainerLayout.js';

function ownerContext(ownerId = 'owner-a') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' });
}

test('AudioSource contains the unified recorded/imported fields and trusted owner', () => {
  const source = createAudioSource({
    ownerContext: ownerContext(),
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    scope: 'meeting',
    origin: 'imported',
    originalFileName: 'meeting.wav',
    mimeType: 'audio/wav',
    format: 'wav',
    byteLength: 1024,
    durationMs: 1000,
    checksum: 'a'.repeat(64),
    chunkCount: 1,
    manifestVersion: 1,
    importState: 'committed',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:01.000Z',
    retentionExpiresAt: '2026-09-06T00:00:00.000Z',
    revision: 2
  });
  assert.equal(validateAudioSource(source, { ownerContext: ownerContext() }).valid, true);
  assert.equal(source.ownerId, 'owner-a');
  assert.equal(source.origin, 'imported');
  assert.equal(source.retentionExpiresAt, '2026-09-06T00:00:00.000Z');
  assert.equal(Object.prototype.hasOwnProperty.call(source, 'plaintext'), false);
});

test('AudioAsset is owner-scoped and binds source, chunk and sequence', () => {
  const asset = createAudioAsset({
    ownerContext: ownerContext(),
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    assetId: 'asset-a-0',
    chunkId: 'chunk-a-0',
    scope: 'meeting',
    sequence: 0,
    byteLength: 512,
    durationMs: 500,
    checksum: 'b'.repeat(64),
    mimeType: 'audio/wav',
    manifestVersion: 1,
    commitState: 'committed',
    createdAt: '2026-08-07T00:00:00.000Z'
  });
  assert.equal(validateAudioAsset(asset, { ownerContext: ownerContext() }).valid, true);
  assert.equal(validateAudioAsset(asset, { ownerContext: ownerContext('owner-b') }).valid, false);
});

test('contract rejects forged owner payloads and invalid retention', () => {
  assert.throws(
    () => createAudioSource({ ownerContext: ownerContext(), ownerId: 'owner-b', meetingId: 'm', sourceId: 's' }),
    (error) => error.code === 'OWNER_ID_OVERRIDE_REJECTED'
  );
  const valid = createAudioSource({
    ownerContext: ownerContext(),
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    origin: 'imported',
    originalFileName: 'meeting.wav',
    mimeType: 'audio/wav',
    format: 'wav',
    byteLength: 1,
    durationMs: 1,
    checksum: 'c'.repeat(64),
    chunkCount: 1,
    manifestVersion: 1,
    importState: 'committed',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    retentionExpiresAt: '2026-09-06T00:00:00.000Z',
    revision: 1
  });
  const invalid = { ...valid, retentionExpiresAt: '' };
  assert.equal(validateAudioSource(invalid, { ownerContext: ownerContext() }).valid, false);
});

test('recorded sources persist an explicit container layout while imported sources are not guessed', () => {
  const base = {
    ownerContext: ownerContext(),
    meetingId: 'meeting-layout',
    sourceId: 'source-layout',
    originalFileName: 'meeting.m4a',
    mimeType: 'audio/mp4;codecs=mp4a.40.2',
    format: 'm4a',
    byteLength: 10,
    durationMs: 1_000,
    checksum: 'd'.repeat(64),
    chunkCount: 1,
    createdAt: '2026-08-15T00:00:00.000Z'
  };
  const recorded = createAudioSource({
    ...base,
    origin: 'recorded',
    containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
  });
  const imported = createAudioSource({
    ...base,
    sourceId: 'source-imported',
    origin: 'imported',
    containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
  });

  assert.equal(recorded.containerLayout, INDEPENDENT_MP4_SEGMENTS_V1);
  assert.equal(Object.hasOwn(imported, 'containerLayout'), false);
  assert.equal(validateAudioSource(recorded).valid, true);
  assert.equal(resolveRecordedContainerLayout(''), CONTINUOUS_FRAGMENT_STREAM_V1);
  assert.equal(resolveRecordedContainerLayout(undefined), CONTINUOUS_FRAGMENT_STREAM_V1);
  assert.throws(
    () => resolveRecordedContainerLayout('invented-layout'),
    (error) => error?.code === 'AUDIO_CONTAINER_LAYOUT_UNSUPPORTED'
  );
});

test('legacy recorded sources without layout validate and resolve as continuous fragments', () => {
  const source = createAudioSource({
    ownerContext: ownerContext(),
    meetingId: 'meeting-legacy',
    sourceId: 'source-legacy',
    origin: 'recorded',
    originalFileName: 'legacy.m4a',
    mimeType: 'audio/mp4',
    format: 'm4a',
    byteLength: 10,
    durationMs: 1_000,
    checksum: 'e'.repeat(64),
    chunkCount: 1,
    createdAt: '2026-08-15T00:00:00.000Z'
  });
  const historical = { ...source };
  delete historical.containerLayout;

  assert.equal(validateAudioSource(historical).valid, true);
  assert.equal(resolveRecordedContainerLayout(historical.containerLayout), CONTINUOUS_FRAGMENT_STREAM_V1);
});
