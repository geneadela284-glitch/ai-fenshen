import {
  ENTITY_ID_PATTERN,
  ENTITY_MODEL_SCHEMA_VERSION,
  ENTITY_RESOLUTION_STATUSES,
  MEMORY_DECISIONS,
  MEMORY_DECISION_ACKNOWLEDGEMENT_POLICIES,
  MEMORY_DECISION_RESPONSE_POLICIES,
  MEMORY_DECISION_TYPES,
  MEMORY_V2_SENSITIVITIES,
  MemoryDecision
} from './contracts.js';

export const MEMORY_DECISION_POLICY_VERSION = 'memory-capture-decision-v1';

const SAFE_SENSITIVITIES = new Set(['public', 'low']);
const CONFLICT_STATUSES = new Set(['none', 'conflict', 'unknown']);
const DUPLICATE_STATUSES = new Set(['none', 'possible', 'exact', 'unknown']);

const STRUCTURED_VALUE_SCHEMAS = Object.freeze({
  birthday: Object.freeze({ required: ['date'], optional: [], types: { date: 'iso-date' } }),
  fact_statement: Object.freeze({ required: ['value'], optional: [], types: { value: 'string' } }),
  relationship_statement: Object.freeze({ required: ['summary'], optional: [], types: { summary: 'string' } }),
  preference_statement: Object.freeze({ required: ['value'], optional: ['values'], types: { value: 'string', values: 'string-array' } }),
  favorite_preference_statement: Object.freeze({ required: ['value'], optional: [], types: { value: 'string' } }),
  goal_statement: Object.freeze({ required: ['summary'], optional: ['targetDate'], types: { summary: 'string', targetDate: 'iso-date-or-null' } }),
  life_event: Object.freeze({ required: ['summary'], optional: ['date'], types: { summary: 'string', date: 'iso-date-or-null' } }),
  habit_observation: Object.freeze({ required: ['summary', 'observedAt'], optional: [], types: { summary: 'string', observedAt: 'iso-timestamp' } }),
  decision_statement: Object.freeze({ required: ['summary'], optional: [], types: { summary: 'string' } }),
  constraint_statement: Object.freeze({ required: ['summary'], optional: [], types: { summary: 'string' } }),
  temporary_presence: Object.freeze({ required: ['summary', 'expiresAt'], optional: [], types: { summary: 'string', expiresAt: 'iso-timestamp' } }),
  financial_transaction: Object.freeze({
    required: ['direction', 'amount', 'currency', 'category'], optional: [],
    types: { direction: 'financial-direction', amount: 'positive-number', currency: 'currency', category: 'string' }
  }),
  schedule_item: Object.freeze({ required: ['title', 'startsAt'], optional: [], types: { title: 'string', startsAt: 'iso-timestamp' } }),
  health_observation: Object.freeze({ required: ['summary'], optional: [], types: { summary: 'string' } })
});

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validType(value, type) {
  if (type === 'string') return nonEmptyString(value);
  if (type === 'string-array') return Array.isArray(value) && value.length > 0 &&
    value.every(nonEmptyString) && new Set(value.map((item) => item.trim())).size === value.length;
  if (type === 'iso-date') return isoCalendarDate(value);
  if (type === 'iso-date-or-null') return value === null || isoCalendarDate(value);
  if (type === 'iso-timestamp') return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  if (type === 'positive-number') return Number.isFinite(value) && value > 0;
  if (type === 'currency') return /^[A-Z]{3}$/.test(String(value || ''));
  if (type === 'financial-direction') return ['income', 'expense'].includes(value);
  return false;
}

export function validateMemoryDecisionStructuredValue(predicate, value) {
  const errors = [];
  const schema = STRUCTURED_VALUE_SCHEMAS[predicate];
  if (!schema) return immutable({ valid: false, errors: ['predicate_schema_missing'] });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return immutable({ valid: false, errors: ['structured_value_invalid_type'] });
  }
  const allowed = new Set([...schema.required, ...schema.optional]);
  for (const field of schema.required) {
    if (!(field in value)) errors.push(`structured_value_required:${field}`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`structured_value_unknown_field:${field}`);
  }
  for (const [field, type] of Object.entries(schema.types)) {
    if (field in value && !validType(value[field], type)) errors.push(`structured_value_invalid_type:${field}`);
  }
  return immutable({ valid: errors.length === 0, errors });
}

function reasons(proposal, additions) {
  return Object.freeze([...new Set([...proposal.reasonCodes, ...additions])]);
}

function exactEntity(ownerUserId, resolution) {
  return resolution?.resolutionStatus === 'exact' &&
    resolution.ownerUserId === ownerUserId &&
    ENTITY_ID_PATTERN.test(String(resolution.entityId || ''));
}

function responsePolicy(decision, reasonCodes) {
  if (decision === 'answer_only' && reasonCodes.includes('financial_report_query')) {
    return 'financial_report_opt_in_advice';
  }
  return {
    answer_only: 'answer_only',
    ignore: 'none',
    temporary_context: 'none',
    store_silently: 'silent',
    confirm_before_store: 'request_confirmation',
    business_record: 'acknowledge_only_after_commit'
  }[decision];
}

function acknowledgementPolicy(decision) {
  if (decision === 'store_silently') return 'silent';
  if (decision === 'business_record') return 'after_commit';
  return 'none';
}

function expectedRetention(decision) {
  if (decision === 'temporary_context') return new Set(['session', 'ttl']);
  if (decision === 'store_silently' || decision === 'confirm_before_store') return new Set(['long_term', 'business_record', 'ttl']);
  if (decision === 'business_record') return new Set(['business_record']);
  return new Set(['none']);
}

export function evaluateMemoryDecisionPolicy({ ownerUserId, entityResolution, proposal, inspection }) {
  const additions = [];
  let decision = proposal.proposedDecision;
  const storingCandidate = !['answer_only', 'ignore'].includes(decision);
  const entityExact = exactEntity(ownerUserId, entityResolution);
  const conflictStatus = CONFLICT_STATUSES.has(inspection?.conflictStatus)
    ? inspection.conflictStatus
    : 'unknown';
  const duplicateStatus = DUPLICATE_STATUSES.has(inspection?.duplicateStatus)
    ? inspection.duplicateStatus
    : 'unknown';
  const structured = proposal.predicate === null
    ? { valid: proposal.suggestedStructuredValue === null }
    : validateMemoryDecisionStructuredValue(proposal.predicate, proposal.suggestedStructuredValue);

  if (storingCandidate && entityResolution?.ownerUserId !== ownerUserId) {
    decision = 'confirm_before_store';
    additions.push('owner_scope_mismatch');
  } else if (storingCandidate && !entityExact) {
    decision = 'confirm_before_store';
    additions.push('entity_resolution_not_exact');
  }
  if (storingCandidate && !structured.valid) {
    decision = 'confirm_before_store';
    additions.push('structured_value_invalid');
  }
  if (storingCandidate && proposal.needsClarification) {
    decision = 'confirm_before_store';
    additions.push('semantic_clarification_required');
  }
  if (storingCandidate && (!SAFE_SENSITIVITIES.has(proposal.sensitivity) || proposal.confidence < 0.85)) {
    decision = 'confirm_before_store';
    additions.push(!SAFE_SENSITIVITIES.has(proposal.sensitivity) ? 'sensitive_information' : 'confidence_below_silent_threshold');
  }
  if (proposal.proposedDecision === 'store_silently' && proposal.importance < 0.5) {
    decision = 'ignore';
    additions.push('importance_below_storage_threshold');
  }
  if (proposal.proposedDecision === 'temporary_context' &&
      proposal.retentionPolicy.mode === 'ttl' &&
      proposal.suggestedStructuredValue?.expiresAt !== proposal.retentionPolicy.expiresAt) {
    decision = 'confirm_before_store';
    additions.push('retention_expiry_mismatch');
  }
  if (storingCandidate && conflictStatus !== 'none') {
    decision = 'confirm_before_store';
    additions.push(conflictStatus === 'conflict' ? 'existing_fact_conflict' : 'conflict_check_unavailable');
  }
  if (storingCandidate && duplicateStatus === 'exact') {
    decision = 'ignore';
    additions.push('exact_duplicate');
  } else if (storingCandidate && duplicateStatus !== 'none') {
    decision = 'confirm_before_store';
    additions.push(duplicateStatus === 'possible' ? 'possible_duplicate' : 'duplicate_check_unavailable');
  }
  const policyIgnoredStorage = duplicateStatus === 'exact' || additions.includes('importance_below_storage_threshold');
  if (!policyIgnoredStorage && !expectedRetention(decision).has(proposal.retentionPolicy.mode)) {
    decision = 'confirm_before_store';
    additions.push('retention_policy_mismatch');
  }
  if (proposal.proposedDecision === 'business_record' && !proposal.explicitBusinessIntent) {
    decision = 'confirm_before_store';
    additions.push('business_intent_not_explicit');
  }

  const reasonCodes = reasons(proposal, additions);
  return immutable({
    decision,
    subjectEntityId: entityExact ? entityResolution.entityId : null,
    confirmationRequired: decision === 'confirm_before_store',
    acknowledgementPolicy: acknowledgementPolicy(decision),
    duplicateCheckRequired: storingCandidate,
    responsePolicy: responsePolicy(decision, reasonCodes),
    reasonCodes
  });
}

export function validateMemoryDecision(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['invalid_type'] };
  for (const field of MemoryDecision.required) if (!(field in value)) errors.push(`required:${field}`);
  for (const field of Object.keys(value)) if (!MemoryDecision.fields.includes(field)) errors.push(`unknown:${field}`);
  if (value.schemaVersion !== ENTITY_MODEL_SCHEMA_VERSION) errors.push('schema_version');
  if (!MEMORY_DECISIONS.includes(value.decision)) errors.push('decision');
  if (value.memoryType !== null && !MEMORY_DECISION_TYPES.includes(value.memoryType)) errors.push('memory_type');
  if (!MEMORY_V2_SENSITIVITIES.includes(value.sensitivity)) errors.push('sensitivity');
  if (!ENTITY_RESOLUTION_STATUSES.includes(value.entityResolutionStatus)) errors.push('resolution_status');
  if (!MEMORY_DECISION_ACKNOWLEDGEMENT_POLICIES.includes(value.acknowledgementPolicy)) errors.push('acknowledgement_policy');
  if (!MEMORY_DECISION_RESPONSE_POLICIES.includes(value.responsePolicy)) errors.push('response_policy');
  if (!/^[a-f0-9]{64}$/.test(String(value.sourceTextDigest || ''))) errors.push('source_text_digest');
  return { valid: errors.length === 0, errors };
}
