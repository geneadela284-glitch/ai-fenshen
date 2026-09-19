import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EntityFoundationError,
  immutableCopy
} from './inMemoryFoundationState.js';
import { assertScopedRealDataDatabaseLocation } from '../../core/safety/scopedRealDataAuthorization.js';

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function validateShadowDatabaseLocation({ shadowRoot, databasePath, repositoryRoot, realDataAccess = null }) {
  for (const [name, value] of Object.entries({ shadowRoot, databasePath, repositoryRoot })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new EntityFoundationError('SHADOW_PATH_INVALID', `${name} must be an absolute path.`);
    }
  }
  if (!fs.existsSync(shadowRoot) || !fs.statSync(shadowRoot).isDirectory()) {
    throw new EntityFoundationError('SHADOW_PATH_INVALID', 'shadowRoot must be an existing directory.');
  }
  const root = fs.realpathSync(shadowRoot);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const repository = fs.realpathSync(repositoryRoot);
  const parent = fs.realpathSync(path.dirname(databasePath));
  if (realDataAccess) {
    try {
      assertScopedRealDataDatabaseLocation({ ...realDataAccess, databasePath: path.resolve(databasePath) });
    } catch (error) {
      throw new EntityFoundationError('SCOPED_REAL_DATA_FAIL_CLOSED', error.message);
    }
    if (root !== parent || within(repository, root) || within(repository, path.resolve(databasePath))) {
      throw new EntityFoundationError('SCOPED_REAL_DATA_PATH_ESCAPE', 'Acceptance database must remain in its exact external runtime directory.');
    }
    if (fs.existsSync(databasePath) && fs.lstatSync(databasePath).isSymbolicLink()) {
      throw new EntityFoundationError('SHADOW_PATH_SYMLINK', 'Acceptance database cannot be a symbolic link.');
    }
    return path.resolve(databasePath);
  }
  if (!within(temporaryRoot, root) || !path.basename(root).startsWith('aiwc-entity-shadow-')) {
    throw new EntityFoundationError('SHADOW_PATH_NOT_TEMPORARY', 'shadowRoot must be a dedicated temporary directory.');
  }
  if (!within(root, parent) || within(repository, root) || within(repository, path.resolve(databasePath))) {
    throw new EntityFoundationError('SHADOW_PATH_ESCAPE', 'Shadow database must remain outside the repository.');
  }
  if (fs.existsSync(databasePath) && fs.lstatSync(databasePath).isSymbolicLink()) {
    throw new EntityFoundationError('SHADOW_PATH_SYMLINK', 'Shadow database cannot be a symbolic link.');
  }
  return path.resolve(databasePath);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function parsePayload(row) {
  return row ? immutableCopy(JSON.parse(row.payload_json)) : null;
}

export function assertConnectionAccess(holder, transactionToken = null) {
  if (holder.closed) throw new EntityFoundationError('SHADOW_DATABASE_CLOSED', 'Shadow database is closed.');
  if (holder.activeTransactionToken && holder.activeTransactionToken !== transactionToken) {
    throw new EntityFoundationError('UNIT_OF_WORK_IN_PROGRESS', 'A different Unit of Work owns the database connection.');
  }
}

export function encodeResult(value) {
  return JSON.stringify({ hasValue: value !== undefined, value: value === undefined ? null : value });
}

export function decodeResult(value) {
  const parsed = JSON.parse(value);
  return parsed.hasValue ? immutableCopy(parsed.value) : undefined;
}

export function runSQLiteIdempotent(holder, namespace, ownerUserId, idempotencyKey, payload, operation) {
  if (idempotencyKey === undefined || idempotencyKey === null) return operation();
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new EntityFoundationError('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must be a non-empty string.');
  }
  const payloadDigest = digest(payload);
  const existing = holder.db.prepare(`
    SELECT payload_sha256, result_json FROM entity_idempotency
    WHERE owner_user_id = ? AND namespace = ? AND idempotency_key = ?
  `).get(ownerUserId, namespace, idempotencyKey);
  if (existing) {
    if (existing.payload_sha256 !== payloadDigest) {
      throw new EntityFoundationError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for a different payload.');
    }
    return decodeResult(existing.result_json);
  }
  holder.savepointSequence += 1;
  const savepoint = `entity_idempotency_${holder.savepointSequence}`;
  holder.db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    holder.db.prepare(`
      INSERT INTO entity_idempotency
        (owner_user_id, namespace, idempotency_key, payload_sha256, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(ownerUserId, namespace, idempotencyKey, payloadDigest, encodeResult(result));
    holder.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return immutableCopy(result);
  } catch (error) {
    try { holder.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); } finally {
      holder.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    }
    throw error;
  }
}

export function sqliteWriteError(error, fallbackCode, fallbackMessage) {
  const message = String(error?.message || '');
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new EntityFoundationError('FOREIGN_KEY_CONSTRAINT', 'Owner-scoped Entity foreign key was rejected.');
  }
  if (/UNIQUE constraint failed: entities\.owner_user_id/i.test(message)) {
    return new EntityFoundationError('SELF_ENTITY_CONFLICT', 'Owner already has an active self Entity.');
  }
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(message)) {
    return new EntityFoundationError(fallbackCode, fallbackMessage);
  }
  return error;
}
