import crypto from 'node:crypto';

import { createEntity } from './kernel.js';
import {
  EntityFoundationError,
  assertAllowedFilters,
  assertOpaqueEntityId,
  assertOwnerMatch,
  assertOwnerScope,
  immutableCopy,
  sha256
} from './inMemoryFoundationState.js';
import {
  assertConnectionAccess,
  parsePayload,
  runSQLiteIdempotent,
  sqliteWriteError
} from './sqliteFoundationState.js';

export class SQLiteEntityRepository {
  constructor(holder, {
    now = () => new Date().toISOString(),
    entityIdFactory = () => `ent_${crypto.randomBytes(16).toString('hex')}`,
    scopeOwnerUserId = null,
    transactionToken = null
  } = {}) {
    this.holder = holder;
    this.now = now;
    this.entityIdFactory = entityIdFactory;
    this.scopeOwnerUserId = scopeOwnerUserId;
    this.transactionToken = transactionToken;
    this.related = null;
  }

  bindRelated(related) {
    this.related = related;
    return this;
  }

  #access(ownerUserId) {
    assertConnectionAccess(this.holder, this.transactionToken);
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
  }

  create(ownerUserId, value, { idempotencyKey } = {}) {
    this.#access(ownerUserId);
    assertOwnerMatch(ownerUserId, value?.ownerUserId);
    const entity = createEntity(value, { trustedOwnerUserId: ownerUserId });
    return runSQLiteIdempotent(this.holder, 'entity.create', ownerUserId, idempotencyKey, entity, () => {
      try {
        this.holder.db.prepare(`
          INSERT INTO entities
            (owner_user_id, entity_id, type, status, version, entity_role, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          ownerUserId, entity.entityId, entity.type, entity.status, entity.version,
          entity.metadata?.entityRole ?? null, JSON.stringify(entity)
        );
        return entity;
      } catch (error) {
        throw sqliteWriteError(error, 'ENTITY_ALREADY_EXISTS', 'Entity already exists.');
      }
    });
  }

  createEntity(...args) { return this.create(...args); }

  getById(ownerUserId, entityId) {
    this.#access(ownerUserId);
    assertOpaqueEntityId(entityId);
    return parsePayload(this.holder.db.prepare(`
      SELECT payload_json FROM entities WHERE owner_user_id = ? AND entity_id = ?
    `).get(ownerUserId, entityId));
  }

  listByOwner(ownerUserId, filters = {}) {
    this.#access(ownerUserId);
    assertAllowedFilters(filters, ['type', 'status']);
    const conditions = ['owner_user_id = ?'];
    const parameters = [ownerUserId];
    for (const field of ['type', 'status']) {
      if (filters[field] !== undefined) {
        conditions.push(`${field} = ?`);
        parameters.push(filters[field]);
      }
    }
    return immutableCopy(this.holder.db.prepare(`
      SELECT payload_json FROM entities
      WHERE ${conditions.join(' AND ')}
      ORDER BY entity_id
    `).all(...parameters).map(parsePayload));
  }

  query(ownerUserId, filters = {}) { return this.listByOwner(ownerUserId, filters); }

  update(ownerUserId, entityId, { expectedVersion, changes = {} } = {}) {
    this.#access(ownerUserId);
    assertOpaqueEntityId(entityId);
    const current = this.getById(ownerUserId, entityId);
    if (!current) throw new EntityFoundationError('ENTITY_NOT_FOUND', 'Entity was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'Entity version does not match expectedVersion.');
    }
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new EntityFoundationError('INVALID_CHANGES', 'changes must be an object.');
    }
    const candidate = createEntity({
      ...structuredClone(current),
      ...structuredClone(changes),
      schemaVersion: current.schemaVersion,
      entityId: current.entityId,
      ownerUserId: current.ownerUserId,
      version: current.version + 1
    }, { trustedOwnerUserId: ownerUserId });
    try {
      const result = this.holder.db.prepare(`
        UPDATE entities SET type = ?, status = ?, version = ?, entity_role = ?, payload_json = ?
        WHERE owner_user_id = ? AND entity_id = ? AND version = ?
      `).run(
        candidate.type, candidate.status, candidate.version, candidate.metadata?.entityRole ?? null,
        JSON.stringify(candidate), ownerUserId, entityId, expectedVersion
      );
      if (Number(result.changes) !== 1) throw new EntityFoundationError('CAS_CONFLICT', 'Entity version changed.');
      return immutableCopy(candidate);
    } catch (error) {
      if (error instanceof EntityFoundationError) throw error;
      throw sqliteWriteError(error, 'ENTITY_UPDATE_FAILED', 'Entity update failed.');
    }
  }

  updateEntity(...args) { return this.update(...args); }

  archive(ownerUserId, entityId, { expectedVersion, updatedAt = this.now() } = {}) {
    return this.update(ownerUserId, entityId, {
      expectedVersion,
      changes: { status: 'archived', updatedAt }
    });
  }

  ensureSelfEntity(ownerUserId) {
    this.#access(ownerUserId);
    const active = this.holder.db.prepare(`
      SELECT payload_json FROM entities
      WHERE owner_user_id = ? AND status = 'active' AND entity_role = 'self'
      ORDER BY entity_id
    `).all(ownerUserId).map(parsePayload);
    if (active.length > 1) throw new EntityFoundationError('SELF_ENTITY_CONFLICT', 'Owner has multiple active self Entities.');
    if (active.length === 1) return active[0];
    let entityId;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.entityIdFactory();
      assertOpaqueEntityId(candidate);
      if (!this.getById(ownerUserId, candidate)) { entityId = candidate; break; }
    }
    if (!entityId) throw new EntityFoundationError('ENTITY_ID_COLLISION', 'Unable to allocate self Entity ID.');
    const timestamp = this.now();
    return this.create(ownerUserId, {
      schemaVersion: 'v2', entityId, ownerUserId, type: 'person', status: 'active', version: 1,
      source: { type: 'system_verified', id: 'ensure-self-entity' },
      checksum: sha256(JSON.stringify({ ownerUserId, entityId, version: 1 })),
      createdAt: timestamp, updatedAt: timestamp, metadata: { entityRole: 'self' }
    });
  }

  findByAlias(...args) { return this.#related('aliases').findByAlias(...args); }
  addAlias(...args) { return this.#related('aliases').addAlias(...args); }
  updateAlias(...args) { return this.#related('aliases').updateAlias(...args); }
  findRelations(...args) { return this.#related('relations').listRelations(...args); }
  createRelation(...args) { return this.#related('relations').createRelation(...args); }
  endRelation(...args) { return this.#related('relations').endRelation(...args); }

  #related(name) {
    if (!this.related?.[name]) throw new EntityFoundationError('REPOSITORY_NOT_BOUND', `${name} repository unavailable.`);
    return this.related[name];
  }
}
