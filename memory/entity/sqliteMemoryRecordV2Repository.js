import { createMemoryRecordV2 } from './kernel.js';
import {
  EntityFoundationError,
  assertAllowedFilters,
  assertOpaqueEntityId,
  assertOwnerMatch,
  assertOwnerScope,
  immutableCopy
} from './inMemoryFoundationState.js';
import {
  assertConnectionAccess,
  parsePayload,
  runSQLiteIdempotent,
  sqliteWriteError
} from './sqliteFoundationState.js';
import {
  allowedProvenanceForProvenancePolicy,
  assertMemoryQueryV2ExecutionContext,
  finalizeMemoryQueryV2Page
} from './memoryQueryV2.js';
import { classifyV2Presence } from './v2Presence.js';

function assertMemoryId(memoryId) {
  if (typeof memoryId !== 'string' || memoryId.trim().length === 0) {
    throw new EntityFoundationError('MEMORY_ID_INVALID', 'memoryId is required.');
  }
}

function parseScopedMemoryRow(row) {
  const memory = parsePayload(row);
  for (const [projection, field] of [
    ['owner_user_id', 'ownerUserId'],
    ['memory_id', 'memoryId'],
    ['subject_entity_id', 'subjectEntityId'],
    ['predicate', 'predicate'],
    ['status', 'status'],
    ['version', 'version']
  ]) {
    if (row[projection] !== memory?.[field]) {
      throw new EntityFoundationError(
        'REPOSITORY_SCOPE_VIOLATION',
        `SQLite projection ${projection} does not match MemoryRecordV2 payload.`
      );
    }
  }
  return memory;
}

export class SQLiteMemoryRecordV2Repository {
  constructor(holder, { now = () => new Date().toISOString(), scopeOwnerUserId = null, transactionToken = null } = {}) {
    this.holder = holder;
    this.now = now;
    this.scopeOwnerUserId = scopeOwnerUserId;
    this.transactionToken = transactionToken;
  }

  #access(ownerUserId) {
    assertConnectionAccess(this.holder, this.transactionToken);
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
  }

  create(ownerUserId, value, { idempotencyKey, resolution } = {}) {
    this.#access(ownerUserId);
    assertOwnerMatch(ownerUserId, value?.ownerUserId);
    const memory = createMemoryRecordV2(value, { trustedOwnerUserId: ownerUserId, resolution });
    return runSQLiteIdempotent(this.holder, 'memory-v2.create', ownerUserId, idempotencyKey, memory, () => {
      try {
        this.holder.db.prepare(`
          INSERT INTO memory_records_v2
            (owner_user_id, memory_id, subject_entity_id, predicate, status, version, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(ownerUserId, memory.memoryId, memory.subjectEntityId, memory.predicate,
          memory.status, memory.version, JSON.stringify(memory));
        return memory;
      } catch (error) {
        throw sqliteWriteError(error, 'MEMORY_ALREADY_EXISTS', 'MemoryRecordV2 already exists.');
      }
    });
  }

  getById(ownerUserId, memoryId) {
    this.#access(ownerUserId);
    assertMemoryId(memoryId);
    return parsePayload(this.holder.db.prepare(`
      SELECT payload_json FROM memory_records_v2
      WHERE owner_user_id = ? AND memory_id = ?
    `).get(ownerUserId, memoryId));
  }

  listByOwner(ownerUserId) {
    this.#access(ownerUserId);
    return immutableCopy(this.holder.db.prepare(`
      SELECT owner_user_id, memory_id, subject_entity_id, predicate, status, version, payload_json
      FROM memory_records_v2
      WHERE owner_user_id = ?
      ORDER BY memory_id
    `).all(ownerUserId).map(parseScopedMemoryRow));
  }

  listByEntityAndPredicateForLifecycle(ownerUserId, subjectEntityId, predicate) {
    this.#access(ownerUserId);
    assertOpaqueEntityId(subjectEntityId);
    if (typeof predicate !== 'string' || predicate.trim().length === 0) {
      throw new EntityFoundationError('PREDICATE_REQUIRED', 'predicate is required.');
    }
    return immutableCopy(this.holder.db.prepare(`
      SELECT owner_user_id, memory_id, subject_entity_id, predicate, status, version, payload_json
      FROM memory_records_v2
      WHERE owner_user_id = ? AND subject_entity_id = ? AND predicate = ?
      ORDER BY memory_id
    `).all(ownerUserId, subjectEntityId, predicate).map(parseScopedMemoryRow));
  }

  transition(ownerUserId, memoryId, value, { expectedVersion } = {}) {
    this.#access(ownerUserId);
    const current = this.getById(ownerUserId, memoryId);
    if (!current) throw new EntityFoundationError('MEMORY_NOT_FOUND', 'MemoryRecordV2 was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'MemoryRecordV2 version does not match expectedVersion.');
    }
    const candidate = createMemoryRecordV2(value, { trustedOwnerUserId: ownerUserId });
    if (candidate.memoryId !== memoryId || candidate.subjectEntityId !== current.subjectEntityId ||
        candidate.predicate !== current.predicate) {
      throw new EntityFoundationError('LIFECYCLE_SCOPE_VIOLATION', 'Lifecycle transition cannot change record identity or scope.');
    }
    const updated = this.holder.db.prepare(`
      UPDATE memory_records_v2 SET status = ?, version = ?, payload_json = ?
      WHERE owner_user_id = ? AND memory_id = ? AND version = ?
    `).run(candidate.status, candidate.version, JSON.stringify(candidate), ownerUserId, memoryId, expectedVersion);
    if (Number(updated.changes) !== 1) throw new EntityFoundationError('CAS_CONFLICT', 'MemoryRecordV2 version changed.');
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
    this.#access(ownerUserId);
    const target = this.getById(ownerUserId, targetMemoryId);
    if (!target) throw new EntityFoundationError('MEMORY_NOT_FOUND', 'MemoryRecordV2 was not found.');
    if (!Number.isInteger(expectedVersion) || target.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'MemoryRecordV2 version does not match expectedVersion.');
    }
    if (target.subjectEntityId !== subjectEntityId || target.predicate !== predicate ||
        !Array.isArray(chainMemoryIds) || !chainMemoryIds.includes(targetMemoryId)) {
      throw new EntityFoundationError('LIFECYCLE_SCOPE_VIOLATION', 'Purge chain is outside exact Memory scope.');
    }
    const uniqueIds = [...new Set(chainMemoryIds)];
    const rows = this.holder.db.prepare(`
      SELECT owner_user_id, memory_id, subject_entity_id, predicate, status, version, payload_json
      FROM memory_records_v2
      WHERE owner_user_id = ? AND memory_id IN (${uniqueIds.map(() => '?').join(', ')})
    `).all(ownerUserId, ...uniqueIds).map(parseScopedMemoryRow);
    if (rows.length !== uniqueIds.length || rows.some((record) =>
      record.subjectEntityId !== subjectEntityId || record.predicate !== predicate)) {
      throw new EntityFoundationError('LIFECYCLE_SCOPE_VIOLATION', 'Purge chain contains an invalid Memory.');
    }
    this.holder.db.prepare(`
      DELETE FROM memory_records_v2
      WHERE owner_user_id = ? AND memory_id IN (${uniqueIds.map(() => '?').join(', ')})
    `).run(ownerUserId, ...uniqueIds);
    this.holder.db.prepare(`
      INSERT INTO memory_records_v2
        (owner_user_id, memory_id, subject_entity_id, predicate, status, version, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ownerUserId, marker.memoryId, marker.subjectEntityId, marker.predicate,
      marker.status, marker.version, JSON.stringify(marker));
    return immutableCopy(marker);
  }

  queryByEntityAndPredicate(ownerOrContext, subjectOrQuery, predicate, filters = {}) {
    if (ownerOrContext && typeof ownerOrContext === 'object' && !Array.isArray(ownerOrContext)) {
      return this.#queryV2(ownerOrContext, subjectOrQuery);
    }
    return this.#querySprint3C(ownerOrContext, subjectOrQuery, predicate, filters);
  }

  inspectPresenceByEntityAndPredicate(context, query) {
    this.#access(context?.ownerUserId);
    assertMemoryQueryV2ExecutionContext(context, query);
    const records = this.holder.db.prepare(`
      SELECT owner_user_id, memory_id, subject_entity_id, predicate, status, version, payload_json
      FROM memory_records_v2
      WHERE owner_user_id = ? AND subject_entity_id = ? AND predicate = ?
      ORDER BY memory_id
    `).all(context.ownerUserId, query.subjectEntityId, query.predicate).map(parseScopedMemoryRow);
    return classifyV2Presence(immutableCopy(records), query);
  }

  #queryV2(context, query) {
    this.#access(context?.ownerUserId);
    assertMemoryQueryV2ExecutionContext(context, query);
    const conditions = [
      'owner_user_id = ?',
      'subject_entity_id = ?',
      'predicate = ?'
    ];
    const parameters = [context.ownerUserId, query.subjectEntityId, query.predicate];

    conditions.push(`status IN (${query.allowedStatuses.map(() => '?').join(', ')})`);
    parameters.push(...query.allowedStatuses);
    conditions.push("json_extract(payload_json, '$.effectiveFrom') <= ?");
    parameters.push(query.effectiveAt);
    conditions.push("(json_extract(payload_json, '$.effectiveTo') IS NULL OR ? < json_extract(payload_json, '$.effectiveTo'))");
    parameters.push(query.effectiveAt);
    conditions.push("(json_extract(payload_json, '$.expiresAt') IS NULL OR ? < json_extract(payload_json, '$.expiresAt'))");
    parameters.push(query.effectiveAt);
    if (query.memoryType !== null) {
      conditions.push("json_extract(payload_json, '$.memoryType') = ?");
      parameters.push(query.memoryType);
    }
    const provenanceLevels = allowedProvenanceForProvenancePolicy(query.provenancePolicy);
    conditions.push(`json_extract(payload_json, '$.provenance') IN (${provenanceLevels.map(() => '?').join(', ')})`);
    parameters.push(...provenanceLevels);
    if (query.readMode === 'current') {
      conditions.push("json_extract(payload_json, '$.confirmationStatus') IN ('user_confirmed', 'system_verified', 'not_required')");
    }

    const records = this.holder.db.prepare(`
      SELECT owner_user_id, memory_id, subject_entity_id, predicate, status, version, payload_json
      FROM memory_records_v2
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        json_extract(payload_json, '$.effectiveFrom') DESC,
        json_extract(payload_json, '$.createdAt') DESC,
        memory_id ASC
    `).all(...parameters).map(parseScopedMemoryRow);
    return finalizeMemoryQueryV2Page(immutableCopy(records), context, query);
  }

  #querySprint3C(ownerUserId, subjectEntityId, predicate, filters = {}) {
    this.#access(ownerUserId);
    assertOpaqueEntityId(subjectEntityId);
    if (typeof predicate !== 'string' || predicate.trim().length === 0) {
      throw new EntityFoundationError('PREDICATE_REQUIRED', 'predicate is required.');
    }
    assertAllowedFilters(filters, ['status']);
    const conditions = ['owner_user_id = ?', 'subject_entity_id = ?', 'predicate = ?'];
    const parameters = [ownerUserId, subjectEntityId, predicate];
    if (filters.status !== undefined) { conditions.push('status = ?'); parameters.push(filters.status); }
    return immutableCopy(this.holder.db.prepare(`
      SELECT payload_json FROM memory_records_v2
      WHERE ${conditions.join(' AND ')} ORDER BY memory_id
    `).all(...parameters).map(parsePayload));
  }

  archive(ownerUserId, memoryId, { expectedVersion, updatedAt = this.now() } = {}) {
    this.#access(ownerUserId);
    const current = this.getById(ownerUserId, memoryId);
    if (!current) throw new EntityFoundationError('MEMORY_NOT_FOUND', 'MemoryRecordV2 was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'MemoryRecordV2 version does not match expectedVersion.');
    }
    const candidate = createMemoryRecordV2({
      ...structuredClone(current), status: 'archived', updatedAt, version: current.version + 1
    }, { trustedOwnerUserId: ownerUserId });
    const result = this.holder.db.prepare(`
      UPDATE memory_records_v2 SET status = ?, version = ?, payload_json = ?
      WHERE owner_user_id = ? AND memory_id = ? AND version = ?
    `).run(candidate.status, candidate.version, JSON.stringify(candidate), ownerUserId, memoryId, expectedVersion);
    if (Number(result.changes) !== 1) throw new EntityFoundationError('CAS_CONFLICT', 'MemoryRecordV2 version changed.');
    return immutableCopy(candidate);
  }
}
