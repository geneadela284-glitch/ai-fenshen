import { randomBytes, scryptSync } from 'node:crypto';

import { DATA_KEY_BYTES, decryptBytes, encryptBytes, keyId } from './crypto.js';
import { ownerHash } from './ownerContext.js';

const RECOVERY_PACKAGE_VERSION = 'key-recovery-v1';

function error(code) {
  const value = new Error(code);
  value.code = code;
  return value;
}

function requestKey(request) {
  const ownerId = String(request?.ownerId || '').trim();
  const spaceId = String(request?.spaceId || '').trim();
  if (!ownerId || !spaceId) throw error('OWNER_OR_SPACE_REQUIRED');
  return `${ownerId}\u0000${spaceId}`;
}

function bytes(value) {
  const result = Buffer.isBuffer(value) ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!result || result.length !== DATA_KEY_BYTES) throw error('KEY_INVALID');
  return result;
}

function recoveryKeyBytes(recoveryKey, ownerId, spaceId) {
  const material = Buffer.isBuffer(recoveryKey) ? Buffer.from(recoveryKey) : Buffer.from(String(recoveryKey ?? ''), 'utf8');
  if (material.length < 16) throw error('RECOVERY_KEY_INVALID');
  return scryptSync(material, Buffer.from(`meeting-recovery:${ownerId}:${spaceId}`, 'utf8'), DATA_KEY_BYTES, {
    N: 1 << 14,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024
  });
}

function recoveryAad(ownerId, spaceId) {
  return `${ownerHash(ownerId)}\u0000${spaceId}\u0000recovery-key`;
}

export class TestKeyProvider {
  #keys = new Map();

  constructor({ initialKeys = {} } = {}) {
    Object.entries(initialKeys).forEach(([key, value]) => this.#keys.set(key, bytes(value)));
  }

  async createDataKey(request) {
    const key = requestKey(request);
    if (!this.#keys.has(key)) this.#keys.set(key, randomBytes(DATA_KEY_BYTES));
    return Buffer.from(this.#keys.get(key));
  }

  async getDataKey(request) {
    const key = this.#keys.get(requestKey(request));
    if (!key) throw error('KEY_NOT_FOUND');
    return Buffer.from(key);
  }

  async deleteDataKey(request) {
    return this.#keys.delete(requestKey(request));
  }

  async wrapForRecovery(request = {}) {
    const { ownerId, spaceId } = requestKeyParts(request);
    const dataKey = this.#keys.get(`${ownerId}\u0000${spaceId}`);
    if (!dataKey) throw error('KEY_NOT_FOUND');
    const wrappingKey = recoveryKeyBytes(request.recoveryKey, ownerId, spaceId);
    return Object.freeze({
      version: RECOVERY_PACKAGE_VERSION,
      mode: 'user-recovery-key',
      ownerHash: ownerHash(ownerId),
      spaceId,
      keyId: keyId(dataKey),
      rawKeyIncluded: false,
      wrappedDataKey: encryptBytes(dataKey, wrappingKey, { aad: recoveryAad(ownerId, spaceId) })
    });
  }

  async restoreFromRecovery(request = {}) {
    const { ownerId, spaceId } = requestKeyParts(request);
    const recoveryPackage = request.recoveryPackage;
    if (
      recoveryPackage?.version !== RECOVERY_PACKAGE_VERSION
      || recoveryPackage.mode !== 'user-recovery-key'
      || recoveryPackage.ownerHash !== ownerHash(ownerId)
      || recoveryPackage.spaceId !== spaceId
      || recoveryPackage.rawKeyIncluded === true
    ) throw error('KEY_RECOVERY_INVALID');
    const wrappingKey = recoveryKeyBytes(request.recoveryKey, ownerId, spaceId);
    let dataKey;
    try {
      dataKey = decryptBytes(recoveryPackage.wrappedDataKey, wrappingKey, { aad: recoveryAad(ownerId, spaceId) });
    } catch {
      throw error('AUTHENTICATION_FAILED');
    }
    if (keyId(dataKey) !== recoveryPackage.keyId) throw error('KEY_RECOVERY_INVALID');
    this.#keys.set(`${ownerId}\u0000${spaceId}`, Buffer.from(dataKey));
    return Buffer.from(dataKey);
  }

  describe() {
    return Object.freeze({ provider: 'test-key-provider', exportsKeys: false, testOnly: true, available: true });
  }

  async withDataKey(request, callback) {
    if (typeof callback !== 'function') throw error('KEY_CALLBACK_REQUIRED');
    return callback(await this.getDataKey(request));
  }
}

function requestKeyParts(request) {
  const ownerId = String(request?.ownerId || '').trim();
  const spaceId = String(request?.spaceId || '').trim();
  if (!ownerId || !spaceId) throw error('OWNER_OR_SPACE_REQUIRED');
  return { ownerId, spaceId };
}

export function createTestKeyProvider(options = {}) {
  return new TestKeyProvider(options);
}
