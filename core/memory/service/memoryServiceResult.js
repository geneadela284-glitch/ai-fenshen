function safeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function createMemoryServiceResult({
  ok = false,
  action = 'unknown',
  code = 'MEMORY_STORAGE_FAILED',
  message = '',
  data = null,
  warnings = [],
  requiresConfirmation = false,
  candidateId = null,
  memoryId = null,
  timestamp
} = {}) {
  return {
    ok: Boolean(ok),
    action: String(action),
    code: String(code),
    message: String(message),
    data,
    warnings: Array.isArray(warnings) ? warnings : [],
    requiresConfirmation: Boolean(requiresConfirmation),
    candidateId: candidateId || null,
    memoryId: memoryId || null,
    timestamp: safeTimestamp(timestamp)
  };
}
