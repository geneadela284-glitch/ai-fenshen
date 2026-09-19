import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';
import { buildMemoryQueryV2 } from './memoryQueryV2.js';

const OWNER_A = ENTITY_TEST_IDS.owner;
const OWNER_B = 'user-memory-query-v2-owner-b';
const NOW = '2026-07-17T06:00:00.000Z';
const MOTHER = 'ent_5061728394a5b6c7d8e9fa0b1c2d3e4f';

function addEntity(foundation, ownerUserId, entityId) {
  foundation.repository.create(ownerUserId, fakeEntity({
    ownerUserId,
    entityId,
    source: { type: 'user_confirmed', id: `source-${ownerUserId}-${entityId}` }
  }));
}

function addMemory(foundation, ownerUserId, entityId, memoryId, overrides = {}) {
  return foundation.memories.create(ownerUserId, fakeMemoryRecordV2({
    memoryId,
    ownerUserId,
    subjectEntityId: entityId,
    source: { type: 'user_confirmed', id: `source-${memoryId}` },
    ...structuredClone(overrides)
  }));
}

function queryRequest({
  ownerUserId = OWNER_A,
  subjectEntityId = MOTHER,
  readMode = 'current',
  effectiveAt,
  memoryType,
  allowedStatuses,
  limit = 20,
  cursor,
  provenancePolicy = 'trusted_v2',
  repositoryGeneration = 'memory-query-v2-generation-1'
} = {}) {
  const context = {
    ownerUserId,
    now: NOW,
    repositoryGeneration,
    entityResolution: fakeEntityResolution({
      ownerUserId,
      entityId: subjectEntityId,
      relationKind: subjectEntityId === ENTITY_TEST_IDS.self ? null : 'family',
      role: subjectEntityId === ENTITY_TEST_IDS.self ? null : 'relative',
      sourceRelationIds: subjectEntityId === ENTITY_TEST_IDS.self ? [] : ['rel_query_v2_0001'],
      resolvedAt: NOW
    })
  };
  const query = buildMemoryQueryV2(context, {
    subjectEntityId,
    predicate: 'birthday',
    readMode,
    ...(effectiveAt === undefined ? {} : { effectiveAt }),
    ...(memoryType === undefined ? {} : { memoryType }),
    ...(allowedStatuses === undefined ? {} : { allowedStatuses }),
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    provenancePolicy
  });
  return { context, query };
}

function execute(foundation, options) {
  const { context, query } = queryRequest(options);
  return foundation.memories.queryByEntityAndPredicate(context, query);
}

async function openForTest(t, createHarness) {
  const harness = await createHarness();
  t.after(async () => harness.close?.());
  return harness;
}

function assertReturnedShape(record) {
  for (const field of [
    'memoryId', 'ownerUserId', 'subjectEntityId', 'predicate', 'structuredValue',
    'status', 'checksum', 'version', 'source', 'supersedesId', 'effectiveFrom'
  ]) assert.ok(Object.hasOwn(record, field), `missing ${field}`);
}

export function registerMemoryQueryV2Conformance(label, createHarness) {
  test(`${label}: exact mother, daughters, same-name friends, and self never cross Entity scope`, async (t) => {
    const { foundation } = await openForTest(t, createHarness);
    const entities = [
      MOTHER,
      ENTITY_TEST_IDS.daughterOne,
      ENTITY_TEST_IDS.daughterTwo,
      ENTITY_TEST_IDS.friendOne,
      ENTITY_TEST_IDS.friendTwo,
      ENTITY_TEST_IDS.self
    ];
    entities.forEach((entityId) => addEntity(foundation, OWNER_A, entityId));
    entities.forEach((entityId, index) => addMemory(
      foundation,
      OWNER_A,
      entityId,
      `memory-query-exact-${index}`,
      { structuredValue: { date: `200${index}-01-0${index + 1}` } }
    ));

    for (const [index, entityId] of entities.entries()) {
      const page = execute(foundation, { subjectEntityId: entityId });
      assert.deepEqual(page.items.map((item) => item.memoryId), [`memory-query-exact-${index}`]);
      assert.equal(page.items[0].subjectEntityId, entityId);
      assertReturnedShape(page.items[0]);
    }
  });

  test(`${label}: owner, Entity, predicate, status, time, type, and provenance are hard filters`, async (t) => {
    const { foundation } = await openForTest(t, createHarness);
    for (const [owner, entity] of [
      [OWNER_A, MOTHER],
      [OWNER_A, ENTITY_TEST_IDS.daughterOne],
      [OWNER_B, MOTHER]
    ]) addEntity(foundation, owner, entity);

    addMemory(foundation, OWNER_A, MOTHER, 'memory-filter-match');
    addMemory(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne, 'memory-filter-wrong-entity');
    addMemory(foundation, OWNER_B, MOTHER, 'memory-filter-wrong-owner');
    addMemory(foundation, OWNER_A, MOTHER, 'memory-filter-deleted', { status: 'deleted' });
    addMemory(foundation, OWNER_A, MOTHER, 'memory-filter-archived', { status: 'archived' });
    addMemory(foundation, OWNER_A, MOTHER, 'memory-filter-expired', {
      expiresAt: '2026-07-17T05:59:59.999Z'
    });
    addMemory(foundation, OWNER_A, MOTHER, 'memory-filter-future', {
      effectiveFrom: '2026-07-17T06:00:00.001Z'
    });
    addMemory(foundation, OWNER_A, MOTHER, 'memory-filter-preference', {
      memoryType: 'preference'
    });
    addMemory(foundation, OWNER_A, MOTHER, 'memory-filter-system', {
      provenance: 'system_verified',
      source: { type: 'system_verified', id: 'source-system-verified' }
    });

    assert.deepEqual(
      execute(foundation, { subjectEntityId: MOTHER, memoryType: 'fact' }).items.map((item) => item.memoryId),
      ['memory-filter-match', 'memory-filter-system']
    );
    assert.deepEqual(
      execute(foundation, {
        subjectEntityId: MOTHER,
        memoryType: 'fact',
        provenancePolicy: 'user_confirmed_v2'
      }).items.map((item) => item.memoryId),
      ['memory-filter-match']
    );
    assert.deepEqual(execute(foundation, { ownerUserId: OWNER_B, subjectEntityId: MOTHER }).items.map(
      (item) => item.memoryId
    ), ['memory-filter-wrong-owner']);
  });

  test(`${label}: current correction returns latest and a version fork fails closed`, async (t) => {
    const { foundation } = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, MOTHER);
    addMemory(foundation, OWNER_A, MOTHER, 'memory-version-old', {
      structuredValue: { date: '1960-01-01' },
      status: 'superseded',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
      supersededById: 'memory-version-current'
    });
    addMemory(foundation, OWNER_A, MOTHER, 'memory-version-current', {
      structuredValue: { date: '1960-01-02' },
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
      version: 2,
      supersedesId: 'memory-version-old'
    });
    assert.deepEqual(execute(foundation, { subjectEntityId: MOTHER }).items.map(
      (item) => item.memoryId
    ), ['memory-version-current']);

    addMemory(foundation, OWNER_A, MOTHER, 'memory-version-fork', {
      structuredValue: { date: '1960-01-03' },
      effectiveFrom: '2025-02-01T00:00:00.000Z',
      createdAt: '2025-02-01T00:00:00.000Z',
      version: 2,
      supersedesId: 'memory-version-old'
    });
    assert.throws(
      () => execute(foundation, { subjectEntityId: MOTHER }),
      (error) => error?.code === 'MEMORY_CONFLICT'
    );
  });

  test(`${label}: historical effectiveAt returns the version valid at that instant`, async (t) => {
    const { foundation } = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, MOTHER);
    addMemory(foundation, OWNER_A, MOTHER, 'memory-history-old', {
      structuredValue: { date: '1960-02-01' },
      status: 'superseded',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
      supersededById: 'memory-history-new'
    });
    addMemory(foundation, OWNER_A, MOTHER, 'memory-history-new', {
      structuredValue: { date: '1960-02-02' },
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
      version: 2,
      supersedesId: 'memory-history-old'
    });
    assert.deepEqual(execute(foundation, {
      subjectEntityId: MOTHER,
      readMode: 'historical',
      effectiveAt: '2024-06-01T00:00:00.000Z'
    }).items.map((item) => item.memoryId), ['memory-history-old']);
    assert.deepEqual(execute(foundation, {
      subjectEntityId: MOTHER,
      readMode: 'historical',
      effectiveAt: '2026-06-01T00:00:00.000Z'
    }).items.map((item) => item.memoryId), ['memory-history-new']);
  });

  test(`${label}: opaque cursor pagination is stable without duplicates or omissions`, async (t) => {
    const { foundation } = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, MOTHER);
    for (let index = 0; index < 5; index += 1) {
      addMemory(foundation, OWNER_A, MOTHER, `memory-page-${index}`, {
        structuredValue: { date: `1970-01-0${index + 1}` },
        effectiveFrom: `202${index}-01-01T00:00:00.000Z`,
        createdAt: `202${index}-01-01T00:00:00.000Z`
      });
    }
    const collected = [];
    let cursor = null;
    do {
      const page = execute(foundation, { subjectEntityId: MOTHER, limit: 2, cursor });
      collected.push(...page.items.map((item) => item.memoryId));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(collected, [
      'memory-page-4',
      'memory-page-3',
      'memory-page-2',
      'memory-page-1',
      'memory-page-0'
    ]);
    assert.equal(new Set(collected).size, collected.length);
  });

  test(`${label}: cursor rejects tampering and reuse across owner or Entity`, async (t) => {
    const { foundation } = await openForTest(t, createHarness);
    for (const [owner, entity] of [
      [OWNER_A, MOTHER],
      [OWNER_A, ENTITY_TEST_IDS.daughterOne],
      [OWNER_B, MOTHER]
    ]) addEntity(foundation, owner, entity);
    for (let index = 0; index < 3; index += 1) {
      addMemory(foundation, OWNER_A, MOTHER, `memory-cursor-${index}`, {
        structuredValue: { date: `1980-01-0${index + 1}` },
        effectiveFrom: `202${index}-01-01T00:00:00.000Z`,
        createdAt: `202${index}-01-01T00:00:00.000Z`
      });
    }
    const cursor = execute(foundation, { subjectEntityId: MOTHER, limit: 1 }).nextCursor;
    assert.ok(typeof cursor === 'string' && cursor.length > 20);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    for (const options of [
      { subjectEntityId: MOTHER, limit: 1, cursor: tampered },
      { subjectEntityId: ENTITY_TEST_IDS.daughterOne, limit: 1, cursor },
      { ownerUserId: OWNER_B, subjectEntityId: MOTHER, limit: 1, cursor }
    ]) {
      assert.throws(
        () => execute(foundation, options),
        (error) => ['CURSOR_INVALID', 'CURSOR_SCOPE_MISMATCH'].includes(error?.code)
      );
    }
  });

  test(`${label}: exact query uses a scoped index and never scans all memories`, async (t) => {
    const harness = await openForTest(t, createHarness);
    addEntity(harness.foundation, OWNER_A, MOTHER);
    addMemory(harness.foundation, OWNER_A, MOTHER, 'memory-no-scan');
    await harness.assertNoFullScan();
    assert.deepEqual(execute(harness.foundation, { subjectEntityId: MOTHER }).items.map(
      (item) => item.memoryId
    ), ['memory-no-scan']);
  });

  for (const [field, value] of [
    ['subjectEntityId', ENTITY_TEST_IDS.daughterOne],
    ['predicate', 'predicate-mismatch']
  ]) {
    test(`${label}: indexed ${field} and payload mismatch fails closed`, async (t) => {
      const harness = await openForTest(t, createHarness);
      addEntity(harness.foundation, OWNER_A, MOTHER);
      if (field === 'subjectEntityId') addEntity(harness.foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
      addMemory(harness.foundation, OWNER_A, MOTHER, `memory-corrupt-${field}`);
      await harness.corruptScopedRecord(`memory-corrupt-${field}`, field, value);
      assert.throws(
        () => execute(harness.foundation, { subjectEntityId: MOTHER }),
        (error) => error?.code === 'REPOSITORY_SCOPE_VIOLATION'
      );
    });
  }

  test(`${label}: restart preserves exact results and cursor ordering`, async (t) => {
    const harness = await openForTest(t, createHarness);
    addEntity(harness.foundation, OWNER_A, MOTHER);
    for (let index = 0; index < 3; index += 1) {
      addMemory(harness.foundation, OWNER_A, MOTHER, `memory-restart-${index}`, {
        structuredValue: { date: `1990-01-0${index + 1}` },
        effectiveFrom: `202${index}-01-01T00:00:00.000Z`,
        createdAt: `202${index}-01-01T00:00:00.000Z`
      });
    }
    const before = execute(harness.foundation, { subjectEntityId: MOTHER, limit: 2 });
    await harness.reopen();
    const after = execute(harness.foundation, { subjectEntityId: MOTHER, limit: 2 });
    assert.deepEqual(after, before);
    const continued = execute(harness.foundation, {
      subjectEntityId: MOTHER,
      limit: 2,
      cursor: before.nextCursor
    });
    assert.deepEqual(continued.items.map((item) => item.memoryId), ['memory-restart-0']);
  });
}
