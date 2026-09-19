import crypto from 'node:crypto';

import { ENTITY_ID_PATTERN } from './contracts.js';

export class EntityFoundationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EntityFoundationError';
    this.code = code;
  }
}

export function createFoundationState() {
  return {
    entities: new Map(),
    aliases: new Map(),
    relations: new Map(),
    memories: new Map(),
    memoryScopeIndex: new Map(),
    selfByOwner: new Map(),
    idempotency: new Map(),
    unitOfWorkIdempotency: new Map()
  };
}

export function cloneFoundationState(state) {
  return structuredClone(state);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function immutableCopy(value) {
  if (value === null || value === undefined) return value;
  return deepFreeze(structuredClone(value));
}

export function assertOwnerUserId(ownerUserId) {
  if (typeof ownerUserId !== 'string' || ownerUserId.trim().length === 0) {
    throw new EntityFoundationError('OWNER_SCOPE_REQUIRED', 'ownerUserId is required.');
  }
}

export function assertOwnerScope(scopeOwnerUserId, ownerUserId) {
  assertOwnerUserId(ownerUserId);
  if (scopeOwnerUserId !== null && scopeOwnerUserId !== ownerUserId) {
    throw new EntityFoundationError('OWNER_SCOPE_MISMATCH', 'ownerUserId is outside the Unit of Work scope.');
  }
}

export function assertOwnerMatch(trustedOwnerUserId, recordOwnerUserId) {
  assertOwnerUserId(trustedOwnerUserId);
  if (trustedOwnerUserId !== recordOwnerUserId) {
    throw new EntityFoundationError('OWNER_SCOPE_MISMATCH', 'record ownerUserId does not match trusted scope.');
  }
}

export function assertOpaqueEntityId(entityId) {
  if (!ENTITY_ID_PATTERN.test(String(entityId || ''))) {
    throw new EntityFoundationError('ENTITY_ID_INVALID', 'entityId must be an opaque Entity ID.');
  }
}

export function assertAllowedFilters(filters, allowed) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new EntityFoundationError('FILTERS_INVALID', 'filters must be an object.');
  }
  const unknown = Object.keys(filters).find((field) => !allowed.includes(field));
  if (unknown) {
    throw new EntityFoundationError('UNKNOWN_FILTER', `Unknown query filter: ${unknown}.`);
  }
}

export function entityKey(ownerUserId, entityId) {
  return JSON.stringify([ownerUserId, entityId]);
}

export function aliasKey(ownerUserId, alias, entityId) {
  return JSON.stringify([ownerUserId, alias, entityId]);
}

export function relationKey(ownerUserId, relationId) {
  return JSON.stringify([ownerUserId, relationId]);
}

export function memoryKey(ownerUserId, memoryId) {
  return JSON.stringify([ownerUserId, memoryId]);
}

export function memoryScopeKey(ownerUserId, subjectEntityId, predicate) {
  return JSON.stringify([ownerUserId, subjectEntityId, predicate]);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function runIdempotent(state, namespace, ownerUserId, idempotencyKey, payload, operation) {
  if (idempotencyKey === undefined || idempotencyKey === null) return operation();
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new EntityFoundationError('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must be a non-empty string.');
  }
  const key = JSON.stringify([namespace, ownerUserId, idempotencyKey]);
  const payloadDigest = digest(payload);
  const existing = state.idempotency.get(key);
  if (existing) {
    if (existing.payloadDigest !== payloadDigest) {
      throw new EntityFoundationError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for a different payload.');
    }
    return immutableCopy(existing.result);
  }
  const result = operation();
  state.idempotency.set(key, { payloadDigest, result: immutableCopy(result) });
  return immutableCopy(result);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function sortByField(values, field) {
  return [...values].sort((left, right) => {
    const a = String(left[field]);
    const b = String(right[field]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
