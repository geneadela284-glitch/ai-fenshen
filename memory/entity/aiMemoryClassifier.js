import {
  MEMORY_DECISIONS,
  MEMORY_DECISION_RETENTION_MODES,
  MEMORY_DECISION_TYPES,
  MEMORY_V2_SENSITIVITIES
} from './contracts.js';

const PROPOSAL_FIELDS = Object.freeze([
  'proposedDecision',
  'memoryType',
  'predicate',
  'confidence',
  'importance',
  'sensitivity',
  'retentionPolicy',
  'reasonCodes',
  'suggestedStructuredValue',
  'containsPersonalFact',
  'needsClarification',
  'explicitBusinessIntent'
]);

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function optionalString(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string or null.`);
  }
  return value.trim();
}

function unitNumber(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be between zero and one.`);
  }
  return value;
}

function boolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean.`);
  return value;
}

function parseRetentionPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('retentionPolicy must be an object.');
  }
  for (const field of Object.keys(value)) {
    if (!['mode', 'expiresAt'].includes(field)) {
      throw new TypeError(`Unknown retentionPolicy field: ${field}`);
    }
  }
  if (!MEMORY_DECISION_RETENTION_MODES.includes(value.mode)) {
    throw new TypeError('retentionPolicy.mode is invalid.');
  }
  const expiresAt = value.expiresAt ?? null;
  if (expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) {
    throw new TypeError('retentionPolicy.expiresAt must be an ISO timestamp or null.');
  }
  if (value.mode === 'ttl' && expiresAt === null) {
    throw new TypeError('retentionPolicy.expiresAt is required for ttl.');
  }
  if (value.mode !== 'ttl' && expiresAt !== null) {
    throw new TypeError('retentionPolicy.expiresAt is allowed only for ttl.');
  }
  return immutable({ mode: value.mode, expiresAt });
}

function parseReasonCodes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) =>
    typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new TypeError('reasonCodes must be a non-empty string array.');
  }
  return Object.freeze([...new Set(value.map((entry) => entry.trim()))]);
}

function parseSuggestedStructuredValue(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('suggestedStructuredValue must be an object or null.');
  }
  return immutable(structuredClone(value));
}

export function validateAIMemoryClassifier(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('AI Memory Classifier must be an object.');
  } else if (typeof value.classify !== 'function') {
    errors.push('AI Memory Classifier must expose classify(input).');
  }
  return immutable({ valid: errors.length === 0, errors });
}

export function parseAIMemoryClassificationProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('AI Memory classification proposal must be an object.');
  }
  for (const field of Object.keys(value)) {
    if (!PROPOSAL_FIELDS.includes(field)) throw new TypeError(`Unknown field: ${field}`);
  }
  for (const field of PROPOSAL_FIELDS) {
    if (!(field in value)) throw new TypeError(`${field} is required.`);
  }
  if (!MEMORY_DECISIONS.includes(value.proposedDecision)) {
    throw new TypeError('proposedDecision is invalid.');
  }
  if (value.memoryType !== null && !MEMORY_DECISION_TYPES.includes(value.memoryType)) {
    throw new TypeError('memoryType is invalid.');
  }
  if (!MEMORY_V2_SENSITIVITIES.includes(value.sensitivity)) {
    throw new TypeError('sensitivity is invalid.');
  }
  const predicate = optionalString(value.predicate, 'predicate');
  const suggestedStructuredValue = parseSuggestedStructuredValue(value.suggestedStructuredValue);
  if (value.memoryType === null && (predicate !== null || suggestedStructuredValue !== null)) {
    throw new TypeError('memoryType is required when predicate or suggestedStructuredValue is present.');
  }
  if (value.memoryType !== null && (predicate === null || suggestedStructuredValue === null)) {
    throw new TypeError('predicate and suggestedStructuredValue are required for a memory candidate.');
  }
  return immutable({
    proposedDecision: value.proposedDecision,
    memoryType: value.memoryType,
    predicate,
    confidence: unitNumber(value.confidence, 'confidence'),
    importance: unitNumber(value.importance, 'importance'),
    sensitivity: value.sensitivity,
    retentionPolicy: parseRetentionPolicy(value.retentionPolicy),
    reasonCodes: parseReasonCodes(value.reasonCodes),
    suggestedStructuredValue,
    containsPersonalFact: boolean(value.containsPersonalFact, 'containsPersonalFact'),
    needsClarification: boolean(value.needsClarification, 'needsClarification'),
    explicitBusinessIntent: boolean(value.explicitBusinessIntent, 'explicitBusinessIntent')
  });
}
