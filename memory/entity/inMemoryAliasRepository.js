import { createEntityAlias } from './kernel.js';
import {
  EntityFoundationError,
  aliasKey,
  assertOpaqueEntityId,
  assertOwnerMatch,
  assertOwnerScope,
  entityKey,
  immutableCopy,
  runIdempotent,
  sortByField
} from './inMemoryFoundationState.js';

function assertAlias(alias) {
  if (typeof alias !== 'string' || alias.trim().length === 0) {
    throw new EntityFoundationError('ALIAS_REQUIRED', 'alias is required.');
  }
}

export class InMemoryAliasRepository {
  constructor(holder, {
    now = () => new Date().toISOString(),
    scopeOwnerUserId = null
  } = {}) {
    this.holder = holder;
    this.now = now;
    this.scopeOwnerUserId = scopeOwnerUserId;
  }

  addAlias(ownerUserId, value, { idempotencyKey } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertOwnerMatch(ownerUserId, value?.ownerUserId);
    const alias = createEntityAlias(value, { trustedOwnerUserId: ownerUserId });
    if (!this.holder.state.entities.has(entityKey(ownerUserId, alias.entityId))) {
      throw new EntityFoundationError('ENTITY_NOT_FOUND', 'Alias target Entity was not found.');
    }
    return runIdempotent(
      this.holder.state,
      'alias.add',
      ownerUserId,
      idempotencyKey,
      alias,
      () => {
        const key = aliasKey(ownerUserId, alias.alias, alias.entityId);
        if (this.holder.state.aliases.has(key)) {
          throw new EntityFoundationError('ALIAS_ALREADY_EXISTS', 'Alias record already exists.');
        }
        this.holder.state.aliases.set(key, alias);
        return alias;
      }
    );
  }

  findByAlias(ownerUserId, alias) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertAlias(alias);
    const candidates = [...this.holder.state.aliases.values()].filter((record) =>
      record.ownerUserId === ownerUserId && record.alias === alias && record.status === 'active'
    );
    return immutableCopy(sortByField(candidates, 'entityId'));
  }

  updateAlias(ownerUserId, alias, entityId, { expectedVersion, changes = {} } = {}) {
    assertOwnerScope(this.scopeOwnerUserId, ownerUserId);
    assertAlias(alias);
    assertOpaqueEntityId(entityId);
    const key = aliasKey(ownerUserId, alias, entityId);
    const current = this.holder.state.aliases.get(key);
    if (!current) throw new EntityFoundationError('ALIAS_NOT_FOUND', 'Alias record was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'Alias version does not match expectedVersion.');
    }
    const candidate = createEntityAlias({
      ...structuredClone(current),
      ...structuredClone(changes),
      schemaVersion: current.schemaVersion,
      alias: current.alias,
      entityId: current.entityId,
      ownerUserId: current.ownerUserId,
      version: current.version + 1
    }, { trustedOwnerUserId: ownerUserId });
    this.holder.state.aliases.set(key, candidate);
    return immutableCopy(candidate);
  }

  disableAlias(ownerUserId, alias, entityId, { expectedVersion, updatedAt = this.now() } = {}) {
    return this.updateAlias(ownerUserId, alias, entityId, {
      expectedVersion,
      changes: { status: 'inactive', updatedAt }
    });
  }
}
