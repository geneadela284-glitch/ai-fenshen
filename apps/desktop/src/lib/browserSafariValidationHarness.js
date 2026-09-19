import {
  createBrowserProductionKeyProvider,
  generateRecoverySecret
} from './browserProductionKeyProvider.js';
import {
  parsePortableRecoveryCredential,
  serializePortableRecoveryCredential
} from './portableRecoveryCredential.js';

export const SAFARI_VALIDATION_OWNER_ID = 'meeting-v1-safari-validation-owner';
export const SYNTHETIC_RECORD_PLAINTEXT = 'PHASE05B_MRC1_SYNTHETIC_RECORD_V1';
const FIXTURE_AAD = 'meeting-v1-validation-fixture-v1';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function base64url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  const encoder = globalThis.btoa || ((value) => Buffer.from(value, 'binary').toString('base64'));
  return encoder(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized) throw codedError('RECOVERY_SECRET_INVALID');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  if (globalThis.atob) return Uint8Array.from(globalThis.atob(padded), (character) => character.charCodeAt(0));
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

async function sha256Hex(cryptoImpl, value) {
  const source = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await cryptoImpl.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function deviceId(cryptoImpl) {
  return `validation-device-${base64url(cryptoImpl.getRandomValues(new Uint8Array(12)))}`;
}

function ownerContext(deviceBindingId) {
  return Object.freeze({
    trusted: true,
    ownerId: SAFARI_VALIDATION_OWNER_ID,
    sessionId: 'meeting-v1-safari-validation-session',
    spaceId: 'meeting-space',
    deviceBindingId
  });
}

export function createBrowserSafariValidationHarness({
  cryptoImpl = globalThis.crypto,
  storage,
  capabilities,
  initialDeviceBindingId = ''
} = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
  let currentDeviceBindingId = String(initialDeviceBindingId || '').trim();
  let provider = null;
  let oldProvider = null;
  let oldDeviceBindingId = '';
  let recoveryCredential = null;
  const fallbackUsedPortableCredentials = new Set();

  async function ensureDeviceBindingId() {
    if (currentDeviceBindingId) return currentDeviceBindingId;
    if (typeof storage?.getOrCreateDeviceBindingId !== 'function') throw codedError('DEVICE_BINDING_UNAVAILABLE');
    currentDeviceBindingId = String(await storage.getOrCreateDeviceBindingId()).trim();
    if (!currentDeviceBindingId) throw codedError('DEVICE_BINDING_UNAVAILABLE');
    return currentDeviceBindingId;
  }

  async function ensureProvider() {
    const bindingId = await ensureDeviceBindingId();
    if (!provider) {
      provider = createBrowserProductionKeyProvider({
        cryptoImpl,
        storage,
        capabilities,
        deviceBindingId: bindingId,
        validationOnly: true
      });
    }
    return provider;
  }

async function encryptedFixture(key) {
    const nonce = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoImpl.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(FIXTURE_AAD) },
      key,
      new TextEncoder().encode(SYNTHETIC_RECORD_PLAINTEXT)
    );
    return {
      nonce,
      ciphertext: new Uint8Array(ciphertext),
      aad: FIXTURE_AAD,
      plaintextDigest: await sha256Hex(cryptoImpl, SYNTHETIC_RECORD_PLAINTEXT)
    };
  }

  return {
    async verifySyntheticFixture() {
      const activeProvider = await ensureProvider();
      const context = ownerContext(currentDeviceBindingId);
      await activeProvider.enrollOwner(context);
      const existing = await storage.getValidationFixture?.();
      if (!existing) {
        const fixture = await activeProvider.withOwnerKey(context, (key) => encryptedFixture(key));
        await storage.putValidationFixture(fixture);
        return { ok: true, action: 'created' };
      }
      const plaintext = await activeProvider.withOwnerKey(context, (key) => cryptoImpl.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(existing.nonce), additionalData: new TextEncoder().encode(existing.aad) },
        key,
        new Uint8Array(existing.ciphertext)
      ));
      if (new TextDecoder().decode(plaintext) !== SYNTHETIC_RECORD_PLAINTEXT) throw codedError('VALIDATION_FIXTURE_MISMATCH');
      return { ok: true, action: 'decrypted', plaintextDigest: await sha256Hex(cryptoImpl, plaintext) };
    },
    async createRecoveryCredential() {
      if (recoveryCredential) return recoveryCredential;
      const activeProvider = await ensureProvider();
      const context = ownerContext(currentDeviceBindingId);
      await activeProvider.enrollOwner(context);
      const recoverySecret = generateRecoverySecret(cryptoImpl);
      const recoveryPackage = await activeProvider.wrapForRecovery(context, recoverySecret);
      recoveryCredential = Object.freeze({ package: recoveryPackage, recoverySecret: base64url(recoverySecret) });
      return recoveryCredential;
    },
    async createPortableRecoveryCredential() {
      if (!recoveryCredential) throw codedError('EXISTING_CREDENTIAL_NOT_PORTABLE');
      const fixture = await storage.getValidationFixture?.();
      const portable = await serializePortableRecoveryCredential({
        cryptoImpl,
        recoveryPackage: recoveryCredential.package,
        recoverySecret: fromBase64url(recoveryCredential.recoverySecret),
        validationFixture: fixture
          ? { ...fixture, plaintextDigest: fixture.plaintextDigest || await sha256Hex(cryptoImpl, SYNTHETIC_RECORD_PLAINTEXT) }
          : null
      });
      return Object.freeze({ credential: portable });
    },
    async restoreWithRecovery({ credential = '', package: recoveryPackage, recoverySecret } = {}) {
      const portable = credential
        ? await parsePortableRecoveryCredential({ cryptoImpl, credential })
        : null;
      const activeRecoveryPackage = portable?.recoveryPackage || recoveryPackage;
      const activeRecoverySecret = portable?.recoverySecret || (recoverySecret ? fromBase64url(recoverySecret) : null);
      if (!activeRecoveryPackage || !activeRecoverySecret) throw codedError('RECOVERY_INPUT_REQUIRED');
      if (portable) {
        const used = typeof storage.getRecoveryCredentialUse === 'function'
          ? await storage.getRecoveryCredentialUse(portable.credentialId)
          : fallbackUsedPortableCredentials.has(portable.credentialId);
        if (used) throw codedError('RECOVERY_CREDENTIAL_ALREADY_USED');
      }
      const previousProvider = await ensureProvider();
      const isPortable = Boolean(portable);
      if (!isPortable) {
        oldProvider = previousProvider;
        oldDeviceBindingId = currentDeviceBindingId;
        currentDeviceBindingId = deviceId(cryptoImpl);
        provider = createBrowserProductionKeyProvider({
          cryptoImpl,
          storage,
          capabilities,
          deviceBindingId: currentDeviceBindingId,
          validationOnly: true
        });
      }
      const targetProvider = isPortable ? previousProvider : provider;
      const restored = await targetProvider.restoreFromRecovery(
        ownerContext(currentDeviceBindingId),
        activeRecoveryPackage,
        activeRecoverySecret
      );
      let syntheticFixtureDecrypted = false;
      let plaintextDigestMatch = false;
      if (portable?.validationFixture) {
        if (typeof storage.putValidationFixture !== 'function') throw codedError('VALIDATION_FIXTURE_TRANSFER_UNAVAILABLE');
        await storage.putValidationFixture(portable.validationFixture);
        await targetProvider.withOwnerKey(ownerContext(currentDeviceBindingId), async (key) => {
          const fixture = portable.validationFixture;
          const plaintext = await cryptoImpl.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(fixture.nonce), additionalData: new TextEncoder().encode(fixture.aad) },
            key,
            new Uint8Array(fixture.ciphertext)
          );
          if (new TextDecoder().decode(plaintext) !== SYNTHETIC_RECORD_PLAINTEXT) throw codedError('VALIDATION_FIXTURE_MISMATCH');
          const actualDigest = await sha256Hex(cryptoImpl, plaintext);
          if (!fixture.plaintextDigest || actualDigest !== fixture.plaintextDigest) throw codedError('VALIDATION_FIXTURE_DIGEST_MISMATCH');
          plaintextDigestMatch = true;
        });
        syntheticFixtureDecrypted = true;
      }
      if (portable) {
        if (typeof storage.claimRecoveryCredentialUse === 'function') {
          await storage.claimRecoveryCredentialUse({
            credentialId: portable.credentialId,
            ownerHash: portable.ownerHash,
            usedAt: new Date().toISOString()
          });
        } else {
          fallbackUsedPortableCredentials.add(portable.credentialId);
        }
      }
      return Object.freeze({
        ...restored,
        recoveryRewrapVerified: true,
        syntheticFixtureDecrypted,
        plaintextDigestMatch,
        deviceChanged: isPortable ? portable.recoveryPackage.sourceDeviceId !== currentDeviceBindingId : oldDeviceBindingId !== currentDeviceBindingId
      });
    },
    async revokeOldDevice() {
      if (!oldProvider || !oldDeviceBindingId) throw codedError('OLD_DEVICE_NOT_READY');
      await oldProvider.revokeOwnerKey(ownerContext(oldDeviceBindingId));
      let oldDeviceReadable = true;
      try {
        await oldProvider.openOwnerKey(ownerContext(oldDeviceBindingId));
      } catch {
        oldDeviceReadable = false;
      }
      return { oldDeviceReadable };
    },
    async getLifecycleEvidence() {
      return storage.getLifecycleEvidence?.() || {
        pageRefreshVerified: false,
        browserRestartVerified: false,
        deviceRestartVerified: false,
        pageLoadMarker: '',
        updatedAt: ''
      };
    },
    async setLifecycleEvidence(evidence) {
      if (typeof storage.setLifecycleEvidence !== 'function') throw codedError('LIFECYCLE_EVIDENCE_UNAVAILABLE');
      await storage.setLifecycleEvidence(evidence);
      return storage.getLifecycleEvidence();
    },
    async getValidationEvidence() {
      return storage.getSafariValidationEvidence?.() || {};
    },
    async setValidationEvidence(evidence) {
      if (typeof storage.setSafariValidationEvidence !== 'function') throw codedError('VALIDATION_EVIDENCE_UNAVAILABLE');
      await storage.setSafariValidationEvidence(evidence);
      return storage.getSafariValidationEvidence();
    },
    getCurrentDeviceBindingId() {
      return currentDeviceBindingId;
    }
  };
}
