import crypto from 'node:crypto';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function copy(value) {
  return value === null || value === undefined ? value : freeze(structuredClone(value));
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} is required.`);
  }
  return value;
}

class PendingCandidateStore {
  constructor({ now, tokenFactory, ttlMs }) {
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  create(ownerUserId, candidate) {
    required(ownerUserId, 'ownerUserId');
    const confirmationToken = required(this.tokenFactory(), 'confirmationToken');
    const createdAt = this.now();
    const entry = {
      confirmationToken,
      ownerUserId,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + this.ttlMs).toISOString(),
      candidate: structuredClone(candidate)
    };
    if (this.entries.has(confirmationToken)) throw new Error('confirmationToken collision.');
    this.entries.set(confirmationToken, entry);
    return copy(entry);
  }

  get(ownerUserId, confirmationToken) {
    required(ownerUserId, 'ownerUserId');
    required(confirmationToken, 'confirmationToken');
    const entry = this.entries.get(confirmationToken);
    if (!entry) throw new Error('Pending candidate was not found.');
    if (entry.ownerUserId !== ownerUserId) throw new Error('Pending candidate owner mismatch.');
    if (Date.parse(this.now()) >= Date.parse(entry.expiresAt)) {
      this.entries.delete(confirmationToken);
      throw new Error('Pending candidate expired.');
    }
    return copy(entry);
  }

  consume(ownerUserId, confirmationToken) {
    const entry = this.get(ownerUserId, confirmationToken);
    this.entries.delete(confirmationToken);
    return entry;
  }

  reject(ownerUserId, confirmationToken) {
    return this.consume(ownerUserId, confirmationToken);
  }

  size(ownerUserId) {
    required(ownerUserId, 'ownerUserId');
    return [...this.entries.values()].filter((entry) =>
      entry.ownerUserId === ownerUserId && Date.parse(this.now()) < Date.parse(entry.expiresAt)
    ).length;
  }

  clearOwner(ownerUserId) {
    required(ownerUserId, 'ownerUserId');
    let deleted = 0;
    for (const [token, entry] of this.entries.entries()) {
      if (entry.ownerUserId !== ownerUserId) continue;
      this.entries.delete(token);
      deleted += 1;
    }
    return deleted;
  }
}

class TemporaryContextStore {
  constructor({ now, tokenFactory }) {
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.entries = new Map();
    this.idempotency = new Map();
  }

  put({ ownerUserId, subjectEntityId, decision, idempotencyKey }) {
    required(ownerUserId, 'ownerUserId');
    required(subjectEntityId, 'subjectEntityId');
    required(idempotencyKey, 'idempotencyKey');
    const replayKey = JSON.stringify([ownerUserId, idempotencyKey]);
    const replayId = this.idempotency.get(replayKey);
    if (replayId) return copy(this.entries.get(replayId));
    const expiresAt = decision?.retentionPolicy?.expiresAt;
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) <= Date.parse(this.now())) {
      throw new TypeError('Temporary context requires a future expiresAt.');
    }
    const contextId = required(this.tokenFactory(), 'contextId');
    const entry = {
      contextId,
      ownerUserId,
      subjectEntityId,
      memoryType: decision.memoryType,
      predicate: decision.predicate,
      structuredValue: structuredClone(decision.suggestedStructuredValue),
      sourceTextDigest: decision.sourceTextDigest,
      createdAt: this.now(),
      expiresAt
    };
    this.entries.set(contextId, entry);
    this.idempotency.set(replayKey, contextId);
    return copy(entry);
  }

  listActive(ownerUserId) {
    required(ownerUserId, 'ownerUserId');
    const now = Date.parse(this.now());
    return Object.freeze([...this.entries.values()]
      .filter((entry) => entry.ownerUserId === ownerUserId && now < Date.parse(entry.expiresAt))
      .map(copy));
  }

  clearOwner(ownerUserId) {
    required(ownerUserId, 'ownerUserId');
    let deleted = 0;
    for (const [contextId, entry] of this.entries.entries()) {
      if (entry.ownerUserId !== ownerUserId) continue;
      this.entries.delete(contextId);
      deleted += 1;
    }
    for (const [key, contextId] of this.idempotency.entries()) {
      if (!this.entries.has(contextId)) this.idempotency.delete(key);
    }
    return deleted;
  }
}

export function createMemoryCaptureStores({
  now = () => new Date().toISOString(),
  tokenFactory = () => crypto.randomUUID(),
  pendingTtlMs = 15 * 60 * 1000
} = {}) {
  if (typeof now !== 'function' || typeof tokenFactory !== 'function') {
    throw new TypeError('Memory capture stores require clock and token factories.');
  }
  if (!Number.isInteger(pendingTtlMs) || pendingTtlMs < 1) {
    throw new TypeError('pendingTtlMs must be a positive integer.');
  }
  return Object.freeze({
    pendingCandidates: new PendingCandidateStore({ now, tokenFactory, ttlMs: pendingTtlMs }),
    temporaryContexts: new TemporaryContextStore({ now, tokenFactory })
  });
}
