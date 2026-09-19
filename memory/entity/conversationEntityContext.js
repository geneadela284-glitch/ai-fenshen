import { ENTITY_ID_PATTERN, ENTITY_TYPES } from './contracts.js';

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} is required.`);
  }
  return value;
}

function timestamp(value, field) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(parsed)) {
    throw new TypeError(`${field} must be an ISO timestamp.`);
  }
  return parsed;
}

function key(ownerUserId, conversationId) {
  return JSON.stringify([ownerUserId, conversationId]);
}

function immutable(value) {
  return value === null ? null : Object.freeze(structuredClone(value));
}

export class ConversationEntityContext {
  constructor({ ttlMs = 5 * 60 * 1000, now = () => new Date().toISOString() } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive integer.');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  recordExact({ ownerUserId, conversationId, entityId, entityType }) {
    requiredString(ownerUserId, 'ownerUserId');
    requiredString(conversationId, 'conversationId');
    if (!ENTITY_ID_PATTERN.test(String(entityId || ''))) {
      throw new TypeError('entityId must be an opaque Entity ID.');
    }
    if (!ENTITY_TYPES.includes(entityType)) throw new TypeError('entityType is invalid.');
    const recordedAt = this.now();
    const recordedAtMs = timestamp(recordedAt, 'now');
    const entry = {
      ownerUserId,
      conversationId,
      entityId,
      entityType,
      recordedAt,
      expiresAt: new Date(recordedAtMs + this.ttlMs).toISOString()
    };
    this.entries.set(key(ownerUserId, conversationId), entry);
    return immutable(entry);
  }

  get({ ownerUserId, conversationId, at = this.now() }) {
    requiredString(ownerUserId, 'ownerUserId');
    requiredString(conversationId, 'conversationId');
    const entryKey = key(ownerUserId, conversationId);
    const entry = this.entries.get(entryKey);
    if (!entry) return null;
    if (timestamp(at, 'at') >= timestamp(entry.expiresAt, 'expiresAt')) {
      this.entries.delete(entryKey);
      return null;
    }
    return immutable(entry);
  }

  snapshot(scope) {
    const entry = this.get(scope);
    if (!entry) return null;
    return Object.freeze({
      entityId: entry.entityId,
      entityType: entry.entityType,
      recordedAt: entry.recordedAt,
      expiresAt: entry.expiresAt
    });
  }

  clear({ ownerUserId, conversationId }) {
    requiredString(ownerUserId, 'ownerUserId');
    requiredString(conversationId, 'conversationId');
    return this.entries.delete(key(ownerUserId, conversationId));
  }
}
