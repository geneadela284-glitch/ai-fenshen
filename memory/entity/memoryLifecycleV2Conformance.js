import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMemoryRecallCacheKeyV2,
  createMemoryLifecycleV2,
  validateMemoryInvalidationV2
} from './memoryLifecycleV2.js';
import { buildMemoryQueryV2 } from './memoryQueryV2.js';
import { validateMemoryRecordV2LifecycleRepositoryInterface } from './interfaces.js';
import { groundRankedEvidenceV2 } from '../recall/groundingV2.js';
import { rankScopedMemoryCandidatesV2 } from '../recall/rankingV2.js';
import { executeV2FirstRead } from '../recall/v2FirstRead.js';
import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const OWNER_A = ENTITY_TEST_IDS.owner;
const OWNER_B = 'user-lifecycle-other';
const MOTHER = 'ent_5061728394a5b6c7d8e9fa0b1c2d3e4f';
const DAUGHTER_A = ENTITY_TEST_IDS.daughterOne;
const DAUGHTER_B = ENTITY_TEST_IDS.daughterTwo;
const FRIEND_A = ENTITY_TEST_IDS.friendOne;
const FRIEND_B = ENTITY_TEST_IDS.friendTwo;
const ORIGINAL_ID = 'memory-lifecycle-original';
const ORIGINAL_DATE = '1960-05-06';
const CORRECTED_DATE = '1960-05-08';
const EFFECTIVE_FROM = '2020-01-01T00:00:00.000Z';

function seedEntity(foundation, entityId = MOTHER, ownerUserId = OWNER_A) {
  foundation.repository.create(ownerUserId, fakeEntity({
    ownerUserId,
    entityId,
    source: { type: 'user_confirmed', id: `entity:${ownerUserId}:${entityId}` }
  }));
}

function seedMemory(foundation, {
  ownerUserId = OWNER_A,
  subjectEntityId = MOTHER,
  memoryId = ORIGINAL_ID,
  date = ORIGINAL_DATE,
  ...overrides
} = {}) {
  const record = fakeMemoryRecordV2({
    ownerUserId,
    subjectEntityId,
    memoryId,
    structuredValue: { date },
    displayValue: date,
    source: { type: 'user_confirmed', id: `source:${memoryId}` },
    sourceTimestamp: EFFECTIVE_FROM,
    createdAt: EFFECTIVE_FROM,
    updatedAt: EFFECTIVE_FROM,
    effectiveFrom: EFFECTIVE_FROM,
    ...overrides
  });
  return foundation.memories.create(ownerUserId, record);
}

function lifecycle(harness, { ids = ['memory-lifecycle-corrected'], faultInjector = () => {} } = {}) {
  let index = 0;
  return createMemoryLifecycleV2({
    foundation: harness.foundation,
    now: () => harness.now(),
    memoryIdFactory: () => ids[index++] ?? `memory-lifecycle-generated-${index}`,
    faultInjector
  });
}

function command(lifecycleAction, overrides = {}) {
  return {
    schemaVersion: 'v2',
    lifecycleAction,
    subjectEntityId: MOTHER,
    predicate: 'birthday',
    memoryId: ORIGINAL_ID,
    expectedVersion: 1,
    idempotencyKey: `lifecycle:${lifecycleAction}:${ORIGINAL_ID}`,
    structuredValue: lifecycleAction === 'correction' ? { date: CORRECTED_DATE } : null,
    confirmed: lifecycleAction === 'purge',
    ...structuredClone(overrides)
  };
}

function context(ownerUserId = OWNER_A) {
  return { ownerUserId };
}

function queryRequest(harness, {
  ownerUserId = OWNER_A,
  subjectEntityId = MOTHER,
  readMode = 'current',
  effectiveAt,
  repositoryGeneration = 'memory-lifecycle-v2-generation'
} = {}) {
  const now = harness.now();
  const queryContext = {
    ownerUserId,
    now,
    repositoryGeneration,
    entityResolution: fakeEntityResolution({
      ownerUserId,
      entityId: subjectEntityId,
      predicate: 'birthday',
      resolvedAt: now
    })
  };
  const query = buildMemoryQueryV2(queryContext, {
    subjectEntityId,
    predicate: 'birthday',
    readMode,
    ...(effectiveAt ? { effectiveAt } : {}),
    provenancePolicy: 'trusted_v2',
    limit: 20
  });
  return { context: queryContext, query };
}

function ranker({ candidates }) {
  return candidates.map((candidate) => ({
    memoryId: candidate.memoryId,
    ownerUserId: candidate.ownerUserId,
    subjectEntityId: candidate.subjectEntityId,
    predicate: candidate.predicate,
    checksum: candidate.checksum,
    provenance: structuredClone(candidate.provenance),
    reasonCodes: ['LIFECYCLE_SCOPE_OK']
  }));
}

function currentPage(harness, options = {}) {
  const request = queryRequest(harness, options);
  return {
    ...request,
    page: harness.foundation.memories.queryByEntityAndPredicate(request.context, request.query)
  };
}

function recall(harness, calls = [], options = {}) {
  const request = queryRequest(harness, options);
  return executeV2FirstRead({
    ...request,
    v2Repository: harness.foundation.memories,
    legacyAdapter: { query() { calls.push('legacy'); return []; } },
    queryPurpose: 'answer_exact_person_fact',
    ranker
  });
}

function setup(harness) {
  seedEntity(harness.foundation);
  return seedMemory(harness.foundation);
}

async function openForTest(t, createHarness) {
  const harness = await createHarness();
  t.after(async () => harness.close?.());
  return harness;
}

async function correct(harness, overrides = {}, serviceOptions = {}) {
  return lifecycle(harness, serviceOptions).execute(context(), command('correction', overrides));
}

async function softDelete(harness, memoryId, expectedVersion, overrides = {}) {
  return lifecycle(harness).execute(context(), command('delete', {
    memoryId,
    expectedVersion,
    idempotencyKey: `lifecycle:delete:${memoryId}`,
    ...overrides
  }));
}

class FakeCacheSpy {
  constructor() {
    this.values = new Map();
    this.invalidations = [];
    this.permanentlyInvalid = new Set();
  }

  set(key, value) { this.values.set(key, structuredClone(value)); }

  invalidate(event) {
    this.invalidations.push(event);
    this.values.clear();
    if (event.lifecycleAction === 'purge') {
      this.permanentlyInvalid.add(`${event.ownerUserId}:${event.subjectEntityId}:${event.predicate}`);
    }
  }

  get(key) { return this.values.get(key) ?? null; }
}

function assertCode(code) {
  return (error) => error?.code === code;
}

export function registerMemoryLifecycleV2Conformance(label, createHarness) {
  test(`${label}: correction creates a same-scope superseding version and current returns 5月8日 only`, async (t) => {
    const harness = await openForTest(t, createHarness);
    const original = setup(harness);
    const result = await correct(harness);
    const old = harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID);
    const current = harness.foundation.memories.getById(OWNER_A, result.memoryId);
    assert.equal(result.outcome, 'corrected');
    assert.equal(current.subjectEntityId, original.subjectEntityId);
    assert.equal(current.ownerUserId, original.ownerUserId);
    assert.equal(current.predicate, original.predicate);
    assert.deepEqual(current.structuredValue, { date: CORRECTED_DATE });
    assert.equal(current.supersedesId, ORIGINAL_ID);
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededById, current.memoryId);
    assert.deepEqual(current.source, original.source);
    assert.equal(current.sourceTimestamp, original.sourceTimestamp);
    assert.equal(current.metadata.lifecycleAudit.previousChecksum, original.checksum);
    assert.deepEqual(currentPage(harness).page.items.map((item) => item.structuredValue.date), [CORRECTED_DATE]);
  });

  test(`${label}: historical correction reads 5月6日 while current Ranking Grounding Safe Answer uses 5月8日`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    await correct(harness);
    const historical = queryRequest(harness, { readMode: 'historical', effectiveAt: '2025-01-01T00:00:00.000Z' });
    const page = harness.foundation.memories.queryByEntityAndPredicate(historical.context, historical.query);
    assert.deepEqual(page.items.map((item) => item.structuredValue.date), [ORIGINAL_DATE]);
    const result = recall(harness);
    assert.equal(result.outcome, 'fact');
    assert.equal(result.groundingResult.structuredValue.date, CORRECTED_DATE);
    assert.equal(result.safeAnswer.type, 'fact');
  });

  test(`${label}: ordinary correction rejects Entity rebind with rebind_required and leaves source intact`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    seedEntity(harness.foundation, DAUGHTER_A);
    await assert.rejects(correct(harness, { subjectEntityId: DAUGHTER_A }), assertCode('REBIND_REQUIRED'));
    assert.equal(harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID).status, 'confirmed');
  });

  test(`${label}: two concurrent corrections of one old version produce MEMORY_CONFLICT without a second branch`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const service = lifecycle(harness, { ids: ['memory-correction-a', 'memory-correction-b'] });
    const results = await Promise.allSettled([
      service.execute(context(), command('correction', { idempotencyKey: 'correction-a' })),
      service.execute(context(), command('correction', { idempotencyKey: 'correction-b', structuredValue: { date: '1960-05-09' } }))
    ]);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter((item) => item.status === 'rejected')[0].reason.code, 'MEMORY_CONFLICT');
    assert.equal(harness.foundation.memories.listByEntityAndPredicateForLifecycle(OWNER_A, MOTHER, 'birthday')
      .filter((item) => item.supersedesId === ORIGINAL_ID).length, 1);
  });

  test(`${label}: correction rollback and idempotent replay create neither partial nor duplicate versions`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const failing = lifecycle(harness, { faultInjector(phase) { if (phase === 'after_previous_superseded') throw new Error('fake failure'); } });
    await assert.rejects(failing.execute(context(), command('correction')), /fake failure/);
    assert.equal(harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID).status, 'confirmed');
    assert.equal(harness.foundation.memories.listByEntityAndPredicateForLifecycle(OWNER_A, MOTHER, 'birthday').length, 1);
    const service = lifecycle(harness);
    const first = await service.execute(context(), command('correction'));
    const replay = await service.execute(context(), command('correction'));
    assert.deepEqual(replay, first);
    await assert.rejects(service.execute(context(), command('correction', {
      structuredValue: { date: '1960-05-09' }
    })), assertCode('IDEMPOTENCY_CONFLICT'));
    assert.equal(harness.foundation.memories.listByEntityAndPredicateForLifecycle(OWNER_A, MOTHER, 'birthday').length, 2);
  });

  test(`${label}: delete removes current answer and deleted tombstone suppresses Legacy fallback`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const result = await softDelete(harness, ORIGINAL_ID, 1);
    assert.equal(result.outcome, 'deleted');
    assert.equal(currentPage(harness).page.items.length, 0);
    const calls = [];
    const recalled = recall(harness, calls);
    assert.equal(recalled.outcome, 'not_found');
    assert.ok(recalled.v2Presence.reasons.includes('deleted_tombstone'));
    assert.equal(calls.length, 0);
  });

  test(`${label}: deleted evidence cannot enter Ranking or Grounding, Entity remains, and replay is idempotent`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const before = currentPage(harness);
    const ranking = rankScopedMemoryCandidatesV2({ ...before, queryPurpose: 'answer_exact_person_fact', ranker });
    const service = lifecycle(harness);
    const deletion = command('delete');
    const first = await service.execute(context(), deletion);
    const replay = await service.execute(context(), deletion);
    assert.deepEqual(replay, first);
    const after = currentPage(harness);
    assert.throws(() => rankScopedMemoryCandidatesV2({ ...after, queryPurpose: 'answer_exact_person_fact', ranker }), assertCode('RANKING_INPUT_EMPTY'));
    assert.equal(groundRankedEvidenceV2({ ...before, rankingResult: ranking, repository: harness.foundation.memories }).grounded, false);
    assert.ok(harness.foundation.repository.getById(OWNER_A, MOTHER));
    assert.equal(harness.foundation.memories.listByEntityAndPredicateForLifecycle(OWNER_A, MOTHER, 'birthday').length, 1);
  });

  test(`${label}: deleted tombstone and suppression survive close and reopen`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    await softDelete(harness, ORIGINAL_ID, 1);
    await harness.reopen();
    assert.equal(harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID).status, 'deleted');
    const calls = [];
    assert.equal(recall(harness, calls).outcome, 'not_found');
    assert.equal(calls.length, 0);
  });

  test(`${label}: restore makes deleted fact current and checksum provenance Ranking Grounding remain valid`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const deleted = await softDelete(harness, ORIGINAL_ID, 1);
    const restored = await lifecycle(harness).execute(context(), command('restore', {
      expectedVersion: deleted.invalidation.newVersion,
      idempotencyKey: 'restore-original'
    }));
    assert.equal(restored.outcome, 'restored');
    const record = harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID);
    assert.equal(record.status, 'confirmed');
    assert.equal(record.source.type, 'user_confirmed');
    const result = recall(harness);
    assert.equal(result.outcome, 'fact');
    assert.equal(result.groundingResult.checksum, record.checksum);
    assert.deepEqual(result.groundingResult.source, record.source);
    assert.equal(result.v2Presence.suppressLegacy, true);
  });

  test(`${label}: restore refuses superseded old version as current`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    await correct(harness);
    const old = harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID);
    await assert.rejects(lifecycle(harness).execute(context(), command('restore', {
      expectedVersion: old.version,
      idempotencyKey: 'restore-superseded'
    })), assertCode('RESTORE_SUPERSEDED_FORBIDDEN'));
  });

  test(`${label}: restore rejects cross-owner and cross-Entity scope`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const deleted = await softDelete(harness, ORIGINAL_ID, 1);
    await assert.rejects(lifecycle(harness).execute(context(OWNER_B), command('restore', {
      expectedVersion: deleted.invalidation.newVersion,
      idempotencyKey: 'restore-other-owner'
    })), assertCode('MEMORY_NOT_FOUND'));
    seedEntity(harness.foundation, DAUGHTER_A);
    await assert.rejects(lifecycle(harness).execute(context(), command('restore', {
      subjectEntityId: DAUGHTER_A,
      expectedVersion: deleted.invalidation.newVersion,
      idempotencyKey: 'restore-other-entity'
    })), assertCode('ENTITY_SCOPE_MISMATCH'));
  });

  test(`${label}: restore CAS/fault conflict rolls back and successful replay is idempotent`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const deleted = await softDelete(harness, ORIGINAL_ID, 1);
    await assert.rejects(lifecycle(harness).execute(context(), command('restore', {
      expectedVersion: 999,
      idempotencyKey: 'restore-stale'
    })), assertCode('CAS_CONFLICT'));
    const failing = lifecycle(harness, { faultInjector(phase) { if (phase === 'after_restore') throw new Error('restore fault'); } });
    await assert.rejects(failing.execute(context(), command('restore', {
      expectedVersion: deleted.invalidation.newVersion,
      idempotencyKey: 'restore-fault'
    })), /restore fault/);
    assert.equal(harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID).status, 'deleted');
    const service = lifecycle(harness);
    const restoreCommand = command('restore', { expectedVersion: deleted.invalidation.newVersion, idempotencyKey: 'restore-once' });
    const first = await service.execute(context(), restoreCommand);
    assert.deepEqual(await service.execute(context(), restoreCommand), first);
  });

  test(`${label}: purge requires confirmation then removes current and historical body and refuses restore`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const service = lifecycle(harness);
    const pending = await service.execute(context(), command('purge', { confirmed: false }));
    assert.equal(pending.outcome, 'confirmation_required');
    assert.equal(pending.confirmationRequired, true);
    assert.deepEqual(harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID).structuredValue, { date: ORIGINAL_DATE });
    const purged = await service.execute(context(), command('purge', { idempotencyKey: 'purge-confirmed' }));
    assert.equal(purged.outcome, 'purged');
    assert.equal(currentPage(harness).page.items.length, 0);
    const historical = queryRequest(harness, { readMode: 'historical', effectiveAt: '2025-01-01T00:00:00.000Z' });
    assert.equal(harness.foundation.memories.queryByEntityAndPredicate(historical.context, historical.query).items.length, 0);
    const marker = harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID);
    assert.equal(marker.metadata.purgedMarker, true);
    assert.equal('structuredValue' in marker, false);
    assert.equal(JSON.stringify(marker).includes(ORIGINAL_DATE), false);
    await assert.rejects(lifecycle(harness).execute(context(), command('restore', {
      expectedVersion: marker.version,
      idempotencyKey: 'restore-purged'
    })), assertCode('MEMORY_PURGED'));
  });

  test(`${label}: purged marker suppresses Legacy and stale Ranking Grounding evidence`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const before = currentPage(harness);
    const ranking = rankScopedMemoryCandidatesV2({ ...before, queryPurpose: 'answer_exact_person_fact', ranker });
    await lifecycle(harness).execute(context(), command('purge'));
    const calls = [];
    const result = recall(harness, calls);
    assert.equal(result.outcome, 'not_found');
    assert.ok(result.v2Presence.reasons.includes('purged_marker'));
    assert.equal(calls.length, 0);
    assert.throws(() => rankScopedMemoryCandidatesV2({ ...currentPage(harness), queryPurpose: 'answer_exact_person_fact', ranker }), assertCode('RANKING_INPUT_EMPTY'));
    assert.equal(groundRankedEvidenceV2({ ...before, rankingResult: ranking, repository: harness.foundation.memories }).grounded, false);
  });

  test(`${label}: purge permanently invalidates Fake Cache and replay creates one content-free marker`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const cache = new FakeCacheSpy();
    const cacheKey = buildMemoryRecallCacheKeyV2({
      ownerUserId: OWNER_A,
      subjectEntityId: MOTHER,
      predicate: 'birthday',
      generation: 'generation-before-purge',
      invalidationToken: '0'.repeat(64),
      readMode: 'current'
    });
    cache.set(cacheKey, { date: ORIGINAL_DATE });
    const service = lifecycle(harness);
    const purgeCommand = command('purge');
    const first = await service.execute(context(), purgeCommand);
    const replay = await service.execute(context(), purgeCommand);
    cache.invalidate(first.invalidation);
    assert.deepEqual(replay, first);
    assert.equal(cache.get(cacheKey), null);
    assert.equal(cache.permanentlyInvalid.has(`${OWNER_A}:${MOTHER}:birthday`), true);
    assert.equal(harness.foundation.memories.listByEntityAndPredicateForLifecycle(OWNER_A, MOTHER, 'birthday').length, 1);
    assert.equal('structuredValue' in harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID), false);
  });

  test(`${label}: purged marker survives close and reopen without recoverable body`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    await lifecycle(harness).execute(context(), command('purge'));
    await harness.reopen();
    const marker = harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID);
    assert.equal(marker.metadata.purgedMarker, true);
    assert.equal('structuredValue' in marker, false);
    assert.equal(recall(harness).outcome, 'not_found');
  });

  test(`${label}: two daughters and same-name friends remain exact lifecycle scopes`, async (t) => {
    const harness = await openForTest(t, createHarness);
    for (const entityId of [DAUGHTER_A, DAUGHTER_B, FRIEND_A, FRIEND_B]) seedEntity(harness.foundation, entityId);
    seedMemory(harness.foundation, { subjectEntityId: DAUGHTER_A, memoryId: 'daughter-a', date: '2010-01-01' });
    seedMemory(harness.foundation, { subjectEntityId: DAUGHTER_B, memoryId: 'daughter-b', date: '2011-01-01' });
    seedMemory(harness.foundation, { subjectEntityId: FRIEND_A, memoryId: 'friend-a', date: '1980-01-01' });
    seedMemory(harness.foundation, { subjectEntityId: FRIEND_B, memoryId: 'friend-b', date: '1981-01-01' });
    await lifecycle(harness).execute(context(), command('delete', {
      subjectEntityId: DAUGHTER_A,
      memoryId: 'daughter-a',
      idempotencyKey: 'delete-daughter-a'
    }));
    await lifecycle(harness).execute(context(), command('correction', {
      subjectEntityId: FRIEND_A,
      memoryId: 'friend-a',
      idempotencyKey: 'correct-friend-a',
      structuredValue: { date: '1980-01-02' }
    }));
    assert.equal(harness.foundation.memories.getById(OWNER_A, 'daughter-b').status, 'confirmed');
    assert.deepEqual(harness.foundation.memories.getById(OWNER_A, 'friend-b').structuredValue, { date: '1981-01-01' });
  });

  test(`${label}: cross-owner commands and relation labels fail closed`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    await assert.rejects(lifecycle(harness).execute(context(OWNER_B), command('delete')), assertCode('MEMORY_NOT_FOUND'));
    await assert.rejects(lifecycle(harness).execute(context(), command('delete', {
      subjectEntityId: 'family:mother',
      idempotencyKey: 'delete-relation-label'
    })), assertCode('ENTITY_ID_INVALID'));
    await assert.rejects(lifecycle(harness).execute(context(), {
      ...command('delete'),
      offset: 0
    }), assertCode('LIFECYCLE_UNKNOWN_FIELD'));
    assert.equal(harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID).status, 'confirmed');
  });

  test(`${label}: invalidation contract binds scope/action/version and every lifecycle token/cache key changes`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const corrected = await correct(harness);
    const deleted = await softDelete(harness, corrected.memoryId, corrected.invalidation.newVersion);
    const restored = await lifecycle(harness).execute(context(), command('restore', {
      memoryId: corrected.memoryId,
      expectedVersion: deleted.invalidation.newVersion,
      idempotencyKey: 'restore-sequence'
    }));
    const purged = await lifecycle(harness).execute(context(), command('purge', {
      memoryId: corrected.memoryId,
      expectedVersion: restored.invalidation.newVersion,
      idempotencyKey: 'purge-sequence'
    }));
    assert.equal(
      harness.foundation.memories.listByEntityAndPredicateForLifecycle(OWNER_A, MOTHER, 'birthday').length,
      1
    );
    const historical = queryRequest(harness, {
      readMode: 'historical',
      effectiveAt: '2025-01-01T00:00:00.000Z'
    });
    assert.equal(
      harness.foundation.memories.queryByEntityAndPredicate(historical.context, historical.query).items.length,
      0
    );
    const events = [corrected, deleted, restored, purged].map((result) => result.invalidation);
    assert.equal(new Set(events.map((event) => event.invalidationToken)).size, 4);
    assert.ok(events.every((event) => validateMemoryInvalidationV2(event, { trustedOwnerUserId: OWNER_A }).valid));
    assert.equal(validateMemoryInvalidationV2({
      ...events[0],
      invalidationToken: 'f'.repeat(64)
    }, { trustedOwnerUserId: OWNER_A }).valid, false);
    const keys = events.map((event, index) => buildMemoryRecallCacheKeyV2({
      ownerUserId: OWNER_A,
      subjectEntityId: MOTHER,
      predicate: 'birthday',
      generation: `generation-${index}`,
      invalidationToken: event.invalidationToken,
      readMode: index === 0 ? 'historical' : 'current'
    }));
    assert.equal(new Set(keys).size, 4);
  });

  test(`${label}: Unit of Work failure leaves no partial purge/suppression and lifecycle needs no model`, async (t) => {
    const harness = await openForTest(t, createHarness);
    setup(harness);
    const service = lifecycle(harness, { faultInjector(phase) { if (phase === 'after_purge') throw new Error('purge fault'); } });
    assert.deepEqual(Object.keys(service), ['execute']);
    assert.equal(validateMemoryRecordV2LifecycleRepositoryInterface(harness.foundation.memories).valid, true);
    await assert.rejects(service.execute(context(), command('purge')), /purge fault/);
    const record = harness.foundation.memories.getById(OWNER_A, ORIGINAL_ID);
    assert.equal(record.status, 'confirmed');
    assert.deepEqual(record.structuredValue, { date: ORIGINAL_DATE });
    assert.equal(currentPage(harness).page.items.length, 1);
    assert.equal(harness.foundation.memories.inspectPresenceByEntityAndPredicate(
      queryRequest(harness).context,
      queryRequest(harness).query
    ).reasons.includes('purged_marker'), false);
  });
}
