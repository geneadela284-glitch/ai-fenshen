import { createEntityRelation } from './kernel.js';
import {
  EntityFoundationError,
  assertAllowedFilters,
  assertOwnerMatch,
  assertOwnerScope,
  entityKey,
  immutableCopy,
  relationKey,
  runIdempotent,
  sortByField
} from './inMemoryFoundationState.js';

function assertTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new EntityFoundationError('INVALID_DATE', 'effective timestamp must be an ISO date.');
  }
}

export class InMemoryRelationRepository {
  constructor(holder, {
    now = () => new Date().toISOString(),
    scopeOwnerUserId = null
  } = {}) {
    this.holder = holder;
    this.now = now;
    this.scopeOwnerUserId = scopeOwnerUserId;
  }

  createRelation(ownerUserId, value, { idempotencyKey } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOwnerMatch(ownerUserId, value?.ownerUserId);
    const relation = createEntityRelation(value, { trustedOwnerUserId: ownerUserId });
    for (const entityId of [relation.sourceEntityId, relation.targetEntityId]) {
      if (!this.holder.state.entities.has(entityKey(ownerUserId, entityId))) {
        throw new EntityFoundationError('ENTITY_NOT_FOUND', 'Relation Entity was not found.');
      }
    }
    return runIdempotent(
      this.holder.state,
      'relation.create',
      ownerUserId,
      idempotencyKey,
      relation,
      () => {
        const key = relationKey(ownerUserId, relation.relationId);
        if (this.holder.state.relations.has(key)) {
          throw new EntityFoundationError('RELATION_ALREADY_EXISTS', 'Relation already exists.');
        }
        this.holder.state.relations.set(key, relation);
        return relation;
      }
    );
  }

  listRelations(ownerUserId, filters = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    const supported = [
      'sourceEntityId', 'targetEntityId', 'relationKind', 'role', 'status'
    ];
    assertAllowedFilters(filters, supported);
    const values = [...this.holder.state.relations.values()].filter((relation) =>
      relation.ownerUserId === ownerUserId && supported.every((field) =>
        filters[field] === undefined || relation[field] === filters[field]
      )
    );
    return immutableCopy(sortByField(values, 'relationId'));
  }

  findEffectiveRelations(ownerUserId, effectiveAt, filters = {}) {
    assertTimestamp(effectiveAt);
    const at = Date.parse(effectiveAt);
    return immutableCopy(this.listRelations(ownerUserId, filters).filter((relation) =>
      relation.status !== 'deleted' &&
      Date.parse(relation.effectiveFrom) <= at &&
      (relation.effectiveTo === null || relation.effectiveTo === undefined || at < Date.parse(relation.effectiveTo))
    ));
  }

  endRelation(ownerUserId, relationId, {
    expectedVersion,
    effectiveTo,
    updatedAt = this.now()
  } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertTimestamp(effectiveTo);
    const key = relationKey(ownerUserId, relationId);
    const current = this.holder.state.relations.get(key);
    if (!current) throw new EntityFoundationError('RELATION_NOT_FOUND', 'Relation was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'Relation version does not match expectedVersion.');
    }
    const candidate = createEntityRelation({
      ...structuredClone(current),
      status: 'ended',
      effectiveTo,
      updatedAt,
      version: current.version + 1
    }, { trustedOwnerUserId: ownerUserId });
    this.holder.state.relations.set(key, candidate);
    return immutableCopy(candidate);
  }
}
