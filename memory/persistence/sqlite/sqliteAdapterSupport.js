import path from 'node:path';

import { validateMemoryRecord } from '../../kernel/index.js';
import { PersistenceError, persistenceError } from '../errors.js';

export function freezeClone(value) {
  const output = structuredClone(value);
  const pending = [output];
  while (pending.length) {
    const current = pending.pop();
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      Object.freeze(current);
      pending.push(...Object.values(current));
    }
  }
  return output;
}

export function nowIso(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function assertKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
}

export function assertUserId(userId) {
  if (typeof userId !== 'string' || !userId.trim()) throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
}

export function encodeCursor(offset, scope) {
  return Buffer.from(JSON.stringify({ v: 1, offset, scope })).toString('base64url');
}

export function decodeCursor(cursor, scope) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value?.v !== 1 || value.scope !== scope || !Number.isInteger(value.offset) || value.offset < 0) {
      throw new Error('invalid');
    }
    return value.offset;
  } catch {
    throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
  }
}

export function parseJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

export function memoryRecordFromRow(row) {
  const record = {
    id: row.id,
    schemaVersion: row.schema_version,
    userId: row.user_id,
    memoryType: row.memory_type,
    subject: parseJson(row.subject_json),
    predicate: row.predicate,
    value: parseJson(row.value_json),
    normalizedValue: parseJson(row.normalized_value_json),
    source: { type: row.source_type, id: row.source_id },
    sourceTimestamp: row.source_timestamp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    confidence: row.confidence,
    importance: row.importance,
    sensitivity: row.sensitivity,
    status: row.status,
    confirmationStatus: row.confirmation_status,
    expiresAt: row.expires_at,
    version: row.version,
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
    conflictGroupId: row.conflict_group_id,
    retentionPolicy: parseJson(row.retention_policy),
    accessPolicy: parseJson(row.access_policy),
    checksum: row.checksum,
    tags: parseJson(row.tags_json),
    metadata: parseJson(row.metadata_json)
  };
  for (const field of ['checksum', 'tags']) {
    if (record[field] === null) delete record[field];
  }
  const validation = validateMemoryRecord(record, { trustedUserId: record.userId });
  if (!validation.valid) throw persistenceError('PERSISTENCE_CORRUPT');
  return record;
}

export function memoryRecordParameters(record) {
  const validation = validateMemoryRecord(record, { trustedUserId: record.userId });
  if (!validation.valid) throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
  const recycle = record.metadata?.recycleBin || {};
  return [
    record.id, record.schemaVersion, record.userId, record.memoryType,
    JSON.stringify(record.subject), record.predicate, JSON.stringify(record.value),
    JSON.stringify(record.normalizedValue), null, record.source.type, record.source.id,
    record.sourceTimestamp, record.createdAt, record.updatedAt, record.effectiveFrom,
    record.effectiveTo ?? null, record.confidence, record.importance, record.sensitivity,
    record.status, record.confirmationStatus, record.expiresAt ?? null,
    record.supersedesId ?? null, record.supersededById ?? null, record.conflictGroupId ?? null,
    JSON.stringify(record.retentionPolicy), JSON.stringify(record.accessPolicy), record.version,
    record.checksum ?? null, JSON.stringify(record.tags ?? null), JSON.stringify(record.metadata),
    recycle.deletedAt ?? null, recycle.purgeAfter ?? null
  ];
}

export function idempotencyParts(key, userId) {
  const [keyUserId, operation, idempotencyKey, ...rest] = String(key).split('\u0000');
  if (rest.length || keyUserId !== userId || !operation || !idempotencyKey) {
    throw persistenceError('PERSISTENCE_INVALID_CONTRACT');
  }
  return { operation, idempotencyKey };
}

export function mapSQLiteError(error, fallback = 'PERSISTENCE_INVALID_CONTRACT') {
  if (error instanceof PersistenceError) return error;
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  if (code.includes('SQLITE_BUSY') || code.includes('SQLITE_LOCKED') || message.includes('database is locked')) {
    return persistenceError('PERSISTENCE_LOCKED');
  }
  if (code.includes('SQLITE_READONLY') || message.includes('readonly database')) return persistenceError('PERSISTENCE_READ_ONLY');
  if (code.includes('SQLITE_CORRUPT') || code.includes('SQLITE_NOTADB') || message.includes('not a database')) {
    return persistenceError('PERSISTENCE_CORRUPT');
  }
  return persistenceError(fallback);
}

export function safeDirectory(rootDirectory, value) {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw persistenceError('PERSISTENCE_PATH_INVALID');
  }
  return resolved;
}
