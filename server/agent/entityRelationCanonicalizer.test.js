import assert from 'node:assert/strict';
import test from 'node:test';

async function subject() {
  return import('./entityRelationCanonicalizer.js').catch(() => null);
}

function input({
  reference,
  relation = null,
  entityRelation = relation,
  message = '',
  context = null,
  explicit = true
} = {}) {
  return {
    entity: { type: 'person', reference, relation_to_owner: entityRelation },
    relationToOwner: relation,
    message,
    explicit,
    trustedEntity: context
  };
}

test('RED: explicit entity female evidence outranks a broader unknown-gender Provider relation', async () => {
  const api = await subject();
  const result = api.canonicalizeEntityRelation(input({
    reference: null,
    relation: 'child',
    entityRelation: 'daughter',
    message: '我女儿出生于2012年6月8日'
  }));
  assert.equal(result.ok, true);
  assert.equal(result.relation.family_role, 'child');
  assert.equal(result.relation.gender, 'female');
  assert.equal(result.legacyRelation, 'daughter');
});

test('RED: structured entity reference reuses the existing relation contract when broad relations omit gender', async () => {
  const api = await subject();
  const daughter = api.canonicalizeEntityRelation(input({
    reference: 'daughter',
    relation: 'child',
    entityRelation: 'child',
    message: '我女儿出生于2012年6月8日'
  }));
  assert.equal(daughter.ok, true);
  assert.equal(daughter.relation.family_role, 'child');
  assert.equal(daughter.relation.gender, 'female');
  assert.equal(daughter.legacyRelation, 'daughter');

  const son = api.canonicalizeEntityRelation(input({
    reference: 'son',
    relation: 'child',
    entityRelation: 'child',
    message: '我儿子出生于2014年2月3日'
  }));
  assert.equal(son.ok, true);
  assert.equal(son.relation.gender, 'male');
  assert.equal(son.legacyRelation, 'son');
});

test('RED: explicit entity male evidence outranks a broader unknown-gender Provider relation', async () => {
  const api = await subject();
  const result = api.canonicalizeEntityRelation(input({
    reference: null,
    relation: 'child',
    entityRelation: 'son',
    message: '我儿子出生于2014年2月3日'
  }));
  assert.equal(result.ok, true);
  assert.equal(result.relation.family_role, 'child');
  assert.equal(result.relation.gender, 'male');
  assert.equal(result.legacyRelation, 'son');
});

test('RED: unknown evidence fills only missing qualifiers and never erases confirmed gender', async () => {
  const api = await subject();
  const neutral = api.canonicalizeEntityRelation(input({
    reference: null,
    relation: 'child',
    entityRelation: 'child',
    message: '我的孩子出生于2016年4月5日'
  }));
  assert.equal(neutral.ok, true);
  assert.equal(neutral.relation.gender, 'unknown');

  const confirmed = api.canonicalizeEntityRelation(input({
    reference: null,
    relation: 'child',
    entityRelation: 'daughter',
    context: { type: 'person', reference: '孩子', relation_to_owner: 'child' },
    message: '我女儿出生于2012年6月8日'
  }));
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.relation.gender, 'female');
});

test('RED: conflicting explicit entity and Provider gender evidence fails closed', async () => {
  const api = await subject();
  const result = api.canonicalizeEntityRelation(input({
    reference: null,
    relation: 'son',
    entityRelation: 'daughter',
    message: '我女儿出生于2012年6月8日'
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_ENTITY_RELATION_CONFLICT');
});

test('RED: child relation plus explicit daughter evidence canonicalizes to child and female', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const result = api.canonicalizeEntityRelation(input({
    reference: '女儿',
    relation: 'child',
    message: '我女儿出生于2012年6月8日'
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.relation, {
    family_role: 'child',
    gender: 'female',
    parental_side: 'unknown',
    generation_distance: 1,
    biological_status: 'unknown',
    explicitness: 'explicit',
    source_evidence: [
      { source: 'entity_reference', kind: 'canonical_kinship_reference' },
      { source: 'provider_relation', kind: 'canonical_family_role' }
    ]
  });
  assert.equal(result.legacyRelation, 'daughter');
  assert.equal(result.audit.raw_relation, 'child');
});

test('RED: child relation distinguishes son and preserves gender-neutral child', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const son = api.canonicalizeEntityRelation(input({
    reference: '儿子',
    relation: 'child',
    message: '我儿子出生于2014年2月3日'
  }));
  assert.equal(son.ok, true);
  assert.equal(son.relation.family_role, 'child');
  assert.equal(son.relation.gender, 'male');
  assert.equal(son.legacyRelation, 'son');

  const child = api.canonicalizeEntityRelation(input({
    reference: '孩子',
    relation: 'child',
    message: '我的孩子出生于2016年4月5日'
  }));
  assert.equal(child.ok, true);
  assert.equal(child.relation.family_role, 'child');
  assert.equal(child.relation.gender, 'unknown');
  assert.equal(child.legacyRelation, 'other');
});

test('RED: parent relation canonicalizes mother and father without leaking raw relation authority', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const mother = api.canonicalizeEntityRelation(input({
    reference: '妈妈',
    relation: 'parent',
    message: '我妈妈生日是6月8号'
  }));
  assert.equal(mother.ok, true);
  assert.equal(mother.relation.family_role, 'parent');
  assert.equal(mother.relation.gender, 'female');
  assert.equal(mother.legacyRelation, 'mother');

  const father = api.canonicalizeEntityRelation(input({
    reference: '爸爸',
    relation: 'parent',
    message: '我爸爸生日是5月7号'
  }));
  assert.equal(father.ok, true);
  assert.equal(father.relation.family_role, 'parent');
  assert.equal(father.relation.gender, 'male');
  assert.equal(father.legacyRelation, 'father');
});

test('RED: structured relation identifiers use the existing localized legacy label', async () => {
  const api = await subject();
  const mother = api.legacyEntityRelationDescriptor('mother', { reference: 'mother' });
  assert.equal(mother.label, '妈妈');

  const daughter = api.legacyEntityRelationDescriptor('daughter', { reference: 'daughter' });
  assert.equal(daughter.label, '女儿');
});

test('RED: current explicit entity overrides trusted entity and pronoun inherits only trusted entity', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const trustedMother = { type: 'person', reference: '妈妈', relation_to_owner: 'mother' };
  const explicit = api.canonicalizeEntityRelation(input({
    reference: '女儿',
    relation: 'child',
    message: '我女儿生日是6月8号',
    context: trustedMother
  }));
  assert.equal(explicit.ok, true);
  assert.equal(explicit.legacyRelation, 'daughter');

  const inherited = api.canonicalizeEntityRelation(input({
    reference: '她',
    relation: null,
    message: '她也喜欢草莓',
    context: { type: 'person', reference: '女儿', relation_to_owner: 'daughter' },
    explicit: false
  }));
  assert.equal(inherited.ok, true);
  assert.equal(inherited.relation.family_role, 'child');
  assert.equal(inherited.relation.gender, 'female');
  assert.equal(inherited.relation.explicitness, 'inherited');
  assert.equal(inherited.legacyRelation, 'daughter');
});

test('RED: unknown raw relation is advisory when structured entity evidence is clear', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const result = api.canonicalizeEntityRelation(input({
    reference: '女儿',
    relation: 'provider_family_slot_42',
    message: '我女儿出生于2012年6月8日'
  }));
  assert.equal(result.ok, true);
  assert.equal(result.relation.family_role, 'child');
  assert.equal(result.relation.gender, 'female');
  assert.equal(result.legacyRelation, 'daughter');
  assert.equal(result.audit.raw_relation, 'provider_family_slot_42');
});

test('RED: conflicting Provider relation and explicit entity evidence fails closed', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const result = api.canonicalizeEntityRelation(input({
    reference: '妈妈',
    relation: 'child',
    message: '我妈妈生日是6月8号'
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_ENTITY_RELATION_CONFLICT');
});

test('RED: structured entity reference must be present in the current raw message evidence', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const result = api.canonicalizeEntityRelation(input({
    reference: '女儿',
    relation: 'provider_family_slot_42',
    message: '我妈妈生日是6月8号'
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_ENTITY_RELATION_EVIDENCE_MISMATCH');
});

test('RED: inherited Provider relation cannot override a conflicting trusted current-conversation entity', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const result = api.canonicalizeEntityRelation(input({
    reference: '她',
    relation: 'daughter',
    message: '她也喜欢草莓',
    context: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    explicit: false
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_ENTITY_RELATION_CONFLICT');
});

test('RED: unresolved pronoun without trusted current-conversation entity fails closed', async () => {
  const api = await subject();
  assert.ok(api, 'Entity Relation Canonicalizer is missing');
  const result = api.canonicalizeEntityRelation(input({
    reference: '她',
    relation: null,
    message: '她也喜欢草莓',
    context: null,
    explicit: false
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANONICAL_ENTITY_RELATION_UNRESOLVED');
});

test('RED: gender-neutral child adapts to the existing Memory schema and remains an accepted low-risk fact', async () => {
  const [{ adaptUnifiedPlanToMemory }, { validateSemanticMemoryPlan }, { evaluateSemanticMemoryContract }] =
    await Promise.all([
      import('./domainPlanAdapters.js'),
      import('../memory/semanticMemoryPlanSchema.js'),
      import('../memory/semanticMemoryContract.js')
    ]);
  const message = '我的孩子出生于2016年4月5日';
  const adapted = adaptUnifiedPlanToMemory({
    domain: 'memory',
    intent: 'create_fact',
    action: 'memory.capture',
    entity: { type: 'person', reference: '孩子', relation_to_owner: 'other' },
    relation_to_owner: 'other',
    canonical_relation: {
      family_role: 'child',
      gender: 'unknown',
      parental_side: 'unknown',
      generation_distance: 1,
      biological_status: 'unknown',
      explicitness: 'explicit',
      source_evidence: []
    },
    predicate: 'birth_date',
    canonical_value: { type: 'date', year: 2016, month: 4, day: 5 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    inherited_fields: [],
    confidence: 0.95,
    ambiguity_reasons: []
  }, { message });
  assert.equal(adapted.ok, true);
  const validation = validateSemanticMemoryPlan(adapted.plan, {
    text: message,
    minimumConfidence: 0
  });
  assert.equal(validation.valid, true, validation.errors.join(','));
  const contract = evaluateSemanticMemoryContract({
    plan: adapted.plan,
    existingRecords: [],
    sourceText: message
  });
  assert.equal(contract.decision, 'ACCEPT');
  assert.equal(contract.operation, 'capture');
});
