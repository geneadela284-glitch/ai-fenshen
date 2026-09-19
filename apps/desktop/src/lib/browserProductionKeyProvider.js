import {
  BROWSER_KEY_HIERARCHY_SCHEMA_VERSION,
  RECOVERY_KDF_ITERATIONS,
  RECOVERY_KDF_NAME,
  deriveRecoveryKek,
  generateDeviceKek,
  generateOwnerDek,
  randomBytes,
  unwrapOwnerDekWithDeviceKek,
  unwrapOwnerDekWithRecoveryKek,
  wrapOwnerDekWithDeviceKek,
  wrapOwnerDekWithRecoveryKek
} from './browserKeyHierarchy.js';
import {
  ProductionKeyProvider
} from '../../../../core/localDataSpace/keyProvider.js';
import { createIndexedDbKeyStorage, recordId } from './browserKeyStore.js';

export const BROWSER_PRODUCTION_KEY_PROVIDER_VERSION = 'browser-production-key-provider-v2';
export const RECOVERY_PACKAGE_VERSION = 'browser-recovery-v2';
const DEFAULT_SPACE_ID = 'meeting-space';
const BASE_BROWSER_CAPABILITIES = Object.freeze([
  'webCryptoAesGcm',
  'nonExportableKeyHandle',
  'indexedDb',
  'persistentCryptoKey'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function byteArray(value, code = 'RECOVERY_SECRET_INVALID') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError(code);
}

function base64url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  const encoder = globalThis.btoa || ((value) => Buffer.from(value, 'binary').toString('base64'));
  return encoder(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value, code = 'KEY_WRAPPER_INVALID') {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw codedError(code);
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  if (globalThis.atob) {
    const binary = globalThis.atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

async function hashOwner(cryptoImpl, ownerId) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(`owner:${ownerId}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function handleFromRecord(record) {
  return Object.freeze({ keyId: record.keyId, keyVersion: record.keyVersion, nonExportable: true });
}

function assertCryptoKey(cryptoKey) {
  if (!cryptoKey || cryptoKey.extractable !== false || cryptoKey.type !== 'secret') throw codedError('KEY_RECORD_INVALID');
  return cryptoKey;
}

function capabilityBaseReady(capabilities) {
  const capabilitySet = capabilities?.capabilities || {};
  return BASE_BROWSER_CAPABILITIES.every((name) => capabilitySet[name] === true);
}

function wrapperAad({ ownerId, keyId, keyVersion, deviceId, wrapperType }) {
  return {
    ownerId,
    keyId,
    keyVersion,
    deviceId,
    wrapperType,
    schemaVersion: BROWSER_KEY_HIERARCHY_SCHEMA_VERSION
  };
}

function recordAad(context, record, wrapperType, deviceId = record.deviceBindingId) {
  return wrapperAad({
    ownerId: context.ownerId,
    keyId: record.keyId,
    keyVersion: record.keyVersion,
    deviceId,
    wrapperType
  });
}

function storedAad(record) {
  return Object.freeze({
    keyId: record.keyId,
    keyVersion: record.keyVersion,
    deviceId: record.deviceBindingId,
    wrapperType: 'device',
    schemaVersion: BROWSER_KEY_HIERARCHY_SCHEMA_VERSION
  });
}

function recoveryPackageWrapper(wrapper) {
  return Object.freeze({
    schemaVersion: wrapper.schemaVersion,
    wrapperType: wrapper.wrapperType,
    nonce: base64url(wrapper.nonce),
    ciphertext: base64url(wrapper.ciphertext),
    rawKeyIncluded: false
  });
}

function recoveryPackageBytes(wrapper) {
  return {
    ...wrapper,
    nonce: fromBase64url(wrapper.nonce, 'KEY_RECOVERY_INVALID'),
    ciphertext: fromBase64url(wrapper.ciphertext, 'KEY_RECOVERY_INVALID')
  };
}

class BrowserSecureKeyStore {
  #crypto;
  #storage;
  #capabilities;
  #platformAdapter;
  #deviceBindingId;
  #validationOnly;
  #locked = new Set();

  constructor({ cryptoImpl = globalThis.crypto, storage, capabilities, platformAdapter, deviceBindingId, validationOnly = false } = {}) {
    this.#crypto = cryptoImpl;
    this.#storage = storage;
    this.#capabilities = capabilities || { productionReady: false, capabilities: {}, errorCodes: {} };
    this.#platformAdapter = platformAdapter;
    this.#deviceBindingId = String(deviceBindingId || '').trim();
    this.#validationOnly = validationOnly === true;
  }

  describe() {
    const capabilitySet = this.#capabilities.capabilities || {};
    const baseReady = capabilityBaseReady(this.#capabilities);
    const platformReady = this.#platformAdapter?.verified === true
      && this.#platformAdapter?.requiresDeviceUnlock === true
      && this.#platformAdapter?.supportsRecoveryWrapping === true
      && this.#platformAdapter?.supportsRevocation === true
      && this.#platformAdapter?.supportsLifecycle === true;
    const available = this.#validationOnly
      ? baseReady && Boolean(this.#storage)
      : this.#capabilities.productionReady === true && baseReady && platformReady && this.#deviceBindingId.length > 0;
    return Object.freeze({
      provider: 'browser-webcrypto-indexeddb-device-kek',
      version: BROWSER_PRODUCTION_KEY_PROVIDER_VERSION,
      exportsKeys: false,
      available,
      requiresDeviceUnlock: true,
      supportsRecoveryWrapping: baseReady && (this.#validationOnly || platformReady),
      supportsRevocation: this.#validationOnly || this.#platformAdapter?.supportsRevocation === true,
      supportsLifecycle: this.#validationOnly || this.#platformAdapter?.supportsLifecycle === true,
      keyVersion: 2,
      hierarchy: Object.freeze({
        deviceKek: 'non-exportable-AES-GCM',
        ownerDek: 'transient-32-byte-AES-GCM',
        recoveryKek: RECOVERY_KDF_NAME
      }),
      capabilityErrorCodes: Object.freeze({ ...(this.#capabilities.errorCodes || {}) }),
      validationOnly: this.#validationOnly
    });
  }

  #baseCapabilityReady() {
    return capabilityBaseReady(this.#capabilities);
  }

  async #ensureDeviceBindingId() {
    if (this.#deviceBindingId) return this.#deviceBindingId;
    if (typeof this.#storage?.getOrCreateDeviceBindingId !== 'function') throw codedError('DEVICE_BINDING_UNAVAILABLE');
    this.#deviceBindingId = required(await this.#storage.getOrCreateDeviceBindingId(), 'DEVICE_BINDING_UNAVAILABLE');
    return this.#deviceBindingId;
  }

  #requireAvailable() {
    if (!this.describe().available) throw codedError(this.#validationOnly ? 'KEY_PROVIDER_PLATFORM_BLOCKED' : 'KEY_PROVIDER_PLATFORM_BLOCKED');
    if (!this.#storage || typeof this.#storage.listKeys !== 'function') throw codedError('INDEXEDDB_UNAVAILABLE');
    if (!this.#crypto?.subtle || typeof this.#crypto.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
  }

  async #context(ownerContext) {
    if (!ownerContext || typeof ownerContext !== 'object' || ownerContext.trusted !== true) throw codedError('OWNER_CONTEXT_UNTRUSTED');
    const ownerId = required(ownerContext.ownerId, 'OWNER_REQUIRED');
    const sessionId = required(ownerContext.sessionId, 'OWNER_SESSION_REQUIRED');
    const spaceId = required(ownerContext.spaceId || DEFAULT_SPACE_ID, 'SPACE_ID_REQUIRED');
    const deviceBindingId = await this.#ensureDeviceBindingId();
    if (ownerContext.deviceBindingId && ownerContext.deviceBindingId !== deviceBindingId) throw codedError('DEVICE_BINDING_MISMATCH');
    const ownerHash = await hashOwner(this.#crypto, ownerId);
    return Object.freeze({ ownerId, sessionId, spaceId, ownerHash, deviceBindingId });
  }

  async #assertDeviceUnlocked(context) {
    if (typeof this.#platformAdapter?.assertDeviceUnlocked === 'function') {
      const unlocked = await this.#platformAdapter.assertDeviceUnlocked(context);
      if (unlocked !== true) throw codedError('DEVICE_UNLOCK_REQUIRED');
    }
    if (typeof this.#platformAdapter?.isDeviceRevoked === 'function' && await this.#platformAdapter.isDeviceRevoked(context)) {
      throw codedError('KEY_REVOKED');
    }
  }

  async #allRecords(context) {
    return (await this.#storage.listKeys()).filter((record) => record.ownerHash === context.ownerHash && record.spaceId === context.spaceId);
  }

  async #deviceRecords(context) {
    return (await this.#allRecords(context)).filter((record) => record.deviceBindingId === context.deviceBindingId);
  }

  async #find(context, keyVersion = null) {
    await this.#assertDeviceUnlocked(context);
    const records = await this.#deviceRecords(context);
    const candidates = records.filter((record) => keyVersion === null || record.keyVersion === keyVersion);
    if (!candidates.length) throw codedError('KEY_NOT_FOUND');
    candidates.sort((left, right) => right.keyVersion - left.keyVersion);
    const record = candidates[0];
    if (record.revoked === true) throw codedError('KEY_REVOKED');
    return record;
  }

  async #makeRecord(context, keyVersion, ownerDek = null) {
    const transientOwnerDek = ownerDek || await generateOwnerDek(this.#crypto, { extractable: true });
    if (transientOwnerDek.extractable !== true) throw codedError('OWNER_DEK_MUST_BE_TRANSIENT_EXPORTABLE_FOR_WRAP');
    const deviceKey = await generateDeviceKek(this.#crypto);
    const keyId = `key-${base64url(randomBytes(this.#crypto, 18))}`;
    const record = {
      schemaVersion: 'browser-key-storage-v1',
      recordId: recordId(context.ownerHash, context.spaceId, keyVersion),
      ownerHash: context.ownerHash,
      spaceId: context.spaceId,
      keyId,
      keyVersion,
      deviceBindingId: context.deviceBindingId,
      deviceKey,
      revoked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const wrapped = await wrapOwnerDekWithDeviceKek({
      cryptoImpl: this.#crypto,
      ownerDek: transientOwnerDek,
      deviceKek: deviceKey,
      aad: recordAad(context, record, 'device')
    });
    return Object.freeze({
      ...record,
      deviceWrappedOwnerDek: wrapped.ciphertext,
      deviceNonce: wrapped.nonce,
      deviceAad: storedAad(record)
    });
  }

  async enrollOwner(ownerContext) {
    this.#requireAvailable();
    const context = await this.#context(ownerContext);
    const current = await this.#find(context).catch((error) => error?.code === 'KEY_NOT_FOUND' ? null : Promise.reject(error));
    if (current) return handleFromRecord(current);
    const record = await this.#makeRecord(context, 1);
    await this.#storage.putKey(record);
    return handleFromRecord(record);
  }

  async openOwnerKey(ownerContext) {
    this.#requireAvailable();
    const context = await this.#context(ownerContext);
    const lockId = `${context.ownerHash}\u0000${context.spaceId}`;
    if (this.#locked.has(lockId)) throw codedError('KEY_LOCKED');
    return handleFromRecord(await this.#find(context, ownerContext.keyVersion ?? null));
  }

  async lockOwner(ownerContext) {
    this.#requireAvailable();
    const context = await this.#context(ownerContext);
    this.#locked.add(`${context.ownerHash}\u0000${context.spaceId}`);
    await this.#platformAdapter?.lockOwner?.(ownerContext);
    return true;
  }

  async rotateOwnerKey(ownerContext) {
    this.#requireAvailable();
    const context = await this.#context(ownerContext);
    const current = await this.#find(context);
    const allRecords = await this.#allRecords(context);
    const nextVersion = Math.max(...allRecords.map((record) => record.keyVersion), current.keyVersion) + 1;
    const record = await this.#makeRecord(context, nextVersion);
    await this.#storage.putKey(record);
    return handleFromRecord(record);
  }

  async createDataKey(request = {}) {
    const normalized = { ...request, trusted: true, sessionId: request.sessionId || 'legacy-key-provider', deviceBindingId: this.#deviceBindingId };
    return this.enrollOwner(normalized);
  }

  async getDataKey(request = {}) {
    const normalized = { ...request, trusted: true, sessionId: request.sessionId || 'legacy-key-provider', deviceBindingId: this.#deviceBindingId };
    return this.openOwnerKey(normalized);
  }

  async deleteDataKey(request = {}) {
    const normalized = { ...request, trusted: true, sessionId: request.sessionId || 'legacy-key-provider', deviceBindingId: this.#deviceBindingId };
    return this.revokeOwnerKey(normalized);
  }

  async withKey(handle, callback) {
    this.#requireAvailable();
    if (typeof callback !== 'function') throw codedError('KEY_CALLBACK_REQUIRED');
    const ownerId = required(handle?.ownerId, 'OWNER_REQUIRED');
    const context = await this.#context({ trusted: true, ownerId, sessionId: 'opaque-key-handle-session', spaceId: handle.spaceId || DEFAULT_SPACE_ID });
    const record = await this.#find(context, handle.keyVersion ?? null);
    if (record.keyId !== handle.keyId) throw codedError('KEY_HANDLE_INVALID');
    const ownerDek = await unwrapOwnerDekWithDeviceKek({
      cryptoImpl: this.#crypto,
      wrapped: { schemaVersion: BROWSER_KEY_HIERARCHY_SCHEMA_VERSION, wrapperType: 'device', nonce: record.deviceNonce, ciphertext: record.deviceWrappedOwnerDek, rawKeyIncluded: false },
      deviceKek: record.deviceKey,
      aad: recordAad(context, record, 'device'),
      extractable: false
    });
    return callback(assertCryptoKey(ownerDek));
  }

  async withOwnerKey(ownerContext, callback) {
    if (typeof callback !== 'function') throw codedError('KEY_CALLBACK_REQUIRED');
    const trusted = ownerContext;
    const handle = await this.openOwnerKey(trusted);
    return this.withKey({ ...handle, ownerId: trusted.ownerId, spaceId: trusted.spaceId || DEFAULT_SPACE_ID }, callback);
  }

  async wrapForRecovery(ownerContext, recoverySecret) {
    this.#requireAvailable();
    const secret = byteArray(recoverySecret);
    if (secret.byteLength !== 32) throw codedError('RECOVERY_SECRET_INVALID');
    const context = await this.#context(ownerContext);
    const record = await this.#find(context);
    const transientOwnerDek = await unwrapOwnerDekWithDeviceKek({
      cryptoImpl: this.#crypto,
      wrapped: { schemaVersion: BROWSER_KEY_HIERARCHY_SCHEMA_VERSION, wrapperType: 'device', nonce: record.deviceNonce, ciphertext: record.deviceWrappedOwnerDek, rawKeyIncluded: false },
      deviceKek: record.deviceKey,
      aad: recordAad(context, record, 'device'),
      extractable: true
    });
    const salt = randomBytes(this.#crypto, 16);
    const recoveryKek = await deriveRecoveryKek({ cryptoImpl: this.#crypto, recoverySecret: secret, salt });
    const recoveryWrapper = await wrapOwnerDekWithRecoveryKek({
      cryptoImpl: this.#crypto,
      ownerDek: transientOwnerDek,
      recoveryKek,
      aad: recordAad(context, record, 'recovery', record.deviceBindingId),
      salt
    });
    return Object.freeze({
      version: RECOVERY_PACKAGE_VERSION,
      schemaVersion: BROWSER_KEY_HIERARCHY_SCHEMA_VERSION,
      ownerHash: context.ownerHash,
      spaceId: context.spaceId,
      keyId: record.keyId,
      keyVersion: record.keyVersion,
      sourceDeviceId: record.deviceBindingId,
      recoveryKdf: Object.freeze({ name: RECOVERY_KDF_NAME, hash: 'SHA-256', iterations: RECOVERY_KDF_ITERATIONS, salt: base64url(salt) }),
      recoveryWrapper: recoveryPackageWrapper(recoveryWrapper),
      rawKeyIncluded: false,
      createdAt: new Date().toISOString()
    });
  }

  async restoreFromRecovery(ownerContext, recoveryPackage, recoverySecret) {
    this.#requireAvailable();
    const secret = byteArray(recoverySecret);
    if (secret.byteLength !== 32) throw codedError('RECOVERY_SECRET_INVALID');
    const context = await this.#context(ownerContext);
    if (!recoveryPackage || recoveryPackage.version !== RECOVERY_PACKAGE_VERSION ||
        recoveryPackage.schemaVersion !== BROWSER_KEY_HIERARCHY_SCHEMA_VERSION ||
        recoveryPackage.ownerHash !== context.ownerHash || recoveryPackage.spaceId !== context.spaceId ||
        recoveryPackage.rawKeyIncluded === true || !recoveryPackage.sourceDeviceId) {
      throw codedError('KEY_RECOVERY_INVALID');
    }
    const recoveryKdf = recoveryPackage.recoveryKdf;
    if (recoveryKdf?.name !== RECOVERY_KDF_NAME || recoveryKdf.hash !== 'SHA-256' || recoveryKdf.iterations !== RECOVERY_KDF_ITERATIONS) throw codedError('KEY_RECOVERY_INVALID');
    const salt = fromBase64url(recoveryKdf.salt, 'KEY_RECOVERY_INVALID');
    const recoveryKek = await deriveRecoveryKek({ cryptoImpl: this.#crypto, recoverySecret: secret, salt, iterations: recoveryKdf.iterations });
    const transientOwnerDek = await unwrapOwnerDekWithRecoveryKek({
      cryptoImpl: this.#crypto,
      wrapped: recoveryPackageBytes(recoveryPackage.recoveryWrapper),
      recoveryKek,
      aad: wrapperAad({
        ownerId: context.ownerId,
        keyId: recoveryPackage.keyId,
        keyVersion: recoveryPackage.keyVersion,
        deviceId: recoveryPackage.sourceDeviceId,
        wrapperType: 'recovery'
      }),
      extractable: true
    });
    const allRecords = await this.#allRecords(context);
    const nextVersion = Math.max(0, ...allRecords.map((record) => record.keyVersion)) + 1;
    const record = await this.#makeRecord(context, nextVersion, transientOwnerDek);
    await this.#storage.putKey(record);
    await unwrapOwnerDekWithDeviceKek({
      cryptoImpl: this.#crypto,
      wrapped: { schemaVersion: BROWSER_KEY_HIERARCHY_SCHEMA_VERSION, wrapperType: 'device', nonce: record.deviceNonce, ciphertext: record.deviceWrappedOwnerDek, rawKeyIncluded: false },
      deviceKek: record.deviceKey,
      aad: recordAad(context, record, 'device'),
      extractable: false
    });
    return handleFromRecord(record);
  }

  async revokeOwnerKey(ownerContext) {
    this.#requireAvailable();
    const context = await this.#context(ownerContext);
    for (const record of await this.#deviceRecords(context)) {
      await this.#storage.updateKey({ ...record, revoked: true, updatedAt: new Date().toISOString() });
    }
    await this.#platformAdapter?.revokeOwnerKey?.(ownerContext);
    return true;
  }

  async deleteOwnerKey(ownerContext) {
    this.#requireAvailable();
    const context = await this.#context(ownerContext);
    await this.#storage.deleteOwner(context.ownerHash, context.spaceId);
    await this.#platformAdapter?.deleteOwnerKey?.(ownerContext);
    return true;
  }

  async getKeyVersion(ownerContext) {
    this.#requireAvailable();
    const context = await this.#context(ownerContext);
    const records = await this.#deviceRecords(context);
    if (!records.length) throw codedError('KEY_NOT_FOUND');
    return Math.max(...records.map((record) => record.keyVersion));
  }

  async createKeyHandle(request) {
    return this.enrollOwner({ ...request, trusted: true, sessionId: 'legacy-key-provider', deviceBindingId: this.#deviceBindingId });
  }

  async getKeyHandle(request) {
    return this.openOwnerKey({ ...request, trusted: true, sessionId: 'legacy-key-provider', deviceBindingId: this.#deviceBindingId });
  }

  async revokeKeyHandle(request) {
    return this.revokeOwnerKey({ ...request, trusted: true, sessionId: 'legacy-key-provider', deviceBindingId: this.#deviceBindingId });
  }

  async wrapKey(request, recoveryKey) {
    return this.wrapForRecovery({ ...request, trusted: true, sessionId: 'legacy-key-provider', deviceBindingId: this.#deviceBindingId }, recoveryKey);
  }

  async unwrapKey(request, recoveryPackage, recoveryKey) {
    return this.restoreFromRecovery({ ...request, trusted: true, sessionId: 'legacy-key-provider', deviceBindingId: this.#deviceBindingId }, recoveryPackage, recoveryKey);
  }
}

export function generateRecoverySecret(cryptoImpl = globalThis.crypto) {
  return randomBytes(cryptoImpl, 32);
}

export function createBrowserProductionKeyProvider({
  cryptoImpl = globalThis.crypto,
  storage = createIndexedDbKeyStorage({}),
  capabilities,
  platformAdapter = null,
  deviceBindingId = '',
  validationOnly = false
} = {}) {
  const secureStore = new BrowserSecureKeyStore({ cryptoImpl, storage, capabilities, platformAdapter, deviceBindingId, validationOnly });
  return new ProductionKeyProvider({ secureStore });
}

export { BrowserSecureKeyStore };
