export const PORTABLE_RECOVERY_CREDENTIAL_SCHEMA = 'meeting-v1-portable-recovery-credential';
export const PORTABLE_RECOVERY_CREDENTIAL_VERSION = 1;
export const PORTABLE_RECOVERY_CREDENTIAL_PREFIX = 'mrc1';
export const PORTABLE_RECOVERY_CREDENTIAL_TTL_MS = 90 * 60 * 1000;

const TEXT_ENCODER = new TextEncoder();
const LEGACY_RECOVERY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
  return cryptoImpl;
}

function bytes(value, code = 'RECOVERY_SECRET_INVALID') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError(code);
}

function base64url(value) {
  const source = bytes(value, 'PORTABLE_RECOVERY_CREDENTIAL_INVALID');
  let binary = '';
  for (const item of source) binary += String.fromCharCode(item);
  const encoder = globalThis.btoa || ((input) => Buffer.from(input, 'binary').toString('base64'));
  return encoder(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value, code = 'PORTABLE_RECOVERY_CREDENTIAL_INVALID') {
  const normalized = String(value || '');
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) throw codedError(code);
  const padded = normalized.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    if (globalThis.atob) return Uint8Array.from(globalThis.atob(padded), (item) => item.charCodeAt(0));
    return new Uint8Array(Buffer.from(padded, 'base64'));
  } catch {
    throw codedError(code);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function digestCanonical(cryptoImpl, value) {
  const digest = await requireCrypto(cryptoImpl).subtle.digest('SHA-256', TEXT_ENCODER.encode(canonicalize(value)));
  return new Uint8Array(digest);
}

function dateMs(value, code) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw codedError(code);
  return parsed;
}

function randomCredentialId(cryptoImpl) {
  return `recovery-${base64url(requireCrypto(cryptoImpl).getRandomValues(new Uint8Array(18)))}`;
}

function assertPackage(recoveryPackage) {
  if (!recoveryPackage || typeof recoveryPackage !== 'object' || Array.isArray(recoveryPackage) ||
      recoveryPackage.rawKeyIncluded === true || recoveryPackage.recoverySecret || recoveryPackage.ownerDek ||
      recoveryPackage.ownerDekBytes || recoveryPackage.deviceKey) {
    throw codedError('PORTABLE_RECOVERY_CREDENTIAL_PACKAGE_INVALID');
  }
  const wrapper = recoveryPackage.recoveryWrapper;
  const recoveryKdf = recoveryPackage.recoveryKdf;
  if (recoveryPackage.version !== 'browser-recovery-v2' ||
      recoveryPackage.schemaVersion !== 'browser-key-hierarchy-v2' ||
      !recoveryPackage.ownerHash || !recoveryPackage.spaceId || !recoveryPackage.keyId ||
      !Number.isSafeInteger(recoveryPackage.keyVersion) || recoveryPackage.keyVersion < 1 ||
      !recoveryPackage.sourceDeviceId ||
      !recoveryKdf || recoveryKdf.name !== 'PBKDF2-SHA-256' || recoveryKdf.hash !== 'SHA-256' ||
      !Number.isSafeInteger(recoveryKdf.iterations) || recoveryKdf.iterations < 100000 ||
      !recoveryKdf.salt ||
      !wrapper || wrapper.schemaVersion !== 'browser-key-hierarchy-v2' || wrapper.wrapperType !== 'recovery' ||
      wrapper.rawKeyIncluded === true || !wrapper.nonce || !wrapper.ciphertext) {
    throw codedError('PORTABLE_RECOVERY_CREDENTIAL_PACKAGE_INVALID');
  }
  return recoveryPackage;
}

function assertSecret(recoverySecret) {
  const secret = bytes(recoverySecret);
  if (secret.byteLength !== 32) throw codedError('RECOVERY_SECRET_INVALID');
  return secret;
}

function fixtureToEnvelope(fixture) {
  if (!fixture) return null;
  if (!fixture || typeof fixture !== 'object' || fixture.plaintext || fixture.rawKeyIncluded === true ||
      !fixture.nonce || !fixture.ciphertext || !fixture.aad) {
    throw codedError('PORTABLE_RECOVERY_CREDENTIAL_FIXTURE_INVALID');
  }
  const plaintextDigest = fixture.plaintextDigest ? String(fixture.plaintextDigest).toLowerCase() : '';
  if (plaintextDigest && !/^[0-9a-f]{64}$/.test(plaintextDigest)) {
    throw codedError('PORTABLE_RECOVERY_CREDENTIAL_FIXTURE_INVALID');
  }
  return Object.freeze({
    nonce: base64url(fixture.nonce),
    ciphertext: base64url(fixture.ciphertext),
    aad: String(fixture.aad),
    rawKeyIncluded: false,
    ...(plaintextDigest ? { plaintextDigest } : {})
  });
}

function fixtureFromEnvelope(fixture) {
  if (!fixture) return null;
  if (typeof fixture !== 'object' || fixture.rawKeyIncluded === true || !fixture.nonce || !fixture.ciphertext || !fixture.aad) {
    throw codedError('PORTABLE_RECOVERY_CREDENTIAL_FIXTURE_INVALID');
  }
  const plaintextDigest = fixture.plaintextDigest ? String(fixture.plaintextDigest).toLowerCase() : '';
  if (plaintextDigest && !/^[0-9a-f]{64}$/.test(plaintextDigest)) {
    throw codedError('PORTABLE_RECOVERY_CREDENTIAL_FIXTURE_INVALID');
  }
  return Object.freeze({
    nonce: fromBase64url(fixture.nonce, 'PORTABLE_RECOVERY_CREDENTIAL_FIXTURE_INVALID'),
    ciphertext: fromBase64url(fixture.ciphertext, 'PORTABLE_RECOVERY_CREDENTIAL_FIXTURE_INVALID'),
    aad: String(fixture.aad),
    rawKeyIncluded: false,
    ...(plaintextDigest ? { plaintextDigest } : {})
  });
}

function unsignedEnvelope(envelope) {
  const { integrity: _integrity, ...unsigned } = envelope;
  return unsigned;
}

function constantTimeEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function isPortableRecoveryCredentialFormat(value) {
  return new RegExp(`^${PORTABLE_RECOVERY_CREDENTIAL_PREFIX}\\.[A-Za-z0-9_-]+$`).test(String(value || '').trim());
}

export function isLegacyRecoverySecret(value) {
  return LEGACY_RECOVERY_SECRET_PATTERN.test(String(value || '').trim());
}

export async function serializePortableRecoveryCredential({
  cryptoImpl = globalThis.crypto,
  recoveryPackage,
  recoverySecret,
  validationFixture = null,
  credentialId = '',
  issuedAt = new Date().toISOString(),
  expiresAt = ''
} = {}) {
  const crypto = requireCrypto(cryptoImpl);
  const packageValue = assertPackage(recoveryPackage);
  const secret = assertSecret(recoverySecret);
  const issuedMs = dateMs(issuedAt, 'PORTABLE_RECOVERY_CREDENTIAL_ISSUED_AT_INVALID');
  const expiryMs = expiresAt ? dateMs(expiresAt, 'PORTABLE_RECOVERY_CREDENTIAL_EXPIRES_AT_INVALID') : issuedMs + PORTABLE_RECOVERY_CREDENTIAL_TTL_MS;
  if (expiryMs <= issuedMs) throw codedError('PORTABLE_RECOVERY_CREDENTIAL_EXPIRY_INVALID');
  const ownerHash = String(packageValue.ownerHash).trim();
  const spaceId = String(packageValue.spaceId).trim();
  const envelope = {
    schema: PORTABLE_RECOVERY_CREDENTIAL_SCHEMA,
    version: PORTABLE_RECOVERY_CREDENTIAL_VERSION,
    credentialId: String(credentialId || randomCredentialId(crypto)).trim(),
    ownerHash,
    spaceId,
    keyId: packageValue.keyId,
    keyVersion: packageValue.keyVersion,
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiryMs).toISOString(),
    oneTimeUse: true,
    algorithms: {
      keyDerivation: packageValue.recoveryKdf.name,
      keyDerivationHash: packageValue.recoveryKdf.hash,
      wrapping: 'AES-256-GCM',
      integrity: 'SHA-256'
    },
    recoverySecret: base64url(secret),
    recoveryPackage: packageValue,
    validationFixture: fixtureToEnvelope(validationFixture)
  };
  const integrity = base64url(await digestCanonical(crypto, envelope));
  const signedEnvelope = { ...envelope, integrity: { algorithm: 'SHA-256', value: integrity } };
  return `${PORTABLE_RECOVERY_CREDENTIAL_PREFIX}.${base64url(TEXT_ENCODER.encode(JSON.stringify(signedEnvelope)))}`;
}

export async function parsePortableRecoveryCredential({
  cryptoImpl = globalThis.crypto,
  credential,
  expectedOwnerHash = '',
  expectedSpaceId = '',
  now = new Date().toISOString()
} = {}) {
  const normalized = String(credential || '').trim();
  if (isLegacyRecoverySecret(normalized)) throw codedError('EXISTING_CREDENTIAL_NOT_PORTABLE');
  if (!isPortableRecoveryCredentialFormat(normalized)) throw codedError('RECOVERY_CREDENTIAL_FORMAT_INVALID');
  const parts = normalized.split('.');
  if (parts.length !== 2) throw codedError('RECOVERY_CREDENTIAL_FORMAT_INVALID');
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
  } catch {
    throw codedError('PORTABLE_RECOVERY_CREDENTIAL_INVALID');
  }
  if (!envelope || envelope.schema !== PORTABLE_RECOVERY_CREDENTIAL_SCHEMA || envelope.version !== PORTABLE_RECOVERY_CREDENTIAL_VERSION) {
    throw codedError('RECOVERY_CREDENTIAL_SCHEMA_VERSION_MISMATCH');
  }
  if (!envelope.integrity || envelope.integrity.algorithm !== 'SHA-256' || !/^[A-Za-z0-9_-]+$/.test(envelope.integrity.value || '')) {
    throw codedError('RECOVERY_CREDENTIAL_INTEGRITY_INVALID');
  }
  const actualIntegrity = await digestCanonical(cryptoImpl, unsignedEnvelope(envelope));
  const expectedIntegrity = fromBase64url(envelope.integrity.value, 'RECOVERY_CREDENTIAL_INTEGRITY_INVALID');
  if (!constantTimeEqual(actualIntegrity, expectedIntegrity)) throw codedError('RECOVERY_CREDENTIAL_INTEGRITY_INVALID');
  if (!envelope.credentialId || !envelope.ownerHash || !envelope.spaceId || envelope.oneTimeUse !== true) {
    throw codedError('PORTABLE_RECOVERY_CREDENTIAL_INVALID');
  }
  if (expectedOwnerHash && envelope.ownerHash !== expectedOwnerHash) throw codedError('RECOVERY_CREDENTIAL_OWNER_MISMATCH');
  if (expectedSpaceId && envelope.spaceId !== expectedSpaceId) throw codedError('RECOVERY_CREDENTIAL_SPACE_MISMATCH');
  const nowMs = dateMs(now, 'RECOVERY_CREDENTIAL_CLOCK_INVALID');
  const expiresMs = dateMs(envelope.expiresAt, 'PORTABLE_RECOVERY_CREDENTIAL_EXPIRES_AT_INVALID');
  if (nowMs >= expiresMs) throw codedError('RECOVERY_CREDENTIAL_EXPIRED');
  const packageValue = assertPackage(envelope.recoveryPackage);
  if (packageValue.ownerHash !== envelope.ownerHash || packageValue.spaceId !== envelope.spaceId ||
      packageValue.keyId !== envelope.keyId || packageValue.keyVersion !== envelope.keyVersion) {
    throw codedError('RECOVERY_CREDENTIAL_PACKAGE_BINDING_MISMATCH');
  }
  const secret = assertSecret(fromBase64url(envelope.recoverySecret, 'RECOVERY_SECRET_INVALID'));
  return Object.freeze({
    credentialId: String(envelope.credentialId),
    ownerHash: String(envelope.ownerHash),
    spaceId: String(envelope.spaceId),
    keyId: String(envelope.keyId),
    keyVersion: Number(envelope.keyVersion),
    issuedAt: String(envelope.issuedAt),
    expiresAt: String(envelope.expiresAt),
    oneTimeUse: true,
    algorithms: Object.freeze({ ...envelope.algorithms }),
    recoveryPackage: packageValue,
    recoverySecret: secret,
    validationFixture: fixtureFromEnvelope(envelope.validationFixture)
  });
}
