import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  deriveRecoveryKek,
  generateDeviceKek,
  generateOwnerDek,
  unwrapOwnerDekWithDeviceKek,
  unwrapOwnerDekWithRecoveryKek,
  wrapOwnerDekWithDeviceKek,
  wrapOwnerDekWithRecoveryKek
} from './browserKeyHierarchy.js';

function aad(overrides = {}) {
  return {
    ownerId: 'owner-a',
    keyId: 'key-a',
    keyVersion: 1,
    deviceId: 'device-a',
    wrapperType: 'device',
    schemaVersion: 'browser-key-hierarchy-v2',
    ...overrides
  };
}

test('Device KEK is non-exportable and only wraps a transient Owner DEK', async () => {
  const deviceKek = await generateDeviceKek(webcrypto);
  assert.equal(deviceKek.extractable, false);
  await assert.rejects(() => webcrypto.subtle.exportKey('raw', deviceKek), /InvalidAccessException|key is not extractable/i);

  const transientOwnerDek = await generateOwnerDek(webcrypto, { extractable: true });
  const wrapped = await wrapOwnerDekWithDeviceKek({ cryptoImpl: webcrypto, ownerDek: transientOwnerDek, deviceKek, aad: aad() });
  const usableOwnerDek = await unwrapOwnerDekWithDeviceKek({ cryptoImpl: webcrypto, wrapped, deviceKek, aad: aad(), extractable: false });
  assert.equal(usableOwnerDek.extractable, false);
  assert.equal(wrapped.rawKeyIncluded, false);
  assert.equal(Object.hasOwn(wrapped, 'ownerDek'), false);

  await assert.rejects(
    () => wrapOwnerDekWithDeviceKek({ cryptoImpl: webcrypto, ownerDek: usableOwnerDek, deviceKek, aad: aad() }),
    (error) => error?.code === 'OWNER_DEK_MUST_BE_TRANSIENT_EXPORTABLE_FOR_WRAP'
  );
});

test('Recovery KEK independently wraps Owner DEK and rejects secret, AAD, nonce, and ciphertext tampering', async () => {
  const transientOwnerDek = await generateOwnerDek(webcrypto, { extractable: true });
  const recoverySecret = new Uint8Array(32).fill(7);
  const salt = new Uint8Array(16).fill(3);
  const recoveryKek = await deriveRecoveryKek({ cryptoImpl: webcrypto, recoverySecret, salt });
  assert.equal(recoveryKek.extractable, false);

  const wrapperAad = aad({ wrapperType: 'recovery', deviceId: 'device-b' });
  const wrapped = await wrapOwnerDekWithRecoveryKek({
    cryptoImpl: webcrypto,
    ownerDek: transientOwnerDek,
    recoveryKek,
    aad: wrapperAad,
    salt
  });
  const restored = await unwrapOwnerDekWithRecoveryKek({
    cryptoImpl: webcrypto,
    wrapped,
    recoveryKek,
    aad: wrapperAad,
    extractable: false
  });
  assert.equal(restored.extractable, false);
  assert.equal(wrapped.rawKeyIncluded, false);
  assert.equal(Object.hasOwn(wrapped, 'recoverySecret'), false);

  const wrongRecoveryKek = await deriveRecoveryKek({ cryptoImpl: webcrypto, recoverySecret: new Uint8Array(32).fill(8), salt });
  await assert.rejects(
    () => unwrapOwnerDekWithRecoveryKek({ cryptoImpl: webcrypto, wrapped, recoveryKek: wrongRecoveryKek, aad: wrapperAad, extractable: false }),
    /OperationError|DataError|decrypt/i
  );
  await assert.rejects(
    () => unwrapOwnerDekWithRecoveryKek({ cryptoImpl: webcrypto, wrapped, recoveryKek, aad: { ...wrapperAad, ownerId: 'owner-b' }, extractable: false }),
    /OperationError|DataError|decrypt/i
  );

  const tampered = { ...wrapped, ciphertext: new Uint8Array(wrapped.ciphertext) };
  tampered.ciphertext[0] ^= 0xff;
  await assert.rejects(
    () => unwrapOwnerDekWithRecoveryKek({ cryptoImpl: webcrypto, wrapped: tampered, recoveryKek, aad: wrapperAad, extractable: false }),
    /OperationError|DataError|decrypt/i
  );
});

test('each wrapper receives a fresh nonce and wrapper type is authenticated', async () => {
  const deviceKek = await generateDeviceKek(webcrypto);
  const ownerDek = await generateOwnerDek(webcrypto, { extractable: true });
  const first = await wrapOwnerDekWithDeviceKek({ cryptoImpl: webcrypto, ownerDek, deviceKek, aad: aad() });
  const second = await wrapOwnerDekWithDeviceKek({ cryptoImpl: webcrypto, ownerDek, deviceKek, aad: aad({ keyVersion: 2 }) });
  assert.notDeepEqual([...first.nonce], [...second.nonce]);
  await assert.rejects(
    () => unwrapOwnerDekWithDeviceKek({ cryptoImpl: webcrypto, wrapped: first, deviceKek, aad: aad({ wrapperType: 'recovery' }), extractable: false }),
    /OperationError|DataError|decrypt/i
  );
});
