import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  createBrowserProductionKeyProvider,
  generateRecoverySecret
} from './browserProductionKeyProvider.js';

const READY_CAPABILITIES = Object.freeze({
  productionReady: true,
  capabilities: Object.freeze({
    webCryptoAesGcm: true,
    nonExportableKeyHandle: true,
    indexedDb: true,
    persistentCryptoKey: true,
    pageRefreshRecovery: true,
    browserRestartRecovery: true,
    deviceRestartRecovery: true,
    platformUserVerification: true,
    recoveryKeyWrapping: true,
    privateBrowsingSafe: true,
    failClosedWhenStorageUnavailable: true
  }),
  errorCodes: Object.freeze({})
});

function owner(ownerId, deviceBindingId = 'device-a') {
  return Object.freeze({
    trusted: true,
    ownerId,
    sessionId: `session-${ownerId}`,
    spaceId: 'meeting-space',
    deviceBindingId
  });
}

function memoryStorage() {
  const records = new Map();
  return {
    records,
    async putKey(record) { records.set(record.recordId, structuredClone(record)); },
    async listKeys() { return [...records.values()]; },
    async updateKey(record) { records.set(record.recordId, structuredClone(record)); },
    async deleteOwner(ownerHash, spaceId) {
      for (const [recordId, record] of records) {
        if (record.ownerHash === ownerHash && record.spaceId === spaceId) records.delete(recordId);
      }
    },
    async probeCryptoKeyPersistence() { return { available: true, reopened: true }; }
  };
}

function platformAdapter() {
  return {
    verified: true,
    requiresDeviceUnlock: true,
    supportsRecoveryWrapping: true,
    supportsRevocation: true,
    supportsLifecycle: true
  };
}

function assertOpaqueRecords(storage) {
  for (const record of storage.records.values()) {
    assert.equal(record.deviceKey?.extractable, false);
    assert.ok(record.deviceWrappedOwnerDek instanceof Uint8Array);
    assert.ok(record.deviceNonce instanceof Uint8Array);
    assert.equal(Object.hasOwn(record, 'cryptoKey'), false);
    assert.equal(Object.hasOwn(record, 'ownerDek'), false);
    assert.equal(Object.hasOwn(record, 'ownerDekBytes'), false);
    assert.equal(Object.hasOwn(record, 'recoverySecret'), false);
  }
  assert.equal(JSON.stringify([...storage.records.values()]).includes('ownerDek'), false);
}

test('browser production provider isolates three owners and persists opaque CryptoKey handles', async () => {
  const storage = memoryStorage();
  const adapter = platformAdapter();
  const provider = createBrowserProductionKeyProvider({
    cryptoImpl: webcrypto,
    storage,
    capabilities: READY_CAPABILITIES,
    platformAdapter: adapter,
    deviceBindingId: 'device-a'
  });
  const ownerA = owner('owner-a');
  const ownerB = owner('owner-b');
  const ownerC = owner('owner-c');

  const handles = await Promise.all([provider.enrollOwner(ownerA), provider.enrollOwner(ownerB), provider.enrollOwner(ownerC)]);
  assert.equal(new Set(handles.map((handle) => handle.keyId)).size, 3);
  const keyA = await provider.withOwnerKey(ownerA, (key) => key);
  assert.equal(keyA.extractable, false);
  await assert.rejects(() => webcrypto.subtle.exportKey('raw', keyA), /InvalidAccessException|key is not extractable/i);
  assertOpaqueRecords(storage);

  const reopened = createBrowserProductionKeyProvider({
    cryptoImpl: webcrypto,
    storage,
    capabilities: READY_CAPABILITIES,
    platformAdapter: adapter,
    deviceBindingId: 'device-a'
  });
  assert.equal((await reopened.openOwnerKey(ownerA)).keyId, handles[0].keyId);
  await assert.rejects(
    () => reopened.openOwnerKey(owner('owner-a', 'device-b')),
    (error) => error?.code === 'DEVICE_BINDING_MISMATCH'
  );
  assert.notEqual((await reopened.openOwnerKey(ownerB)).keyId, (await reopened.openOwnerKey(ownerC)).keyId);
});

test('browser provider rotates by version while retaining old data keys, then revokes and deletes an owner', async () => {
  const storage = memoryStorage();
  const provider = createBrowserProductionKeyProvider({
    cryptoImpl: webcrypto,
    storage,
    capabilities: READY_CAPABILITIES,
    platformAdapter: platformAdapter(),
    deviceBindingId: 'device-a'
  });
  const context = owner('owner-a');
  const first = await provider.enrollOwner(context);
  const second = await provider.rotateOwnerKey(context);
  assert.equal(first.keyVersion, 1);
  assert.equal(second.keyVersion, 2);
  assert.equal(await provider.getKeyVersion(context), 2);
  assert.equal((await provider.openOwnerKey({ ...context, keyVersion: 1 })).keyVersion, 1);
  assert.equal((await provider.openOwnerKey({ ...context, keyVersion: 2 })).keyVersion, 2);

  await provider.revokeOwnerKey(context);
  await assert.rejects(() => provider.openOwnerKey(context), (error) => error?.code === 'KEY_REVOKED');
  await provider.deleteOwnerKey(context);
  assert.equal((await storage.listKeys()).some((record) => record.ownerHash), false);
});

test('browser provider independently wraps Owner DEK for recovery and restores onto a new device', async () => {
  const storage = memoryStorage();
  const oldProvider = createBrowserProductionKeyProvider({
    cryptoImpl: webcrypto,
    storage,
    capabilities: READY_CAPABILITIES,
    platformAdapter: platformAdapter(),
    deviceBindingId: 'device-a'
  });
  const oldContext = owner('owner-a', 'device-a');
  await oldProvider.enrollOwner(oldContext);
  const recoverySecret = generateRecoverySecret(webcrypto);
  const wrapped = await oldProvider.wrapForRecovery(oldContext, recoverySecret);
  assert.equal(wrapped.rawKeyIncluded, false);
  assert.equal(wrapped.recoveryWrapper.wrapperType, 'recovery');
  assert.equal(JSON.stringify(wrapped).includes('recoverySecret'), false);
  assert.equal(JSON.stringify(wrapped).includes('ownerDek'), false);

  const newProvider = createBrowserProductionKeyProvider({
    cryptoImpl: webcrypto,
    storage,
    capabilities: READY_CAPABILITIES,
    platformAdapter: platformAdapter(),
    deviceBindingId: 'device-b'
  });
  await assert.rejects(
    () => newProvider.restoreFromRecovery(owner('owner-a', 'device-b'), wrapped, generateRecoverySecret(webcrypto)),
    /OperationError|DataError|decrypt/i
  );
  const tampered = {
    ...wrapped,
    recoveryWrapper: {
      ...wrapped.recoveryWrapper,
      ciphertext: `${wrapped.recoveryWrapper.ciphertext[0] === 'A' ? 'B' : 'A'}${wrapped.recoveryWrapper.ciphertext.slice(1)}`
    }
  };
  await assert.rejects(
    () => newProvider.restoreFromRecovery(owner('owner-a', 'device-b'), tampered, recoverySecret),
    /OperationError|DataError|decrypt/i
  );
  await assert.rejects(
    () => newProvider.restoreFromRecovery(owner('owner-b', 'device-b'), wrapped, recoverySecret),
    (error) => error?.code === 'KEY_RECOVERY_INVALID'
  );

  const restored = await newProvider.restoreFromRecovery(owner('owner-a', 'device-b'), wrapped, recoverySecret);
  assert.equal(restored.keyVersion, 2);
  assert.notEqual(restored.keyId, wrapped.keyId);
  assert.equal((await newProvider.openOwnerKey(owner('owner-a', 'device-b'))).keyVersion, 2);
  assert.equal(new Set([...storage.records.values()].filter((record) => record.ownerHash).map((record) => record.deviceBindingId)).size, 2);

  await oldProvider.revokeOwnerKey(oldContext);
  await assert.rejects(
    () => oldProvider.openOwnerKey(oldContext),
    (error) => error?.code === 'KEY_REVOKED'
  );
  assert.equal((await newProvider.openOwnerKey(owner('owner-a', 'device-b'))).keyVersion, 2);
  assertOpaqueRecords(storage);
});

test('browser provider refuses production operations when the capability verdict is blocked', async () => {
  const provider = createBrowserProductionKeyProvider({
    cryptoImpl: webcrypto,
    storage: memoryStorage(),
    capabilities: { productionReady: false, capabilities: {}, errorCodes: { recoveryKeyWrapping: 'NON_EXPORTABLE_KEY_CANNOT_BE_WRAPPED' } },
    platformAdapter: null,
    deviceBindingId: ''
  });
  assert.equal(provider.describe().available, false);
  await assert.rejects(
    () => provider.enrollOwner(owner('owner-a')),
    (error) => error?.code === 'KEY_PROVIDER_UNAVAILABLE'
  );
});

test('validation-only browser provider can exercise hierarchy before final Safari verdict', async () => {
  const provider = createBrowserProductionKeyProvider({
    cryptoImpl: webcrypto,
    storage: memoryStorage(),
    capabilities: {
      productionReady: false,
      capabilities: {
        webCryptoAesGcm: true,
        nonExportableKeyHandle: true,
        indexedDb: true,
        persistentCryptoKey: true
      },
      errorCodes: {}
    },
    validationOnly: true,
    deviceBindingId: 'device-validation'
  });
  assert.equal(provider.describe().available, true);
  const context = owner('validation-owner', 'device-validation');
  await provider.enrollOwner(context);
  const key = await provider.withOwnerKey(context, (ownerKey) => ownerKey);
  assert.equal(key.extractable, false);
});
