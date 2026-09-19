const DEFAULT_ENDPOINT = '/api/meeting/analysis';
const DEFAULT_TIMEOUT_MS = 105_000;
const SAFE_ERROR_CODES = new Set([
  'ACCOUNT_ACCESS_DISABLED',
  'ACCOUNT_CONCURRENCY_LIMITED',
  'ACCOUNT_QUOTA_NOT_CONFIGURED',
  'ACCOUNT_REQUEST_RATE_LIMITED',
  'ACCOUNT_USAGE_LIMIT_REACHED',
  'ACCESS_CONTROL_UNAVAILABLE',
  'AUTH_REQUIRED',
  'CONSENT_REQUIRED',
  'RATE_LIMITED',
  'TIMEOUT',
  'AI_ANALYSIS_UNAVAILABLE'
]);

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requestId() {
  return globalThis.crypto?.randomUUID?.()
    || `meeting-analysis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function errorCode(payload, status) {
  const code = String(payload?.code || '').trim();
  if (SAFE_ERROR_CODES.has(code)) return code;
  if (Number(status) === 401) return 'AUTH_REQUIRED';
  if (Number(status) === 429) return 'RATE_LIMITED';
  return 'AI_ANALYSIS_UNAVAILABLE';
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && ['system', 'user'].includes(String(message.role || '')))
    .map((message) => ({
      role: String(message.role),
      content: String(message.content || '')
    }));
}

export function createMeetingAnalysisModelClient({
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idFactory = requestId
} = {}) {
  if (typeof fetchImpl !== 'function') throw codedError('MEETING_ANALYSIS_FETCH_UNAVAILABLE');
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedEndpoint) throw codedError('MEETING_ANALYSIS_ENDPOINT_REQUIRED');

  return async function runMeetingAnalysisModel(task = {}) {
    const messages = normalizeMessages(task.messages);
    const input = String(task.input || '').trim();
    if (!input || !messages.length) throw codedError('MEETING_ANALYSIS_REQUEST_INVALID');
    const clientRequestId = String(
      task.metadata?.idempotencyKey || task.metadata?.clientRequestId || idFactory()
    ).slice(0, 160);
    const body = {
      input,
      messages,
      clientRequestId
    };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)) : null;
    try {
      const response = await fetchImpl(normalizedEndpoint, {
        method: 'POST',
        credentials: 'include',
        mode: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {})
      });
      const payload = await readJson(response);
      if (!response.ok || payload?.ok !== true) {
        throw codedError(errorCode(payload, response.status));
      }
      return { content: String(payload.content || '') };
    } catch (error) {
      if (error?.name === 'AbortError') throw codedError('TIMEOUT');
      throw error?.code ? error : codedError('AI_ANALYSIS_UNAVAILABLE');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

export { DEFAULT_ENDPOINT as MEETING_ANALYSIS_ENDPOINT };
