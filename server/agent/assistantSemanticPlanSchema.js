const FIELDS = Object.freeze([
  'domain', 'intent', 'action', 'entity', 'relation_to_owner', 'predicate', 'value',
  'qualifiers', 'tool', 'arguments', 'required_evidence', 'explicit_fields',
  'inherited_fields', 'ambiguity_reasons', 'confidence', 'requires_confirmation',
  'source_spans', 'source_message_id'
]);
const ENTITY_FIELDS = Object.freeze(['type', 'reference', 'relation_to_owner']);
const DOMAINS = new Set(['memory', 'finance', 'tool', 'ordinary_chat', 'ambiguous']);
const OWNER_KEYS = new Set(['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsOwnerAuthority(value) {
  if (Array.isArray(value)) return value.some(containsOwnerAuthority);
  if (!plainObject(value)) return false;
  return Object.entries(value).some(([key, child]) => OWNER_KEYS.has(key) || containsOwnerAuthority(child));
}

function exactFields(value, fields, path, errors) {
  if (!plainObject(value)) {
    errors.push(`${path}: expected object`);
    return false;
  }
  for (const key of fields) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) errors.push(`${path}.${key}: unexpected field`);
  return true;
}

function nullableString(value) {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

function stringArray(value, path, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()) ||
      new Set(value).size !== value.length) {
    errors.push(`${path}: expected unique string array`);
  }
}

function canonicalizeEmptyContainers(value) {
  if (!plainObject(value)) return value;
  const plan = structuredClone(value);
  if (plan.entity === null) plan.entity = { type: null, reference: null, relation_to_owner: null };
  if (plan.qualifiers === null) plan.qualifiers = {};
  if (plan.arguments === null) plan.arguments = {};
  if (plan.required_evidence === null) plan.required_evidence = [];
  if (plan.explicit_fields === null) plan.explicit_fields = [];
  if (plan.inherited_fields === null) plan.inherited_fields = [];
  if (plan.ambiguity_reasons === null) plan.ambiguity_reasons = [];
  if (plan.source_spans === null) plan.source_spans = [];
  return plan;
}

export function validateAssistantSemanticPlan(input, { allowInheritedTool = false } = {}) {
  const value = canonicalizeEmptyContainers(input);
  const errors = [];
  if (!exactFields(value, FIELDS, 'plan', errors)) return { valid: false, errors, value: null };
  if (!DOMAINS.has(value.domain)) errors.push('domain: invalid enum');
  if (typeof value.intent !== 'string' || !value.intent.trim()) errors.push('intent: required');
  if (typeof value.action !== 'string' || !value.action.trim()) errors.push('action: required');
  if (exactFields(value.entity, ENTITY_FIELDS, 'entity', errors)) {
    if (!nullableString(value.entity.type)) errors.push('entity.type: expected string or null');
    if (!nullableString(value.entity.reference)) errors.push('entity.reference: expected string or null');
    if (!nullableString(value.entity.relation_to_owner)) errors.push('entity.relation_to_owner: expected string or null');
  }
  if (!nullableString(value.relation_to_owner)) errors.push('relation_to_owner: expected string or null');
  if (value.entity?.relation_to_owner !== null && value.relation_to_owner !== value.entity?.relation_to_owner) {
    errors.push('relation_to_owner: entity mismatch');
  }
  if (!nullableString(value.predicate)) errors.push('predicate: expected string or null');
  if (!plainObject(value.qualifiers)) errors.push('qualifiers: expected object');
  if (!plainObject(value.arguments)) errors.push('arguments: expected object');
  if (value.domain === 'tool') {
    const inheritedTool = allowInheritedTool && value.tool === null &&
      Array.isArray(value.inherited_fields) && value.inherited_fields.includes('tool');
    if (!inheritedTool && (typeof value.tool !== 'string' || !value.tool.trim())) errors.push('tool: required');
  } else if (value.tool !== null) {
    errors.push('tool: must be null outside tool domain');
  }
  if (!Array.isArray(value.required_evidence)) errors.push('required_evidence: expected array');
  else if (value.required_evidence.some((item) => !plainObject(item))) errors.push('required_evidence: expected object array');
  stringArray(value.explicit_fields, 'explicit_fields', errors);
  stringArray(value.inherited_fields, 'inherited_fields', errors);
  if (!Array.isArray(value.ambiguity_reasons) ||
      value.ambiguity_reasons.some((item) => !(typeof item === 'string' && item.trim()) && !plainObject(item))) {
    errors.push('ambiguity_reasons: expected string or object array');
  }
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) {
    errors.push('confidence: expected number 0..1');
  }
  if (typeof value.requires_confirmation !== 'boolean') errors.push('requires_confirmation: expected boolean');
  if (!Array.isArray(value.source_spans)) errors.push('source_spans: expected array');
  if (!nullableString(value.source_message_id)) errors.push('source_message_id: expected string or null');
  if (containsOwnerAuthority(value)) errors.push('owner authority is forbidden');
  return { valid: errors.length === 0, errors, value: errors.length ? null : Object.freeze(value) };
}

export function parseAssistantSemanticPlanResponse(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { valid: false, errors: ['response: invalid JSON'], value: null };
  }
  return validateAssistantSemanticPlan(value);
}
