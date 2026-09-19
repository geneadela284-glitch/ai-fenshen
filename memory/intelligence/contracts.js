import { findForbiddenSecretPaths } from '../kernel/index.js';

export const LifePatternType = Object.freeze({ REPEATED_BEHAVIOR: 'repeated_behavior' });
export const LifeCadence = Object.freeze({ REPEATED: 'repeated', DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' });
export const LifeTrendType = Object.freeze({ VALUE_CHANGE: 'value_change' });
export const LifeTrendDirection = Object.freeze({ CHANGED: 'changed' });
export const LifeDerivedStatus = Object.freeze({ OBSERVED: 'observed', EXPLICIT: 'explicit', INFORMATIONAL: 'informational', OPTIONAL: 'optional' });
export const LifeInsightType = Object.freeze({ PATTERN_SUMMARY: 'pattern_summary', TREND_SUMMARY: 'trend_summary', STAGE_SUMMARY: 'stage_summary' });
export const LifeSuggestionType = Object.freeze({ OPTIONAL_REFLECTION: 'optional_reflection' });

const PATTERN_FIELDS = ['id', 'userId', 'patternType', 'subject', 'predicate', 'occurrenceCount', 'beginTime', 'endTime', 'cadence', 'status', 'confidence', 'importance', 'memoryIds', 'timelineEventIds', 'evidence', 'metadata'];
const TREND_FIELDS = ['id', 'userId', 'trendType', 'subject', 'predicate', 'beginTime', 'endTime', 'direction', 'status', 'confidence', 'memoryIds', 'timelineEventIds', 'evidence', 'metadata'];
const STAGE_FIELDS = ['id', 'userId', 'periodId', 'title', 'beginTime', 'endTime', 'status', 'confidence', 'memoryIds', 'timelinePeriodIds', 'evidence', 'metadata'];
const INSIGHT_FIELDS = ['id', 'userId', 'insightType', 'title', 'summary', 'confidence', 'status', 'memoryIds', 'timelineEventIds', 'patternIds', 'trendIds', 'stageIds', 'evidence', 'createdAt', 'metadata'];
const SUGGESTION_FIELDS = ['id', 'userId', 'suggestionType', 'title', 'summary', 'decisionOwner', 'status', 'insightIds', 'memoryIds', 'evidence', 'createdAt', 'metadata'];

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function string(value) { return typeof value === 'string' && value.trim().length > 0; }
function iso(value) { return string(value) && !Number.isNaN(Date.parse(value)); }
function optionalIso(value) { return value === null || value === undefined || iso(value); }
function unit(value) { return Number.isFinite(value) && value >= 0 && value <= 1; }
function issue(path, code) { return Object.freeze({ path, code, message: code }); }
function result(errors) { return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), warnings: Object.freeze([]) }); }

export function deepFreezeLifeIntelligence(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreezeLifeIntelligence(nested);
  return value;
}

function shape(value, fields, errors) {
  if (!object(value)) { errors.push(issue('', 'INVALID_TYPE')); return false; }
  for (const field of fields) if (!(field in value)) errors.push(issue(field, 'REQUIRED'));
  for (const field of Object.keys(value)) if (!fields.includes(field)) errors.push(issue(field, 'UNKNOWN_FIELD'));
  return true;
}

function owner(value, trustedUserId, errors) {
  if (!string(value.userId)) errors.push(issue('userId', 'REQUIRED'));
  if (trustedUserId !== undefined && value.userId !== trustedUserId) errors.push(issue('userId', 'USER_SCOPE_MISMATCH'));
}

function ids(value, field, minimum, errors) {
  const list = value[field];
  if (!Array.isArray(list) || list.length < minimum || list.some((id) => !string(id)) || new Set(list).size !== list.length) {
    errors.push(issue(field, 'INVALID_REFERENCES'));
  }
}

function evidence(value, errors) {
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.some((item) => !object(item))) {
    errors.push(issue('evidence', 'EVIDENCE_REQUIRED'));
  }
}

function dates(value, errors) {
  if (!iso(value.beginTime)) errors.push(issue('beginTime', 'INVALID_DATE'));
  if (!optionalIso(value.endTime)) errors.push(issue('endTime', 'INVALID_DATE'));
  if (iso(value.beginTime) && iso(value.endTime) && Date.parse(value.endTime) < Date.parse(value.beginTime)) errors.push(issue('endTime', 'INVALID_RANGE'));
}

function safe(value, errors) {
  for (const path of findForbiddenSecretPaths({ metadata: value.metadata, evidence: value.evidence })) errors.push(issue(path, 'SECRET_FORBIDDEN'));
}

function common(value, fields, trustedUserId) {
  const errors = [];
  if (!shape(value, fields, errors)) return errors;
  owner(value, trustedUserId, errors);
  if (!object(value.metadata)) errors.push(issue('metadata', 'INVALID_TYPE'));
  evidence(value, errors);
  safe(value, errors);
  return errors;
}

export function validateLifePattern(value, { trustedUserId } = {}) {
  const errors = common(value, PATTERN_FIELDS, trustedUserId);
  if (!object(value)) return result(errors);
  for (const field of ['id', 'subject', 'predicate']) if (!string(value[field])) errors.push(issue(field, 'REQUIRED'));
  if (!Object.values(LifePatternType).includes(value.patternType)) errors.push(issue('patternType', 'INVALID_ENUM'));
  if (!Object.values(LifeCadence).includes(value.cadence)) errors.push(issue('cadence', 'INVALID_ENUM'));
  if (value.status !== LifeDerivedStatus.OBSERVED) errors.push(issue('status', 'INVALID_ENUM'));
  if (!Number.isInteger(value.occurrenceCount) || value.occurrenceCount < 3) errors.push(issue('occurrenceCount', 'INSUFFICIENT_EVIDENCE'));
  if (!unit(value.confidence)) errors.push(issue('confidence', 'INVALID_RANGE'));
  if (!unit(value.importance)) errors.push(issue('importance', 'INVALID_RANGE'));
  dates(value, errors);
  ids(value, 'memoryIds', 3, errors);
  ids(value, 'timelineEventIds', 3, errors);
  return result(errors);
}

export function validateLifeTrend(value, { trustedUserId } = {}) {
  const errors = common(value, TREND_FIELDS, trustedUserId);
  if (!object(value)) return result(errors);
  for (const field of ['id', 'subject', 'predicate']) if (!string(value[field])) errors.push(issue(field, 'REQUIRED'));
  if (!Object.values(LifeTrendType).includes(value.trendType)) errors.push(issue('trendType', 'INVALID_ENUM'));
  if (!Object.values(LifeTrendDirection).includes(value.direction)) errors.push(issue('direction', 'INVALID_ENUM'));
  if (value.status !== LifeDerivedStatus.OBSERVED) errors.push(issue('status', 'INVALID_ENUM'));
  if (!unit(value.confidence)) errors.push(issue('confidence', 'INVALID_RANGE'));
  dates(value, errors);
  ids(value, 'memoryIds', 2, errors);
  ids(value, 'timelineEventIds', 2, errors);
  return result(errors);
}

export function validateLifeStage(value, { trustedUserId } = {}) {
  const errors = common(value, STAGE_FIELDS, trustedUserId);
  if (!object(value)) return result(errors);
  for (const field of ['id', 'periodId', 'title']) if (!string(value[field])) errors.push(issue(field, 'REQUIRED'));
  if (value.status !== LifeDerivedStatus.EXPLICIT) errors.push(issue('status', 'EXPLICIT_PERIOD_REQUIRED'));
  if (!unit(value.confidence)) errors.push(issue('confidence', 'INVALID_RANGE'));
  dates(value, errors);
  ids(value, 'memoryIds', 1, errors);
  ids(value, 'timelinePeriodIds', 1, errors);
  return result(errors);
}

export function validateLifeInsight(value, { trustedUserId } = {}) {
  const errors = common(value, INSIGHT_FIELDS, trustedUserId);
  if (!object(value)) return result(errors);
  for (const field of ['id', 'title', 'summary']) if (!string(value[field])) errors.push(issue(field, 'REQUIRED'));
  if (!Object.values(LifeInsightType).includes(value.insightType)) errors.push(issue('insightType', 'INVALID_ENUM'));
  if (value.status !== LifeDerivedStatus.INFORMATIONAL) errors.push(issue('status', 'INVALID_ENUM'));
  if (!unit(value.confidence)) errors.push(issue('confidence', 'INVALID_RANGE'));
  if (!iso(value.createdAt)) errors.push(issue('createdAt', 'INVALID_DATE'));
  for (const field of ['memoryIds', 'timelineEventIds', 'patternIds', 'trendIds', 'stageIds']) ids(value, field, 0, errors);
  const sourceIds = ['patternIds', 'trendIds', 'stageIds'].flatMap((field) => Array.isArray(value[field]) ? value[field] : []);
  if (!sourceIds.length) errors.push(issue('evidence', 'SOURCE_ARTIFACT_REQUIRED'));
  return result(errors);
}

export function validateLifeSuggestion(value, { trustedUserId } = {}) {
  const errors = common(value, SUGGESTION_FIELDS, trustedUserId);
  if (!object(value)) return result(errors);
  for (const field of ['id', 'title', 'summary']) if (!string(value[field])) errors.push(issue(field, 'REQUIRED'));
  if (!Object.values(LifeSuggestionType).includes(value.suggestionType)) errors.push(issue('suggestionType', 'INVALID_ENUM'));
  if (value.status !== LifeDerivedStatus.OPTIONAL) errors.push(issue('status', 'INVALID_ENUM'));
  if (value.decisionOwner !== 'user') errors.push(issue('decisionOwner', 'USER_DECISION_REQUIRED'));
  if (/自动替你|替你决定|已经替你|必须立即|系统将自动/.test(value.summary || '')) errors.push(issue('summary', 'AUTONOMOUS_DECISION_FORBIDDEN'));
  if (!iso(value.createdAt)) errors.push(issue('createdAt', 'INVALID_DATE'));
  ids(value, 'insightIds', 1, errors);
  ids(value, 'memoryIds', 1, errors);
  return result(errors);
}

function factory(validator, code) {
  return (value, options = {}) => {
    if (!validator(value, options).valid) throw new TypeError(code);
    return deepFreezeLifeIntelligence(structuredClone(value));
  };
}

export const createLifePattern = factory(validateLifePattern, 'LIFE_INTELLIGENCE_INVALID_PATTERN');
export const createLifeTrend = factory(validateLifeTrend, 'LIFE_INTELLIGENCE_INVALID_TREND');
export const createLifeStage = factory(validateLifeStage, 'LIFE_INTELLIGENCE_INVALID_STAGE');
export const createLifeInsight = factory(validateLifeInsight, 'LIFE_INTELLIGENCE_INVALID_INSIGHT');
export const createLifeSuggestion = factory(validateLifeSuggestion, 'LIFE_INTELLIGENCE_INVALID_SUGGESTION');
