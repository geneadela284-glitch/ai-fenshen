import {
  defaultMemoryType,
  memoryDirections,
  memoryRetentionPolicies,
  memorySensitivityLevels,
  memoryStatuses,
  normalizeMemoryCategory,
  normalizeSourceType
} from './memoryTypes.js';
import { normalizeMemoryInput } from './memoryNormalizer.js';

function now(context = {}) {
  const date = context.now ? new Date(context.now) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function createId() {
  return `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createMemoryRecord(input = {}, context = {}) {
  const createdAt = input.createdAt || now(context);
  const originalText = String(input.originalText || '');
  const normalizedText = input.normalizedText ?? normalizeMemoryInput(originalText);
  const category = normalizeMemoryCategory(input.category || input.memoryType || defaultMemoryType);
  const sensitivity = memorySensitivityLevels.includes(input.sensitivity) ? input.sensitivity : 'low';
  const needsConfirmation = input.needsConfirmation === undefined
    ? sensitivity === 'high'
    : Boolean(input.needsConfirmation);
  const status = input.status || (needsConfirmation ? 'needs_confirmation' : 'candidate');

  return {
    id: String(input.id || createId()),
    sourceType: normalizeSourceType(input.sourceType || context.sourceType || 'unknown'),
    sourceId: String(input.sourceId || context.sourceId || ''),
    originalText,
    normalizedText: String(normalizedText || ''),
    memoryType: normalizeMemoryCategory(input.memoryType || category),
    category,
    title: String(input.title || ''),
    summary: String(input.summary || ''),
    people: normalizeStringArray(input.people),
    organizations: normalizeStringArray(input.organizations),
    projects: normalizeStringArray(input.projects),
    amount: normalizeNumber(input.amount),
    currency: input.currency ? String(input.currency) : '',
    direction: memoryDirections.includes(input.direction) ? input.direction : 'neutral',
    eventDate: String(input.eventDate || ''),
    eventTime: String(input.eventTime || ''),
    startAt: String(input.startAt || ''),
    endAt: String(input.endAt || ''),
    location: String(input.location || ''),
    tags: normalizeStringArray(input.tags),
    importance: Number.isFinite(Number(input.importance)) ? Number(input.importance) : 0.5,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0,
    sensitivity,
    retentionPolicy: memoryRetentionPolicies.includes(input.retentionPolicy) ? input.retentionPolicy : 'short_term',
    needsConfirmation,
    status: memoryStatuses.includes(status) ? status : 'candidate',
    createdAt,
    updatedAt: input.updatedAt || createdAt,
    metadata: normalizeObject(input.metadata)
  };
}

export function validateMemoryRecord(record = {}) {
  const errors = [];
  const required = [
    'id',
    'sourceType',
    'sourceId',
    'originalText',
    'normalizedText',
    'memoryType',
    'category',
    'title',
    'summary',
    'people',
    'organizations',
    'projects',
    'amount',
    'currency',
    'direction',
    'eventDate',
    'eventTime',
    'startAt',
    'endAt',
    'location',
    'tags',
    'importance',
    'confidence',
    'sensitivity',
    'retentionPolicy',
    'needsConfirmation',
    'status',
    'createdAt',
    'updatedAt',
    'metadata'
  ];

  required.forEach((field) => {
    if (!(field in record)) errors.push(`missing:${field}`);
    if (record[field] === undefined) errors.push(`undefined:${field}`);
  });
  if (record.amount !== null && typeof record.amount !== 'number') errors.push('amount_must_be_number_or_null');
  if (!Array.isArray(record.people)) errors.push('people_must_be_array');
  if (!Array.isArray(record.organizations)) errors.push('organizations_must_be_array');
  if (!Array.isArray(record.projects)) errors.push('projects_must_be_array');
  if (!Array.isArray(record.tags)) errors.push('tags_must_be_array');
  if (!record.originalText && !record.summary) errors.push('empty_memory_content');

  return {
    valid: errors.length === 0,
    errors
  };
}
