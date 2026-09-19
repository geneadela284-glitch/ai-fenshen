import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KEY_PROVIDER_CONTRACT_VERSION,
  ProductionKeyProvider,
  ProductionKeyProviderContract,
  validateProductionKeyProvider,
  validateKeyProvider
} from './keyProvider.js';

test('ProductionKeyProvider fails closed without a verified secure platform adapter', async () => {
  const provider = new ProductionKeyProvider();

  assert.equal(KEY_PROVIDER_CONTRACT_VERSION, 'key-provider-v1');
  assert.equal(validateKeyProvider(provider).valid, true);
  assert.equal(provider.describe().exportsKeys, false);
  assert.equal(provider.describe().available, false);
  await assert.rejects(
    () => provider.createDataKey({ ownerId: 'owner-a', spaceId: 'space-a' }),
    (error) => error?.code === 'KEY_PROVIDER_UNAVAILABLE'
  );
});

test('ProductionKeyProvider fails closed when recovery or revocation support is incomplete', async () => {
  const insecureStore = {
    describe: () => ({
      exportsKeys: false,
      requiresDeviceUnlock: true,
      supportsRecoveryWrapping: false,
      supportsRevocation: true,
      keyVersion: 1
    }),
    createKeyHandle: async () => ({ keyId: 'key-a', keyVersion: 1, nonExportable: true }),
    getKeyHandle: async () => ({ keyId: 'key-a', keyVersion: 1, nonExportable: true }),
    revokeKeyHandle: async () => true,
    withKey: async (_handle, callback) => callback(Buffer.alloc(32)),
    wrapKey: async () => ({}),
    unwrapKey: async () => ({ keyId: 'key-a', keyVersion: 1, nonExportable: true })
  };
  const provider = new ProductionKeyProvider({ secureStore: insecureStore });
  assert.equal(provider.describe().available, false);
  await assert.rejects(
    () => provider.createDataKey({ ownerId: 'owner-a', spaceId: 'space-a' }),
    (error) => error?.code === 'KEY_PROVIDER_UNAVAILABLE'
  );
});

test('ProductionKeyProvider exposes the owner lifecycle contract without exporting key material', async () => {
  const ownerContext = Object.freeze({ ownerId: 'owner-a', sessionId: 'session-a', trusted: true });
  const calls = [];
  const secureStore = {
    describe: () => ({
      exportsKeys: false,
      requiresDeviceUnlock: true,
      supportsRecoveryWrapping: true,
      supportsRevocation: true,
      supportsLifecycle: true,
      keyVersion: 1
    }),
    createKeyHandle: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    getKeyHandle: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    revokeKeyHandle: async () => true,
    withKey: async (_handle, callback) => callback(Object.freeze({ type: 'opaque-platform-key' })),
    wrapKey: async () => ({ rawKeyIncluded: false }),
    unwrapKey: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    enrollOwner: async (context) => { calls.push(['enrollOwner', context]); return { keyId: 'key-v1', keyVersion: 1, nonExportable: true }; },
    openOwnerKey: async (context) => { calls.push(['openOwnerKey', context]); return { keyId: 'key-v1', keyVersion: 1, nonExportable: true }; },
    lockOwner: async (context) => { calls.push(['lockOwner', context]); return true; },
    rotateOwnerKey: async (context) => { calls.push(['rotateOwnerKey', context]); return { keyId: 'key-v2', keyVersion: 2, nonExportable: true }; },
    wrapForRecovery: async (context, recoverySecret) => {
      calls.push(['wrapForRecovery', context, recoverySecret]);
      return { version: 'native-recovery-v1', rawKeyIncluded: false, keyVersion: 2 };
    },
    restoreFromRecovery: async (context, wrappedPackage, recoverySecret) => {
      calls.push(['restoreFromRecovery', context, wrappedPackage, recoverySecret]);
      return { keyId: 'key-v3', keyVersion: 3, nonExportable: true };
    },
    revokeOwnerKey: async (context) => { calls.push(['revokeOwnerKey', context]); return true; },
    deleteOwnerKey: async (context) => { calls.push(['deleteOwnerKey', context]); return true; },
    getKeyVersion: async (context) => { calls.push(['getKeyVersion', context]); return 2; }
  };
  const provider = new ProductionKeyProvider({ secureStore });

  assert.deepEqual(
    ProductionKeyProviderContract.requiredMethods,
    ['enrollOwner', 'openOwnerKey', 'lockOwner', 'rotateOwnerKey', 'wrapForRecovery', 'restoreFromRecovery', 'revokeOwnerKey', 'deleteOwnerKey', 'getKeyVersion']
  );
  assert.equal(validateProductionKeyProvider(provider).valid, true);
  assert.deepEqual(await provider.enrollOwner(ownerContext), { keyId: 'key-v1', keyVersion: 1, nonExportable: true, ownerId: 'owner-a' });
  assert.deepEqual(await provider.openOwnerKey(ownerContext), { keyId: 'key-v1', keyVersion: 1, nonExportable: true, ownerId: 'owner-a' });
  assert.equal(await provider.lockOwner(ownerContext), true);
  assert.deepEqual(await provider.rotateOwnerKey(ownerContext), { keyId: 'key-v2', keyVersion: 2, nonExportable: true, ownerId: 'owner-a' });
  assert.deepEqual(await provider.wrapForRecovery(ownerContext, new Uint8Array(32)), { version: 'native-recovery-v1', rawKeyIncluded: false, keyVersion: 2 });
  assert.deepEqual(await provider.restoreFromRecovery(ownerContext, { version: 'native-recovery-v1' }, new Uint8Array(32)), { keyId: 'key-v3', keyVersion: 3, nonExportable: true, ownerId: 'owner-a' });
  assert.equal(await provider.revokeOwnerKey(ownerContext), true);
  assert.equal(await provider.deleteOwnerKey(ownerContext), true);
  assert.equal(await provider.getKeyVersion(ownerContext), 2);
  assert.equal(calls.every(([, context]) => context === ownerContext), true);
  assert.equal(calls.some(([name, , secret]) => name === 'wrapForRecovery' && secret instanceof Uint8Array), true);
});

test('ProductionKeyProvider accepts Uint8Array recovery secrets in a browser without Buffer', async () => {
  const secureStore = {
    describe: () => ({
      exportsKeys: false,
      requiresDeviceUnlock: true,
      supportsRecoveryWrapping: true,
      supportsRevocation: true,
      supportsLifecycle: true,
      keyVersion: 1
    }),
    createKeyHandle: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    getKeyHandle: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    revokeKeyHandle: async () => true,
    withKey: async (_handle, callback) => callback(Object.freeze({ type: 'opaque-platform-key' })),
    wrapKey: async () => ({ rawKeyIncluded: false }),
    unwrapKey: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    wrapForRecovery: async (_context, secret) => {
      assert.ok(secret instanceof Uint8Array);
      return { version: 'browser-recovery-v2', rawKeyIncluded: false };
    },
    restoreFromRecovery: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    enrollOwner: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    openOwnerKey: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    lockOwner: async () => true,
    rotateOwnerKey: async () => ({ keyId: 'legacy-key', keyVersion: 1, nonExportable: true }),
    revokeOwnerKey: async () => true,
    deleteOwnerKey: async () => true,
    getKeyVersion: async () => 1
  };
  const provider = new ProductionKeyProvider({ secureStore });
  const originalBuffer = globalThis.Buffer;
  globalThis.Buffer = undefined;
  try {
    const wrapped = await provider.wrapForRecovery(
      { ownerId: 'owner-a', sessionId: 'session-a', trusted: true },
      new Uint8Array(32)
    );
    assert.equal(wrapped.rawKeyIncluded, false);
  } finally {
    globalThis.Buffer = originalBuffer;
  }
});

test('ProductionKeyProvider lifecycle methods fail closed without the verified platform adapter', async () => {
  const provider = new ProductionKeyProvider();
  assert.equal(validateProductionKeyProvider(provider).valid, false);
  for (const method of ProductionKeyProviderContract.requiredMethods) {
    await assert.rejects(
      () => method === 'wrapForRecovery'
        ? provider[method]({ ownerId: 'owner-a', sessionId: 'session-a', trusted: true }, new Uint8Array(32))
        : method === 'restoreFromRecovery'
          ? provider[method]({ ownerId: 'owner-a', sessionId: 'session-a', trusted: true }, {}, new Uint8Array(32))
          : provider[method]({ ownerId: 'owner-a', sessionId: 'session-a', trusted: true }),
      (error) => error?.code === 'KEY_PROVIDER_UNAVAILABLE'
    );
  }
});
