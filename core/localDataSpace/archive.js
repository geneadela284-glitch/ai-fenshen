import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

import { decryptBytes, encryptBytes, keyId } from './crypto.js';
import { DATA_SPACE_DIRECTORIES, validateManifest } from './manifest.js';
import { withProviderDataKey } from './keyProvider.js';
import { assertTrustedOwnerContext, ownerHash, safeRelativePath } from './ownerContext.js';

export const ARCHIVE_SCHEMA_VERSION = 'local-data-space-archive-v1';

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

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function archiveAad(ownerHashValue, spaceId) {
  return `${ownerHashValue}\u0000${spaceId}\u0000archive`;
}

function filesUnder(rootDirectory, relative = '') {
  const directory = path.join(rootDirectory, relative);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw error('ARCHIVE_SYMLINK_FORBIDDEN');
    if (entry.isDirectory()) return filesUnder(rootDirectory, entryRelative);
    if (!entry.isFile() || entry.name.includes('.tmp-')) return [];
    return [safeRelativePath(entryRelative)];
  });
}

function readOuter(archivePath) {
  try {
    const outer = JSON.parse(readFileSync(path.resolve(required(archivePath, 'ARCHIVE_PATH_REQUIRED')), 'utf8'));
    if (!outer || typeof outer !== 'object' || Array.isArray(outer)) throw new Error('invalid');
    return outer;
  } catch {
    throw error('ARCHIVE_INVALID');
  }
}

function validateEntries(entries) {
  if (!Array.isArray(entries)) throw error('ARCHIVE_INVALID');
  const seen = new Set();
  return entries.map((entry) => {
    const relativePath = safeRelativePath(entry?.path);
    if (seen.has(relativePath)) throw error('ARCHIVE_DUPLICATE_PATH');
    seen.add(relativePath);
    let bytes;
    try { bytes = Buffer.from(String(entry?.bytes || ''), 'base64'); } catch { throw error('ARCHIVE_INVALID'); }
    if (hash(bytes) !== entry?.sha256) throw error('ARCHIVE_CHECKSUM_INVALID');
    return { path: relativePath, bytes, sha256: entry.sha256, mode: Number(entry.mode || 0o600) & 0o600 };
  });
}

function ownerScopedDestination(destination, ownerId) {
  const expectedHash = ownerHash(ownerId);
  return destination.split(path.sep).some((segment) => (
    segment === expectedHash || segment === `owner-${expectedHash}`
  ));
}

function decodeArchive(outer, { ownerId, dataKey }) {
  if (outer.version !== ARCHIVE_SCHEMA_VERSION || outer.encrypted !== true) throw error('ARCHIVE_INVALID');
  if (outer.ownerHash !== ownerHash(ownerId)) throw error('OWNER_MISMATCH');
  if (!outer.spaceId || outer.keyId !== keyId(dataKey)) throw error('KEY_MISMATCH');
  if (!outer.keyWrapping || outer.keyWrapping.rawKeyIncluded === true) throw error('KEY_RECOVERY_INVALID');
  let body;
  try {
    body = JSON.parse(decryptBytes(outer.body, dataKey, { aad: archiveAad(outer.ownerHash, outer.spaceId) }).toString('utf8'));
  } catch {
    throw error('AUTHENTICATION_FAILED');
  }
  if (!body?.manifest || body.manifest.spaceId !== outer.spaceId) throw error('ARCHIVE_INVALID');
  const manifestCheck = validateManifest(body.manifest, { ownerId, dataKey });
  if (!manifestCheck.valid) throw Object.assign(error('ARCHIVE_INVALID'), { details: manifestCheck.errors });
  const entries = validateEntries(body.entries);
  if (Number(body.fileCount) !== entries.length) throw error('ARCHIVE_INVALID');
  return { outer, body, entries };
}

function validateDestinationRoot(rootDirectory) {
  const root = path.resolve(required(rootDirectory, 'DATA_ROOT_INVALID'));
  if (root === path.parse(root).root) throw error('DATA_ROOT_INVALID');
  return root;
}

function writeEntry(staging, entry) {
  const filePath = path.resolve(staging, entry.path);
  const relative = path.relative(staging, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw error('PATH_INVALID');
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, entry.bytes, { mode: entry.mode });
  if (hash(readFileSync(filePath)) !== entry.sha256) throw error('ARCHIVE_CHECKSUM_INVALID');
}

export async function exportEncryptedArchive({
  sourceRoot,
  ownerId,
  manifest,
  dataKey,
  destinationPath,
  keyWrapping = null,
  createdAt = new Date().toISOString()
} = {}) {
  const root = path.resolve(required(sourceRoot, 'ARCHIVE_SOURCE_REQUIRED'));
  const destination = path.resolve(required(destinationPath, 'ARCHIVE_DESTINATION_REQUIRED'));
  if (!existsSync(root) || !statSync(root).isDirectory()) throw error('ARCHIVE_SOURCE_INVALID');
  if (!ownerScopedDestination(destination, ownerId)) throw error('ARCHIVE_DESTINATION_OWNER_SCOPE');
  if (existsSync(destination)) throw error('ARCHIVE_DESTINATION_EXISTS');
  const manifestCheck = validateManifest(manifest, { ownerId, dataKey });
  if (!manifestCheck.valid) throw Object.assign(error('ARCHIVE_INVALID'), { details: manifestCheck.errors });
  const entries = filesUnder(root).map((relativePath) => {
    const bytes = readFileSync(path.join(root, relativePath));
    return { path: relativePath, bytes: bytes.toString('base64'), sha256: hash(bytes), mode: 0o600 };
  });
  const body = {
    manifest,
    directories: [...DATA_SPACE_DIRECTORIES],
    entries,
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + Buffer.byteLength(entry.bytes, 'base64'), 0)
  };
  const owner = ownerHash(ownerId);
  const outer = {
    version: ARCHIVE_SCHEMA_VERSION,
    encrypted: true,
    algorithm: 'aes-256-gcm',
    ownerHash: owner,
    spaceId: manifest.spaceId,
    keyId: keyId(dataKey),
    createdAt,
    keyWrapping: keyWrapping || { mode: 'provider-key-id', keyId: keyId(dataKey), rawKeyIncluded: false },
    body: encryptBytes(Buffer.from(JSON.stringify(body), 'utf8'), dataKey, { aad: archiveAad(owner, manifest.spaceId) })
  };
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(outer)}\n`, { mode: 0o600 });
    renameSync(temporary, destination);
  } catch (caught) {
    try { rmSync(temporary, { force: true }); } catch { /* cleanup is best effort */ }
    throw caught;
  }
  return Object.freeze({ encrypted: true, format: ARCHIVE_SCHEMA_VERSION, fileCount: entries.length, totalBytes: body.totalBytes, path: destination });
}

export async function restoreEncryptedArchive({ archivePath, destinationRoot, ownerContext, keyProvider, recoveryKey } = {}) {
  const trusted = assertTrustedOwnerContext(ownerContext);
  const outer = readOuter(archivePath);
  if (outer.ownerHash !== ownerHash(trusted.ownerId)) throw error('OWNER_MISMATCH');
  const spaceId = required(outer.spaceId, 'ARCHIVE_INVALID');
  let keyReference;
  if (outer.keyWrapping?.mode === 'user-recovery-key') {
    if (recoveryKey === undefined || typeof keyProvider?.restoreFromRecovery !== 'function') throw error('KEY_RECOVERY_UNAVAILABLE');
    keyReference = await keyProvider.restoreFromRecovery({
      ownerId: trusted.ownerId,
      spaceId,
      recoveryPackage: outer.keyWrapping,
      recoveryKey
    });
  } else {
    keyReference = await keyProvider.getDataKey({ ownerId: trusted.ownerId, spaceId });
  }
  const decoded = await withProviderDataKey(
    keyProvider,
    { ownerId: trusted.ownerId, spaceId, keyHandle: keyReference },
    (dataKey) => decodeArchive(outer, { ownerId: trusted.ownerId, dataKey })
  );
  const root = validateDestinationRoot(destinationRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.resolve(root, `owner-${ownerHash(trusted.ownerId)}`);
  if (existsSync(target)) {
    const existingManifestPath = path.join(target, 'manifest.json');
    try {
      const existingManifest = JSON.parse(readFileSync(existingManifestPath, 'utf8'));
      if (existingManifest.spaceId === decoded.body.manifest.spaceId && existingManifest.keyId === decoded.body.manifest.keyId) {
        return Object.freeze({ target, manifest: decoded.body.manifest, restoreIdempotent: true });
      }
    } catch {
      // An existing malformed target is never silently replaced.
    }
    throw error('RESTORE_TARGET_EXISTS');
  }
  const staging = path.join(root, `.local-data-space-restore-${randomUUID()}`);
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const directory of DATA_SPACE_DIRECTORIES) mkdirSync(path.join(staging, directory), { recursive: true, mode: 0o700 });
    for (const entry of decoded.entries) writeEntry(staging, entry);
    renameSync(staging, target);
    return Object.freeze({ target, manifest: decoded.body.manifest, restoreIdempotent: false });
  } catch (caught) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* cleanup is best effort */ }
    throw caught;
  }
}
