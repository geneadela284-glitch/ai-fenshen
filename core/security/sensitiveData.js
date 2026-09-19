const SENSITIVE_KEY_PART = /(?:^|_)(?:api_key|authorization|cookie|password|passwd|secret|private_key|access_token|refresh_token|session_token)(?:$|_)/;
const RAW_OR_INTERNAL_KEY_PART = /(?:^|_)(?:body|content|input|prompt|messages|attachments?|stack|path|raw|payload)(?:$|_)/;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/root\/|file:\/\/)/i;
const SECRET_TEXT = /(?:authorization\s*[:=]|bearer\s+\S+|token\s+\S+|credential\s*[:=]|sk-[A-Za-z0-9_-]{8,}|api[-_\s]?key\s*[:=]|password\s*[:=]|cookie\s*[:=]|private[-_\s]?key\s*[:=])/i;

function normalizeFieldName(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

function isSensitiveField(key) {
  const normalized = normalizeFieldName(key);
  return SENSITIVE_KEY_PART.test(normalized) || RAW_OR_INTERNAL_KEY_PART.test(normalized);
}

export function sanitizeSensitiveData(value) {
  if (Array.isArray(value)) return value.map(sanitizeSensitiveData);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && (ABSOLUTE_PATH.test(value) || SECRET_TEXT.test(value))) return '[REDACTED]';
    return value;
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isSensitiveField(key))
    .map(([key, nested]) => [key, sanitizeSensitiveData(nested)]));
}
