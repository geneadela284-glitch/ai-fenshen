export const BROWSER_KEY_HIERARCHY_SCHEMA_VERSION = 'browser-key-hierarchy-v2';
export const RECOVERY_KDF_NAME = 'PBKDF2-SHA-256';
export const RECOVERY_KDF_ITERATIONS = 310000;

const AES_GCM = 'AES-GCM';
const AES_KEY_LENGTH = 256;
const NONCE_BYTES = 12;
const MIN_SALT_BYTES = 16;
const REQUIRED_AAD_FIELDS = Object.freeze([
  'ownerId',
  'keyId',
  'keyVersion',
  'deviceId',
  'wrapperType',
  'schemaVersion'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
  return cryptoImpl;
}

function bytes(value, code = 'BYTES_INVALID') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError(code);
}

function requireAad(aad) {
  if (!aad || typeof aad !== 'object' || Array.isArray(aad)) throw codedError('KEY_AAD_INVALID');
  const normalized = {};
  for (const field of REQUIRED_AAD_FIELDS) {
    const value = field === 'keyVersion' ? Number(aad[field]) : String(aad[field] ?? '').trim();
    if (field === 'keyVersion' ? !Number.isSafeInteger(value) || value < 1 : !value) throw codedError('KEY_AAD_INVALID');
    normalized[field] = value;
  }
  return normalized;
}

export function encodeKeyAad(aad) {
  const normalized = requireAad(aad);
  return new TextEncoder().encode(JSON.stringify(REQUIRED_AAD_FIELDS.map((field) => [field, normalized[field]])));
}

function assertTransientOwnerDek(ownerDek) {
  if (!ownerDek || ownerDek.type !== 'secret' || ownerDek.extractable !== true) {
    throw codedError('OWNER_DEK_MUST_BE_TRANSIENT_EXPORTABLE_FOR_WRAP');
  }
  return ownerDek;
}

function assertDeviceKek(deviceKek) {
  if (!deviceKek || deviceKek.type !== 'secret' || deviceKek.extractable !== false ||
      !deviceKek.usages.includes('wrapKey') || !deviceKek.usages.includes('unwrapKey')) {
    throw codedError('DEVICE_KEK_INVALID');
  }
  return deviceKek;
}

function assertRecoveryKek(recoveryKek) {
  if (!recoveryKek || recoveryKek.type !== 'secret' || recoveryKek.extractable !== false ||
      !recoveryKek.usages.includes('wrapKey') || !recoveryKek.usages.includes('unwrapKey')) {
    throw codedError('RECOVERY_KEK_INVALID');
  }
  return recoveryKek;
}

function nonce(cryptoImpl) {
  return cryptoImpl.getRandomValues(new Uint8Array(NONCE_BYTES));
}

function wrapperResult({ wrapperType, nonceValue, ciphertext, aad }) {
  return Object.freeze({
    schemaVersion: aad.schemaVersion,
    wrapperType,
    nonce: new Uint8Array(nonceValue),
    ciphertext: new Uint8Array(ciphertext),
    rawKeyIncluded: false
  });
}

function assertWrapper(wrapped, expectedType) {
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped) ||
      wrapped.schemaVersion !== BROWSER_KEY_HIERARCHY_SCHEMA_VERSION ||
      wrapped.wrapperType !== expectedType || wrapped.rawKeyIncluded === true) {
    throw codedError('KEY_WRAPPER_INVALID');
  }
  const iv = bytes(wrapped.nonce, 'KEY_WRAPPER_NONCE_INVALID');
  const ciphertext = bytes(wrapped.ciphertext, 'KEY_WRAPPER_CIPHERTEXT_INVALID');
  if (iv.byteLength !== NONCE_BYTES || ciphertext.byteLength < 16) throw codedError('KEY_WRAPPER_INVALID');
  return { iv, ciphertext };
}

export async function generateDeviceKek(cryptoImpl = globalThis.crypto) {
  const crypto = requireCrypto(cryptoImpl);
  return crypto.subtle.generateKey({ name: AES_GCM, length: AES_KEY_LENGTH }, false, ['wrapKey', 'unwrapKey']);
}

export async function generateOwnerDek(cryptoImpl = globalThis.crypto, { extractable = true } = {}) {
  const crypto = requireCrypto(cryptoImpl);
  return crypto.subtle.generateKey({ name: AES_GCM, length: AES_KEY_LENGTH }, extractable, ['encrypt', 'decrypt']);
}

export async function wrapOwnerDekWithDeviceKek({ cryptoImpl = globalThis.crypto, ownerDek, deviceKek, aad }) {
  const crypto = requireCrypto(cryptoImpl);
  const transientOwnerDek = assertTransientOwnerDek(ownerDek);
  const wrappingKey = assertDeviceKek(deviceKek);
  const normalizedAad = requireAad(aad);
  const iv = nonce(crypto);
  const ciphertext = await crypto.subtle.wrapKey(
    'raw',
    transientOwnerDek,
    wrappingKey,
    { name: AES_GCM, iv, additionalData: encodeKeyAad(normalizedAad) }
  );
  return wrapperResult({ wrapperType: 'device', nonceValue: iv, ciphertext, aad: normalizedAad });
}

export async function unwrapOwnerDekWithDeviceKek({ cryptoImpl = globalThis.crypto, wrapped, deviceKek, aad, extractable = false }) {
  const crypto = requireCrypto(cryptoImpl);
  const wrapper = assertWrapper(wrapped, 'device');
  const wrappingKey = assertDeviceKek(deviceKek);
  const normalizedAad = requireAad(aad);
  return crypto.subtle.unwrapKey(
    'raw',
    wrapper.ciphertext,
    wrappingKey,
    { name: AES_GCM, iv: wrapper.iv, additionalData: encodeKeyAad(normalizedAad) },
    { name: AES_GCM },
    extractable === true,
    ['encrypt', 'decrypt']
  );
}

export async function deriveRecoveryKek({ cryptoImpl = globalThis.crypto, recoverySecret, salt, iterations = RECOVERY_KDF_ITERATIONS }) {
  const crypto = requireCrypto(cryptoImpl);
  const secretBytes = bytes(recoverySecret, 'RECOVERY_SECRET_INVALID');
  const saltBytes = bytes(salt, 'RECOVERY_SALT_INVALID');
  if (secretBytes.byteLength !== 32) throw codedError('RECOVERY_SECRET_INVALID');
  if (saltBytes.byteLength < MIN_SALT_BYTES) throw codedError('RECOVERY_SALT_INVALID');
  if (!Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 1000000) throw codedError('RECOVERY_KDF_INVALID');
  const baseKey = await crypto.subtle.importKey('raw', secretBytes, { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    { name: AES_GCM, length: AES_KEY_LENGTH },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

export async function wrapOwnerDekWithRecoveryKek({ cryptoImpl = globalThis.crypto, ownerDek, recoveryKek, aad }) {
  const crypto = requireCrypto(cryptoImpl);
  const transientOwnerDek = assertTransientOwnerDek(ownerDek);
  const wrappingKey = assertRecoveryKek(recoveryKek);
  const normalizedAad = requireAad(aad);
  const iv = nonce(crypto);
  const ciphertext = await crypto.subtle.wrapKey(
    'raw',
    transientOwnerDek,
    wrappingKey,
    { name: AES_GCM, iv, additionalData: encodeKeyAad(normalizedAad) }
  );
  return wrapperResult({ wrapperType: 'recovery', nonceValue: iv, ciphertext, aad: normalizedAad });
}

export async function unwrapOwnerDekWithRecoveryKek({ cryptoImpl = globalThis.crypto, wrapped, recoveryKek, aad, extractable = false }) {
  const crypto = requireCrypto(cryptoImpl);
  const wrapper = assertWrapper(wrapped, 'recovery');
  const wrappingKey = assertRecoveryKek(recoveryKek);
  const normalizedAad = requireAad(aad);
  return crypto.subtle.unwrapKey(
    'raw',
    wrapper.ciphertext,
    wrappingKey,
    { name: AES_GCM, iv: wrapper.iv, additionalData: encodeKeyAad(normalizedAad) },
    { name: AES_GCM },
    extractable === true,
    ['encrypt', 'decrypt']
  );
}

export function randomBytes(cryptoImpl = globalThis.crypto, length = 16) {
  const crypto = requireCrypto(cryptoImpl);
  if (!Number.isSafeInteger(length) || length < 1 || length > 1024) throw codedError('RANDOM_BYTES_LENGTH_INVALID');
  return crypto.getRandomValues(new Uint8Array(length));
}
