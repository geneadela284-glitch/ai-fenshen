function frozenValues(definition) {
  return Object.freeze(Object.values(definition));
}

export const MemoryStatus = Object.freeze({
  CANDIDATE: 'candidate',
  PENDING_CONFIRMATION: 'pending_confirmation',
  CONFIRMED: 'confirmed',
  DISPUTED: 'disputed',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
  ARCHIVED: 'archived',
  DELETED: 'deleted'
});

export const MemoryConfirmation = Object.freeze({
  NOT_REQUIRED: 'not_required',
  PENDING: 'pending',
  USER_CONFIRMED: 'user_confirmed',
  USER_REJECTED: 'user_rejected',
  SYSTEM_VERIFIED: 'system_verified'
});

export const MemorySensitivity = Object.freeze({
  PUBLIC: 'public',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  RESTRICTED: 'restricted'
});

export const MemoryImportance = Object.freeze({
  MIN: 0,
  MAX: 1
});

export const MemorySourceType = Object.freeze({
  USER_EXPLICIT: 'user_explicit',
  USER_CONFIRMED: 'user_confirmed',
  STRUCTURED_SYSTEM_RECORD: 'structured_system_record',
  REPEATED_OBSERVATION: 'repeated_observation',
  MODEL_INFERRED: 'model_inferred',
  IMPORTED: 'imported',
  LEGACY_UNKNOWN: 'legacy_unknown'
});

export const MemoryType = Object.freeze({
  FACT: 'fact',
  RELATIONSHIP: 'relationship',
  PREFERENCE: 'preference',
  GOAL: 'goal',
  LIFE_EVENT: 'life_event',
  HABIT_ROUTINE: 'habit_routine',
  CONSTRAINT: 'constraint',
  COMMITMENT: 'commitment',
  DECISION: 'decision',
  CONTEXT: 'context',
  MEMORY_CANDIDATE: 'memory_candidate',
  SENSITIVE_MEMORY: 'sensitive_memory'
});

export const MemoryEventType = Object.freeze({
  CANDIDATE_CREATED: 'candidate_created',
  CONFIRMATION_REQUESTED: 'confirmation_requested',
  CONFIRMED: 'confirmed',
  DISPUTED: 'disputed',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
  ARCHIVED: 'archived',
  DELETED: 'deleted'
});

export const MEMORY_STATUSES = frozenValues(MemoryStatus);
export const MEMORY_CONFIRMATIONS = frozenValues(MemoryConfirmation);
export const MEMORY_SENSITIVITIES = frozenValues(MemorySensitivity);
export const MEMORY_SOURCE_TYPES = frozenValues(MemorySourceType);
export const MEMORY_TYPES = frozenValues(MemoryType);
export const MEMORY_EVENT_TYPES = frozenValues(MemoryEventType);
export const MEMORY_IMPORTANCE_RANGE = Object.freeze({ min: MemoryImportance.MIN, max: MemoryImportance.MAX });
