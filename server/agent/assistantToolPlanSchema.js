const REQUIRED_KEYS = Object.freeze([
  'domain', 'action', 'tool', 'arguments', 'required_evidence', 'inherited_context',
  'confidence', 'ambiguity', 'requires_confirmation', 'source_message_id'
]);

const OWNER_KEYS = new Set(['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsOwnerAuthority(value) {
  if (Array.isArray(value)) return value.some(containsOwnerAuthority);
  if (!plainObject(value)) return false;
  return Object.entries(value).some(([key, child]) => OWNER_KEYS.has(key) || containsOwnerAuthority(child));
}

function parseJson(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return null; }
}

export function validateAssistantToolPlan(value) {
  const errors = [];
  if (!plainObject(value)) return { ok: false, errors: ['plan: expected object'] };
  for (const key of REQUIRED_KEYS) if (!(key in value)) errors.push(`${key}: required`);
  for (const key of Object.keys(value)) if (!REQUIRED_KEYS.includes(key)) errors.push(`${key}: unexpected field`);
  if (!['tool', 'ordinary_chat'].includes(value.domain)) errors.push('domain: invalid enum');
  if (value.domain === 'tool') {
    if (typeof value.action !== 'string' || !value.action.trim()) errors.push('action: expected non-empty string');
    if (typeof value.tool !== 'string' || !value.tool.trim()) errors.push('tool: expected non-empty string');
  } else if (value.action !== 'ordinary_chat' || value.tool !== null) {
    errors.push('ordinary_chat: action/tool mismatch');
  }
  if (!plainObject(value.arguments)) errors.push('arguments: expected object');
  if (!Array.isArray(value.required_evidence)) errors.push('required_evidence: expected array');
  else for (const [index, requirement] of value.required_evidence.entries()) {
    if (!plainObject(requirement)) { errors.push(`required_evidence.${index}: expected object`); continue; }
    if (typeof requirement.entity_relation !== 'string' || !requirement.entity_relation.trim()) errors.push(`required_evidence.${index}.entity_relation: required`);
    if (typeof requirement.predicate !== 'string' || !requirement.predicate.trim()) errors.push(`required_evidence.${index}.predicate: required`);
    if (!Array.isArray(requirement.required_qualifiers) || requirement.required_qualifiers.some((item) => typeof item !== 'string')) {
      errors.push(`required_evidence.${index}.required_qualifiers: expected string array`);
    }
  }
  if (!plainObject(value.inherited_context)) errors.push('inherited_context: expected object');
  else {
    for (const key of ['previous_entity', 'previous_predicate', 'previous_tool']) {
      if (!(key in value.inherited_context) || ![null, 'string'].includes(value.inherited_context[key] === null ? null : typeof value.inherited_context[key])) {
        errors.push(`inherited_context.${key}: expected string or null`);
      }
    }
  }
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) errors.push('confidence: expected number 0..1');
  if (!Array.isArray(value.ambiguity) || value.ambiguity.some((item) => typeof item !== 'string')) errors.push('ambiguity: expected string array');
  if (typeof value.requires_confirmation !== 'boolean') errors.push('requires_confirmation: expected boolean');
  if (!(value.source_message_id === null || typeof value.source_message_id === 'string')) errors.push('source_message_id: expected string or null');
  if (containsOwnerAuthority(value)) errors.push('owner authority is forbidden');
  return { ok: errors.length === 0, errors };
}

export function parseAssistantToolPlanResponse(content) {
  const value = parseJson(content);
  if (!value) return { valid: false, errors: ['response: invalid JSON'], value: null };
  const validation = validateAssistantToolPlan(value);
  return { valid: validation.ok, errors: validation.errors, value: validation.ok ? value : null };
}
