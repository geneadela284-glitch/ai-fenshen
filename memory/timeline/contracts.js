import { MEMORY_TYPES, findForbiddenSecretPaths } from '../kernel/index.js';
import { RepositoryActorType } from '../repository/index.js';

export const TimelineGranularity = Object.freeze({
  YEAR: 'year', QUARTER: 'quarter', MONTH: 'month', WEEK: 'week', DAY: 'day'
});

export const TimelineQueryPreset = Object.freeze({
  ALL: 'all', TODAY: 'today', YESTERDAY: 'yesterday', THIS_YEAR: 'this_year', LAST_YEAR: 'last_year'
});

export const TimelineEventStatus = Object.freeze({
  CURRENT: 'current', HISTORICAL: 'historical', CONFLICT: 'conflict'
});

export const TimelineVisibility = Object.freeze({
  VISIBLE: 'visible', HIDDEN_SENSITIVE: 'hidden_sensitive'
});

export const TimelineTimeBasis = Object.freeze({
  EFFECTIVE: 'effective_time', ESTIMATED_CAPTURE: 'estimated_capture_time'
});

export const TimelineAuditAction = Object.freeze({
  BUILT: 'timeline_built', QUERIED: 'timeline_queried', MERGED: 'timeline_merged',
  SENSITIVE_HIDDEN: 'timeline_sensitive_hidden', CONFLICT_MARKED: 'timeline_conflict_marked',
  RENDERED: 'timeline_rendered', FAILED: 'timeline_failed'
});

const CONTEXT_FIELDS = Object.freeze([
  'authenticatedUserId', 'actorType', 'actorId', 'requestId', 'correlationId',
  'timestamp', 'timezone', 'locale', 'purpose', 'policyVersion', 'metadata'
]);
const EVENT_FIELDS = Object.freeze([
  'id', 'userId', 'memoryIds', 'title', 'summary', 'type', 'beginTime', 'endTime',
  'status', 'confidence', 'importance', 'visibility', 'sourceCount', 'version', 'metadata'
]);
const PERIOD_FIELDS = Object.freeze([
  'id', 'userId', 'memoryIds', 'title', 'beginTime', 'endTime', 'status', 'visibility', 'version', 'metadata'
]);
const SEGMENT_FIELDS = Object.freeze([
  'id', 'granularity', 'label', 'beginTime', 'endTime', 'events', 'periods', 'count', 'metadata'
]);
const QUERY_FIELDS = Object.freeze([
  'preset', 'from', 'to', 'memoryTypes', 'subject', 'predicate', 'normalizedValue', 'tags',
  'memoryIds', 'periodId', 'includeHistorical', 'includeSensitive', 'granularity', 'limit'
]);
const DEFAULT_QUERY = Object.freeze({
  preset: TimelineQueryPreset.ALL,
  from: null,
  to: null,
  memoryTypes: [],
  subject: null,
  predicate: null,
  normalizedValue: null,
  tags: [],
  memoryIds: [],
  periodId: null,
  includeHistorical: false,
  includeSensitive: false,
  granularity: TimelineGranularity.MONTH,
  limit: 200
});

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function string(value) { return typeof value === 'string' && value.trim().length > 0; }
function iso(value) { return string(value) && !Number.isNaN(Date.parse(value)); }
function optionalIso(value) { return value === null || value === undefined || iso(value); }
function issue(path, code) { return Object.freeze({ path, code, message: code }); }
function result(errors) { return { valid: errors.length === 0, errors, warnings: [] }; }
function unit(value) { return Number.isFinite(value) && value >= 0 && value <= 1; }
function positiveInteger(value) { return Number.isInteger(value) && value >= 1; }

export function deepFreezeTimeline(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreezeTimeline(nested);
  return value;
}

function shape(value, fields, errors) {
  if (!object(value)) { errors.push(issue('', 'INVALID_TYPE')); return false; }
  for (const field of fields) if (!(field in value)) errors.push(issue(field, 'REQUIRED'));
  for (const field of Object.keys(value)) if (!fields.includes(field)) errors.push(issue(field, 'UNKNOWN_FIELD'));
  return true;
}

function validateOwner(userId, trustedUserId, errors) {
  if (!string(userId)) errors.push(issue('userId', 'REQUIRED'));
  if (trustedUserId !== undefined && userId !== trustedUserId) errors.push(issue('userId', 'USER_SCOPE_MISMATCH'));
}

function validateMemoryIds(memoryIds, errors) {
  if (!Array.isArray(memoryIds) || memoryIds.length === 0 || memoryIds.some((id) => !string(id))) {
    errors.push(issue('memoryIds', 'INVALID_RANGE'));
  } else if (new Set(memoryIds).size !== memoryIds.length) {
    errors.push(issue('memoryIds', 'DUPLICATE_ID'));
  }
}

function validateSafeMetadata(metadata, errors) {
  if (!object(metadata)) errors.push(issue('metadata', 'INVALID_TYPE'));
  else for (const path of findForbiddenSecretPaths(metadata, 'metadata')) errors.push(issue(path, 'SECRET_FORBIDDEN'));
}

export function validateTimelineContext(context) {
  const errors = [];
  if (!shape(context, CONTEXT_FIELDS, errors)) return result(errors);
  for (const field of ['authenticatedUserId', 'actorId', 'requestId', 'correlationId', 'timezone', 'locale', 'purpose', 'policyVersion']) {
    if (!string(context[field])) errors.push(issue(field, 'REQUIRED'));
  }
  if (!Object.values(RepositoryActorType).includes(context.actorType)) errors.push(issue('actorType', 'INVALID_ENUM'));
  if (!iso(context.timestamp)) errors.push(issue('timestamp', 'INVALID_DATE'));
  validateSafeMetadata(context.metadata, errors);
  return result(errors);
}

export function normalizeTimelineQuery(input = {}) {
  if (!object(input)) throw new TypeError('TIMELINE_INVALID_QUERY');
  if (Object.keys(input).some((field) => !QUERY_FIELDS.includes(field))) throw new TypeError('TIMELINE_INVALID_QUERY');
  const query = { ...structuredClone(DEFAULT_QUERY), ...structuredClone(input) };
  if (!Object.values(TimelineQueryPreset).includes(query.preset)) throw new TypeError('TIMELINE_INVALID_QUERY');
  if (!Object.values(TimelineGranularity).includes(query.granularity)) throw new TypeError('TIMELINE_INVALID_QUERY');
  if (!optionalIso(query.from) || !optionalIso(query.to)) throw new TypeError('TIMELINE_INVALID_QUERY');
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new TypeError('TIMELINE_INVALID_QUERY');
  if (!Array.isArray(query.memoryTypes) || !Array.isArray(query.tags) || !Array.isArray(query.memoryIds)) throw new TypeError('TIMELINE_INVALID_QUERY');
  query.memoryTypes = [...new Set(query.memoryTypes.filter((value) => MEMORY_TYPES.includes(value)))];
  query.tags = [...new Set(query.tags.filter(string))];
  query.memoryIds = [...new Set(query.memoryIds.filter(string))];
  for (const field of ['subject', 'predicate', 'periodId']) if (query[field] !== null && !string(query[field])) throw new TypeError('TIMELINE_INVALID_QUERY');
  if (query.normalizedValue !== null && query.normalizedValue === undefined) throw new TypeError('TIMELINE_INVALID_QUERY');
  if (typeof query.includeHistorical !== 'boolean' || typeof query.includeSensitive !== 'boolean') throw new TypeError('TIMELINE_INVALID_QUERY');
  query.limit = Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 500) : DEFAULT_QUERY.limit;
  return deepFreezeTimeline(query);
}

export function validateTimelineEvent(event, { trustedUserId } = {}) {
  const errors = [];
  if (!shape(event, EVENT_FIELDS, errors)) return result(errors);
  validateOwner(event.userId, trustedUserId, errors);
  validateMemoryIds(event.memoryIds, errors);
  for (const field of ['id', 'title', 'summary', 'type']) if (!string(event[field])) errors.push(issue(field, 'REQUIRED'));
  if (!iso(event.beginTime)) errors.push(issue('beginTime', 'INVALID_DATE'));
  if (!optionalIso(event.endTime)) errors.push(issue('endTime', 'INVALID_DATE'));
  if (iso(event.beginTime) && iso(event.endTime) && Date.parse(event.endTime) < Date.parse(event.beginTime)) errors.push(issue('endTime', 'INVALID_RANGE'));
  if (!Object.values(TimelineEventStatus).includes(event.status)) errors.push(issue('status', 'INVALID_ENUM'));
  if (!Object.values(TimelineVisibility).includes(event.visibility)) errors.push(issue('visibility', 'INVALID_ENUM'));
  if (!unit(event.confidence)) errors.push(issue('confidence', 'INVALID_RANGE'));
  if (!unit(event.importance)) errors.push(issue('importance', 'INVALID_RANGE'));
  if (!positiveInteger(event.sourceCount)) errors.push(issue('sourceCount', 'INVALID_RANGE'));
  if (!positiveInteger(event.version)) errors.push(issue('version', 'INVALID_RANGE'));
  validateSafeMetadata(event.metadata, errors);
  return result(errors);
}

export function createTimelineEvent(event, options = {}) {
  const validation = validateTimelineEvent(event, options);
  if (!validation.valid) throw new TypeError('TIMELINE_INVALID_EVENT');
  return deepFreezeTimeline(structuredClone(event));
}

export function validateTimelinePeriod(period, { trustedUserId } = {}) {
  const errors = [];
  if (!shape(period, PERIOD_FIELDS, errors)) return result(errors);
  validateOwner(period.userId, trustedUserId, errors);
  validateMemoryIds(period.memoryIds, errors);
  for (const field of ['id', 'title']) if (!string(period[field])) errors.push(issue(field, 'REQUIRED'));
  if (!iso(period.beginTime)) errors.push(issue('beginTime', 'INVALID_DATE'));
  if (!optionalIso(period.endTime)) errors.push(issue('endTime', 'INVALID_DATE'));
  if (iso(period.beginTime) && iso(period.endTime) && Date.parse(period.endTime) < Date.parse(period.beginTime)) errors.push(issue('endTime', 'INVALID_RANGE'));
  if (!Object.values(TimelineEventStatus).includes(period.status)) errors.push(issue('status', 'INVALID_ENUM'));
  if (!Object.values(TimelineVisibility).includes(period.visibility)) errors.push(issue('visibility', 'INVALID_ENUM'));
  if (!positiveInteger(period.version)) errors.push(issue('version', 'INVALID_RANGE'));
  validateSafeMetadata(period.metadata, errors);
  if (period.metadata?.explicitlyDeclared !== true) errors.push(issue('metadata.explicitlyDeclared', 'TIMELINE_PERIOD_SOURCE_REQUIRED'));
  return result(errors);
}

export function createTimelinePeriod(period, options = {}) {
  const validation = validateTimelinePeriod(period, options);
  if (!validation.valid) throw new TypeError('TIMELINE_INVALID_PERIOD');
  return deepFreezeTimeline(structuredClone(period));
}

export function validateTimelineSegment(segment) {
  const errors = [];
  if (!shape(segment, SEGMENT_FIELDS, errors)) return result(errors);
  for (const field of ['id', 'label']) if (!string(segment[field])) errors.push(issue(field, 'REQUIRED'));
  if (!Object.values(TimelineGranularity).includes(segment.granularity)) errors.push(issue('granularity', 'INVALID_ENUM'));
  if (!iso(segment.beginTime) || !iso(segment.endTime)) errors.push(issue('beginTime', 'INVALID_DATE'));
  if (iso(segment.beginTime) && iso(segment.endTime) && Date.parse(segment.endTime) <= Date.parse(segment.beginTime)) errors.push(issue('endTime', 'INVALID_RANGE'));
  if (!Array.isArray(segment.events)) errors.push(issue('events', 'INVALID_TYPE'));
  if (!Array.isArray(segment.periods)) errors.push(issue('periods', 'INVALID_TYPE'));
  if (!Number.isInteger(segment.count) || segment.count < 0 || segment.count !== segment.events?.length) errors.push(issue('count', 'INVALID_RANGE'));
  validateSafeMetadata(segment.metadata, errors);
  return result(errors);
}

export function createTimelineSegment(segment) {
  const validation = validateTimelineSegment(segment);
  if (!validation.valid) throw new TypeError('TIMELINE_INVALID_SEGMENT');
  return deepFreezeTimeline(structuredClone(segment));
}

export function toTimelineRepositoryContext(context) {
  return deepFreezeTimeline({
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
