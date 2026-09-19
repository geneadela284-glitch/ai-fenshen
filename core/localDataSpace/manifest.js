import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { keyId } from './crypto.js';
import { assertTrustedOwnerContext, ownerHash, ownerLocator } from './ownerContext.js';

export const MANIFEST_SCHEMA_VERSION = 'local-data-space-manifest-v1';

// This directory contract is kept compatible with the Local Data Space
// prototype. Phase 0 only writes meetings, index, queue, backups, exports and
// tmp; the remaining directories reserve the same owner-scoped data space.
export const DATA_SPACE_DIRECTORIES = Object.freeze([
  'memory', 'conversations', 'documents', 'index', 'attachments',
  'generated-images', 'meetings', 'finance', 'diary', 'backups',
  'exports', 'queue', 'tmp'
]);

function error(code) {
  const value = new Error(code);
  value.code = code;
  return value;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw error(code);
  return normalized;
}

function signaturePayload(manifest) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    spaceId: manifest.spaceId,
    ownerHash: manifest.ownerHash,
    keyId: manifest.keyId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    encryption: manifest.encryption,
    directories: manifest.directories
  });
}

function signature(manifest, dataKey) {
  return createHmac('sha256', Buffer.from(dataKey)).update(signaturePayload(manifest)).digest('base64url');
}

function sameSignature(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function iso(value, code) {
  const normalized = new Date(value).toISOString();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw error(code);
  return normalized;
}

export function resolveOwnerSpacePath(rootDirectory, ownerContext) {
  const trusted = assertTrustedOwnerContext(ownerContext);
  const root = path.resolve(required(rootDirectory, 'DATA_ROOT_INVALID'));
  if (root === path.parse(root).root) throw error('DATA_ROOT_INVALID');
  return path.resolve(root, ownerLocator(trusted.ownerId));
}

export function ensureDataSpaceLayout(rootDirectory, ownerContext) {
  const spacePath = resolveOwnerSpacePath(rootDirectory, ownerContext);
  mkdirSync(spacePath, { recursive: true, mode: 0o700 });
  for (const directory of DATA_SPACE_DIRECTORIES) {
    mkdirSync(path.join(spacePath, directory), { recursive: true, mode: 0o700 });
  }
  const manifestPath = path.join(spacePath, 'manifest.json');
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, '{"state":"initializing"}\n', { mode: 0o600 });
  return spacePath;
}

export function createManifest({
  ownerContext,
  spaceId = randomUUID(),
  dataKey,
  createdAt = new Date().toISOString(),
  updatedAt = createdAt
} = {}) {
  const trusted = assertTrustedOwnerContext(ownerContext);
  const normalizedSpaceId = required(spaceId, 'SPACE_ID_REQUIRED');
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    spaceId: normalizedSpaceId,
    ownerHash: ownerHash(trusted.ownerId),
    keyId: keyId(dataKey),
    createdAt: iso(createdAt, 'MANIFEST_CREATED_AT_INVALID'),
    updatedAt: iso(updatedAt, 'MANIFEST_UPDATED_AT_INVALID'),
    encryption: {
      payload: 'aes-256-gcm',
      keyBytes: 32,
      database: 'encrypted-record-payloads',
      fts: 'transient-memory-only'
    },
    directories: [...DATA_SPACE_DIRECTORIES],
    signature: ''
  };
  manifest.signature = signature(manifest, dataKey);
  return Object.freeze(manifest);
}

export function validateManifest(manifest, { ownerId, dataKey } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: [{ code: 'MANIFEST_INVALID' }] };
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) errors.push({ code: 'MANIFEST_SCHEMA_VERSION_INVALID' });
  if (!manifest.spaceId || !manifest.ownerHash || !manifest.keyId || !manifest.signature) errors.push({ code: 'MANIFEST_FIELDS_INVALID' });
  if (ownerId && manifest.ownerHash !== ownerHash(ownerId)) errors.push({ code: 'MANIFEST_OWNER_MISMATCH' });
  if (dataKey) {
    try {
      if (manifest.keyId !== keyId(dataKey)) errors.push({ code: 'MANIFEST_KEY_MISMATCH' });
      if (!sameSignature(manifest.signature, signature(manifest, dataKey))) errors.push({ code: 'MANIFEST_SIGNATURE_INVALID' });
    } catch {
      errors.push({ code: 'MANIFEST_KEY_INVALID' });
    }
  }
  if (JSON.stringify(manifest.directories || []) !== JSON.stringify(DATA_SPACE_DIRECTORIES)) errors.push({ code: 'MANIFEST_DIRECTORIES_INVALID' });
  if (manifest.encryption?.payload !== 'aes-256-gcm' || manifest.encryption?.keyBytes !== 32) errors.push({ code: 'MANIFEST_ENCRYPTION_INVALID' });
  if (Object.hasOwn(manifest, 'dataKey') || Object.hasOwn(manifest, 'ownerId')) errors.push({ code: 'MANIFEST_SECRET_OR_IDENTITY_LEAK' });
  return { valid: errors.length === 0, errors };
}

export function manifestSignatureForTest(manifest, dataKey) {
  return signature(manifest, dataKey);
}
