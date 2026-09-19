import { DatabaseSync } from 'node:sqlite';

import { SQLiteAliasRepository } from './sqliteAliasRepository.js';
import { SQLiteEntityRepository } from './sqliteEntityRepository.js';
import { SQLiteMemoryRecordV2Repository } from './sqliteMemoryRecordV2Repository.js';
import { SQLiteRelationRepository } from './sqliteRelationRepository.js';
import { initializeEntityV2ShadowSchema } from './sqliteSchemaRuntime.js';
import { validateShadowDatabaseLocation } from './sqliteFoundationState.js';
import { SQLiteMemoryUnitOfWork } from './sqliteUnitOfWork.js';
import { EntityFoundationError } from './inMemoryFoundationState.js';

function buildRepositories(holder, options, scopeOwnerUserId = null, transactionToken = null) {
  const shared = { ...options, scopeOwnerUserId, transactionToken };
  const repository = new SQLiteEntityRepository(holder, shared);
  const aliases = new SQLiteAliasRepository(holder, shared);
  const relations = new SQLiteRelationRepository(holder, shared);
  const memories = new SQLiteMemoryRecordV2Repository(holder, shared);
  repository.bindRelated({ aliases, relations });
  return { repository, aliases, relations, memories };
}

function diagnostics(holder) {
  return Object.freeze({
    foreignKeysEnabled: () => holder.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1,
    domainTables: () => holder.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('entities', 'entity_aliases', 'entity_relations', 'memory_records_v2')
      ORDER BY name
    `).all().map((row) => row.name),
    integrityCheck: () => holder.db.prepare('PRAGMA integrity_check').get()?.integrity_check,
    foreignKeyCheck: () => holder.db.prepare('PRAGMA foreign_key_check').all().map((row) => ({ ...row })),
    queryPlan: (query) => {
      const definitions = {
        entity: ['SELECT payload_json FROM entities WHERE owner_user_id = ? AND entity_id = ?', ['owner', 'ent_00112233445566778899aabbccddeeff']],
        alias: ["SELECT payload_json FROM entity_aliases WHERE owner_user_id = ? AND alias = ? AND status = 'active'", ['owner', 'alias']],
        'relation-effective': [
          'SELECT payload_json FROM entity_relations WHERE owner_user_id = ? AND source_entity_id = ? AND relation_kind = ? AND effective_from_ms <= ? AND (effective_to_ms IS NULL OR ? < effective_to_ms)',
          ['owner', 'ent_00112233445566778899aabbccddeeff', 'child', 1, 1]
        ],
        'memory-entity-predicate': [
          'SELECT payload_json FROM memory_records_v2 WHERE owner_user_id = ? AND subject_entity_id = ? AND predicate = ? AND status = ?',
          ['owner', 'ent_00112233445566778899aabbccddeeff', 'birthday', 'confirmed']
        ],
        'memory-query-v2': [
          `SELECT payload_json FROM memory_records_v2
           WHERE owner_user_id = ? AND subject_entity_id = ? AND predicate = ?
             AND status IN (?)
             AND json_extract(payload_json, '$.effectiveFrom') <= ?
           ORDER BY json_extract(payload_json, '$.effectiveFrom') DESC,
             json_extract(payload_json, '$.createdAt') DESC, memory_id ASC`,
          ['owner', 'ent_00112233445566778899aabbccddeeff', 'birthday', 'confirmed', '2026-07-17T06:00:00.000Z']
        ],
        'memory-v2-presence': [
          `SELECT memory_id FROM memory_records_v2
           WHERE owner_user_id = ? AND subject_entity_id = ? AND predicate = ?
           ORDER BY memory_id`,
          ['owner', 'ent_00112233445566778899aabbccddeeff', 'birthday']
        ]
      };
      const definition = definitions[query];
      if (!definition) throw new EntityFoundationError('QUERY_PLAN_UNKNOWN', 'Unknown diagnostic query.');
      return holder.db.prepare(`EXPLAIN QUERY PLAN ${definition[0]}`).all(...definition[1]).map((row) => row.detail);
    }
  });
}

export function createSQLiteEntityFoundation({
  shadowRoot,
  databasePath,
  repositoryRoot = process.cwd(),
  now,
  entityIdFactory,
  realDataAccess = null
} = {}) {
  const location = validateShadowDatabaseLocation({ shadowRoot, databasePath, repositoryRoot, realDataAccess });
  const db = new DatabaseSync(location, { timeout: 5000 });
  try {
    initializeEntityV2ShadowSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const holder = {
    db,
    location,
    closed: false,
    activeTransactionToken: null,
    savepointSequence: 0
  };
  const options = { ...(now ? { now } : {}), ...(entityIdFactory ? { entityIdFactory } : {}) };
  const repositories = buildRepositories(holder, options);
  const { repository, aliases, relations, memories } = repositories;
  const unitOfWork = new SQLiteMemoryUnitOfWork(
    holder,
    (transactionHolder, ownerUserId, transactionToken) =>
      buildRepositories(transactionHolder, options, ownerUserId, transactionToken)
  );
  function exportOwner(ownerUserId) {
    const owner = String(ownerUserId || '').trim();
    if (!owner) throw new EntityFoundationError('OWNER_REQUIRED', 'ownerUserId is required.');
    return Object.freeze({
      entities: repository.listByOwner(owner),
      aliases: aliases.listByOwner(owner),
      relations: relations.listRelations(owner),
      allMemories: memories.listByOwner(owner),
      currentMemories: memories.listByOwner(owner)
        .filter((memory) => memory.status === 'confirmed' && !memory.supersededById)
    });
  }
  function deleteOwner(ownerUserId) {
    const owner = String(ownerUserId || '').trim();
    if (!owner) throw new EntityFoundationError('OWNER_REQUIRED', 'ownerUserId is required.');
    holder.db.exec('BEGIN IMMEDIATE');
    try {
      const counts = {};
      for (const [name, sql] of [
        ['memories', 'DELETE FROM memory_records_v2 WHERE owner_user_id = ?'],
        ['relations', 'DELETE FROM entity_relations WHERE owner_user_id = ?'],
        ['aliases', 'DELETE FROM entity_aliases WHERE owner_user_id = ?'],
        ['idempotency', 'DELETE FROM entity_idempotency WHERE owner_user_id = ?'],
        ['uowReceipts', 'DELETE FROM entity_uow_receipts WHERE owner_user_id = ?'],
        ['entities', 'DELETE FROM entities WHERE owner_user_id = ?']
      ]) {
        counts[name] = Number(holder.db.prepare(sql).run(owner).changes);
      }
      holder.db.exec('COMMIT');
      return Object.freeze(counts);
    } catch (error) {
      holder.db.exec('ROLLBACK');
      throw error;
    }
  }
  function verifyOwnerDeleted(ownerUserId) {
    const owner = String(ownerUserId || '').trim();
    if (!owner) return false;
    return [
      'entities', 'entity_aliases', 'entity_relations', 'memory_records_v2',
      'entity_idempotency', 'entity_uow_receipts'
    ].every((table) => Number(holder.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ?`
    ).get(owner).count) === 0);
  }
  return Object.freeze({
    ...repositories,
    unitOfWork,
    exportOwner,
    deleteOwner,
    verifyOwnerDeleted,
    diagnostics: diagnostics(holder),
    databasePath: location,
    close() {
      if (holder.closed) return;
      if (holder.activeTransactionToken) {
        throw new EntityFoundationError('UNIT_OF_WORK_IN_PROGRESS', 'Cannot close during a Unit of Work.');
      }
      holder.db.close();
      holder.closed = true;
    }
  });
}

export { SQLiteAliasRepository } from './sqliteAliasRepository.js';
export { SQLiteEntityRepository } from './sqliteEntityRepository.js';
export { SQLiteMemoryRecordV2Repository } from './sqliteMemoryRecordV2Repository.js';
export { SQLiteRelationRepository } from './sqliteRelationRepository.js';
export { SQLiteMemoryUnitOfWork } from './sqliteUnitOfWork.js';
