import { createMemoryRecordV2 } from './kernel.js';
import {
  EntityFoundationError,
  assertAllowedFilters,
  assertOpaqueEntityId,
  assertOwnerMatch,
  assertOwnerScope,
  entityKey,
  immutableCopy,
  memoryKey,
  memoryScopeKey,
  runIdempotent,
  sortByField
} from './inMemoryFoundationState.js';
import {
  assertMemoryQueryV2ExecutionContext,
  finalizeMemoryQueryV2Page
} from './memoryQueryV2.js';
import { classifyV2Presence } from './v2Presence.js';

export class InMemoryMemoryRecordV2Repository {
  constructor(holder, {
    now = () => new Date().toISOString(),
    scopeOwnerUserId = null
  } = {}) {
    this.holder = holder;
    this.now = now;
    this.scopeOwnerUserId = scopeOwnerUserId;
  }

  create(ownerUserId, value, { idempotencyKey, resolution } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOwnerMatch(ownerUserId, value?.ownerUserId);
    const memory = createMemoryRecordV2(value, {
      trustedOwnerUserId: ownerUserId,
      resolution
    });
    if (!this.holder.state.entities.has(entityKey(ownerUserId, memory.subjectEntityId))) {
      throw new EntityFoundationError('ENTITY_NOT_FOUND', 'Memory subject Entity was not found.');
    }
    return runIdempotent(
      this.holder.state,
      'memory-v2.create',
      ownerUserId,
      idempotencyKey,
      memory,
      () => {
        const key = memoryKey(ownerUserId, memory.memoryId);
        if (this.holder.state.memories.has(key)) {
          throw new EntityFoundationError('MEMORY_ALREADY_EXISTS', 'MemoryRecordV2 already exists.');
        }
        this.holder.state.memories.set(key, memory);
        const scopeKey = memoryScopeKey(ownerUserId, memory.subjectEntityId, memory.predicate);
        const indexedKeys = this.holder.state.memoryScopeIndex.get(scopeKey) ?? new Set();
        indexedKeys.add(key);
        this.holder.state.memoryScopeIndex.set(scopeKey, indexedKeys);
        return memory;
      }
    );
  }

  getById(ownerUserId, memoryId) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    if (typeof memoryId !== 'string' || memoryId.trim().length === 0) {
      throw new EntityFoundationError('MEMORY_ID_INVALID', 'memoryId is required.');
    }
    return immutableCopy(this.holder.state.memories.get(memoryKey(ownerUserId, memoryId)) ?? null);
  }

  listByEntityAndPredicateForLifecycle(ownerUserId, subjectEntityId, predicate) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOpaqueEntityId(subjectEntityId);
    if (typeof predicate !== 'string' || predicate.trim().length === 0) {
      throw new EntityFoundationError('PREDICATE_REQUIRED', 'predicate is required.');
    }
    return immutableCopy(sortByField(
      this.#recordsForScope(ownerUserId, subjectEntityId, predicate),
      'memoryId'
    ));
  }

  transition(ownerUserId, memoryId, value, { expectedVersion } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    const key = memoryKey(ownerUserId, memoryId);
    const current = this.holder.state.memories.get(key);
    if (!current) throw new EntityFoundationError('MEMORY_NOT_FOUND', 'MemoryRecordV2 was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'MemoryRecordV2 version does not match expectedVersion.');
    }
    const candidate = createMemoryRecordV2(value, { trustedOwnerUserId: ownerUserId });
    if (candidate.memoryId !== memoryId || candidate.subjectEntityId !== current.subjectEntityId ||
        candidate.predicate !== current.predicate) {
      throw new EntityFoundationError('LIFECYCLE_SCOPE_VIOLATION', 'Lifecycle transition cannot change record identity or scope.');
    }
    this.holder.state.memories.set(key, candidate);
    return immutableCopy(candidate);
  }

  purgeChain(ownerUserId, {
    targetMemoryId,
    subjectEntityId,
    predicate,
    expectedVersion,
    chainMemoryIds,
    marker
  } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOpaqueEntityId(subjectEntityId);
    const targetKey = memoryKey(ownerUserId, targetMemoryId);
    const target = this.holder.state.memories.get(targetKey);
    if (!target) throw new EntityFoundationError('MEMORY_NOT_FOUND', 'MemoryRecordV2 was not found.');
    if (!Number.isInteger(expectedVersion) || target.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'MemoryRecordV2 version does not match expectedVersion.');
    }
    if (target.subjectEntityId !== subjectEntityId || target.predicate !== predicate ||
        !Array.isArray(chainMemoryIds) || !chainMemoryIds.includes(targetMemoryId)) {
      throw new EntityFoundationError('LIFECYCLE_SCOPE_VIOLATION', 'Purge chain is outside exact Memory scope.');
    }
    const indexedKeys = this.holder.state.memoryScopeIndex.get(
      memoryScopeKey(ownerUserId, subjectEntityId, predicate)
    ) ?? new Set();
    for (const memoryId of new Set(chainMemoryIds)) {
      const key = memoryKey(ownerUserId, memoryId);
      const record = this.holder.state.memories.get(key);
      if (!record || record.subjectEntityId !== subjectEntityId || record.predicate !== predicate) {
        throw new EntityFoundationError('LIFECYCLE_SCOPE_VIOLATION', 'Purge chain contains an invalid Memory.');
      }
      this.holder.state.memories.delete(key);
      indexedKeys.delete(key);
    }
    const storedMarker = immutableCopy(marker);
    this.holder.state.memories.set(targetKey, storedMarker);
    indexedKeys.add(targetKey);
    this.holder.state.memoryScopeIndex.set(memoryScopeKey(ownerUserId, subjectEntityId, predicate), indexedKeys);
    return storedMarker;
  }

  queryByEntityAndPredicate(ownerOrContext, subjectOrQuery, predicate, filters = {}) {
    if (ownerOrContext && typeof ownerOrContext === 'object' && !Array.isArray(ownerOrContext)) {
      return this.#queryV2(ownerOrContext, subjectOrQuery);
    }
    return this.#querySprint3C(ownerOrContext, subjectOrQuery, predicate, filters);
  }

  inspectPresenceByEntityAndPredicate(context, query) {
    assertOwnerScope(this.scopeOwnerUserId, context?.ownerUserId);
    assertMemoryQueryV2ExecutionContext(context, query);
    return classifyV2Presence(immutableCopy(this.#recordsForScope(
      context.ownerUserId,
      query.subjectEntityId,
      query.predicate
    )), query);
  }

  #recordsForScope(ownerUserId, subjectEntityId, predicate) {
    const indexedKeys = this.holder.state.memoryScopeIndex.get(
      memoryScopeKey(ownerUserId, subjectEntityId, predicate)
    ) ?? new Set();
    return [...indexedKeys]
      .map((key) => this.holder.state.memories.get(key))
      .filter(Boolean);
  }

  #queryV2(context, query) {
    assertOwnerScope(this.scopeOwnerUserId, context?.ownerUserId);
    assertMemoryQueryV2ExecutionContext(context, query);
    const values = this.#recordsForScope(
      context.ownerUserId,
      query.subjectEntityId,
      query.predicate
    ).filter((record) => record.metadata?.purgedMarker !== true);
    return finalizeMemoryQueryV2Page(immutableCopy(values), context, query);
  }

  #querySprint3C(ownerUserId, subjectEntityId, predicate, filters = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOpaqueEntityId(subjectEntityId);
    if (typeof predicate !== 'string' || predicate.trim().length === 0) {
      throw new EntityFoundationError('PREDICATE_REQUIRED', 'predicate is required.');
    }
    assertAllowedFilters(filters, ['status']);
    const values = this.#recordsForScope(ownerUserId, subjectEntityId, predicate).filter((memory) =>
      (filters.status === undefined || memory.status === filters.status)
    );
    return immutableCopy(sortByField(values, 'memoryId'));
  }

  archive(ownerUserId, memoryId, { expectedVersion, updatedAt = this.now() } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    const key = memoryKey(ownerUserId, memoryId);
    const current = this.holder.state.memories.get(key);
    if (!current) throw new EntityFoundationError('MEMORY_NOT_FOUND', 'MemoryRecordV2 was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'MemoryRecordV2 version does not match expectedVersion.');
    }
    const candidate = createMemoryRecordV2({
      ...structuredClone(current),
      status: 'archived',
      updatedAt,
      version: current.version + 1
    }, { trustedOwnerUserId: ownerUserId });
    this.holder.state.memories.set(key, candidate);
    return immutableCopy(candidate);
  }
}
