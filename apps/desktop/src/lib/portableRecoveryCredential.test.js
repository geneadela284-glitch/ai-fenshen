import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  isPortableRecoveryCredentialFormat,
  parsePortableRecoveryCredential,
  serializePortableRecoveryCredential
} from './portableRecoveryCredential.js';

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function recoveryPackage() {
  return {
    version: 'browser-recovery-v2',
    schemaVersion: 'browser-key-hierarchy-v2',
    ownerHash: 'owner-hash-a',
    spaceId: 'meeting-space',
    keyId: 'key-a',
    keyVersion: 1,
    sourceDeviceId: 'device-a',
    recoveryKdf: {
      name: 'PBKDF2-SHA-256',
      hash: 'SHA-256',
      iterations: 310000,
      salt: base64url(new Uint8Array(16).fill(1))
    },
    recoveryWrapper: {
      schemaVersion: 'browser-key-hierarchy-v2',
      wrapperType: 'recovery',
      nonce: base64url(new Uint8Array(12).fill(2)),
      ciphertext: base64url(new Uint8Array(48).fill(3)),
      rawKeyIncluded: false
    },
    rawKeyIncluded: false,
    createdAt: '2026-08-06T00:00:00.000Z'
  };
}

test('portable recovery credential round-trips the encrypted package and secret', async () => {
  const token = await serializePortableRecoveryCredential({
    cryptoImpl: webcrypto,
    recoveryPackage: recoveryPackage(),
    recoverySecret: new Uint8Array(32).fill(7),
    validationFixture: {
      nonce: new Uint8Array(12).fill(4),
      ciphertext: new Uint8Array(48).fill(5),
      aad: 'synthetic-fixture-aad',
      plaintextDigest: 'bd87fb93292574763e9db20b7bb7290eea03d893d6f7084cb92e3967e5617bbe'
    },
    credentialId: 'credential-a',
    issuedAt: '2026-08-06T01:00:00.000Z',
    expiresAt: '2026-08-06T02:30:00.000Z'
  });

  assert.equal(isPortableRecoveryCredentialFormat(token), true);
  const parsed = await parsePortableRecoveryCredential({ cryptoImpl: webcrypto, credential: token, now: '2026-08-06T01:30:00.000Z' });
  assert.equal(parsed.credentialId, 'credential-a');
  assert.equal(parsed.oneTimeUse, true);
  assert.equal(parsed.expiresAt, '2026-08-06T02:30:00.000Z');
  assert.deepEqual(parsed.recoveryPackage, recoveryPackage());
  assert.deepEqual([...parsed.recoverySecret], [...new Uint8Array(32).fill(7)]);
  assert.deepEqual([...parsed.validationFixture.nonce], [...new Uint8Array(12).fill(4)]);
  assert.deepEqual([...parsed.validationFixture.ciphertext], [...new Uint8Array(48).fill(5)]);
  assert.equal(parsed.validationFixture.aad, 'synthetic-fixture-aad');
  assert.equal(parsed.validationFixture.plaintextDigest, 'bd87fb93292574763e9db20b7bb7290eea03d893d6f7084cb92e3967e5617bbe');
  assert.equal(token.includes('owner-hash-a'), false);
  assert.equal(token.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
});

test('portable recovery credential rejects tampering, wrong owner, expiry and legacy secret-only values', async () => {
  const token = await serializePortableRecoveryCredential({
    cryptoImpl: webcrypto,
    recoveryPackage: recoveryPackage(),
    recoverySecret: new Uint8Array(32).fill(8),
    credentialId: 'credential-b',
    issuedAt: '2026-08-06T01:00:00.000Z',
    expiresAt: '2026-08-06T02:30:00.000Z'
  });
  const [, encoded] = token.split('.');
  const tamperedPayload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  tamperedPayload.credentialId = 'credential-tampered';
  const tampered = `mrc1.${Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url')}`;

  await assert.rejects(
    () => parsePortableRecoveryCredential({ cryptoImpl: webcrypto, credential: tampered, now: '2026-08-06T01:30:00.000Z' }),
    (error) => error?.code === 'RECOVERY_CREDENTIAL_INTEGRITY_INVALID'
  );
  await assert.rejects(
    () => parsePortableRecoveryCredential({ cryptoImpl: webcrypto, credential: token, expectedOwnerHash: 'owner-hash-b', now: '2026-08-06T01:30:00.000Z' }),
    (error) => error?.code === 'RECOVERY_CREDENTIAL_OWNER_MISMATCH'
  );
  await assert.rejects(
    () => parsePortableRecoveryCredential({ cryptoImpl: webcrypto, credential: token, now: '2026-08-06T02:30:00.000Z' }),
    (error) => error?.code === 'RECOVERY_CREDENTIAL_EXPIRED'
  );
  await assert.rejects(
    () => parsePortableRecoveryCredential({ cryptoImpl: webcrypto, credential: 'A'.repeat(43), now: '2026-08-06T01:30:00.000Z' }),
    (error) => error?.code === 'EXISTING_CREDENTIAL_NOT_PORTABLE'
  );
});
