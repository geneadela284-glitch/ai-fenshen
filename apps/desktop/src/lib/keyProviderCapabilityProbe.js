import {
  deriveRecoveryKek,
  generateDeviceKek,
  generateOwnerDek,
  randomBytes,
  unwrapOwnerDekWithDeviceKek,
  unwrapOwnerDekWithRecoveryKek,
  wrapOwnerDekWithDeviceKek,
  wrapOwnerDekWithRecoveryKek
} from './browserKeyHierarchy.js';

export const CAPABILITY_PROBE_VERSION = 'production-key-provider-capability-probe-v2';

function errorCode(error, fallback) {
  const code = String(error?.code || '').trim();
  return code || fallback;
}

function versionFromUserAgent(userAgent) {
  const match = String(userAgent || '').match(/(?:CriOS|FxiOS|EdgiOS|Chrome|Firefox|Version|Safari)\/([0-9.]+)/i);
  return match ? match[1] : 'unknown';
}

function inferEnvironment({ environment, windowImpl = globalThis.window, documentImpl = globalThis.document }) {
  if (environment === 'browser' || environment === 'test') return environment;
  return windowImpl && documentImpl ? 'browser' : 'test';
}

function runtimeInfo({ runtime = {}, navigatorImpl = globalThis.navigator } = {}) {
  const userAgent = String(runtime.userAgent || navigatorImpl?.userAgent || 'unknown');
  return Object.freeze({
    secureContext: runtime.secureContext ?? Boolean(globalThis.isSecureContext),
    userAgent,
    browserVersion: String(runtime.browserVersion || versionFromUserAgent(userAgent)),
    platform: String(runtime.platform || navigatorImpl?.platform || 'unknown')
  });
}

function resultEntry(supported, error = '') {
  return { supported: supported === true, errorCode: supported === true ? null : String(error || 'CAPABILITY_UNAVAILABLE') };
}

function toCapabilityMap(entries) {
  return Object.freeze(Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, Boolean(entry?.supported)])));
}

async function probeAesGcm(cryptoImpl) {
  const text = new TextEncoder().encode('ai-fenshen-key-provider-capability-probe');
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') {
    return { aes: resultEntry(false, 'WEB_CRYPTO_UNAVAILABLE'), nonExportable: resultEntry(false, 'WEB_CRYPTO_UNAVAILABLE') };
  }
  try {
    const key = await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, text);
    const plaintext = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    if (new TextDecoder().decode(plaintext) !== new TextDecoder().decode(text)) return { aes: resultEntry(false, 'AES_GCM_ROUNDTRIP_FAILED'), nonExportable: resultEntry(false, 'AES_GCM_ROUNDTRIP_FAILED') };
    try {
      await cryptoImpl.subtle.exportKey('raw', key);
      return { aes: resultEntry(true), nonExportable: resultEntry(false, 'NON_EXPORTABLE_KEY_EXPORTABLE') };
    } catch {
      return { aes: resultEntry(true), nonExportable: resultEntry(true) };
    }
  } catch (error) {
    return { aes: resultEntry(false, errorCode(error, 'AES_GCM_PROBE_FAILED')), nonExportable: resultEntry(false, 'AES_GCM_PROBE_FAILED') };
  }
}

async function probeStoragePersistence({ storageProbe, navigatorImpl }) {
  if (typeof storageProbe?.probeStoragePersistence === 'function') {
    try {
      const result = await storageProbe.probeStoragePersistence();
      return {
        quota: resultEntry(Number(result?.quotaBytes || 0) > 0, result?.quotaBytes ? null : 'STORAGE_QUOTA_UNAVAILABLE'),
        persistent: resultEntry(result?.persisted === true, 'STORAGE_PERSISTENCE_UNVERIFIED'),
        privateMode: resultEntry(result?.privateModeSafe === true, 'PRIVATE_MODE_UNVERIFIABLE')
      };
    } catch (error) {
      const code = errorCode(error, 'STORAGE_PERSISTENCE_PROBE_FAILED');
      return { quota: resultEntry(false, code), persistent: resultEntry(false, code), privateMode: resultEntry(false, 'PRIVATE_MODE_UNVERIFIABLE') };
    }
  }
  const storage = navigatorImpl?.storage;
  if (typeof storage?.estimate !== 'function') {
    return {
      quota: resultEntry(false, 'STORAGE_QUOTA_UNAVAILABLE'),
      persistent: resultEntry(false, 'STORAGE_PERSISTENCE_UNVERIFIED'),
      privateMode: resultEntry(false, 'PRIVATE_MODE_UNVERIFIABLE')
    };
  }
  try {
    const estimate = await storage.estimate();
    let persisted = typeof storage.persisted === 'function' ? await storage.persisted() : false;
    if (!persisted && typeof storage.persist === 'function') persisted = await storage.persist();
    return {
      quota: resultEntry(Number(estimate?.quota || 0) > 0, 'STORAGE_QUOTA_UNAVAILABLE'),
      persistent: resultEntry(persisted === true, 'STORAGE_PERSISTENCE_UNVERIFIED'),
      privateMode: resultEntry(false, 'PRIVATE_MODE_UNVERIFIABLE')
    };
  } catch (error) {
    const code = errorCode(error, 'STORAGE_PERSISTENCE_PROBE_FAILED');
    return { quota: resultEntry(false, code), persistent: resultEntry(false, code), privateMode: resultEntry(false, 'PRIVATE_MODE_UNVERIFIABLE') };
  }
}

async function probeRecoveryWrapping(cryptoImpl, override) {
  if (typeof override === 'function') {
    try {
      const result = await override({ cryptoImpl });
      return result?.supported === true ? resultEntry(true) : resultEntry(false, result?.errorCode || 'RECOVERY_WRAPPING_UNAVAILABLE');
    } catch (error) {
      return resultEntry(false, errorCode(error, 'RECOVERY_WRAPPING_UNAVAILABLE'));
    }
  }
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') return resultEntry(false, 'RECOVERY_WRAPPING_UNAVAILABLE');
  try {
    const deviceKek = await generateDeviceKek(cryptoImpl);
    const transientOwnerDek = await generateOwnerDek(cryptoImpl, { extractable: true });
    const aad = { ownerId: 'capability-owner', keyId: 'capability-key', keyVersion: 1, deviceId: 'capability-device', wrapperType: 'device', schemaVersion: 'browser-key-hierarchy-v2' };
    const deviceWrapper = await wrapOwnerDekWithDeviceKek({ cryptoImpl, ownerDek: transientOwnerDek, deviceKek, aad });
    const usableOwnerDek = await unwrapOwnerDekWithDeviceKek({ cryptoImpl, wrapped: deviceWrapper, deviceKek, aad, extractable: false });
    if (usableOwnerDek.extractable !== false) return resultEntry(false, 'OWNER_DEK_EXPORTABLE_AFTER_UNWRAP');
    const recoverySecret = randomBytes(cryptoImpl, 32);
    const salt = randomBytes(cryptoImpl, 16);
    const recoveryKek = await deriveRecoveryKek({ cryptoImpl, recoverySecret, salt });
    const recoveryWrapper = await wrapOwnerDekWithRecoveryKek({ cryptoImpl, ownerDek: transientOwnerDek, recoveryKek, aad: { ...aad, wrapperType: 'recovery' } });
    const restored = await unwrapOwnerDekWithRecoveryKek({ cryptoImpl, wrapped: recoveryWrapper, recoveryKek, aad: { ...aad, wrapperType: 'recovery' }, extractable: false });
    return resultEntry(restored.extractable === false, 'RECOVERY_OWNER_DEK_NOT_NON_EXPORTABLE');
  } catch (error) {
    return resultEntry(false, errorCode(error, 'RECOVERY_WRAPPING_UNAVAILABLE'));
  }
}

async function probePlatformUserVerification({ configured, publicKeyCredential, navigatorImpl }) {
  if (typeof configured === 'function') {
    try {
      return resultEntry(await configured() === true, 'PLATFORM_USER_VERIFICATION_UNAVAILABLE');
    } catch (error) {
      return resultEntry(false, errorCode(error, 'PLATFORM_USER_VERIFICATION_UNAVAILABLE'));
    }
  }
  if (typeof configured === 'boolean') return resultEntry(configured, 'PLATFORM_USER_VERIFICATION_UNAVAILABLE');
  const credential = publicKeyCredential || navigatorImpl?.credentials?.PublicKeyCredential || globalThis.PublicKeyCredential;
  if (typeof credential?.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return resultEntry(false, 'PLATFORM_USER_VERIFICATION_UNAVAILABLE');
  try {
    return resultEntry(await credential.isUserVerifyingPlatformAuthenticatorAvailable() === true, 'PLATFORM_USER_VERIFICATION_UNAVAILABLE');
  } catch (error) {
    return resultEntry(false, errorCode(error, 'PLATFORM_USER_VERIFICATION_UNAVAILABLE'));
  }
}

function lifecycleEntry(value, error) {
  return resultEntry(value === true, value === true ? null : error);
}

function assessmentFor({ environment, capabilitiesReady, storageAvailable, realSafariValidated }) {
  if (environment === 'test') return 'TEST_ENV_CAPABILITY_UNAVAILABLE';
  if (!capabilitiesReady) return 'BROWSER_CAPABILITY_INCOMPLETE';
  if (!realSafariValidated) return 'BROWSER_CAPABILITIES_READY_PENDING_MANUAL_VALIDATION';
  return 'PRODUCTION_KEYPROVIDER_VALIDATED';
}

export async function probeKeyProviderCapabilities({
  environment,
  windowImpl = globalThis.window,
  documentImpl = globalThis.document,
  cryptoImpl = globalThis.crypto,
  storageProbe = null,
  platformUserVerification,
  publicKeyCredential,
  lifecycleEvidence = {},
  privateBrowsingSafe,
  recoveryWrappingProbe,
  realSafariEvidence = {},
  runtime,
  navigatorImpl = globalThis.navigator
} = {}) {
  const resolvedEnvironment = inferEnvironment({ environment, windowImpl, documentImpl });
  const runtimeSnapshot = runtimeInfo({ runtime, navigatorImpl });
  const aesProbe = await probeAesGcm(cryptoImpl);
  const storageAvailable = storageProbe?.available === true || Boolean(navigatorImpl?.indexedDB?.open || globalThis.indexedDB?.open);
  let persistence = resultEntry(false, storageProbe?.errorCode || 'INDEXEDDB_UNAVAILABLE');
  if (storageAvailable && typeof storageProbe?.probeCryptoKeyPersistence === 'function' && aesProbe.nonExportable.supported) {
    try {
      const checked = await storageProbe.probeCryptoKeyPersistence(await generateDeviceKek(cryptoImpl));
      persistence = resultEntry(checked?.reopened === true || checked === true, checked?.errorCode || 'CRYPTO_KEY_PERSISTENCE_FAILED');
    } catch (error) {
      persistence = resultEntry(false, errorCode(error, 'CRYPTO_KEY_PERSISTENCE_FAILED'));
    }
  }
  const storagePersistence = await probeStoragePersistence({ storageProbe, navigatorImpl });
  const platformVerification = await probePlatformUserVerification({ configured: platformUserVerification, publicKeyCredential, navigatorImpl });
  const recoveryWrapping = await probeRecoveryWrapping(cryptoImpl, recoveryWrappingProbe);
  const privateMode = typeof privateBrowsingSafe === 'boolean' ? resultEntry(privateBrowsingSafe, 'PRIVATE_MODE_UNVERIFIABLE') : storagePersistence.privateMode;
  const entries = {
    secureContext: resultEntry(runtimeSnapshot.secureContext, 'INSECURE_CONTEXT'),
    webCryptoAesGcm: aesProbe.aes,
    nonExportableKeyHandle: aesProbe.nonExportable,
    indexedDb: resultEntry(storageAvailable, storageProbe?.errorCode || 'INDEXEDDB_UNAVAILABLE'),
    persistentCryptoKey: persistence,
    storageQuota: storagePersistence.quota,
    persistentStorage: storagePersistence.persistent,
    pageRefreshRecovery: persistence.supported ? lifecycleEntry(lifecycleEvidence.pageRefreshVerified, 'PAGE_REFRESH_NOT_VERIFIED') : resultEntry(false, persistence.errorCode || 'PAGE_REFRESH_NOT_VERIFIED'),
    browserRestartRecovery: lifecycleEntry(lifecycleEvidence.browserRestartVerified, 'BROWSER_RESTART_NOT_VERIFIED'),
    deviceRestartRecovery: lifecycleEntry(lifecycleEvidence.deviceRestartVerified, 'DEVICE_RESTART_NOT_VERIFIED'),
    platformUserVerification: platformVerification,
    recoveryKeyWrapping: recoveryWrapping,
    privateBrowsingSafe: privateMode,
    failClosedWhenStorageUnavailable: resultEntry(true)
  };
  const capabilities = toCapabilityMap(entries);
  const capabilitiesReady = Object.values(capabilities).every(Boolean);
  const realSafariValidated = realSafariEvidence?.validated === true;
  const productionReady = resolvedEnvironment === 'browser' && capabilitiesReady && realSafariValidated;
  const errorCodes = Object.freeze(Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.errorCode).map(([name, entry]) => [name, entry.errorCode])));
  return Object.freeze({
    probeVersion: CAPABILITY_PROBE_VERSION,
    environment: resolvedEnvironment,
    assessment: assessmentFor({ environment: resolvedEnvironment, capabilitiesReady, storageAvailable, realSafariValidated }),
    runtime: runtimeSnapshot,
    capabilities,
    capabilitiesReady,
    productionReady,
    errorCodes
  });
}
