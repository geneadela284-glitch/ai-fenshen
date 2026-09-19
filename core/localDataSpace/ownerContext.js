import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const OWNER_CONTEXT_VERSION = 'owner-context-v1';
export const OWNER_CONTEXT_TRUST = Symbol('trusted-owner-context');

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

function signingPayload({ version, ownerId, role, sessionId, issuedAt }) {
  return [version, ownerId, role, sessionId, issuedAt].map((value) => String(value || '')).join('\u0000');
}

function signatureFor(payload, secret) {
  const value = String(secret || '');
  if (value.length < 32) throw codedError('OWNER_CONTEXT_SIGNING_SECRET_INVALID');
  return createHmac('sha256', value).update(payload).digest('base64url');
}

export function ownerHash(ownerId) {
  return createHash('sha256').update(`owner:${required(ownerId, 'OWNER_REQUIRED')}`).digest('hex');
}

export function ownerLocator(ownerId) {
  return `owner-${ownerHash(ownerId)}`;
}

export function safeRelativePath(value) {
  const input = String(value ?? '');
  if (!input || input.includes('\u0000') || input.includes('\\') || path.posix.isAbsolute(input)) {
    throw codedError('PATH_INVALID');
  }
  const segments = input.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) throw codedError('PATH_INVALID');
  const normalized = path.posix.normalize(input);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw codedError('PATH_INVALID');
  }
  return normalized;
}

// This fixture is intentionally only used by synthetic tests. Production callers
// must receive a server-trusted context from the authenticated Session boundary.
export function createSignedTestOwnerContext({ ownerId, secret, sessionId = 'fixture-session', role = 'user', issuedAt = new Date().toISOString() } = {}) {
  const owner = required(ownerId, 'OWNER_REQUIRED');
  const normalizedRole = required(role, 'OWNER_ROLE_REQUIRED');
  const session = required(sessionId, 'OWNER_SESSION_REQUIRED');
  const timestamp = required(issuedAt, 'OWNER_CONTEXT_TIME_REQUIRED');
  const version = OWNER_CONTEXT_VERSION;
  return Object.freeze({
    version,
    ownerId: owner,
    role: normalizedRole,
    sessionId: session,
    issuedAt: timestamp,
    signature: signatureFor(signingPayload({ version, ownerId: owner, role: normalizedRole, sessionId: session, issuedAt: timestamp }), secret)
  });
}

export function verifyOwnerContext(context, { secret, clock = () => new Date(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!context || typeof context !== 'object' || context.version !== OWNER_CONTEXT_VERSION) {
    throw codedError('OWNER_CONTEXT_INVALID');
  }
  try {
    const ownerId = required(context.ownerId, 'OWNER_REQUIRED');
    const role = required(context.role, 'OWNER_ROLE_REQUIRED');
    const sessionId = required(context.sessionId, 'OWNER_SESSION_REQUIRED');
    const issuedAt = required(context.issuedAt, 'OWNER_CONTEXT_TIME_REQUIRED');
    const expected = signatureFor(signingPayload({
      version: OWNER_CONTEXT_VERSION,
      ownerId,
      role,
      sessionId,
      issuedAt
    }), secret);
    const actualBytes = Buffer.from(String(context.signature || ''), 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw codedError('OWNER_CONTEXT_INVALID');
    }
    const age = Math.abs(new Date(clock()).getTime() - new Date(issuedAt).getTime());
    if (!Number.isFinite(age) || age > Number(maxAgeMs)) throw codedError('OWNER_CONTEXT_EXPIRED');
    const verified = { version: OWNER_CONTEXT_VERSION, ownerId, role, sessionId, issuedAt };
    Object.defineProperty(verified, OWNER_CONTEXT_TRUST, { value: true, enumerable: false });
    return Object.freeze(verified);
  } catch (error) {
    if (error?.code === 'OWNER_CONTEXT_EXPIRED') throw error;
    throw codedError('OWNER_CONTEXT_INVALID');
  }
}

export function assertTrustedOwnerContext(context) {
  if (!context || typeof context !== 'object' || context[OWNER_CONTEXT_TRUST] !== true) {
    throw codedError('OWNER_CONTEXT_UNTRUSTED');
  }
  required(context.ownerId, 'OWNER_REQUIRED');
  return context;
}
