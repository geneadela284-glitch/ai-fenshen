import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_TEST_IDS,
  fakeEntityResolution
} from '../../testing/entityFixtures.js';

const QueryModule = await import('./memoryQueryV2.js').catch(() => ({}));

const NOW = '2026-07-17T06:00:00.000Z';

function context(overrides = {}) {
  return {
    ownerUserId: ENTITY_TEST_IDS.owner,
    now: NOW,
    repositoryGeneration: 'entity-v2-test-generation-1',
    entityResolution: fakeEntityResolution({ resolvedAt: NOW }),
    ...structuredClone(overrides)
  };
}

function input(overrides = {}) {
  return {
    subjectEntityId: ENTITY_TEST_IDS.daughterOne,
    predicate: 'birthday',
    readMode: 'current',
    limit: 2,
    provenancePolicy: 'trusted_v2',
    ...structuredClone(overrides)
  };
}

test('MemoryQueryV2 freezes the exact read contract', () => {
  assert.deepEqual(QueryModule.MemoryQueryV2?.fields, [
    'schemaVersion',
    'ownerUserId',
    'subjectEntityId',
    'predicate',
    'effectiveAt',
    'memoryType',
    'allowedStatuses',
    'limit',
    'cursor',
    'provenancePolicy',
    'readMode'
  ]);
  assert.equal(QueryModule.MemoryQueryV2?.unknownFieldPolicy, 'reject');
  assert.ok(Object.isFrozen(QueryModule.MemoryQueryV2));
});

test('buildMemoryQueryV2 copies owner and current time only from trusted context', () => {
  const query = QueryModule.buildMemoryQueryV2(context(), input());
  assert.deepEqual(query, {
    schemaVersion: 'v2',
    ownerUserId: ENTITY_TEST_IDS.owner,
    subjectEntityId: ENTITY_TEST_IDS.daughterOne,
    predicate: 'birthday',
    effectiveAt: NOW,
    memoryType: null,
    allowedStatuses: ['confirmed'],
    limit: 2,
    cursor: null,
    provenancePolicy: 'trusted_v2',
    readMode: 'current'
  });
  assert.ok(Object.isFrozen(query));
  assert.ok(Object.isFrozen(query.allowedStatuses));
});

test('historical MemoryQueryV2 requires one explicit effectiveAt', () => {
  const effectiveAt = '2024-01-01T00:00:00.000Z';
  const query = QueryModule.buildMemoryQueryV2(context(), input({
    readMode: 'historical',
    effectiveAt
  }));
  assert.equal(query.effectiveAt, effectiveAt);
  assert.deepEqual(query.allowedStatuses, ['confirmed', 'superseded', 'archived']);
  assert.throws(
    () => QueryModule.buildMemoryQueryV2(context(), input({ readMode: 'historical' })),
    (error) => error?.code === 'EFFECTIVE_AT_REQUIRED'
  );
});

test('MemoryQueryV2 rejects ambiguous, no-match, relation-label, and cross-Entity construction', () => {
  for (const resolutionStatus of ['ambiguous', 'no_match']) {
    const resolution = resolutionStatus === 'ambiguous'
      ? fakeEntityResolution({
        resolutionStatus,
        entityId: null,
        candidateEntityIds: [ENTITY_TEST_IDS.daughterOne, ENTITY_TEST_IDS.daughterTwo]
      })
      : fakeEntityResolution({ resolutionStatus, entityId: null, candidateEntityIds: [] });
    assert.throws(
      () => QueryModule.buildMemoryQueryV2(context({ entityResolution: resolution }), input()),
      (error) => error?.code === 'RESOLUTION_EXACT_REQUIRED'
    );
  }
  assert.throws(
    () => QueryModule.buildMemoryQueryV2(context(), input({ subjectEntityId: 'daughter' })),
    (error) => error?.code === 'ENTITY_ID_INVALID'
  );
  assert.throws(
    () => QueryModule.buildMemoryQueryV2(context(), input({ subjectEntityId: ENTITY_TEST_IDS.daughterTwo })),
    (error) => error?.code === 'ENTITY_SCOPE_MISMATCH'
  );
});

test('MemoryQueryV2 fails closed on unknown fields, offset, unsafe status, policy, and limit', () => {
  for (const [overrides, code] of [
    [{ offset: 10 }, 'UNKNOWN_FIELD'],
    [{ ownerUserId: 'forged-owner' }, 'UNKNOWN_FIELD'],
    [{ allowedStatuses: ['confirmed', 'deleted'] }, 'STATUS_POLICY_INVALID'],
    [{ provenancePolicy: 'accept_everything' }, 'PROVENANCE_POLICY_INVALID'],
    [{ limit: 51 }, 'LIMIT_EXCEEDED'],
    [{ cursor: { offset: 1 } }, 'CURSOR_INVALID']
  ]) {
    assert.throws(
      () => QueryModule.buildMemoryQueryV2(context(), input(overrides)),
      (error) => error?.code === code
    );
  }
});
