const FAMILY_ROLES = new Set([
  'self', 'parent', 'child', 'spouse', 'sibling', 'grandparent',
  'grandchild', 'other_family', 'unknown'
]);

const LEGACY_RELATIONS = Object.freeze({
  mother: Object.freeze({ family_role: 'parent', gender: 'female' }),
  father: Object.freeze({ family_role: 'parent', gender: 'male' }),
  daughter: Object.freeze({ family_role: 'child', gender: 'female' }),
  son: Object.freeze({ family_role: 'child', gender: 'male' }),
  spouse: Object.freeze({ family_role: 'spouse', gender: 'unknown' }),
  self: Object.freeze({ family_role: 'self', gender: 'unknown' }),
  other: Object.freeze({ family_role: 'other_family', gender: 'unknown' }),
  unknown: Object.freeze({ family_role: 'unknown', gender: 'unknown' })
});

const CANONICAL_REFERENCES = Object.freeze({
  女儿: Object.freeze({ family_role: 'child', gender: 'female' }),
  儿子: Object.freeze({ family_role: 'child', gender: 'male' }),
  孩子: Object.freeze({ family_role: 'child', gender: 'unknown' }),
  妈妈: Object.freeze({ family_role: 'parent', gender: 'female' }),
  爸爸: Object.freeze({ family_role: 'parent', gender: 'male' })
});

function relationFromProvider(value) {
  const relation = String(value || '').trim();
  if (FAMILY_ROLES.has(relation)) {
    return {
      family_role: relation,
      gender: 'unknown',
      evidence: { source: 'provider_relation', kind: 'canonical_family_role' }
    };
  }
  const legacy = LEGACY_RELATIONS[relation];
  return legacy ? {
    ...legacy,
    evidence: { source: 'provider_relation', kind: 'legacy_relation_contract' }
  } : null;
}

function relationFromReference(value) {
  const reference = String(value || '').trim();
  const relation = CANONICAL_REFERENCES[reference];
  if (relation) {
    return {
      ...relation,
      evidence: { source: 'entity_reference', kind: 'canonical_kinship_reference' }
    };
  }
  const structured = relationFromProvider(reference);
  return structured ? {
    family_role: structured.family_role,
    gender: structured.gender,
    evidence: { source: 'entity_reference', kind: 'structured_relation_reference' }
  } : null;
}

function relationFromTrustedEntity(value) {
  if (!value || typeof value !== 'object') return null;
  const relation = relationFromProvider(value.relation_to_owner) ||
    relationFromReference(value.reference);
  return relation ? {
    ...relation,
    evidence: { source: 'trusted_context', kind: 'scoped_active_entity' }
  } : null;
}

function conflicts(left, right) {
  if (!left || !right) return false;
  if (left.family_role !== 'unknown' && right.family_role !== 'unknown' &&
      left.family_role !== right.family_role) return true;
  return left.gender !== 'unknown' && right.gender !== 'unknown' &&
    left.gender !== right.gender;
}

function merge(left, right) {
  return {
    family_role: left?.family_role && left.family_role !== 'unknown'
      ? left.family_role
      : right?.family_role || 'unknown',
    gender: left?.gender && left.gender !== 'unknown'
      ? left.gender
      : right?.gender || 'unknown'
  };
}

function generationDistance(role) {
  if (role === 'parent' || role === 'child') return 1;
  if (role === 'grandparent' || role === 'grandchild') return 2;
  if (role === 'self' || role === 'spouse' || role === 'sibling') return 0;
  return null;
}

export function adaptCanonicalRelationToLegacy(relation) {
  const role = relation?.family_role;
  const gender = relation?.gender;
  if (role === 'parent') return gender === 'female' ? 'mother' : gender === 'male' ? 'father' : 'other';
  if (role === 'child') return gender === 'female' ? 'daughter' : gender === 'male' ? 'son' : 'other';
  if (role === 'self') return 'self';
  if (role === 'spouse') return 'spouse';
  if (role === 'unknown') return 'unknown';
  return 'other';
}

export function legacyEntityRelationDescriptor(legacyRelation, { reference = null } = {}) {
  const legacy = String(legacyRelation || '').trim();
  const rawReference = String(reference || '').trim();
  const provider = relationFromProvider(legacy);
  const referenceRelation = relationFromReference(rawReference);
  const canonical = legacy === 'other' && referenceRelation
    ? referenceRelation
    : provider;
  if (!canonical || canonical.family_role === 'unknown') return null;
  const labels = {
    self: '本人',
    mother: '妈妈',
    father: '爸爸',
    daughter: '女儿',
    son: '儿子',
    spouse: '配偶',
    other: '这位家人'
  };
  return Object.freeze({
    role: legacy,
    relationKind: canonical.family_role === 'other_family' ? 'family' : canonical.family_role,
    label: (relationFromProvider(rawReference) ? '' : rawReference) ||
      labels[legacy] ||
      '这位家人'
  });
}

export function canonicalizeEntityRelation({
  entity = null,
  relationToOwner = null,
  trustedEntity = null,
  explicit = true,
  message = ''
} = {}) {
  const rawRelation = relationToOwner ?? null;
  const rawEntityRelation = entity?.relation_to_owner ?? null;
  const provider = relationFromProvider(rawRelation);
  const entityRelation = rawEntityRelation === rawRelation
    ? null
    : relationFromProvider(rawEntityRelation);
  const reference = relationFromReference(entity?.reference);
  if (!provider && reference?.evidence?.kind === 'canonical_kinship_reference' && String(message) &&
      !String(message).includes(String(entity?.reference || ''))) {
    return { ok: false, code: 'CANONICAL_ENTITY_RELATION_EVIDENCE_MISMATCH' };
  }
  if (conflicts(reference, entityRelation) ||
      conflicts(reference, provider) ||
      conflicts(entityRelation, provider)) {
    return { ok: false, code: 'CANONICAL_ENTITY_RELATION_CONFLICT' };
  }
  let resolved = merge(reference, merge(entityRelation, provider));
  const evidence = [
    reference?.evidence,
    entityRelation?.evidence,
    provider?.evidence
  ].filter(Boolean);
  let explicitness = explicit ? 'explicit' : 'unknown';
  const trusted = relationFromTrustedEntity(trustedEntity);
  if (!explicit && trusted) {
    if (conflicts(resolved, trusted)) {
      return { ok: false, code: 'CANONICAL_ENTITY_RELATION_CONFLICT' };
    }
    resolved = { family_role: trusted.family_role, gender: trusted.gender };
    evidence.push(trusted.evidence);
    explicitness = 'inherited';
  } else if (resolved.family_role === 'unknown' && trusted) {
    resolved = { family_role: trusted.family_role, gender: trusted.gender };
    evidence.push(trusted.evidence);
    explicitness = 'inherited';
  }
  if (resolved.family_role === 'unknown') {
    return { ok: false, code: 'CANONICAL_ENTITY_RELATION_UNRESOLVED' };
  }
  const relation = Object.freeze({
    family_role: resolved.family_role,
    gender: resolved.gender,
    parental_side: 'unknown',
    generation_distance: generationDistance(resolved.family_role),
    biological_status: 'unknown',
    explicitness,
    source_evidence: Object.freeze(evidence.map((item) => Object.freeze({ ...item })))
  });
  return Object.freeze({
    ok: true,
    relation,
    legacyRelation: adaptCanonicalRelationToLegacy(relation),
    audit: Object.freeze({
      raw_relation: rawRelation,
      raw_entity_relation: rawEntityRelation
    })
  });
}
