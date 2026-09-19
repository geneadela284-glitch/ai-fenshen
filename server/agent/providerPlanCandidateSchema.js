const FIELDS = Object.freeze([
  'domain', 'intent', 'action', 'entity', 'relation_to_owner', 'predicate', 'value',
  'qualifiers', 'tool', 'arguments', 'required_evidence', 'explicit_fields',
  'inherited_fields', 'ambiguity_reasons', 'confidence', 'requires_confirmation',
  'source_spans', 'source_message_id'
]);
const REQUIRED_FIELDS = Object.freeze([
  'domain', 'intent', 'action', 'entity', 'predicate', 'value', 'qualifiers',
  'tool', 'arguments', 'required_evidence', 'explicit_fields', 'inherited_fields',
  'ambiguity_reasons'
]);
const ENTITY_FIELDS = Object.freeze(['type', 'reference', 'relation_to_owner']);
const DOMAINS = new Set(['memory', 'finance', 'tool', 'ordinary_chat', 'ambiguous']);
const CONFIDENCE_BANDS = new Set(['high', 'medium', 'low']);
const OWNER_KEYS = new Set(['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id']);
const TOOL_ENVELOPE_FIELDS = new Set([
  'id', 'description', 'argumentSchema', 'actions', 'evidenceSchema',
  'permissions', 'planSchema', 'resultSchema', 'failureBehavior',
  'action', 'arguments', 'required_evidence'
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function stringArray(value, path, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()) ||
      new Set(value).size !== value.length) {
    errors.push(`${path}: expected unique string array`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!plainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function normalizeExplicitToolInvocation(value) {
  const envelope = plainObject(value.tool) ? value.tool : null;
  if (envelope && Object.keys(envelope).some((field) => !TOOL_ENVELOPE_FIELDS.has(field))) {
    return value;
  }
  const toolId = typeof value.tool === 'string' ? value.tool : envelope?.id;
  const topLevelArguments = plainObject(value.arguments) ? value.arguments : {};
  const envelopeArguments = plainObject(envelope?.arguments) ? envelope.arguments : null;
  const action = (value.domain === 'tool' && typeof value.action === 'string'
    ? value.action
    : null) ??
    envelope?.action ??
    topLevelArguments.action ??
    (Array.isArray(envelope?.actions) && envelope.actions.length === 1
      ? envelope.actions[0]
      : toolId);
  if (typeof toolId !== 'string' || !toolId.trim() ||
      typeof action !== 'string' || !action.trim()) {
    return value;
  }
  const hasTopLevelArguments = Object.keys(topLevelArguments).length > 0;
  if (envelope && (!envelopeArguments ||
      (hasTopLevelArguments && stableJson(topLevelArguments) !== stableJson(envelopeArguments)))) {
    return value;
  }
  const topLevelEvidence = Array.isArray(value.required_evidence) ? value.required_evidence : [];
  const envelopeEvidence = Array.isArray(envelope?.required_evidence)
    ? envelope.required_evidence
    : [];
  if (envelope && topLevelEvidence.length && envelopeEvidence.length &&
      stableJson(topLevelEvidence) !== stableJson(envelopeEvidence)) {
    return value;
  }
  const invocationArguments = structuredClone(
    hasTopLevelArguments ? topLevelArguments : envelopeArguments || {}
  );
  delete invocationArguments.action;
  return {
    ...value,
    domain: 'tool',
    action,
    tool: toolId,
    arguments: invocationArguments,
    required_evidence: structuredClone(
      topLevelEvidence.length ? topLevelEvidence : envelopeEvidence
    )
  };
}

function normalizeKnownEmptyContainers(input) {
  const value = normalizeExplicitToolInvocation(structuredClone(input));
  if (value.domain === 'tool' &&
      (value.tool === 'tasks.create' || ['tasks.create', 'create_task'].includes(value.action))) {
    // Tasks provenance is bound from the authenticated request after planning.
    // Provider-supplied evidence varies in shape and is never trusted by the Tasks tool.
    value.required_evidence = [];
  }
  if (value.entity === null) {
    value.entity = { type: null, reference: null, relation_to_owner: null };
  } else if (plainObject(value.entity)) {
    value.entity = {
      ...value.entity,
      type: Object.hasOwn(value.entity, 'type') ? value.entity.type : null,
      reference: Object.hasOwn(value.entity, 'reference') ? value.entity.reference : null,
      relation_to_owner: Object.hasOwn(value.entity, 'relation_to_owner')
        ? value.entity.relation_to_owner
        : null
    };
  }
  if (value.qualifiers === null || (Array.isArray(value.qualifiers) && value.qualifiers.length === 0)) {
    value.qualifiers = {};
  }
  if (value.arguments === null || (Array.isArray(value.arguments) && value.arguments.length === 0)) {
    value.arguments = {};
  }
  if (value.required_evidence === null) value.required_evidence = [];
  if (value.explicit_fields === null) value.explicit_fields = [];
  if (value.inherited_fields === null) value.inherited_fields = [];
  if (value.ambiguity_reasons === null) value.ambiguity_reasons = [];
  if (value.source_spans === null || value.source_spans === undefined) value.source_spans = [];
  if (value.requires_confirmation === null || value.requires_confirmation === undefined) {
    value.requires_confirmation = false;
  }
  if (!Object.hasOwn(value, 'confidence')) value.confidence = null;
  if (!Object.hasOwn(value, 'source_message_id')) value.source_message_id = null;
  return value;
}

export function validateProviderPlanCandidate(input) {
  if (!plainObject(input)) {
    return { valid: false, errors: ['plan: expected object'], value: null };
  }
  const value = normalizeKnownEmptyContainers(input);
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field)) errors.push(`plan.${field}: required`);
  }
  for (const field of Object.keys(value)) {
    if (!FIELDS.includes(field)) errors.push(`plan.${field}: unexpected field`);
  }
  if (!DOMAINS.has(value.domain)) errors.push('domain: invalid enum');
  if (typeof value.intent !== 'string' || !value.intent.trim()) errors.push('intent: required');
  if (typeof value.action !== 'string' || !value.action.trim()) errors.push('action: required');

  if (!plainObject(value.entity)) {
    errors.push('entity: expected object');
  } else {
    for (const field of ['type', 'reference']) {
      if (!Object.hasOwn(value.entity, field)) errors.push(`entity.${field}: required`);
    }
    for (const field of Object.keys(value.entity)) {
      if (!ENTITY_FIELDS.includes(field)) errors.push(`entity.${field}: unexpected field`);
    }
    if (!nullableString(value.entity.type)) errors.push('entity.type: expected string or null');
    if (!nullableString(value.entity.reference)) errors.push('entity.reference: expected string or null');
    if (Object.hasOwn(value.entity, 'relation_to_owner') &&
        !nullableString(value.entity.relation_to_owner)) {
      errors.push('entity.relation_to_owner: expected string or null');
    }
  }
  if (Object.hasOwn(value, 'relation_to_owner') && !nullableString(value.relation_to_owner)) {
    errors.push('relation_to_owner: expected string or null');
  }
  if (!nullableString(value.predicate)) errors.push('predicate: expected string or null');
  if (!plainObject(value.qualifiers)) errors.push('qualifiers: expected object');
  if (!plainObject(value.arguments)) errors.push('arguments: expected object');

  const inheritedTool = value.domain === 'tool' && value.tool === null &&
    Array.isArray(value.inherited_fields) && value.inherited_fields.includes('tool');
  if (value.domain === 'tool') {
    if (!inheritedTool && (typeof value.tool !== 'string' || !value.tool.trim())) {
      errors.push('tool: required');
    }
  } else if (value.tool !== null) {
    errors.push('tool: must be null outside tool domain');
  }
  if (!Array.isArray(value.required_evidence) ||
      value.required_evidence.some((item) => !plainObject(item))) {
    errors.push('required_evidence: expected object array');
  }
  stringArray(value.explicit_fields, 'explicit_fields', errors);
  stringArray(value.inherited_fields, 'inherited_fields', errors);
  if (!Array.isArray(value.ambiguity_reasons) ||
      value.ambiguity_reasons.some((item) =>
        !(typeof item === 'string' && item.trim()) && !plainObject(item))) {
    errors.push('ambiguity_reasons: expected string or object array');
  }
  const confidenceValid = value.confidence === null ||
    (typeof value.confidence === 'number' && Number.isFinite(value.confidence) &&
      value.confidence >= 0 && value.confidence <= 1) ||
    (typeof value.confidence === 'string' && CONFIDENCE_BANDS.has(value.confidence));
  if (!confidenceValid) {
    errors.push('confidence: expected number 0..1, high/medium/low, or null');
  }
  if (typeof value.requires_confirmation !== 'boolean') {
    errors.push('requires_confirmation: expected boolean');
  }
  if (!Array.isArray(value.source_spans)) errors.push('source_spans: expected array');
  if (!nullableString(value.source_message_id)) {
    errors.push('source_message_id: expected string or null');
  }
  if (containsOwnerAuthority(input) || containsOwnerAuthority(value)) {
    errors.push('owner authority is forbidden');
  }
  return {
    valid: errors.length === 0,
    errors,
    value: errors.length ? null : Object.freeze(value)
  };
}

export function parseProviderPlanCandidateResponse(content) {
  const raw = String(content || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { valid: false, errors: ['response: invalid JSON'], value: null };
  }
  return validateProviderPlanCandidate(value);
}
