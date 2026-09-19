export { processConversationMemory } from '../../../../core/memory/realUserMemoryClient.js';

async function memoryRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.message || '记忆暂时不可用，其他功能仍可继续。');
    error.code = payload.code || 'MEMORY_TEMPORARILY_UNAVAILABLE';
    error.status = response.status;
    throw error;
  }
  return payload.result;
}

export function confirmMemoryCapture(body) {
  return memoryRequest('/api/memory/confirm', { method: 'POST', body });
}

export function fetchMemoryStatus() {
  return memoryRequest('/api/memory/status');
}

export function fetchMemoryList(view = 'current') {
  return memoryRequest(`/api/memory/memories?view=${encodeURIComponent(view)}`);
}

export function fetchMemoryDetails(memoryId) {
  return memoryRequest(`/api/memory/memories/${encodeURIComponent(memoryId)}`);
}

export function fetchMemoryHistory(memoryId) {
  return memoryRequest(`/api/memory/memories/${encodeURIComponent(memoryId)}/history`);
}

export function correctMemory(memoryId, body) {
  return memoryRequest(`/api/memory/memories/${encodeURIComponent(memoryId)}/correct`, { method: 'POST', body });
}

export function deleteMemory(memoryId, body) {
  return memoryRequest(`/api/memory/memories/${encodeURIComponent(memoryId)}/delete`, { method: 'POST', body });
}

export function restoreMemory(memoryId, body) {
  return memoryRequest(`/api/memory/memories/${encodeURIComponent(memoryId)}/restore`, { method: 'POST', body });
}

export function permanentlyDeleteMemory(memoryId, body) {
  return memoryRequest(`/api/memory/memories/${encodeURIComponent(memoryId)}/purge`, { method: 'POST', body });
}
