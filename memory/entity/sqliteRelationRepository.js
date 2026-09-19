import { createEntityRelation } from './kernel.js';
import {
  EntityFoundationError,
  assertAllowedFilters,
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

function timestamp(value) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(parsed)) {
    throw new EntityFoundationError('INVALID_DATE', 'effective timestamp must be an ISO date.');
  }
  return parsed;
}

export class SQLiteRelationRepository {
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

  createRelation(ownerUserId, value, { idempotencyKey } = {}) {
    this.#access(ownerUserId);
    assertOwnerMatch(ownerUserId, value?.ownerUserId);
    const relation = createEntityRelation(value, { trustedOwnerUserId: ownerUserId });
    return runSQLiteIdempotent(this.holder, 'relation.create', ownerUserId, idempotencyKey, relation, () => {
      try {
        this.holder.db.prepare(`
          INSERT INTO entity_relations
            (owner_user_id, relation_id, source_entity_id, target_entity_id, relation_kind, role,
             effective_from_ms, effective_to_ms, status, version, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ownerUserId, relation.relationId, relation.sourceEntityId, relation.targetEntityId,
          relation.relationKind, relation.role, timestamp(relation.effectiveFrom),
          relation.effectiveTo == null ? null : timestamp(relation.effectiveTo),
          relation.status, relation.version, JSON.stringify(relation)
        );
        return relation;
      } catch (error) {
        throw sqliteWriteError(error, 'RELATION_ALREADY_EXISTS', 'Relation already exists.');
      }
    });
  }

  listRelations(ownerUserId, filters = {}) {
    this.#access(ownerUserId);
    const columns = {
      sourceEntityId: 'source_entity_id', targetEntityId: 'target_entity_id',
      relationKind: 'relation_kind', role: 'role', status: 'status'
    };
    assertAllowedFilters(filters, Object.keys(columns));
    const conditions = ['owner_user_id = ?'];
    const parameters = [ownerUserId];
    for (const [field, column] of Object.entries(columns)) {
      if (filters[field] !== undefined) { conditions.push(`${column} = ?`); parameters.push(filters[field]); }
    }
    return immutableCopy(this.holder.db.prepare(`
      SELECT payload_json FROM entity_relations
      WHERE ${conditions.join(' AND ')} ORDER BY relation_id
    `).all(...parameters).map(parsePayload));
  }

  findEffectiveRelations(ownerUserId, effectiveAt, filters = {}) {
    this.#access(ownerUserId);
    const at = timestamp(effectiveAt);
    const columns = {
      sourceEntityId: 'source_entity_id', targetEntityId: 'target_entity_id',
      relationKind: 'relation_kind', role: 'role', status: 'status'
    };
    assertAllowedFilters(filters, Object.keys(columns));
    const conditions = [
      'owner_user_id = ?', 'effective_from_ms <= ?',
      '(effective_to_ms IS NULL OR ? < effective_to_ms)', "status <> 'deleted'"
    ];
    const parameters = [ownerUserId, at, at];
    for (const [field, column] of Object.entries(columns)) {
      if (filters[field] !== undefined) { conditions.push(`${column} = ?`); parameters.push(filters[field]); }
    }
    return immutableCopy(this.holder.db.prepare(`
      SELECT payload_json FROM entity_relations
      WHERE ${conditions.join(' AND ')} ORDER BY relation_id
    `).all(...parameters).map(parsePayload));
  }

  endRelation(ownerUserId, relationId, { expectedVersion, effectiveTo, updatedAt = this.now() } = {}) {
    this.#access(ownerUserId);
    const current = parsePayload(this.holder.db.prepare(`
      SELECT payload_json FROM entity_relations WHERE owner_user_id = ? AND relation_id = ?
    `).get(ownerUserId, relationId));
    if (!current) throw new EntityFoundationError('RELATION_NOT_FOUND', 'Relation was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'Relation version does not match expectedVersion.');
    }
    const candidate = createEntityRelation({
      ...structuredClone(current), status: 'ended', effectiveTo, updatedAt, version: current.version + 1
    }, { trustedOwnerUserId: ownerUserId });
    const result = this.holder.db.prepare(`
      UPDATE entity_relations
      SET effective_to_ms = ?, status = ?, version = ?, payload_json = ?
      WHERE owner_user_id = ? AND relation_id = ? AND version = ?
    `).run(timestamp(effectiveTo), candidate.status, candidate.version, JSON.stringify(candidate),
      ownerUserId, relationId, expectedVersion);
    if (Number(result.changes) !== 1) throw new EntityFoundationError('CAS_CONFLICT', 'Relation version changed.');
    return immutableCopy(candidate);
  }
}
