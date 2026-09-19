const TRACE_FIELDS = Object.freeze([
  'traceId', 'requestId', 'userIdHash', 'workspaceIdHash', 'capability',
  'providerId', 'modelId', 'routeReason', 'attempts', 'startedAt', 'completedAt',
  'durationMs', 'success', 'errorCode', 'tokenUsage', 'estimatedCost', 'warnings'
]);

const ATTEMPT_TRACE_FIELDS = new Set([
  'attempt', 'providerId', 'modelId', 'startedAt', 'completedAt', 'durationMs',
  'success', 'errorCode', 'retryable', 'reason', 'details'
]);

const FORBIDDEN_KEY = /(api[-_]?key|authorization|cookie|password|passwd|secret|session[-_]?cookie|full[-_]?input|prompt|attachment[-_]?content|absolute[-_]?path)/i;
const FULL_CONTENT_KEY = /^(input|content|raw|body|messages|attachments?|file|path)$/i;

export const TRACE_SCHEMA_V1 = Object.freeze({
  schemaVersion: 'v1',
  fields: TRACE_FIELDS,
  forbiddenData: Object.freeze([
    'apiKey', 'password', 'sessionCookie', 'fullInput', 'fullAttachmentContent', 'absolutePath'
  ])
});

function hashSafeReference(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `ref_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sanitizeString(value) {
  if (/^(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/root\/|file:\/\/)/i.test(value)) return '[REDACTED_PATH]';
  if (/(bearer\s+\S+|api[-_]?key\s*[:=]|password\s*[:=]|cookie\s*[:=])/i.test(value)) return '[REDACTED]';
  return value;
}

function sanitizeValue(value, allowedKeys = null) {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, allowedKeys));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? sanitizeString(value) : value;

  const clean = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) || FULL_CONTENT_KEY.test(key)) continue;
    if (allowedKeys && !allowedKeys.has(key)) continue;
    clean[key] = sanitizeValue(nestedValue);
  }
  return clean;
}

export function sanitizeTrace(trace = {}) {
  const source = trace && typeof trace === 'object' ? trace : {};
  const sanitized = {};
  for (const key of TRACE_FIELDS) {
    if (key === 'userIdHash' || key === 'workspaceIdHash' || key === 'attempts') continue;
    if (source[key] !== undefined) sanitized[key] = sanitizeValue(source[key]);
  }
  sanitized.userIdHash = source.userIdHash || hashSafeReference(source.userId);
  sanitized.workspaceIdHash = source.workspaceIdHash || hashSafeReference(source.workspaceId);
  sanitized.attempts = Array.isArray(source.attempts)
    ? source.attempts.map((attempt) => sanitizeValue(attempt, ATTEMPT_TRACE_FIELDS))
    : [];
  return sanitized;
}
