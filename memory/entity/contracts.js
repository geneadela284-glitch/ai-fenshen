export const ENTITY_MODEL_SCHEMA_VERSION = 'v2';
export const ENTITY_ID_PATTERN = /^ent_[0-9a-f]{32}$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function schema(name, fields, required = fields) {
  return Object.freeze({
    name,
    schemaVersion: ENTITY_MODEL_SCHEMA_VERSION,
    fields: Object.freeze([...fields]),
    required: Object.freeze([...required]),
    unknownFieldPolicy: 'reject'
  });
}

export const ENTITY_TYPES = Object.freeze([
  'person', 'organization', 'event', 'place', 'project', 'other'
]);
export const ENTITY_STATUSES = Object.freeze([
  'candidate', 'active', 'merged', 'archived', 'deleted'
]);
export const ENTITY_ALIAS_STATUSES = Object.freeze([
  'active', 'inactive', 'disputed', 'deleted'
]);
export const ENTITY_RELATION_STATUSES = Object.freeze([
  'active', 'ended', 'disputed', 'deleted'
]);
export const ENTITY_RESOLUTION_STATUSES = Object.freeze([
  'exact', 'ambiguous', 'no_match'
]);
export const MEMORY_DECISIONS = Object.freeze([
  'answer_only',
  'ignore',
  'temporary_context',
  'store_silently',
  'confirm_before_store',
  'business_record'
]);
export const MEMORY_DECISION_TYPES = Object.freeze([
  'fact',
  'relationship',
  'preference',
  'goal',
  'life_event',
  'habit_candidate',
  'decision',
  'constraint',
  'temporary_context',
  'financial_record',
  'schedule_record',
  'health_record'
]);
export const MEMORY_DECISION_RETENTION_MODES = Object.freeze([
  'none', 'session', 'ttl', 'long_term', 'business_record'
]);
export const MEMORY_DECISION_ACKNOWLEDGEMENT_POLICIES = Object.freeze([
  'none', 'silent', 'after_commit'
]);
export const MEMORY_DECISION_RESPONSE_POLICIES = Object.freeze([
  'none',
  'answer_only',
  'financial_report_opt_in_advice',
  'silent',
  'request_confirmation',
  'acknowledge_only_after_commit'
]);
export const FINANCIAL_REPORT_ADVICE_PROMPT = '需要我根据这份收支情况给你一些建议吗？';
export const MEMORY_V2_STATUSES = Object.freeze([
  'candidate', 'pending_confirmation', 'confirmed', 'disputed', 'superseded',
  'expired', 'archived', 'deleted'
]);
export const MEMORY_V2_CONFIRMATION_STATUSES = Object.freeze([
  'not_required', 'pending', 'user_confirmed', 'user_rejected', 'system_verified'
]);
export const MEMORY_V2_SENSITIVITIES = Object.freeze([
  'public', 'low', 'medium', 'high', 'restricted'
]);
export const MEMORY_V2_PROVENANCE_LEVELS = Object.freeze([
  'user_stated',
  'user_confirmed',
  'system_verified',
  'ai_inferred',
  'imported_unverified'
]);

export const ENTITY_SOURCE_FIELDS = Object.freeze(['type', 'id']);
export const EntitySource = schema('EntitySource', ENTITY_SOURCE_FIELDS);

export const ENTITY_FIELDS = Object.freeze([
  'schemaVersion', 'entityId', 'ownerUserId', 'type', 'status', 'version',
  'source', 'checksum', 'createdAt', 'updatedAt', 'metadata'
]);
export const Entity = schema('Entity', ENTITY_FIELDS);

export const ENTITY_ALIAS_FIELDS = Object.freeze([
  'schemaVersion', 'alias', 'entityId', 'ownerUserId', 'source', 'confidence',
  'status', 'version', 'createdAt', 'updatedAt', 'metadata'
]);
export const EntityAlias = schema('EntityAlias', ENTITY_ALIAS_FIELDS);

export const ENTITY_RELATION_FIELDS = Object.freeze([
  'schemaVersion', 'relationId', 'ownerUserId', 'sourceEntityId',
  'targetEntityId', 'relationKind', 'role', 'effectiveFrom', 'effectiveTo',
  'status', 'version', 'source', 'checksum', 'createdAt', 'updatedAt', 'metadata'
]);
export const EntityRelation = schema('EntityRelation', ENTITY_RELATION_FIELDS);

export const MEMORY_RECORD_V2_FIELDS = Object.freeze([
  'memoryId', 'schemaVersion', 'ownerUserId', 'memoryType', 'subjectEntityId',
  'predicate', 'structuredValue', 'displayValue', 'legacySubject', 'source',
  'provenance', 'sourceTimestamp', 'createdAt', 'updatedAt', 'effectiveFrom', 'effectiveTo',
  'confidence', 'importance', 'sensitivity', 'status', 'confirmationStatus',
  'expiresAt', 'version', 'supersedesId', 'supersededById', 'conflictGroupId',
  'retentionPolicy', 'accessPolicy', 'checksum', 'tags', 'metadata'
]);
export const MEMORY_RECORD_V2_REQUIRED_FIELDS = Object.freeze([
  'memoryId', 'schemaVersion', 'ownerUserId', 'memoryType', 'subjectEntityId',
  'predicate', 'structuredValue', 'source', 'provenance', 'sourceTimestamp', 'createdAt',
  'updatedAt', 'effectiveFrom', 'confidence', 'importance', 'sensitivity',
  'status', 'confirmationStatus', 'version', 'retentionPolicy', 'accessPolicy',
  'checksum', 'metadata'
]);
export const MemoryRecordV2 = schema(
  'MemoryRecordV2',
  MEMORY_RECORD_V2_FIELDS,
  MEMORY_RECORD_V2_REQUIRED_FIELDS
);

export const MEMORY_RECORD_V2_CHECKSUM_FIELDS = Object.freeze([
  'memoryId',
  'ownerUserId',
  'subjectEntityId',
  'predicate',
  'structuredValue',
  'provenance',
  'version'
]);

export const PREDICATE_STRUCTURED_VALUE_SCHEMAS = deepFreeze({
  birthday: {
    fields: ['date', 'calendarType', 'year', 'month', 'day', 'lunarLeapMonth', 'recurrence'],
    required: ['date'],
    fieldTypes: {
      date: 'iso-date',
      calendarType: 'calendar-type',
      year: 'year-or-null',
      month: 'month',
      day: 'day',
      lunarLeapMonth: 'lunar-leap-month',
      recurrence: 'recurrence'
    },
    unknownFieldPolicy: 'reject'
  },
  preference_statement: {
    fields: ['value', 'values'],
    required: ['value'],
    fieldTypes: { value: 'string', values: 'string-array' },
    unknownFieldPolicy: 'reject'
  },
  favorite_preference_statement: {
    fields: ['value'],
    required: ['value'],
    fieldTypes: { value: 'string' },
    unknownFieldPolicy: 'reject'
  }
});

export const ENTITY_RESOLUTION_FIELDS = Object.freeze([
  'schemaVersion', 'resolutionStatus', 'ownerUserId', 'entityType', 'entityId',
  'relationKind', 'role', 'predicate', 'candidateEntityIds', 'sourceRelationIds',
  'resolutionReason', 'policyVersion', 'resolvedAt'
]);
export const EntityResolution = schema('EntityResolution', ENTITY_RESOLUTION_FIELDS);

export const MEMORY_DECISION_FIELDS = Object.freeze([
  'schemaVersion', 'decision', 'memoryType', 'ownerUserId', 'subjectEntityId',
  'predicate', 'confidence', 'importance', 'sensitivity', 'retentionPolicy',
  'reasonCodes', 'sourceTextDigest', 'entityResolutionStatus',
  'confirmationRequired', 'acknowledgementPolicy', 'duplicateCheckRequired',
  'suggestedStructuredValue', 'responsePolicy', 'policyVersion', 'decidedAt'
]);
export const MemoryDecision = schema('MemoryDecision', MEMORY_DECISION_FIELDS);
