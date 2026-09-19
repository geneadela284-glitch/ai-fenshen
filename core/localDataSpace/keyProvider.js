export const KEY_PROVIDER_CONTRACT_VERSION = 'key-provider-v1';

export const KeyProviderContract = Object.freeze({
  version: KEY_PROVIDER_CONTRACT_VERSION,
  requiredMethods: Object.freeze(['createDataKey', 'getDataKey', 'deleteDataKey', 'wrapForRecovery', 'restoreFromRecovery', 'describe']),
  requiredDescriptionFields: Object.freeze(['provider', 'exportsKeys'])
});

export const ProductionKeyProviderContract = Object.freeze({
  version: KEY_PROVIDER_CONTRACT_VERSION,
  requiredMethods: Object.freeze([
    'enrollOwner',
    'openOwnerKey',
    'lockOwner',
    'rotateOwnerKey',
    'wrapForRecovery',
    'restoreFromRecovery',
    'revokeOwnerKey',
    'deleteOwnerKey',
    'getKeyVersion'
  ])
});

function issue(path, code, message) {
  return Object.freeze({ path, code, message });
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validRequest(request) {
  const ownerId = String(request?.ownerId || '').trim();
  const spaceId = String(request?.spaceId || '').trim();
  if (!ownerId || !spaceId) throw codedError('OWNER_OR_SPACE_REQUIRED');
  return { ownerId, spaceId };
}

function normalizeHandle(handle, request) {
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) throw codedError('KEY_HANDLE_INVALID');
  const keyId = String(handle.keyId || '').trim();
  const keyVersion = Number(handle.keyVersion || 0);
  if (!keyId || !Number.isSafeInteger(keyVersion) || keyVersion < 1 || handle.nonExportable !== true) {
    throw codedError('KEY_HANDLE_INVALID');
  }
  return Object.freeze({ keyId, keyVersion, nonExportable: true, ownerId: request.ownerId, spaceId: request.spaceId });
}

function validOwnerContext(ownerContext) {
  if (!ownerContext || typeof ownerContext !== 'object' || Array.isArray(ownerContext) || ownerContext.trusted !== true) {
    throw codedError('OWNER_CONTEXT_UNTRUSTED');
  }
  const ownerId = String(ownerContext.ownerId || '').trim();
  const sessionId = String(ownerContext.sessionId || '').trim();
  if (!ownerId || !sessionId) throw codedError('OWNER_CONTEXT_INVALID');
  return ownerContext;
}

function normalizeOwnerHandle(handle, ownerContext) {
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) throw codedError('KEY_HANDLE_INVALID');
  const keyId = String(handle.keyId || '').trim();
  const keyVersion = Number(handle.keyVersion || 0);
  if (!keyId || !Number.isSafeInteger(keyVersion) || keyVersion < 1 || handle.nonExportable !== true) {
    throw codedError('KEY_HANDLE_INVALID');
  }
  const normalized = { keyId, keyVersion, nonExportable: true, ownerId: ownerContext.ownerId };
  if (ownerContext.spaceId) normalized.spaceId = String(ownerContext.spaceId);
  return Object.freeze(normalized);
}

function isByteArray(value) {
  return (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(value))
    || value instanceof Uint8Array;
}

export function validateKeyProvider(provider) {
  const errors = [];
  if (!provider || typeof provider !== 'object') {
    return { valid: false, errors: [issue('', 'KEY_PROVIDER_INVALID', 'KeyProvider must be an object.')] };
  }
  for (const method of KeyProviderContract.requiredMethods) {
    if (typeof provider[method] !== 'function') errors.push(issue(method, 'KEY_PROVIDER_METHOD_MISSING', `${method}() is required.`));
  }
  if (typeof provider.describe === 'function') {
    let description;
    try { description = provider.describe(); } catch { description = null; }
    if (!description || typeof description !== 'object') {
      errors.push(issue('describe', 'KEY_PROVIDER_DESCRIPTION_INVALID', 'describe() must return an object.'));
    } else {
      if (typeof description.provider !== 'string' || !description.provider.trim()) {
        errors.push(issue('describe.provider', 'KEY_PROVIDER_DESCRIPTION_INVALID', 'provider is required.'));
      }
      if (description.exportsKeys !== false) {
        errors.push(issue('describe.exportsKeys', 'KEY_PROVIDER_EXPORTS_KEYS', 'KeyProvider must never export raw keys.'));
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateProductionKeyProvider(provider) {
  const base = validateKeyProvider(provider);
  const errors = [...base.errors];
  if (!provider || typeof provider !== 'object') return { valid: false, errors };
  for (const method of ProductionKeyProviderContract.requiredMethods) {
    if (typeof provider[method] !== 'function') {
      errors.push(issue(method, 'PRODUCTION_KEY_PROVIDER_METHOD_MISSING', `${method}() is required.`));
    }
  }
  let description = null;
  try { description = provider.describe?.() || null; } catch { description = null; }
  if (description?.available !== true) {
    errors.push(issue('describe.available', 'KEY_PROVIDER_UNAVAILABLE', 'ProductionKeyProvider must have a verified platform adapter.'));
  }
  return { valid: errors.length === 0, errors };
}

export class ProductionKeyProvider {
  #secureStore;

  constructor({ secureStore = null } = {}) {
    this.#secureStore = secureStore;
  }

  describe() {
    let secureDescription = null;
    try { secureDescription = this.#secureStore?.describe?.() || null; } catch { secureDescription = null; }
    return Object.freeze({
      provider: 'production-key-provider',
      exportsKeys: false,
      available: Boolean(
        this.#secureStore
        && secureDescription?.exportsKeys === false
        && secureDescription?.requiresDeviceUnlock === true
        && secureDescription?.supportsRecoveryWrapping === true
        && secureDescription?.supportsRevocation === true
        && secureDescription?.supportsLifecycle === true
      ),
      keyVersion: Number(secureDescription?.keyVersion || 1),
      requiresDeviceUnlock: true,
      supportsRecoveryWrapping: Boolean(secureDescription?.supportsRecoveryWrapping),
      supportsRevocation: Boolean(secureDescription?.supportsRevocation),
      supportsLifecycle: Boolean(secureDescription?.supportsLifecycle)
    });
  }

  #requireStore() {
    const description = this.describe();
    if (!description.available) throw codedError('KEY_PROVIDER_UNAVAILABLE');
    for (const method of ['createKeyHandle', 'getKeyHandle', 'revokeKeyHandle', 'withKey', 'wrapKey', 'unwrapKey']) {
      if (typeof this.#secureStore?.[method] !== 'function') throw codedError('KEY_PROVIDER_UNAVAILABLE');
    }
    return this.#secureStore;
  }

  #requireLifecycleStore() {
    const description = this.describe();
    if (!description.available) throw codedError('KEY_PROVIDER_UNAVAILABLE');
    for (const method of ['enrollOwner', 'openOwnerKey', 'lockOwner', 'rotateOwnerKey', 'revokeOwnerKey', 'deleteOwnerKey', 'getKeyVersion']) {
      if (typeof this.#secureStore?.[method] !== 'function') throw codedError('KEY_PROVIDER_UNAVAILABLE');
    }
    if (typeof this.#secureStore?.wrapForRecovery !== 'function' || typeof this.#secureStore?.restoreFromRecovery !== 'function') {
      throw codedError('KEY_RECOVERY_UNAVAILABLE');
    }
    return this.#secureStore;
  }

  async enrollOwner(ownerContext) {
    const trusted = validOwnerContext(ownerContext);
    const store = this.#requireLifecycleStore();
    return normalizeOwnerHandle(await store.enrollOwner(trusted), trusted);
  }

  async openOwnerKey(ownerContext) {
    const trusted = validOwnerContext(ownerContext);
    const store = this.#requireLifecycleStore();
    return normalizeOwnerHandle(await store.openOwnerKey(trusted), trusted);
  }

  async lockOwner(ownerContext) {
    const trusted = validOwnerContext(ownerContext);
    const store = this.#requireLifecycleStore();
    return store.lockOwner(trusted);
  }

  async rotateOwnerKey(ownerContext) {
    const trusted = validOwnerContext(ownerContext);
    const store = this.#requireLifecycleStore();
    return normalizeOwnerHandle(await store.rotateOwnerKey(trusted), trusted);
  }

  async createDataKey(request = {}) {
    const normalized = validRequest(request);
    const store = this.#requireStore();
    return normalizeHandle(await store.createKeyHandle(normalized), normalized);
  }

  async getDataKey(request = {}) {
    const normalized = validRequest(request);
    const store = this.#requireStore();
    return normalizeHandle(await store.getKeyHandle(normalized), normalized);
  }

  async deleteDataKey(request = {}) {
    const normalized = validRequest(request);
    const store = this.#requireStore();
    await store.revokeKeyHandle(normalized);
    return true;
  }

  async withDataKey(request = {}, callback) {
    if (typeof callback !== 'function') throw codedError('KEY_CALLBACK_REQUIRED');
    const normalized = validRequest(request);
    const store = this.#requireStore();
    const handle = request.keyHandle || await this.getDataKey(normalized);
    return store.withKey(handle, callback);
  }

  async withOwnerKey(ownerContext, callback) {
    if (typeof callback !== 'function') throw codedError('KEY_CALLBACK_REQUIRED');
    const trusted = validOwnerContext(ownerContext);
    const store = this.#requireLifecycleStore();
    const handle = await this.openOwnerKey(trusted);
    return store.withKey(handle, callback);
  }

  async wrapForRecovery(request = {}, recoverySecret) {
    if (recoverySecret !== undefined) {
      const trusted = validOwnerContext(request);
      if (!isByteArray(recoverySecret) || recoverySecret.byteLength !== 32) throw codedError('RECOVERY_SECRET_INVALID');
      const store = this.#requireLifecycleStore();
      const wrapped = await store.wrapForRecovery(trusted, recoverySecret);
      if (!wrapped || typeof wrapped !== 'object' || wrapped.rawKeyIncluded === true) throw codedError('KEY_RECOVERY_INVALID');
      return Object.freeze({ ...wrapped, rawKeyIncluded: false });
    }
    const normalized = validRequest(request);
    const store = this.#requireStore();
    if (typeof store.wrapKey !== 'function') throw codedError('KEY_RECOVERY_UNAVAILABLE');
    const wrapped = await store.wrapKey(normalized, request.recoveryKey);
    if (!wrapped || typeof wrapped !== 'object' || wrapped.rawKeyIncluded === true) throw codedError('KEY_RECOVERY_INVALID');
    return Object.freeze({ ...wrapped, rawKeyIncluded: false });
  }

  async restoreFromRecovery(request = {}, wrappedPackage, recoverySecret) {
    if (wrappedPackage !== undefined || recoverySecret !== undefined) {
      const trusted = validOwnerContext(request);
      if (!isByteArray(recoverySecret) || recoverySecret.byteLength !== 32) throw codedError('RECOVERY_SECRET_INVALID');
      const store = this.#requireLifecycleStore();
      return normalizeOwnerHandle(
        await store.restoreFromRecovery(trusted, wrappedPackage, recoverySecret),
        trusted
      );
    }
    const normalized = validRequest(request);
    const store = this.#requireStore();
    if (typeof store.unwrapKey !== 'function') throw codedError('KEY_RECOVERY_UNAVAILABLE');
    return normalizeHandle(await store.unwrapKey(normalized, request.recoveryPackage, request.recoveryKey), normalized);
  }

  async revokeOwnerKey(ownerContext) {
    const trusted = validOwnerContext(ownerContext);
    const store = this.#requireLifecycleStore();
    return store.revokeOwnerKey(trusted);
  }

  async deleteOwnerKey(ownerContext) {
    const trusted = validOwnerContext(ownerContext);
    const store = this.#requireLifecycleStore();
    return store.deleteOwnerKey(trusted);
  }

  async getKeyVersion(ownerContext) {
    const trusted = validOwnerContext(ownerContext);
    const store = this.#requireLifecycleStore();
    const version = await store.getKeyVersion(trusted);
    if (!Number.isSafeInteger(version) || version < 1) throw codedError('KEY_VERSION_INVALID');
    return version;
  }
}

export async function withProviderDataKey(provider, request, callback) {
  const validation = validateKeyProvider(provider);
  if (!validation.valid) throw Object.assign(codedError('KEY_PROVIDER_INVALID'), { details: validation.errors });
  if (typeof provider.withDataKey === 'function') return provider.withDataKey(request, callback);
  const dataKey = await provider.getDataKey(request);
  if (!Buffer.isBuffer(dataKey) && !(dataKey instanceof Uint8Array)) throw codedError('KEY_HANDLE_UNSUPPORTED');
  return callback(Buffer.from(dataKey));
}
