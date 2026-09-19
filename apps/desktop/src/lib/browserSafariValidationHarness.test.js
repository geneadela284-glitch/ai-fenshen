import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  createBrowserSafariValidationHarness,
  SYNTHETIC_RECORD_PLAINTEXT
} from './browserSafariValidationHarness.js';

const CAPABILITIES = {
  productionReady: false,
  capabilities: {
    webCryptoAesGcm: true,
    nonExportableKeyHandle: true,
    indexedDb: true,
    persistentCryptoKey: true
  },
  errorCodes: {}
};

function memoryStorage(deviceBindingId = 'device-a') {
  const records = new Map();
  const metadata = new Map();
  return {
    records,
    metadata,
    async putKey(record) { records.set(record.recordId, structuredClone(record)); },
    async listKeys() { return [...records.values()]; },
    async updateKey(record) { records.set(record.recordId, structuredClone(record)); },
    async deleteOwner(ownerHash, spaceId) {
      for (const [recordId, record] of records) if (record.ownerHash === ownerHash && record.spaceId === spaceId) records.delete(recordId);
    },
    async getOrCreateDeviceBindingId() { return deviceBindingId; },
    async putValidationFixture(fixture) { metadata.set('validation-fixture', structuredClone(fixture)); },
    async getValidationFixture() { return metadata.get('validation-fixture') || null; },
    async deleteValidationFixture() { metadata.delete('validation-fixture'); },
    async getRecoveryCredentialUse(credentialId) { return metadata.get(`recovery-use:${credentialId}`) || null; },
    async claimRecoveryCredentialUse(record) {
      const key = `recovery-use:${record.credentialId}`;
      if (metadata.has(key)) {
        const error = new Error('RECOVERY_CREDENTIAL_ALREADY_USED');
        error.code = 'RECOVERY_CREDENTIAL_ALREADY_USED';
        throw error;
      }
      metadata.set(key, structuredClone(record));
    }
  };
}

test('Safari validation harness encrypts and decrypts only a synthetic fixture', async () => {
  const storage = memoryStorage();
  const harness = createBrowserSafariValidationHarness({ cryptoImpl: webcrypto, storage, capabilities: CAPABILITIES });

  assert.equal((await harness.verifySyntheticFixture()).action, 'created');
  const decrypted = await harness.verifySyntheticFixture();
  assert.equal(decrypted.action, 'decrypted');
  assert.equal(decrypted.plaintextDigest, 'bd87fb93292574763e9db20b7bb7290eea03d893d6f7084cb92e3967e5617bbe');
  const serialized = JSON.stringify([...storage.metadata.values()]);
  assert.equal(serialized.includes(SYNTHETIC_RECORD_PLAINTEXT), false);
});

test('Safari validation harness restores on a new device and revokes the old device', async () => {
  const storage = memoryStorage();
  const harness = createBrowserSafariValidationHarness({ cryptoImpl: webcrypto, storage, capabilities: CAPABILITIES });
  await harness.verifySyntheticFixture();
  const recovery = await harness.createRecoveryCredential();
  assert.equal(typeof recovery.recoverySecret, 'string');
  assert.equal(recovery.package.rawKeyIncluded, false);
  const repeatedRecovery = await harness.createRecoveryCredential();
  assert.equal(repeatedRecovery.recoverySecret, recovery.recoverySecret);
  assert.deepEqual(repeatedRecovery.package, recovery.package);

  const restored = await harness.restoreWithRecovery(recovery);
  assert.equal(restored.keyVersion, 2);
  assert.equal(restored.deviceChanged, true);
  assert.equal((await harness.revokeOldDevice()).oldDeviceReadable, false);
  assert.equal((await harness.verifySyntheticFixture()).ok, true);
});

test('portable recovery credential crosses isolated device storage and decrypts the synthetic fixture once', async () => {
  const sourceStorage = memoryStorage('device-a');
  const sourceHarness = createBrowserSafariValidationHarness({ cryptoImpl: webcrypto, storage: sourceStorage, capabilities: CAPABILITIES });
  await sourceHarness.verifySyntheticFixture();
  await sourceHarness.createRecoveryCredential();
  const portable = await sourceHarness.createPortableRecoveryCredential();
  assert.equal(typeof portable.credential, 'string');
  assert.equal(portable.credential.startsWith('mrc1.'), true);
  assert.equal(sourceStorage.records.size, 1);

  const targetStorage = memoryStorage('device-b');
  const targetHarness = createBrowserSafariValidationHarness({ cryptoImpl: webcrypto, storage: targetStorage, capabilities: CAPABILITIES });
  const restored = await targetHarness.restoreWithRecovery({ credential: portable.credential });
  assert.equal(restored.recoveryRewrapVerified, true);
  assert.equal(restored.deviceChanged, true);
  assert.equal(restored.syntheticFixtureDecrypted, true);
  assert.equal(restored.plaintextDigestMatch, true);
  assert.equal((await targetHarness.verifySyntheticFixture()).action, 'decrypted');
  assert.equal(targetStorage.records.size, 1);
  assert.equal(sourceStorage.records.size, 1);
  await assert.rejects(
    () => targetHarness.restoreWithRecovery({ credential: portable.credential }),
    (error) => error?.code === 'RECOVERY_CREDENTIAL_ALREADY_USED'
  );
});

test('portable recovery credential is one-time even when no validation fixture is transferred', async () => {
  const sourceStorage = memoryStorage('device-a');
  const sourceHarness = createBrowserSafariValidationHarness({ cryptoImpl: webcrypto, storage: sourceStorage, capabilities: CAPABILITIES });
  await sourceHarness.createRecoveryCredential();
  const portable = await sourceHarness.createPortableRecoveryCredential();

  const targetStorage = memoryStorage('device-b');
  const targetHarness = createBrowserSafariValidationHarness({ cryptoImpl: webcrypto, storage: targetStorage, capabilities: CAPABILITIES });
  const restored = await targetHarness.restoreWithRecovery({ credential: portable.credential });
  assert.equal(restored.deviceChanged, true);
  assert.equal(restored.syntheticFixtureDecrypted, false);
  await assert.rejects(
    () => targetHarness.restoreWithRecovery({ credential: portable.credential }),
    (error) => error?.code === 'RECOVERY_CREDENTIAL_ALREADY_USED'
  );
});
