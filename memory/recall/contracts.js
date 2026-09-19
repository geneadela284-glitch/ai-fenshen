import {
  MEMORY_TYPES,
  MemorySensitivity,
  createMemoryKernelError,
  findForbiddenSecretPaths
} from '../kernel/index.js';
import { RepositoryActorType } from '../repository/index.js';

export const MemoryRecallIntent = Object.freeze({
  NO_MEMORY_NEEDED: 'no_memory_needed',
  PERSONAL_PREFERENCE: 'personal_preference',
  PERSONAL_FACT: 'personal_fact',
  RELATIONSHIP_CONTEXT: 'relationship_context',
  GOAL_CONTEXT: 'goal_context',
  HABIT_OR_ROUTINE: 'habit_or_routine',
  PRIOR_DECISION: 'prior_decision',
  LIFE_EVENT_CONTEXT: 'life_event_context',
  COMMITMENT_OR_CONSTRAINT: 'commitment_or_constraint',
  RECENT_CONTEXT: 'recent_context',
  HISTORICAL_CONTEXT: 'historical_context',
  SENSITIVE_CONTEXT: 'sensitive_context',
  AMBIGUOUS: 'ambiguous'
});

export const RecallReasonCode = Object.freeze({
  NO_PERSONAL_MEMORY_NEEDED: 'RECALL_NO_PERSONAL_MEMORY_NEEDED',
  PREFERENCE_SIGNAL: 'RECALL_PREFERENCE_SIGNAL',
  FACT_SIGNAL: 'RECALL_FACT_SIGNAL',
  RELATIONSHIP_SIGNAL: 'RECALL_RELATIONSHIP_SIGNAL',
  GOAL_SIGNAL: 'RECALL_GOAL_SIGNAL',
  ROUTINE_SIGNAL: 'RECALL_ROUTINE_SIGNAL',
  DECISION_SIGNAL: 'RECALL_DECISION_SIGNAL',
  LIFE_EVENT_SIGNAL: 'RECALL_LIFE_EVENT_SIGNAL',
  COMMITMENT_SIGNAL: 'RECALL_COMMITMENT_SIGNAL',
  RECENT_SIGNAL: 'RECALL_RECENT_SIGNAL',
  HISTORICAL_SIGNAL: 'RECALL_HISTORICAL_SIGNAL',
  SENSITIVE_SIGNAL: 'RECALL_SENSITIVE_SIGNAL',
  AMBIGUOUS_SIGNAL: 'RECALL_AMBIGUOUS_SIGNAL',
  ASSISTANT_SUGGESTION: 'RECALL_ASSISTANT_SUGGESTION',
  RULE_FALLBACK: 'RECALL_RULE_FALLBACK',
  PLAN_CREATED: 'RECALL_PLAN_CREATED',
  EMPTY: 'RECALL_EMPTY',
  SELECTED: 'RECALL_SELECTED',
  FILTERED: 'RECALL_FILTERED',
  BUDGET_TRIMMED: 'RECALL_BUDGET_TRIMMED',
  CONFLICT_FOUND: 'RECALL_CONFLICT_FOUND',
  INVALID_CONTEXT: 'RECALL_INVALID_CONTEXT',
  INVALID_PLAN: 'RECALL_INVALID_PLAN',
  REPOSITORY_UNAVAILABLE: 'RECALL_REPOSITORY_UNAVAILABLE',
  RANKING_FAILED: 'RECALL_RANKING_FAILED'
});

export const RecallAuditAction = Object.freeze({
  INTENT_ANALYZED: 'recall_intent_analyzed',
  PLAN_CREATED: 'recall_plan_created',
  EXECUTED: 'recall_executed',
  EMPTY: 'recall_empty',
  CONFLICT_FOUND: 'recall_conflict_found',
  SENSITIVE_FILTERED: 'recall_sensitive_filtered',
  BUDGET_TRIMMED: 'recall_budget_trimmed',
  FAILED: 'recall_failed',
  CONTEXT_PACK_CREATED: 'context_pack_created'
});

export const RecallConflictClassification = Object.freeze({
  RESOLVED_CURRENT: 'resolved_current',
  HISTORICAL_ONLY: 'historical_only',
  POTENTIAL_CONFLICT: 'potential_conflict',
  UNRESOLVED_CONFLICT: 'unresolved_conflict',
  DUPLICATE: 'duplicate',
  INDEPENDENT_EVENT: 'independent_event'
});

const CONTEXT_FIELDS = Object.freeze([
  'authenticatedUserId', 'actorType', 'actorId', 'requestId', 'correlationId',
  'timestamp', 'timezone', 'locale', 'taskType', 'purpose', 'sensitivityAllowance',
  'contextBudget', 'policyVersion', 'metadata'
]);
const ALLOWED_SENSITIVITY = Object.freeze([
  MemorySensitivity.PUBLIC, MemorySensitivity.LOW, MemorySensitivity.MEDIUM, MemorySensitivity.HIGH
]);
const DEFAULT_BUDGET = Object.freeze({
  maxItems: 8,
  maxCharacters: 4000,
  maxEstimatedTokens: 1000,
  maxSensitiveItems: 0,
  perTypeLimit: 4,
  reserveForCurrentTask: 200,
  reserveForSystemInstructions: 200
});
const BUDGET_CEILINGS = Object.freeze({
  maxItems: 20,
  maxCharacters: 12000,
  maxEstimatedTokens: 3000,
  maxSensitiveItems: 2,
  perTypeLimit: 10,
  reserveForCurrentTask: 2000,
  reserveForSystemInstructions: 2000
});

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function string(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function issue(path, code, message) {
  return createMemoryKernelError(path, code, message);
}

export function deepFreezeRecall(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreezeRecall(nested);
  return value;
}

export function normalizeMemoryContextBudget(value = {}) {
  const input = object(value) ? value : {};
  return deepFreezeRecall(Object.fromEntries(Object.keys(DEFAULT_BUDGET).map((key) => {
    const proposed = Number.isFinite(input[key]) && input[key] >= 0 ? Math.floor(input[key]) : DEFAULT_BUDGET[key];
    return [key, Math.min(proposed, BUDGET_CEILINGS[key])];
  })));
}

export function validateMemoryRecallContext(context) {
  const errors = [];
  if (!object(context)) return { valid: false, errors: [issue('', 'INVALID_TYPE', 'MemoryRecallContext must be an object.')], warnings: [] };
  for (const field of CONTEXT_FIELDS) if (!(field in context)) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
  for (const field of Object.keys(context)) if (!CONTEXT_FIELDS.includes(field)) errors.push(issue(field, 'UNKNOWN_FIELD', `${field} is not allowed.`));
  for (const field of ['authenticatedUserId', 'actorId', 'requestId', 'correlationId', 'timezone', 'locale', 'taskType', 'purpose', 'policyVersion']) {
    if (field in context && !string(context[field])) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
  }
  if (!Object.values(RepositoryActorType).includes(context.actorType)) errors.push(issue('actorType', 'INVALID_ENUM', 'actorType is invalid.'));
  if (!string(context.timestamp) || Number.isNaN(Date.parse(context.timestamp))) errors.push(issue('timestamp', 'INVALID_DATE', 'timestamp must be ISO 8601.'));
  if (!ALLOWED_SENSITIVITY.includes(context.sensitivityAllowance)) errors.push(issue('sensitivityAllowance', 'INVALID_ENUM', 'sensitivityAllowance is invalid.'));
  if (!object(context.contextBudget) || Object.values(context.contextBudget).some((item) => !Number.isFinite(item) || item < 0)) {
    errors.push(issue('contextBudget', 'INVALID_RANGE', 'contextBudget must contain finite non-negative limits.'));
  }
  if (!object(context.metadata)) errors.push(issue('metadata', 'INVALID_TYPE', 'metadata must be an object.'));
  else for (const path of findForbiddenSecretPaths(context.metadata, 'metadata')) errors.push(issue(path, 'SECRET_FORBIDDEN', 'Recall metadata cannot contain secrets.'));
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function toRepositoryContext(context) {
  return deepFreezeRecall({
    authenticatedUserId: context.authenticatedUserId,
    actorType: context.actorType,
    actorId: context.actorId,
    requestId: context.requestId,
    correlationId: context.correlationId,
    timestamp: context.timestamp,
    policyVersion: context.policyVersion,
    transactionId: null,
    metadata: {}
  });
}

export function validateMemoryRecallPlan(plan, { trustedUserId } = {}) {
  const errors = [];
  if (!object(plan)) return { valid: false, errors: [issue('', 'INVALID_TYPE', 'MemoryRecallPlan must be an object.')], warnings: [] };
  if (!string(plan.userId)) errors.push(issue('userId', 'REQUIRED', 'userId is required.'));
  else if (plan.userId !== trustedUserId) errors.push(issue('userId', 'USER_SCOPE_MISMATCH', 'Plan userId must match trusted context.'));
  if (!Object.values(MemoryRecallIntent).includes(plan.intent)) errors.push(issue('intent', 'INVALID_ENUM', 'intent is invalid.'));
  if (!Array.isArray(plan.memoryTypes) || plan.memoryTypes.some((type) => !MEMORY_TYPES.includes(type))) errors.push(issue('memoryTypes', 'INVALID_ENUM', 'memoryTypes are invalid.'));
  if (!Array.isArray(plan.subjects) || plan.subjects.some((item) => !string(item))) errors.push(issue('subjects', 'INVALID_TYPE', 'subjects must be an array of non-empty strings.'));
  if (!Array.isArray(plan.predicates) || plan.predicates.some((item) => !string(item))) errors.push(issue('predicates', 'INVALID_TYPE', 'predicates must be an array of non-empty strings.'));
  if (plan.timeRange !== null && !(
    object(plan.timeRange) && string(plan.timeRange.from) && string(plan.timeRange.to) &&
    !Number.isNaN(Date.parse(plan.timeRange.from)) && !Number.isNaN(Date.parse(plan.timeRange.to))
  )) errors.push(issue('timeRange', 'INVALID_DATE_RANGE', 'timeRange must be null or an ISO 8601 range.'));
  if (!string(plan.effectiveAt) || Number.isNaN(Date.parse(plan.effectiveAt))) errors.push(issue('effectiveAt', 'INVALID_DATE', 'effectiveAt must be ISO 8601.'));
  if (plan.includeCandidates !== false) errors.push(issue('includeCandidates', 'INVARIANT_VIOLATION', 'Normal recall cannot include Candidates.'));
  if (typeof plan.includeHistorical !== 'boolean') errors.push(issue('includeHistorical', 'INVALID_TYPE', 'includeHistorical must be boolean.'));
  if (!ALLOWED_SENSITIVITY.includes(plan.sensitivityMax)) errors.push(issue('sensitivityMax', 'INVALID_ENUM', 'sensitivityMax is invalid.'));
  if (!Number.isInteger(plan.limit) || plan.limit < 0 || plan.limit > 50) errors.push(issue('limit', 'INVALID_RANGE', 'limit must be between zero and fifty.'));
  if (plan.sort !== 'updatedAt:desc') errors.push(issue('sort', 'INVALID_ENUM', 'sort must use the stable updatedAt order.'));
  if (!object(plan.budget)) errors.push(issue('budget', 'INVALID_TYPE', 'budget is required.'));
  if (!object(plan.rankingWeights)) errors.push(issue('rankingWeights', 'INVALID_TYPE', 'rankingWeights are required.'));
  if (plan.conflictPolicy !== 'safe_unresolved') errors.push(issue('conflictPolicy', 'INVALID_ENUM', 'conflictPolicy must fail safe.'));
  if (!Array.isArray(plan.reasonCodes)) errors.push(issue('reasonCodes', 'INVALID_TYPE', 'reasonCodes must be an array.'));
  return { valid: errors.length === 0, errors, warnings: [] };
}
