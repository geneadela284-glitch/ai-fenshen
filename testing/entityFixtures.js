import { computeMemoryRecordV2Checksum } from '../memory/entity/validation.js';

const NOW = '2026-07-16T12:00:00.000Z';
const CHECKSUM = 'a'.repeat(64);

export const ENTITY_TEST_IDS = Object.freeze({
  owner: 'user-entity-contract',
  self: 'ent_00112233445566778899aabbccddeeff',
  daughterOne: 'ent_102132435465768798a9bacbdcedfe0f',
  daughterTwo: 'ent_2031425364758697a8b9cadbecfd0e1f',
  friendOne: 'ent_30415263748596a7b8c9daebfc0d1e2f',
  friendTwo: 'ent_405162738495a6b7c8d9eafb0c1d2e3f'
});

export function fakeEntity(overrides = {}) {
  return {
    schemaVersion: 'v2',
    entityId: ENTITY_TEST_IDS.daughterOne,
    ownerUserId: ENTITY_TEST_IDS.owner,
    type: 'person',
    status: 'active',
    version: 1,
    source: { type: 'user_confirmed', id: 'source-entity-1' },
    checksum: CHECKSUM,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...structuredClone(overrides)
  };
}

export function fakeEntityAlias(overrides = {}) {
  return {
    schemaVersion: 'v2',
    alias: '小王',
    entityId: ENTITY_TEST_IDS.friendOne,
    ownerUserId: ENTITY_TEST_IDS.owner,
    source: { type: 'user_confirmed', id: 'source-alias-1' },
    confidence: 1,
    status: 'active',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...structuredClone(overrides)
  };
}

export function fakeEntityRelation(overrides = {}) {
  return {
    schemaVersion: 'v2',
    relationId: 'rel_daughter_0001',
    ownerUserId: ENTITY_TEST_IDS.owner,
    sourceEntityId: ENTITY_TEST_IDS.self,
    targetEntityId: ENTITY_TEST_IDS.daughterOne,
    relationKind: 'child',
    role: 'daughter',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    effectiveTo: null,
    status: 'active',
    version: 1,
    source: { type: 'user_confirmed', id: 'source-relation-1' },
    checksum: CHECKSUM,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    ...structuredClone(overrides)
  };
}

export function fakeEntityResolution(overrides = {}) {
  return {
    schemaVersion: 'v2',
    resolutionStatus: 'exact',
    ownerUserId: ENTITY_TEST_IDS.owner,
    entityType: 'person',
    entityId: ENTITY_TEST_IDS.daughterOne,
    relationKind: 'child',
    role: 'daughter',
    predicate: 'birthday',
    candidateEntityIds: [],
    sourceRelationIds: ['rel_daughter_0001'],
    resolutionReason: 'unique_alias_and_relation',
    policyVersion: 'entity-resolution-v2',
    resolvedAt: NOW,
    ...structuredClone(overrides)
  };
}

export function fakeMemoryRecordV2(overrides = {}) {
  const record = {
    memoryId: 'memory-v2-0001',
    schemaVersion: 'v2',
    ownerUserId: ENTITY_TEST_IDS.owner,
    memoryType: 'fact',
    subjectEntityId: ENTITY_TEST_IDS.daughterOne,
    predicate: 'birthday',
    structuredValue: { date: '2018-05-20' },
    displayValue: '5月20日',
    legacySubject: null,
    source: { type: 'user_confirmed', id: 'source-memory-1' },
    provenance: 'user_confirmed',
    sourceTimestamp: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    effectiveFrom: NOW,
    effectiveTo: null,
    confidence: 1,
    importance: 0.8,
    sensitivity: 'low',
    status: 'confirmed',
    confirmationStatus: 'user_confirmed',
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: {},
    accessPolicy: {},
    checksum: '',
    tags: [],
    metadata: {},
    ...structuredClone(overrides)
  };
  if (!Object.hasOwn(overrides, 'checksum')) {
    record.checksum = computeMemoryRecordV2Checksum(record);
  }
  return record;
}
