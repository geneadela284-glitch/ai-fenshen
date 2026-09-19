import crypto from 'node:crypto';

import { createEntity } from './kernel.js';
import {
  EntityFoundationError,
  assertAllowedFilters,
  assertOpaqueEntityId,
  assertOwnerMatch,
  assertOwnerScope,
  entityKey,
  immutableCopy,
  runIdempotent,
  sha256,
  sortByField
} from './inMemoryFoundationState.js';

export class InMemoryEntityRepository {
  constructor(holder, {
    now = () => new Date().toISOString(),
    entityIdFactory = () => `ent_${crypto.randomBytes(16).toString('hex')}`,
    scopeOwnerUserId = null
  } = {}) {
    this.holder = holder;
    this.now = now;
    this.entityIdFactory = entityIdFactory;
    this.scopeOwnerUserId = scopeOwnerUserId;
    this.related = null;
  }

  bindRelated(related) {
    this.related = related;
    return this;
  }

  create(ownerUserId, value, { idempotencyKey } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOwnerMatch(ownerUserId, value?.ownerUserId);
    const entity = createEntity(value, { trustedOwnerUserId: ownerUserId });
    return runIdempotent(
      this.holder.state,
      'entity.create',
      ownerUserId,
      idempotencyKey,
      entity,
      () => {
        const key = entityKey(ownerUserId, entity.entityId);
        if (this.holder.state.entities.has(key)) {
          throw new EntityFoundationError('ENTITY_ALREADY_EXISTS', 'Entity already exists.');
        }
        this.holder.state.entities.set(key, entity);
        return entity;
      }
    );
  }

  createEntity(...args) {
    return this.create(...args);
  }

  getById(ownerUserId, entityId) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOpaqueEntityId(entityId);
    return immutableCopy(this.holder.state.entities.get(entityKey(ownerUserId, entityId)) ?? null);
  }

  listByOwner(ownerUserId, filters = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertAllowedFilters(filters, ['type', 'status']);
    const values = [...this.holder.state.entities.values()].filter((entity) =>
      entity.ownerUserId === ownerUserId &&
      (filters.type === undefined || entity.type === filters.type) &&
      (filters.status === undefined || entity.status === filters.status)
    );
    return immutableCopy(sortByField(values, 'entityId'));
  }

  query(ownerUserId, filters = {}) {
    return this.listByOwner(ownerUserId, filters);
  }

  update(ownerUserId, entityId, { expectedVersion, changes = {} } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOpaqueEntityId(entityId);
    const key = entityKey(ownerUserId, entityId);
    const current = this.holder.state.entities.get(key);
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
    this.holder.state.entities.set(key, candidate);
    return immutableCopy(candidate);
  }

  updateEntity(...args) {
    return this.update(...args);
  }

  archive(ownerUserId, entityId, { expectedVersion, updatedAt = this.now() } = {}) {
    return this.update(ownerUserId, entityId, {
      expectedVersion,
      changes: { status: 'archived', updatedAt }
    });
  }

  ensureSelfEntity(ownerUserId) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    const mappedId = this.holder.state.selfByOwner.get(ownerUserId);
    const mapped = mappedId
      ? this.holder.state.entities.get(entityKey(ownerUserId, mappedId))
      : null;
    if (mapped?.status === 'active') return immutableCopy(mapped);

    const activeSelf = this.listByOwner(ownerUserId, { status: 'active' })
      .filter((entity) => entity.metadata?.entityRole === 'self');
    if (activeSelf.length > 1) {
      throw new EntityFoundationError('SELF_ENTITY_CONFLICT', 'Owner has more than one active self Entity.');
    }
    if (activeSelf.length === 1) {
      this.holder.state.selfByOwner.set(ownerUserId, activeSelf[0].entityId);
      return activeSelf[0];
    }

    let entityId;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.entityIdFactory();
      assertOpaqueEntityId(candidate);
      if (!this.holder.state.entities.has(entityKey(ownerUserId, candidate))) {
        entityId = candidate;
        break;
      }
    }
    if (!entityId) throw new EntityFoundationError('ENTITY_ID_COLLISION', 'Unable to allocate a unique self Entity ID.');
    const timestamp = this.now();
    const self = this.create(ownerUserId, {
      schemaVersion: 'v2',
      entityId,
      ownerUserId,
      type: 'person',
      status: 'active',
      version: 1,
      source: { type: 'system_verified', id: 'ensure-self-entity' },
      checksum: sha256(JSON.stringify({ ownerUserId, entityId, version: 1 })),
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { entityRole: 'self' }
    }, { idempotencyKey: 'ensure-self-entity' });
    this.holder.state.selfByOwner.set(ownerUserId, self.entityId);
    return self;
  }

  findByAlias(...args) {
    return this.#related('aliases').findByAlias(...args);
  }

  addAlias(...args) {
    return this.#related('aliases').addAlias(...args);
  }

  updateAlias(...args) {
    return this.#related('aliases').updateAlias(...args);
  }

  findRelations(...args) {
    return this.#related('relations').listRelations(...args);
  }

  createRelation(...args) {
    return this.#related('relations').createRelation(...args);
  }

  endRelation(...args) {
    return this.#related('relations').endRelation(...args);
  }

  #related(name) {
    if (!this.related?.[name]) throw new EntityFoundationError('REPOSITORY_NOT_BOUND', `${name} repository is unavailable.`);
    return this.related[name];
  }
}
