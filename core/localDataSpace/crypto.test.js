import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AEAD_ALGORITHM,
  DATA_KEY_BYTES,
  decryptBytes,
  encryptBytes
} from './crypto.js';
import { buildMeetingAad } from '../meeting/phase0/meetingCrypto.js';
import { TestKeyProvider } from './testKeyProvider.js';

test('meeting encryption binds owner, meeting, entity, schema, revision and segment index', async () => {
  const provider = new TestKeyProvider();
  const key = await provider.createDataKey({ ownerId: 'owner-a', spaceId: 'meeting-space' });
  const aad = buildMeetingAad({
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    entityType: 'audio-segment',
    schemaVersion: 1,
    segmentIndex: 0
  });
  const envelope = encryptBytes(Buffer.from('synthetic meeting body'), key, { aad });

  assert.equal(AEAD_ALGORITHM, 'aes-256-gcm');
  assert.equal(key.length, DATA_KEY_BYTES);
  assert.deepEqual(decryptBytes(envelope, key, { aad }), Buffer.from('synthetic meeting body'));
  for (const changed of [
    { ownerId: 'owner-b' },
    { meetingId: 'meeting-b' },
    { entityType: 'transcript-revision' },
    { schemaVersion: 2 },
    { segmentIndex: 1 }
  ]) {
    assert.throws(
      () => decryptBytes(envelope, key, { aad: buildMeetingAad({
        ownerId: changed.ownerId || 'owner-a',
        meetingId: changed.meetingId || 'meeting-a',
        entityType: changed.entityType || 'audio-segment',
        schemaVersion: changed.schemaVersion || 1,
        segmentIndex: changed.segmentIndex ?? 0
      }) }),
      /AUTHENTICATION_FAILED/
    );
  }
});

test('tampered ciphertext, nonce and tag fail closed', async () => {
  const provider = new TestKeyProvider();
  const key = await provider.createDataKey({ ownerId: 'owner-a', spaceId: 'meeting-space' });
  const aad = 'owner-a\u0000meeting-a\u0000meeting\u00001\u0000';
  const envelope = encryptBytes(Buffer.from('private body'), key, { aad });
  for (const field of ['ciphertext', 'nonce', 'tag']) {
    const tampered = { ...envelope, [field]: `${envelope[field].slice(0, -2)}AA` };
    assert.throws(() => decryptBytes(tampered, key, { aad }), /AUTHENTICATION_FAILED/);
  }
});
