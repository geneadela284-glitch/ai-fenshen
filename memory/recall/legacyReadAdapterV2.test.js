import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_MAPPING_STATUSES,
  LegacyAdapterResultV2,
  assertDeterministicLegacyResultV2,
  assertLegacyAdapterResultV2,
  computeLegacyAdapterResultChecksum,
  createLegacyReadAdapterV2
} from './legacyReadAdapterV2.js';
import * as Interfaces from '../entity/interfaces.js';
import { ENTITY_TEST_IDS } from '../../testing/entityFixtures.js';

const OWNER = ENTITY_TEST_IDS.owner;
const ENTITY = ENTITY_TEST_IDS.daughterOne;
const NOW = '2026-07-17T06:00:00.000Z';

function result(overrides = {}) {
  const value = {
    legacyMemoryId: 'legacy-birthday-1',
    ownerUserId: OWNER,
    mappedSubjectEntityId: ENTITY,
    predicate: 'birthday',
    structuredValue: { date: '2018-05-20' },
    mappingStatus: 'deterministic_mapped',
    mappingEvidence: {
      type: 'stable_mapping_table',
      subjectEntityId: ENTITY,
      evidenceIds: ['mapping:legacy-birthday-1']
    },
    adapterVersion: 'legacy-read-adapter-v2',
    source: { type: 'user_confirmed', id: 'legacy-source-1' },
    provenance: {
      sourceMode: 'legacy',
      source: { type: 'user_confirmed', id: 'legacy-source-1' },
      mappingStatus: 'deterministic_mapped',
      adapterVersion: 'legacy-read-adapter-v2'
    },
    checksum: '',
    effectiveTime: { effectiveFrom: NOW, effectiveTo: null },
    ...structuredClone(overrides)
  };
  if (!Object.hasOwn(overrides, 'checksum')) {
    value.checksum = computeLegacyAdapterResultChecksum(value);
  }
  return value;
}

function expectCode(code, operation) {
  assert.throws(operation, (error) => error?.code === code);
}

test('LegacyAdapterResultV2 freezes the exact read-only result contract', () => {
  assert.deepEqual(LEGACY_MAPPING_STATUSES, [
    'deterministic_mapped',
    'suggested_review',
    'review_required',
    'unmappable'
  ]);
  assert.deepEqual(LegacyAdapterResultV2.fields, [
    'legacyMemoryId',
    'ownerUserId',
    'mappedSubjectEntityId',
    'predicate',
    'structuredValue',
    'mappingStatus',
    'mappingEvidence',
    'adapterVersion',
    'source',
    'provenance',
    'checksum',
    'effectiveTime'
  ]);
  assert.equal(LegacyAdapterResultV2.unknownFieldPolicy, 'reject');
  assert.equal(LegacyAdapterResultV2.writePolicy, 'read-only');
});

test('deterministic Legacy result requires exact Entity evidence and a valid checksum', () => {
  const value = result();
  assert.equal(assertLegacyAdapterResultV2(value, {
    trustedOwnerUserId: OWNER,
    subjectEntityId: ENTITY,
    predicate: 'birthday'
  }), value);
  assert.equal(assertDeterministicLegacyResultV2(value, {
    trustedOwnerUserId: OWNER,
    subjectEntityId: ENTITY,
    predicate: 'birthday'
  }), value);
});

test('unknown fields, cross-owner results, relation labels, and tampering fail closed', () => {
  expectCode('LEGACY_RESULT_INVALID', () => assertLegacyAdapterResultV2(
    result({ unexpected: true }),
    { trustedOwnerUserId: OWNER, subjectEntityId: ENTITY, predicate: 'birthday' }
  ));
  expectCode('LEGACY_SCOPE_VIOLATION', () => assertLegacyAdapterResultV2(
    result({ ownerUserId: 'another-owner' }),
    { trustedOwnerUserId: OWNER, subjectEntityId: ENTITY, predicate: 'birthday' }
  ));
  expectCode('LEGACY_SCOPE_VIOLATION', () => assertLegacyAdapterResultV2(
    result({ mappedSubjectEntityId: 'family:mother' }),
    { trustedOwnerUserId: OWNER, subjectEntityId: ENTITY, predicate: 'birthday' }
  ));
  expectCode('LEGACY_RESULT_INVALID', () => assertLegacyAdapterResultV2(
    result({ checksum: '0'.repeat(64) }),
    { trustedOwnerUserId: OWNER, subjectEntityId: ENTITY, predicate: 'birthday' }
  ));
});

test('provenance and mapping evidence are mandatory and confidence cannot replace determinism', () => {
  expectCode('LEGACY_RESULT_INVALID', () => assertLegacyAdapterResultV2(
    result({ provenance: null }),
    { trustedOwnerUserId: OWNER, subjectEntityId: ENTITY, predicate: 'birthday' }
  ));
  expectCode('LEGACY_RESULT_INVALID', () => assertLegacyAdapterResultV2(
    result({ mappingEvidence: null }),
    { trustedOwnerUserId: OWNER, subjectEntityId: ENTITY, predicate: 'birthday' }
  ));
  const confidenceOnly = result({
    mappingEvidence: {
      type: 'confidence_score',
      subjectEntityId: ENTITY,
      evidenceIds: ['confidence:0.99']
    }
  });
  confidenceOnly.checksum = computeLegacyAdapterResultChecksum(confidenceOnly);
  expectCode('LEGACY_MAPPING_UNSAFE', () => assertDeterministicLegacyResultV2(
    confidenceOnly,
    { trustedOwnerUserId: OWNER, subjectEntityId: ENTITY, predicate: 'birthday' }
  ));
});

test('review states validate as adapter output but cannot continue to Ranking', () => {
  for (const mappingStatus of ['suggested_review', 'review_required', 'unmappable']) {
    const value = result({
      mappedSubjectEntityId: null,
      mappingStatus,
      mappingEvidence: {
        type: 'insufficient_evidence',
        subjectEntityId: null,
        evidenceIds: [`review:${mappingStatus}`]
      },
      provenance: {
        sourceMode: 'legacy',
        source: { type: 'user_confirmed', id: 'legacy-source-1' },
        mappingStatus,
        adapterVersion: 'legacy-read-adapter-v2'
      }
    });
    value.checksum = computeLegacyAdapterResultChecksum(value);
    assert.equal(assertLegacyAdapterResultV2(value, {
      trustedOwnerUserId: OWNER,
      subjectEntityId: ENTITY,
      predicate: 'birthday'
    }), value);
    expectCode('LEGACY_MAPPING_UNSAFE', () => assertDeterministicLegacyResultV2(value, {
      trustedOwnerUserId: OWNER,
      subjectEntityId: ENTITY,
      predicate: 'birthday'
    }));
  }
});

test('Legacy adapter exposes query only and forwards an exact owner Entity predicate scope', () => {
  const calls = [];
  const adapter = createLegacyReadAdapterV2({
    queryExact(scope) {
      calls.push(scope);
      return [result()];
    }
  });
  assert.deepEqual(Object.keys(adapter), ['query']);
  const values = adapter.query({ ownerUserId: OWNER }, {
    ownerUserId: OWNER,
    subjectEntityId: ENTITY,
    predicate: 'birthday',
    effectiveAt: NOW,
    readMode: 'current',
    limit: 20
  });
  assert.equal(values.length, 1);
  assert.deepEqual(calls, [{
    ownerUserId: OWNER,
    subjectEntityId: ENTITY,
    predicate: 'birthday',
    effectiveAt: NOW,
    readMode: 'current',
    limit: 20
  }]);
});

test('V2 presence inspection is a separate read-only Repository port', () => {
  assert.deepEqual(Interfaces.MemoryRecordV2PresenceRepository.requiredMethods, [
    'inspectPresenceByEntityAndPredicate'
  ]);
  assert.equal(Interfaces.validateMemoryRecordV2PresenceRepositoryInterface({
    inspectPresenceByEntityAndPredicate() {}
  }).valid, true);
  assert.equal(Interfaces.validateMemoryRecordV2PresenceRepositoryInterface({}).valid, false);
});
