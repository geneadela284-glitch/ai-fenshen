import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const AEAD_ALGORITHM = 'aes-256-gcm';
export const DATA_KEY_BYTES = 32;
export const AEAD_NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;
export const ENCRYPTED_PAYLOAD_VERSION = 'aead-payload-v1';

function error(code) {
  const value = new Error(code);
  value.code = code;
  return value;
}

function bytes(value, code = 'KEY_INVALID') {
  const result = Buffer.isBuffer(value) ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!result || result.length !== DATA_KEY_BYTES) throw error(code);
  return result;
}

function aadBytes(aad = '') {
  return Buffer.from(String(aad ?? ''), 'utf8');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function keyId(key) {
  return `key-${digest(bytes(key)).slice(0, 24)}`;
}

export function encryptBytes(plaintext, key, { aad = '' } = {}) {
  const dataKey = bytes(key);
  const nonce = randomBytes(AEAD_NONCE_BYTES);
  const associatedData = aadBytes(aad);
  const cipher = createCipheriv(AEAD_ALGORITHM, dataKey, nonce, { authTagLength: AEAD_TAG_BYTES });
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Object.freeze({
    version: ENCRYPTED_PAYLOAD_VERSION,
    algorithm: AEAD_ALGORITHM,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
    aadHash: digest(associatedData)
  });
}

export function decryptBytes(envelope, key, { aad = '' } = {}) {
  try {
    if (!envelope || envelope.version !== ENCRYPTED_PAYLOAD_VERSION || envelope.algorithm !== AEAD_ALGORITHM) throw error('AUTHENTICATION_FAILED');
    const associatedData = aadBytes(aad);
    if (envelope.aadHash !== digest(associatedData)) throw error('AUTHENTICATION_FAILED');
    const dataKey = bytes(key);
    const nonce = Buffer.from(String(envelope.nonce || ''), 'base64');
    const tag = Buffer.from(String(envelope.tag || ''), 'base64');
    if (nonce.length !== AEAD_NONCE_BYTES || tag.length !== AEAD_TAG_BYTES) throw error('AUTHENTICATION_FAILED');
    const decipher = createDecipheriv(AEAD_ALGORITHM, dataKey, nonce, { authTagLength: AEAD_TAG_BYTES });
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(String(envelope.ciphertext || ''), 'base64')), decipher.final()]);
  } catch {
    throw error('AUTHENTICATION_FAILED');
  }
}
