import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  CAPABILITY_PROBE_VERSION,
  probeKeyProviderCapabilities
} from './keyProviderCapabilityProbe.js';

function storageProbe(overrides = {}) {
  return {
    available: true,
    async probeCryptoKeyPersistence() { return { available: true, reopened: true }; },
    async probeStoragePersistence() { return { quotaBytes: 1024 * 1024, persisted: true, privateModeSafe: true }; },
    ...overrides
  };
}

function verifiedLifecycle() {
  return { pageRefreshVerified: true, browserRestartVerified: true, deviceRestartVerified: true };
}

test('capability probe records synthetic capability readiness without calling it real Safari validation', async () => {
  const result = await probeKeyProviderCapabilities({
    environment: 'test',
    cryptoImpl: webcrypto,
    storageProbe: storageProbe(),
    runtime: { secureContext: true, userAgent: 'SyntheticBrowser/1.0', browserVersion: '1.0', platform: 'synthetic' },
    platformUserVerification: async () => true,
    lifecycleEvidence: verifiedLifecycle(),
    privateBrowsingSafe: true,
    recoveryWrappingProbe: async () => ({ supported: true }),
    realSafariEvidence: { validated: false }
  });

  assert.equal(result.probeVersion, CAPABILITY_PROBE_VERSION);
  assert.equal(result.capabilitiesReady, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.assessment, 'TEST_ENV_CAPABILITY_UNAVAILABLE');
  assert.equal(result.capabilities.webCryptoAesGcm, true);
  assert.equal(result.capabilities.nonExportableKeyHandle, true);
  assert.equal(result.capabilities.persistentCryptoKey, true);
  assert.equal(result.capabilities.pageRefreshRecovery, true);
  assert.equal(result.capabilities.browserRestartRecovery, true);
  assert.equal(result.capabilities.deviceRestartRecovery, true);
  assert.equal(result.capabilities.platformUserVerification, true);
  assert.equal(result.capabilities.recoveryKeyWrapping, true);
  assert.equal(result.capabilities.privateBrowsingSafe, true);
  assert.equal(result.capabilities.failClosedWhenStorageUnavailable, true);
  assert.equal(Object.hasOwn(result, 'key'), false);
  assert.equal(Object.hasOwn(result, 'secret'), false);
});

test('capability probe blocks when IndexedDB or CryptoKey persistence is unavailable', async () => {
  const result = await probeKeyProviderCapabilities({
    environment: 'test',
    cryptoImpl: webcrypto,
    storageProbe: storageProbe({ available: false, errorCode: 'INDEXEDDB_UNAVAILABLE' }),
    platformUserVerification: async () => true,
    lifecycleEvidence: verifiedLifecycle(),
    privateBrowsingSafe: true,
    recoveryWrappingProbe: async () => ({ supported: true })
  });

  assert.equal(result.capabilities.indexedDb, false);
  assert.equal(result.capabilities.persistentCryptoKey, false);
  assert.equal(result.capabilities.pageRefreshRecovery, false);
  assert.equal(result.productionReady, false);
  assert.equal(result.assessment, 'TEST_ENV_CAPABILITY_UNAVAILABLE');
  assert.notEqual(result.assessment, 'PRODUCTION_KEYPROVIDER_PLATFORM_BLOCKED');
  assert.equal(result.errorCodes.indexedDb, 'INDEXEDDB_UNAVAILABLE');
  assert.equal(result.errorCodes.persistentCryptoKey, 'INDEXEDDB_UNAVAILABLE');
});

test('capability probe uses a separate recovery wrapper instead of wrapping a non-exportable Owner key', async () => {
  const result = await probeKeyProviderCapabilities({
    environment: 'test',
    cryptoImpl: webcrypto,
    storageProbe: storageProbe(),
    platformUserVerification: async () => true,
    lifecycleEvidence: verifiedLifecycle(),
    privateBrowsingSafe: true,
    recoveryWrappingProbe: async () => ({ supported: true })
  });

  assert.equal(result.capabilities.nonExportableKeyHandle, true);
  assert.equal(result.capabilities.recoveryKeyWrapping, true);
  assert.equal(result.errorCodes.recoveryKeyWrapping, undefined);
  assert.equal(result.productionReady, false);
});

test('capability probe keeps browser lifecycle and private-mode uncertainty fail-closed without final platform verdict', async () => {
  const result = await probeKeyProviderCapabilities({
    environment: 'browser',
    cryptoImpl: webcrypto,
    storageProbe: storageProbe({ async probeStoragePersistence() { return { quotaBytes: 1024 * 1024, persisted: true, privateModeSafe: false }; } }),
    platformUserVerification: async () => false,
    lifecycleEvidence: { pageRefreshVerified: false, browserRestartVerified: false, deviceRestartVerified: false },
    recoveryWrappingProbe: async () => ({ supported: true })
  });

  assert.equal(result.capabilities.browserRestartRecovery, false);
  assert.equal(result.capabilities.deviceRestartRecovery, false);
  assert.equal(result.capabilities.pageRefreshRecovery, false);
  assert.equal(result.capabilities.platformUserVerification, false);
  assert.equal(result.capabilities.privateBrowsingSafe, false);
  assert.equal(result.errorCodes.browserRestartRecovery, 'BROWSER_RESTART_NOT_VERIFIED');
  assert.equal(result.errorCodes.deviceRestartRecovery, 'DEVICE_RESTART_NOT_VERIFIED');
  assert.equal(result.errorCodes.privateBrowsingSafe, 'PRIVATE_MODE_UNVERIFIABLE');
  assert.equal(result.assessment, 'BROWSER_CAPABILITY_INCOMPLETE');
  assert.notEqual(result.assessment, 'PRODUCTION_KEYPROVIDER_PLATFORM_BLOCKED');
  assert.equal(result.productionReady, false);
});

test('browser capability readiness waits for explicit real Safari evidence', async () => {
  const result = await probeKeyProviderCapabilities({
    environment: 'browser',
    cryptoImpl: webcrypto,
    storageProbe: storageProbe(),
    runtime: { secureContext: true, userAgent: 'Version/18.6 Mobile/15E148 Safari/604.1', browserVersion: '18.6', platform: 'iPhone' },
    platformUserVerification: async () => true,
    lifecycleEvidence: verifiedLifecycle(),
    privateBrowsingSafe: true,
    recoveryWrappingProbe: async () => ({ supported: true }),
    realSafariEvidence: { validated: false }
  });

  assert.equal(result.capabilitiesReady, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.assessment, 'BROWSER_CAPABILITIES_READY_PENDING_MANUAL_VALIDATION');
});
