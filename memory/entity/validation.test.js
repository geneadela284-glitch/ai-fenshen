import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityAlias,
  fakeEntityRelation,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const Validation = await import('./validation.js').catch(() => ({}));

function hasError(validation, path, code) {
  return validation.errors.some((error) => error.path === path && error.code === code);
}

test('Entity V2 validators expose every frozen trust boundary', () => {
  for (const name of [
    'validateEntity',
    'validateEntityAlias',
    'validateEntityRelation',
    'validateEntityResolution',
    'validateMemoryRecordV2',
    'validateEntityScopedRecordSet',
    'validateMemoryCorrectionV2',
    'classifyResolutionCandidates',
    'canonicalSerializeMemoryRecordV2ChecksumInput',
    'computeMemoryRecordV2Checksum'
  ]) assert.equal(typeof Validation[name], 'function', `${name} must exist`);
});

test('valid Entity, Alias, Relation, Resolution, and MemoryRecordV2 fixtures are accepted', () => {
  const options = { trustedOwnerUserId: ENTITY_TEST_IDS.owner };
  assert.equal(Validation.validateEntity(fakeEntity(), options).valid, true);
  assert.equal(Validation.validateEntityAlias(fakeEntityAlias(), options).valid, true);
  assert.equal(Validation.validateEntityRelation(fakeEntityRelation(), options).valid, true);
  assert.equal(Validation.validateEntityResolution(fakeEntityResolution(), options).valid, true);
  assert.equal(Validation.validateMemoryRecordV2(fakeMemoryRecordV2(), options).valid, true);
});

test('MemoryRecordV2 accepts omission of migration-only and presentation-only fields', () => {
  const record = fakeMemoryRecordV2();
  for (const field of [
    'displayValue', 'legacySubject', 'effectiveTo', 'expiresAt', 'supersedesId',
    'supersededById', 'conflictGroupId', 'tags'
  ]) delete record[field];
  assert.equal(Validation.validateMemoryRecordV2(record, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  }).valid, true);
});

test('confirmed MemoryRecordV2 without subjectEntityId is rejected', () => {
  const record = fakeMemoryRecordV2();
  delete record.subjectEntityId;
  const validation = Validation.validateMemoryRecordV2(record, { trustedOwnerUserId: ENTITY_TEST_IDS.owner });
  assert.equal(validation.valid, false);
  assert.ok(hasError(validation, 'subjectEntityId', 'SUBJECT_ENTITY_REQUIRED'));
});

test('subjectEntityId family:daughter is rejected as a relation label', () => {
  const validation = Validation.validateMemoryRecordV2(
    fakeMemoryRecordV2({ subjectEntityId: 'family:daughter' }),
    { trustedOwnerUserId: ENTITY_TEST_IDS.owner }
  );
  assert.equal(validation.valid, false);
  assert.ok(hasError(validation, 'subjectEntityId', 'ENTITY_ID_INVALID'));
});

test('MemoryRecordV2 rejects legacy id and requires memoryId', () => {
  const record = fakeMemoryRecordV2();
  record.id = record.memoryId;
  delete record.memoryId;
  const validation = Validation.validateMemoryRecordV2(record, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  });
  assert.equal(validation.valid, false);
  assert.ok(hasError(validation, 'memoryId', 'REQUIRED'));
  assert.ok(hasError(validation, 'id', 'UNKNOWN_FIELD'));
});

test('semantic Entity IDs are rejected even when they use the ent_ prefix', () => {
  for (const entityId of [
    'ent_self_000001',
    'ent_daughter_0001',
    'ent_friend_000001',
    'ent_family_daughter'
  ]) {
    const validation = Validation.validateEntity(fakeEntity({ entityId }), {
      trustedOwnerUserId: ENTITY_TEST_IDS.owner
    });
    assert.ok(hasError(validation, 'entityId', 'ENTITY_ID_INVALID'), entityId);
  }
});

test('random opaque Entity ID passes validation', () => {
  const validation = Validation.validateEntity(
    fakeEntity({ entityId: 'ent_0123456789abcdef0123456789abcdef' }),
    { trustedOwnerUserId: ENTITY_TEST_IDS.owner }
  );
  assert.equal(validation.valid, true);
});

test('MemoryRecordV2 checksum is deterministic for identical input', () => {
  const record = fakeMemoryRecordV2();
  assert.equal(
    Validation.computeMemoryRecordV2Checksum(record),
    Validation.computeMemoryRecordV2Checksum(structuredClone(record))
  );
});

test('structuredValue key order does not affect canonical checksum', () => {
  const first = fakeMemoryRecordV2({ structuredValue: { zeta: 2, alpha: 1 } });
  const second = fakeMemoryRecordV2({ structuredValue: Object.fromEntries([
    ['alpha', 1],
    ['zeta', 2]
  ]) });
  assert.equal(
    Validation.canonicalSerializeMemoryRecordV2ChecksumInput(first),
    Validation.canonicalSerializeMemoryRecordV2ChecksumInput(second)
  );
  assert.equal(
    Validation.computeMemoryRecordV2Checksum(first),
    Validation.computeMemoryRecordV2Checksum(second)
  );
});

test('MemoryRecordV2 checksum binds every frozen checksum field', () => {
  const original = fakeMemoryRecordV2();
  const originalChecksum = Validation.computeMemoryRecordV2Checksum(original);
  const changes = {
    memoryId: 'memory-v2-other',
    ownerUserId: 'other-owner',
    subjectEntityId: ENTITY_TEST_IDS.daughterTwo,
    predicate: 'other-predicate',
    structuredValue: { date: '2018-05-21' },
    version: 2
  };
  for (const [field, replacement] of Object.entries(changes)) {
    const changed = { ...structuredClone(original), [field]: replacement };
    assert.notEqual(
      Validation.computeMemoryRecordV2Checksum(changed),
      originalChecksum,
      field
    );
  }
});

test('birthday structuredValue rejects legacy fields unknown fields and invalid date types', () => {
  for (const structuredValue of [
    { year: 2026, month: 1, day: 1 },
    { date: '2026-01-01', calendar: 'gregorian' },
    { date: 20260101 },
    { date: '2026-02-30' }
  ]) {
    const validation = Validation.validateMemoryRecordV2(
      fakeMemoryRecordV2({ structuredValue }),
      { trustedOwnerUserId: ENTITY_TEST_IDS.owner }
    );
    assert.equal(validation.valid, false, JSON.stringify(structuredValue));
    assert.ok(validation.errors.some((error) => error.path.startsWith('structuredValue')));
  }
});

test('unregistered predicate fails closed', () => {
  const validation = Validation.validateMemoryRecordV2(
    fakeMemoryRecordV2({ predicate: 'unregistered-predicate', structuredValue: {} }),
    { trustedOwnerUserId: ENTITY_TEST_IDS.owner }
  );
  assert.equal(validation.valid, false);
  assert.ok(hasError(validation, 'predicate', 'PREDICATE_SCHEMA_MISSING'));
});

test('preference structuredValue accepts legacy one-value and unique multi-value forms and rejects unknown fields', () => {
  const valid = Validation.validateMemoryRecordV2(
    fakeMemoryRecordV2({
      memoryType: 'preference', predicate: 'preference_statement', structuredValue: { value: '草莓' }
    }),
    { trustedOwnerUserId: ENTITY_TEST_IDS.owner }
  );
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  const multi = Validation.validateMemoryRecordV2(
    fakeMemoryRecordV2({
      memoryType: 'preference', predicate: 'preference_statement',
      structuredValue: { value: '苹果、草莓', values: ['苹果', '草莓'] }
    }),
    { trustedOwnerUserId: ENTITY_TEST_IDS.owner }
  );
  assert.equal(multi.valid, true, JSON.stringify(multi.errors));
  for (const structuredValue of [
    { value: '' },
    { value: '草莓', values: [] },
    { value: '草莓', values: ['草莓', '草莓'] },
    { value: '草莓', fixedAnswer: '草莓' }
  ]) {
    const invalid = Validation.validateMemoryRecordV2(
      fakeMemoryRecordV2({ memoryType: 'preference', predicate: 'preference_statement', structuredValue }),
      { trustedOwnerUserId: ENTITY_TEST_IDS.owner }
    );
    assert.equal(invalid.valid, false);
  }
});

test('ownerUserId mismatch is rejected across Entity Model V2 contracts', () => {
  const validation = Validation.validateEntity(
    fakeEntity({ ownerUserId: 'another-user' }),
    { trustedOwnerUserId: ENTITY_TEST_IDS.owner }
  );
  assert.equal(validation.valid, false);
  assert.ok(hasError(validation, 'ownerUserId', 'OWNER_SCOPE_MISMATCH'));
});

test('two daughter relations classify as ambiguous and cannot be exact', () => {
  const relations = [
    fakeEntityRelation(),
    fakeEntityRelation({ relationId: 'rel_daughter_0002', targetEntityId: ENTITY_TEST_IDS.daughterTwo })
  ];
  const candidateEntityIds = relations.map((relation) => relation.targetEntityId);
  assert.equal(Validation.classifyResolutionCandidates(candidateEntityIds), 'ambiguous');
  const ambiguous = fakeEntityResolution({
    resolutionStatus: 'ambiguous',
    entityId: null,
    candidateEntityIds,
    sourceRelationIds: relations.map((relation) => relation.relationId),
    resolutionReason: 'multiple_current_relations'
  });
  assert.equal(Validation.validateEntityResolution(ambiguous, { trustedOwnerUserId: ENTITY_TEST_IDS.owner }).valid, true);
  const invalidExact = { ...ambiguous, resolutionStatus: 'exact', entityId: ENTITY_TEST_IDS.daughterOne };
  const validation = Validation.validateEntityResolution(invalidExact, { trustedOwnerUserId: ENTITY_TEST_IDS.owner });
  assert.ok(hasError(validation, 'candidateEntityIds', 'RESOLUTION_AMBIGUOUS'));
});

test('two friends sharing one alias remain ambiguous and cannot auto-merge', () => {
  const aliases = [
    fakeEntityAlias(),
    fakeEntityAlias({ entityId: ENTITY_TEST_IDS.friendTwo, source: { type: 'user_confirmed', id: 'source-alias-2' } })
  ];
  assert.equal(new Set(aliases.map((item) => item.alias)).size, 1);
  assert.equal(Validation.classifyResolutionCandidates(aliases.map((item) => item.entityId)), 'ambiguous');
  const resolution = fakeEntityResolution({
    resolutionStatus: 'ambiguous',
    entityId: null,
    relationKind: 'friend',
    role: 'friend',
    candidateEntityIds: aliases.map((item) => item.entityId),
    sourceRelationIds: [],
    resolutionReason: 'alias_collision'
  });
  assert.equal(Validation.validateEntityResolution(resolution, { trustedOwnerUserId: ENTITY_TEST_IDS.owner }).valid, true);
});

test('ambiguous resolution cannot authorize a MemoryRecordV2 write', () => {
  const resolution = fakeEntityResolution({
    resolutionStatus: 'ambiguous',
    entityId: null,
    candidateEntityIds: [ENTITY_TEST_IDS.daughterOne, ENTITY_TEST_IDS.daughterTwo]
  });
  const validation = Validation.validateMemoryRecordV2(fakeMemoryRecordV2(), {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner,
    resolution
  });
  assert.equal(validation.valid, false);
  assert.ok(hasError(validation, 'resolution', 'RESOLUTION_EXACT_REQUIRED'));
});

test('unknown resolution status is rejected and cannot authorize confirmed Memory', () => {
  const resolution = fakeEntityResolution({ resolutionStatus: 'unknown' });
  const resolutionValidation = Validation.validateEntityResolution(resolution, { trustedOwnerUserId: ENTITY_TEST_IDS.owner });
  assert.ok(hasError(resolutionValidation, 'resolutionStatus', 'INVALID_ENUM'));
  const memoryValidation = Validation.validateMemoryRecordV2(fakeMemoryRecordV2(), {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner,
    resolution
  });
  assert.ok(hasError(memoryValidation, 'resolution', 'RESOLUTION_EXACT_REQUIRED'));
});

test('wrong entity record set fails the pre-Ranking scope gate', () => {
  const records = [
    fakeMemoryRecordV2(),
    fakeMemoryRecordV2({ memoryId: 'memory-v2-wrong', subjectEntityId: ENTITY_TEST_IDS.daughterTwo })
  ];
  const validation = Validation.validateEntityScopedRecordSet(records, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner,
    subjectEntityId: ENTITY_TEST_IDS.daughterOne,
    predicate: 'birthday'
  });
  assert.equal(validation.valid, false);
  assert.ok(hasError(validation, 'records[1].subjectEntityId', 'ENTITY_SCOPE_MISMATCH'));
});

test('ordinary correction preserves subjectEntityId and rejects silent rebind', () => {
  const current = fakeMemoryRecordV2();
  const correction = fakeMemoryRecordV2({
    memoryId: 'memory-v2-0002',
    version: 2,
    supersedesId: current.memoryId,
    structuredValue: { date: '2018-05-21' }
  });
  assert.equal(Validation.validateMemoryCorrectionV2(current, correction, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  }).valid, true);
  const rebind = { ...correction, subjectEntityId: ENTITY_TEST_IDS.daughterTwo };
  const validation = Validation.validateMemoryCorrectionV2(current, rebind, {
    trustedOwnerUserId: ENTITY_TEST_IDS.owner
  });
  assert.ok(hasError(validation, 'subjectEntityId', 'ENTITY_REBIND_REQUIRES_GOVERNANCE'));
});

test('relation labels are rejected anywhere an opaque Entity ID is required', () => {
  const relation = fakeEntityRelation({ targetEntityId: 'daughter' });
  const validation = Validation.validateEntityRelation(relation, { trustedOwnerUserId: ENTITY_TEST_IDS.owner });
  assert.equal(validation.valid, false);
  assert.ok(hasError(validation, 'targetEntityId', 'ENTITY_ID_INVALID'));
});
