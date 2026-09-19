export const SEMANTIC_MEMORY_INTENTS = Object.freeze([
  'memory_candidate',
  'memory_query',
  'memory_correction',
  'memory_negation',
  'memory_delete',
  'ordinary_chat',
  'ambiguous'
]);

const PLAN_FIELDS = Object.freeze([
  'intent', 'subject', 'predicate', 'value', 'qualifiers', 'confidence',
  'source_spans', 'ambiguity_reasons', 'requires_confirmation', 'inherited_context'
]);
const SUBJECT_FIELDS = Object.freeze([
  'entity_type', 'relation_to_owner', 'normalized_reference', 'resolved_entity_hint'
]);
const QUALIFIER_FIELDS = Object.freeze([
  'calendar_type', 'year', 'month', 'day', 'lunar_leap_month', 'temporal_scope',
  'recurrence', 'degree', 'cardinality', 'negation', 'uncertainty'
]);
const INHERITED_FIELDS = Object.freeze([
  'previous_entity', 'previous_predicate', 'previously_returned_values'
]);
const SPAN_FIELDS = Object.freeze(['text', 'start', 'end']);
const RELATIONS = Object.freeze([
  'self', 'mother', 'father', 'daughter', 'son', 'spouse', 'other', 'unknown'
]);
const CALENDARS = Object.freeze(['gregorian', 'lunar', 'unknown']);
const RECURRENCES = Object.freeze(['yearly', 'one_time', 'unknown']);
const CARDINALITIES = Object.freeze(['single', 'multiple', 'unknown']);
const WRITE_INTENTS = new Set([
  'memory_candidate', 'memory_correction', 'memory_negation', 'memory_delete'
]);
const MEMORY_INTENTS = new Set([...WRITE_INTENTS, 'memory_query']);
const CANONICAL_PREDICATE = /^(?:birthday|likes_[a-z][a-z0-9_]*|favorite_[a-z][a-z0-9_]*)$/;
const EXPLICIT_PREFERENCE_NEGATION = /(?:不(?:再)?(?:喜欢|爱)|讨厌)/;
const FAVORITE_DEGREE = /最(?:喜欢|爱)/;

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, fields, path, errors) {
  if (!object(value)) {
    errors.push(`${path}:invalid_type`);
    return false;
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${path}.${field}:required`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) errors.push(`${path}.${field}:unknown`);
  }
  return true;
}

function nullableString(value) {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

function integerOrNull(value, { min, max }) {
  return value === null || (Number.isInteger(value) && value >= min && value <= max);
}

function validateSubject(value, errors) {
  if (!exactFields(value, SUBJECT_FIELDS, 'subject', errors)) return;
  if (typeof value.entity_type !== 'string' || !value.entity_type.trim()) errors.push('subject.entity_type:invalid');
  if (!RELATIONS.includes(value.relation_to_owner)) errors.push('subject.relation_to_owner:invalid');
  if (typeof value.normalized_reference !== 'string') errors.push('subject.normalized_reference:invalid');
  if (!nullableString(value.resolved_entity_hint)) errors.push('subject.resolved_entity_hint:invalid');
}

function validateQualifiers(value, errors) {
  if (!exactFields(value, QUALIFIER_FIELDS, 'qualifiers', errors)) return;
  if (!CALENDARS.includes(value.calendar_type)) errors.push('qualifiers.calendar_type:invalid');
  if (!integerOrNull(value.year, { min: 1, max: 9999 })) errors.push('qualifiers.year:invalid');
  if (!integerOrNull(value.month, { min: 1, max: 12 })) errors.push('qualifiers.month:invalid');
  if (!integerOrNull(value.day, { min: 1, max: value.calendar_type === 'lunar' ? 30 : 31 })) {
    errors.push('qualifiers.day:invalid');
  }
  if (![true, false, 'unknown'].includes(value.lunar_leap_month)) errors.push('qualifiers.lunar_leap_month:invalid');
  if (value.lunar_leap_month !== 'unknown' && value.calendar_type !== 'lunar') {
    errors.push('qualifiers.lunar_leap_month:calendar_conflict');
  }
  if (typeof value.temporal_scope !== 'string' || !value.temporal_scope.trim()) errors.push('qualifiers.temporal_scope:invalid');
  if (!RECURRENCES.includes(value.recurrence)) errors.push('qualifiers.recurrence:invalid');
  if (typeof value.degree !== 'string' || !value.degree.trim()) errors.push('qualifiers.degree:invalid');
  if (!CARDINALITIES.includes(value.cardinality)) errors.push('qualifiers.cardinality:invalid');
  if (typeof value.negation !== 'boolean') errors.push('qualifiers.negation:invalid');
  if (typeof value.uncertainty !== 'boolean') errors.push('qualifiers.uncertainty:invalid');
}

function validateSpans(value, text, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('source_spans:required');
    return;
  }
  value.forEach((span, index) => {
    const path = `source_spans.${index}`;
    if (!exactFields(span, SPAN_FIELDS, path, errors)) return;
    if (typeof span.text !== 'string' || !span.text) errors.push(`${path}.text:invalid`);
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start) {
      errors.push(`${path}:range_invalid`);
      return;
    }
    if (String(text).slice(span.start, span.end) !== span.text) errors.push(`${path}:source_mismatch`);
  });
}

function validateInherited(value, errors) {
  if (!exactFields(value, INHERITED_FIELDS, 'inherited_context', errors)) return;
  if (!nullableString(value.previous_entity)) errors.push('inherited_context.previous_entity:invalid');
  if (!nullableString(value.previous_predicate)) errors.push('inherited_context.previous_predicate:invalid');
  if (!Array.isArray(value.previously_returned_values) ||
      value.previously_returned_values.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push('inherited_context.previously_returned_values:invalid');
  }
}

export function validateSemanticMemoryPlan(value, { text, minimumConfidence = 0.78 } = {}) {
  const errors = [];
  if (!exactFields(value, PLAN_FIELDS, 'plan', errors)) return Object.freeze({ valid: false, errors: Object.freeze(errors) });
  if (!SEMANTIC_MEMORY_INTENTS.includes(value.intent)) errors.push('intent:invalid');
  validateSubject(value.subject, errors);
  if (!nullableString(value.predicate)) errors.push('predicate:invalid');
  else if (typeof value.predicate === 'string' && !CANONICAL_PREDICATE.test(value.predicate)) {
    errors.push('predicate:unsupported');
  }
  if (MEMORY_INTENTS.has(value.intent) && value.predicate === null) {
    errors.push('predicate:required_for_memory_intent');
  }
  validateQualifiers(value.qualifiers, errors);
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push('confidence:invalid');
  if (WRITE_INTENTS.has(value.intent) && value.confidence < minimumConfidence) errors.push('confidence:below_write_threshold');
  validateSpans(value.source_spans, String(text || ''), errors);
  if (!Array.isArray(value.ambiguity_reasons) ||
      value.ambiguity_reasons.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push('ambiguity_reasons:invalid');
  }
  if (typeof value.requires_confirmation !== 'boolean') errors.push('requires_confirmation:invalid');
  validateInherited(value.inherited_context, errors);
  if (WRITE_INTENTS.has(value.intent) && value.subject?.relation_to_owner === 'unknown') {
    errors.push('subject.relation_to_owner:owner_ambiguous');
  }
  if (value.intent === 'ambiguous' && (!value.requires_confirmation || value.ambiguity_reasons.length === 0)) {
    errors.push('ambiguous:confirmation_required');
  }
  if (value.intent !== 'ambiguous' && value.qualifiers?.uncertainty && WRITE_INTENTS.has(value.intent)) {
    errors.push('qualifiers.uncertainty:write_forbidden');
  }
  const preferencePredicate = typeof value.predicate === 'string' &&
    (value.predicate.startsWith('likes_') || value.predicate.startsWith('favorite_'));
  const explicitPreferenceNegation = preferencePredicate && EXPLICIT_PREFERENCE_NEGATION.test(String(text || ''));
  if (explicitPreferenceNegation && value.intent !== 'memory_negation') {
    errors.push('intent:explicit_preference_negation_conflict');
  }
  if (explicitPreferenceNegation && !FAVORITE_DEGREE.test(String(text || '')) &&
      value.predicate.startsWith('favorite_')) {
    errors.push('predicate:explicit_negation_degree_conflict');
  }
  if (explicitPreferenceNegation && FAVORITE_DEGREE.test(String(text || '')) &&
      value.predicate.startsWith('likes_')) {
    errors.push('predicate:explicit_negation_degree_conflict');
  }
  if (value.intent === 'memory_negation' && value.qualifiers?.negation !== true) {
    errors.push('qualifiers.negation:required_for_negation');
  }
  if (value.intent !== 'memory_negation' && value.qualifiers?.negation === true) {
    errors.push('qualifiers.negation:intent_conflict');
  }
  if (value.predicate === 'birthday' && WRITE_INTENTS.has(value.intent) && value.intent !== 'memory_delete') {
    const hasDate = Number.isInteger(value.qualifiers?.month) && Number.isInteger(value.qualifiers?.day);
    const qualifierOnlyCorrection = value.intent === 'memory_correction' &&
      value.inherited_context?.previous_predicate === 'birthday' && value.qualifiers?.calendar_type !== 'unknown';
    if (!hasDate && !qualifierOnlyCorrection) errors.push('birthday:date_incomplete');
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function parseSemanticMemoryPlanResponse(content, options) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return Object.freeze({ valid: false, errors: Object.freeze(['response:invalid_json']), value: null });
  }
  const validation = validateSemanticMemoryPlan(value, options);
  return Object.freeze({ ...validation, value: validation.valid ? Object.freeze(structuredClone(value)) : null });
}
