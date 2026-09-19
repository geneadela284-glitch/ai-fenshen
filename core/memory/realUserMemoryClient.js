const SAFE_UNAVAILABLE_RESULT = Object.freeze({
  enabled: true,
  handled: false,
  status: 'degraded',
  safeMessage: '记忆暂时不可用，其他功能仍可继续。',
  memoryContext: Object.freeze({ items: Object.freeze([]) })
});

export async function processConversationMemory(request = {}) {
  const response = await fetch('/api/memory/conversation', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    if (response.status === 404) return { ...SAFE_UNAVAILABLE_RESULT, enabled: false };
    const error = new Error(payload.message || SAFE_UNAVAILABLE_RESULT.safeMessage);
    error.code = payload.code || 'MEMORY_TEMPORARILY_UNAVAILABLE';
    error.status = response.status;
    throw error;
  }
  return payload.result;
}

export const realUserMemoryClient = Object.freeze({
  process: processConversationMemory
});

export default realUserMemoryClient;
