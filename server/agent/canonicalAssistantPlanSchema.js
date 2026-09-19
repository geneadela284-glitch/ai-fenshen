const FIELDS = Object.freeze([
  'domain', 'intent', 'action', 'entity', 'relation_to_owner',
  'canonical_relation', 'predicate', 'canonical_value', 'qualifiers', 'tool',
  'canonical_arguments', 'explicit_fields', 'inherited_fields',
  'required_evidence', 'confidence', 'ambiguity_reasons', 'source_message_id',
  'provider_advisory'
]);
const ENTITY_FIELDS = Object.freeze(['type', 'reference', 'relation_to_owner']);
const RELATION_FIELDS = Object.freeze([
  'family_role', 'gender', 'parental_side', 'generation_distance',
  'biological_status', 'explicitness', 'source_evidence'
]);
const ADVISORY_FIELDS = Object.freeze([
  'requires_confirmation', 'confidence', 'confidence_band', 'source_spans'
]);
const DOMAINS = new Set(['memory', 'finance', 'tool', 'ordinary_chat', 'ambiguous']);
const CONFIDENCE_BANDS = new Set(['high', 'medium', 'low', 'unknown']);
const VALUE_TYPES = new Set([
  'date', 'date_without_year', 'scalar', 'list', 'object',
  'entity_reference', 'tool_arguments'
]);
const OWNER_KEYS = new Set(['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, fields, path, errors) {
  if (!plainObject(value)) {
    errors.push(`${path}: expected object`);
    return false;
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${path}.${field}: required`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) errors.push(`${path}.${field}: unexpected field`);
  }
  return true;
}

function containsOwnerAuthority(value) {
  if (Array.isArray(value)) return value.some(containsOwnerAuthority);
  if (!plainObject(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    OWNER_KEYS.has(key) || containsOwnerAuthority(child));
}

function nullableString(value) {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

function uniqueStringArray(value, path, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()) ||
      new Set(value).size !== value.length) {
    errors.push(`${path}: expected unique string array`);
  }
}

function validateCanonicalValue(value, errors) {
  if (value === null) return;
  if (!plainObject(value) || !VALUE_TYPES.has(value.type)) {
    errors.push('canonical_value: invalid typed value');
    return;
  }
  if (value.type === 'date') {
    if (!Number.isInteger(value.year) || !Number.isInteger(value.month) ||
        !Number.isInteger(value.day)) errors.push('canonical_value: invalid date');
  }
  if (value.type === 'date_without_year') {
    if (!Number.isInteger(value.month) || !Number.isInteger(value.day)) {
      errors.push('canonical_value: invalid date_without_year');
    }
  }
}

function actionMatchesDomain(domain, action) {
  if (domain === 'memory') return String(action).startsWith('memory.');
  if (domain === 'finance') return String(action).startsWith('finance.');
  if (domain === 'tool') {
    return String(action).startsWith('calendar.') || String(action).startsWith('tasks.');
  }
  return action === domain;
}

export function validateCanonicalAssistantPlan(value) {
  const errors = [];
  if (!exactFields(value, FIELDS, 'plan', errors)) {
    return { valid: false, errors, value: null };
  }
  if (!DOMAINS.has(value.domain)) errors.push('domain: invalid enum');
  if (typeof value.intent !== 'string' || !value.intent.trim()) errors.push('intent: required');
  if (typeof value.action !== 'string' || !value.action.trim()) errors.push('action: required');
  else if (!actionMatchesDomain(value.domain, value.action)) errors.push('action: domain mismatch');

  if (exactFields(value.entity, ENTITY_FIELDS, 'entity', errors)) {
    if (!nullableString(value.entity.type)) errors.push('entity.type: expected string or null');
    if (!nullableString(value.entity.reference)) errors.push('entity.reference: expected string or null');
    if (!nullableString(value.entity.relation_to_owner)) {
      errors.push('entity.relation_to_owner: expected string or null');
    }
  }
  if (!nullableString(value.relation_to_owner)) {
    errors.push('relation_to_owner: expected string or null');
  }
  if (value.entity?.relation_to_owner !== value.relation_to_owner) {
    errors.push('relation_to_owner: entity mismatch');
  }
  if (value.canonical_relation !== null) {
    if (exactFields(value.canonical_relation, RELATION_FIELDS, 'canonical_relation', errors)) {
      if (!Array.isArray(value.canonical_relation.source_evidence)) {
        errors.push('canonical_relation.source_evidence: expected array');
      }
    }
  } else if (value.domain === 'memory' ||
      (value.domain === 'tool' && !String(value.action).startsWith('tasks.'))) {
    errors.push('canonical_relation: required for memory/tool');
  }
  if (!nullableString(value.predicate)) errors.push('predicate: expected string or null');
  validateCanonicalValue(value.canonical_value, errors);
  if (!plainObject(value.qualifiers)) errors.push('qualifiers: expected object');
  if (!plainObject(value.canonical_arguments)) errors.push('canonical_arguments: expected object');
  if (value.domain === 'tool') {
    if (typeof value.tool !== 'string' || !value.tool.trim()) errors.push('tool: required');
  } else if (value.tool !== null) {
    errors.push('tool: must be null outside tool domain');
  }
  uniqueStringArray(value.explicit_fields, 'explicit_fields', errors);
  uniqueStringArray(value.inherited_fields, 'inherited_fields', errors);
  if (!Array.isArray(value.required_evidence) ||
      value.required_evidence.some((item) => !plainObject(item))) {
    errors.push('required_evidence: expected object array');
  }
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) {
    errors.push('confidence: expected number 0..1');
  }
  if (!Array.isArray(value.ambiguity_reasons)) {
    errors.push('ambiguity_reasons: expected array');
  }
  if (!nullableString(value.source_message_id)) {
    errors.push('source_message_id: expected string or null');
  }
  if (exactFields(value.provider_advisory, ADVISORY_FIELDS, 'provider_advisory', errors)) {
    if (typeof value.provider_advisory.requires_confirmation !== 'boolean') {
      errors.push('provider_advisory.requires_confirmation: expected boolean');
    }
    if (typeof value.provider_advisory.confidence !== 'number' ||
        value.provider_advisory.confidence < 0 ||
        value.provider_advisory.confidence > 1) {
      errors.push('provider_advisory.confidence: expected number 0..1');
    }
    if (!CONFIDENCE_BANDS.has(value.provider_advisory.confidence_band)) {
      errors.push('provider_advisory.confidence_band: invalid enum');
    }
    if (!Array.isArray(value.provider_advisory.source_spans)) {
      errors.push('provider_advisory.source_spans: expected array');
    }
  }
  if (containsOwnerAuthority(value)) errors.push('owner authority is forbidden');
  return {
    valid: errors.length === 0,
    errors,
    value: errors.length ? null : Object.freeze(value)
  };
}
