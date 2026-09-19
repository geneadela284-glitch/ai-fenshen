import { createEntityAlias } from './kernel.js';
import {
  EntityFoundationError,
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

function assertAlias(alias) {
  if (typeof alias !== 'string' || alias.trim().length === 0) {
    throw new EntityFoundationError('ALIAS_REQUIRED', 'alias is required.');
  }
}

export class SQLiteAliasRepository {
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

  addAlias(ownerUserId, value, { idempotencyKey } = {}) {
    this.#access(ownerUserId);
    assertOwnerMatch(ownerUserId, value?.ownerUserId);
    const alias = createEntityAlias(value, { trustedOwnerUserId: ownerUserId });
    return runSQLiteIdempotent(this.holder, 'alias.add', ownerUserId, idempotencyKey, alias, () => {
      try {
        this.holder.db.prepare(`
          INSERT INTO entity_aliases
            (owner_user_id, alias, entity_id, status, version, payload_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(ownerUserId, alias.alias, alias.entityId, alias.status, alias.version, JSON.stringify(alias));
        return alias;
      } catch (error) {
        throw sqliteWriteError(error, 'ALIAS_ALREADY_EXISTS', 'Alias record already exists.');
      }
    });
  }

  findByAlias(ownerUserId, alias) {
    this.#access(ownerUserId);
    assertAlias(alias);
    return immutableCopy(this.holder.db.prepare(`
      SELECT payload_json FROM entity_aliases
      WHERE owner_user_id = ? AND alias = ? AND status = 'active'
      ORDER BY entity_id
    `).all(ownerUserId, alias).map(parsePayload));
  }

  listByOwner(ownerUserId) {
    this.#access(ownerUserId);
    return immutableCopy(this.holder.db.prepare(`
      SELECT payload_json FROM entity_aliases
      WHERE owner_user_id = ?
      ORDER BY alias, entity_id
    `).all(ownerUserId).map(parsePayload));
  }

  updateAlias(ownerUserId, alias, entityId, { expectedVersion, changes = {} } = {}) {
    this.#access(ownerUserId);
    assertAlias(alias);
    assertOpaqueEntityId(entityId);
    const current = parsePayload(this.holder.db.prepare(`
      SELECT payload_json FROM entity_aliases
      WHERE owner_user_id = ? AND alias = ? AND entity_id = ?
    `).get(ownerUserId, alias, entityId));
    if (!current) throw new EntityFoundationError('ALIAS_NOT_FOUND', 'Alias record was not found.');
    if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
      throw new EntityFoundationError('CAS_CONFLICT', 'Alias version does not match expectedVersion.');
    }
    const candidate = createEntityAlias({
      ...structuredClone(current), ...structuredClone(changes),
      schemaVersion: current.schemaVersion, alias: current.alias, entityId: current.entityId,
      ownerUserId: current.ownerUserId, version: current.version + 1
    }, { trustedOwnerUserId: ownerUserId });
    const result = this.holder.db.prepare(`
      UPDATE entity_aliases SET status = ?, version = ?, payload_json = ?
      WHERE owner_user_id = ? AND alias = ? AND entity_id = ? AND version = ?
    `).run(candidate.status, candidate.version, JSON.stringify(candidate), ownerUserId, alias, entityId, expectedVersion);
    if (Number(result.changes) !== 1) throw new EntityFoundationError('CAS_CONFLICT', 'Alias version changed.');
    return immutableCopy(candidate);
  }

  disableAlias(ownerUserId, alias, entityId, { expectedVersion, updatedAt = this.now() } = {}) {
    return this.updateAlias(ownerUserId, alias, entityId, {
      expectedVersion, changes: { status: 'inactive', updatedAt }
    });
  }
}
