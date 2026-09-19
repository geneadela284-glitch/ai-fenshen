import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityRelation,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';
import { registerEntityFoundationConformance } from './entityFoundationConformance.js';
import { createSQLiteEntityFoundation } from './sqliteFoundation.js';

const OWNER_A = ENTITY_TEST_IDS.owner;
const OWNER_B = 'user-entity-contract-b';

function permanentAcceptanceAuthorization(databasePath, originalPath) {
  return {
    authorization: {
      scope: 'local-m9-2-acceptance',
      environment: 'local-m9-2-acceptance',
      database_kind: 'isolated_acceptance_memory',
      database_path: databasePath,
      owner_source: 'authenticated_session',
      allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
      original_memory_database: { path: originalPath, access: 'read_only' },
      cross_owner_access: 'denied',
      migration_allowed: false,
      bulk_import_allowed: false,
      active_action_ids: ['M9_2_REAL_CONVERSATION_MEMORY_OS_WIRING']
    },
    scope: 'local-m9-2-acceptance',
    ownerSource: 'authenticated_session',
    actionId: 'M9_2_REAL_CONVERSATION_MEMORY_OS_WIRING'
  };
}

function createHarness() {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-'));
  const databasePath = path.join(shadowRoot, 'entity-v2-shadow.sqlite');
  let foundation = createSQLiteEntityFoundation({
    shadowRoot,
    databasePath,
    repositoryRoot: process.cwd()
  });
  return {
    get foundation() { return foundation; },
    databasePath,
    shadowRoot,
    reopen() {
      foundation.close();
      foundation = createSQLiteEntityFoundation({ shadowRoot, databasePath, repositoryRoot: process.cwd() });
      return foundation;
    },
    close() {
      foundation?.close();
      fs.rmSync(shadowRoot, { recursive: true, force: true });
    }
  };
}

registerEntityFoundationConformance('SQLite shadow foundation shared conformance', async () => {
  const harness = createHarness();
  return { foundation: harness.foundation, close: () => harness.close() };
});

test('SQLite shadow foundation rejects repository and non-temporary database paths', () => {
  const repositoryRoot = process.cwd();
  assert.throws(() => createSQLiteEntityFoundation({
    shadowRoot: repositoryRoot,
    databasePath: path.join(repositoryRoot, 'package.json'),
    repositoryRoot
  }), /shadow|temporary|repository/i);
});

test('SQLite foundation opens only the exact permanent acceptance path authorized by canonical scope', (t) => {
  const acceptanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-2-acceptance-runtime-'));
  const originalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-2-original-memory-'));
  const databasePath = path.join(acceptanceRoot, 'memory.sqlite');
  const originalPath = path.join(originalRoot, 'memory.sqlite');
  const realDataAccess = permanentAcceptanceAuthorization(databasePath, originalPath);
  const foundation = createSQLiteEntityFoundation({
    shadowRoot: acceptanceRoot,
    databasePath,
    repositoryRoot: process.cwd(),
    realDataAccess
  });
  t.after(() => {
    foundation.close();
    fs.rmSync(acceptanceRoot, { recursive: true, force: true });
    fs.rmSync(originalRoot, { recursive: true, force: true });
  });
  assert.equal(foundation.databasePath, databasePath);
  assert.deepEqual(foundation.diagnostics.domainTables(), [
    'entities', 'entity_aliases', 'entity_relations', 'memory_records_v2'
  ]);
  assert.throws(() => createSQLiteEntityFoundation({
    shadowRoot: acceptanceRoot,
    databasePath: path.join(acceptanceRoot, 'other.sqlite'),
    repositoryRoot: process.cwd(),
    realDataAccess
  }), /authorization|database path|fail.closed/i);
  assert.throws(() => createSQLiteEntityFoundation({
    shadowRoot: originalRoot,
    databasePath: originalPath,
    repositoryRoot: process.cwd(),
    realDataAccess
  }), /original|read.only|fail.closed/i);
});

test('SQLite shadow schema enables owner-scoped foreign keys and required indexes', (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  assert.equal(harness.foundation.diagnostics.foreignKeysEnabled(), true);
  assert.deepEqual(harness.foundation.diagnostics.domainTables(), [
    'entities', 'entity_aliases', 'entity_relations', 'memory_records_v2'
  ]);
  for (const query of ['entity', 'alias', 'relation-effective', 'memory-entity-predicate']) {
    const plan = harness.foundation.diagnostics.queryPlan(query);
    assert.ok(plan.some((line) => /INDEX|PRIMARY KEY/i.test(line)), `${query} must use an index: ${plan}`);
    assert.equal(plan.some((line) => /SCAN (?:entities|entity_aliases|entity_relations|memory_records_v2)\b/i.test(line)), false);
  }
});

test('SQLite Entity persists across close and reopen', (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  harness.foundation.repository.create(OWNER_A, fakeEntity());
  const reopened = harness.reopen();
  assert.deepEqual(reopened.repository.getById(OWNER_A, ENTITY_TEST_IDS.daughterOne), fakeEntity());
});

test('SQLite composite foreign keys reject cross-owner relation and Memory references', (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  harness.foundation.repository.create(OWNER_B, fakeEntity({
    ownerUserId: OWNER_B,
    entityId: ENTITY_TEST_IDS.self
  }));
  harness.foundation.repository.create(OWNER_B, fakeEntity({
    ownerUserId: OWNER_B,
    entityId: ENTITY_TEST_IDS.daughterOne
  }));
  assert.throws(() => harness.foundation.relations.createRelation(OWNER_A, fakeEntityRelation()),
    (error) => error?.code === 'FOREIGN_KEY_CONSTRAINT');
  assert.throws(() => harness.foundation.memories.create(OWNER_A, fakeMemoryRecordV2()),
    (error) => error?.code === 'FOREIGN_KEY_CONSTRAINT');
});

test('SQLite restart preserves Entity, relation, and exact Memory binding', (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  for (const entity of [
    fakeEntity({ entityId: ENTITY_TEST_IDS.self }),
    fakeEntity({ entityId: ENTITY_TEST_IDS.daughterOne })
  ]) harness.foundation.repository.create(OWNER_A, entity);
  harness.foundation.relations.createRelation(OWNER_A, fakeEntityRelation());
  harness.foundation.memories.create(OWNER_A, fakeMemoryRecordV2());
  const reopened = harness.reopen();
  assert.equal(reopened.relations.listRelations(OWNER_A).length, 1);
  assert.equal(reopened.memories.getById(OWNER_A, 'memory-v2-0001').subjectEntityId,
    ENTITY_TEST_IDS.daughterOne);
});

test('SQLite owner export and deletion remove every A layer while preserving B', (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  for (const ownerUserId of [OWNER_A, OWNER_B]) {
    harness.foundation.repository.create(ownerUserId, fakeEntity({
      ownerUserId,
      entityId: ENTITY_TEST_IDS.self
    }));
    harness.foundation.repository.create(ownerUserId, fakeEntity({
      ownerUserId,
      entityId: ENTITY_TEST_IDS.daughterOne
    }));
    harness.foundation.aliases.addAlias(ownerUserId, {
      schemaVersion: 'v2',
      alias: '女儿',
      entityId: ENTITY_TEST_IDS.daughterOne,
      ownerUserId,
      source: { type: 'user_confirmed', id: `alias-${ownerUserId}` },
      confidence: 1,
      status: 'active',
      version: 1,
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:00:00.000Z',
      metadata: {}
    });
    harness.foundation.relations.createRelation(ownerUserId, fakeEntityRelation({
      ownerUserId,
      relationId: `rel_${ownerUserId}`
    }));
    harness.foundation.memories.create(ownerUserId, fakeMemoryRecordV2({
      ownerUserId,
      memoryId: `memory-${ownerUserId}`
    }));
  }

  const exportedA = harness.foundation.exportOwner(OWNER_A);
  assert.equal(exportedA.entities.length, 2);
  assert.equal(exportedA.aliases.length, 1);
  assert.equal(exportedA.relations.length, 1);
  assert.equal(exportedA.allMemories.length, 1);
  assert.equal(exportedA.currentMemories.length, 1);
  assert.ok(exportedA.entities.every((item) => item.ownerUserId === OWNER_A));
  assert.ok(exportedA.allMemories.every((item) => item.ownerUserId === OWNER_A));

  harness.foundation.deleteOwner(OWNER_A);
  assert.equal(harness.foundation.verifyOwnerDeleted(OWNER_A), true);
  assert.deepEqual(harness.foundation.exportOwner(OWNER_A), {
    entities: [],
    aliases: [],
    relations: [],
    allMemories: [],
    currentMemories: []
  });
  assert.equal(harness.foundation.verifyOwnerDeleted(OWNER_B), false);
  assert.equal(harness.foundation.exportOwner(OWNER_B).entities.length, 2);
  assert.equal(harness.foundation.exportOwner(OWNER_B).allMemories.length, 1);
});

test('SQLite Unit of Work atomically persists all four record types and replays idempotently', async (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  let runs = 0;
  const execute = () => harness.foundation.unitOfWork.run({
    ownerUserId: OWNER_A,
    idempotencyKey: 'sqlite-complete-write'
  }, async ({ repository, aliases, relations, memories }) => {
    runs += 1;
    repository.create(OWNER_A, fakeEntity({ entityId: ENTITY_TEST_IDS.self }));
    repository.create(OWNER_A, fakeEntity({ entityId: ENTITY_TEST_IDS.daughterOne }));
    aliases.addAlias(OWNER_A, {
      schemaVersion: 'v2', alias: '女儿', entityId: ENTITY_TEST_IDS.daughterOne,
      ownerUserId: OWNER_A, source: { type: 'user_confirmed', id: 'alias-daughter' },
      confidence: 1, status: 'active', version: 1,
      createdAt: '2026-07-16T12:00:00.000Z', updatedAt: '2026-07-16T12:00:00.000Z', metadata: {}
    });
    relations.createRelation(OWNER_A, fakeEntityRelation());
    memories.create(OWNER_A, fakeMemoryRecordV2());
    return { complete: true };
  });
  assert.deepEqual(await execute(), { complete: true });
  assert.deepEqual(await execute(), { complete: true });
  assert.equal(runs, 1);
  const reopened = harness.reopen();
  assert.equal(reopened.repository.listByOwner(OWNER_A).length, 2);
  assert.equal(reopened.memories.queryByEntityAndPredicate(
    OWNER_A, ENTITY_TEST_IDS.daughterOne, 'birthday'
  ).length, 1);
});

test('SQLite integrity and foreign_key checks are clean', (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  assert.equal(harness.foundation.diagnostics.integrityCheck(), 'ok');
  assert.deepEqual(harness.foundation.diagnostics.foreignKeyCheck(), []);
});

test('SQLite V1 sentinel table survives V2 shadow schema initialization unchanged', (t) => {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-'));
  const databasePath = path.join(shadowRoot, 'entity-v2-shadow.sqlite');
  const seed = new DatabaseSync(databasePath);
  seed.exec('CREATE TABLE memories_v1_sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  seed.prepare('INSERT INTO memories_v1_sentinel (id, value) VALUES (?, ?)').run('v1', 'unchanged');
  seed.close();
  const foundation = createSQLiteEntityFoundation({ shadowRoot, databasePath, repositoryRoot: process.cwd() });
  t.after(() => {
    fs.rmSync(shadowRoot, { recursive: true, force: true });
  });
  foundation.close();
  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verify.prepare('SELECT value FROM memories_v1_sentinel WHERE id = ?').get('v1').value, 'unchanged');
  verify.close();
});
