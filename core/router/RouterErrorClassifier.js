const FALLBACK_STATUS = new Set([429, 502, 503, 504]);
const FALLBACK_CODES = new Set([
  'TIMEOUT',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'NETWORK_ERROR',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'RATE_LIMITED',
  'HTTP_429',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504',
  'PROVIDER_UNAVAILABLE',
  'CREDENTIAL_RESOLVER_UNAVAILABLE',
  'RUNTIME_CONNECTION_UNAVAILABLE',
  'NO_USABLE_RUNTIME_CONNECTION'
]);

function normalizedCode(error = {}) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const explicit = String(error?.code || '').trim().toUpperCase();
  if (explicit) return explicit;
  if (FALLBACK_STATUS.has(status)) return `HTTP_${status}`;
  return 'PROVIDER_ERROR';
}

export function classifyRouterError(error = {}) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  let code = normalizedCode(error);
  if (FALLBACK_STATUS.has(status)) code = status === 429 ? 'RATE_LIMITED' : `HTTP_${status}`;
  else if (!String(error?.code || '').trim() && /timed?\s*out|timeout|超时/.test(message)) code = 'TIMEOUT';
  else if (!String(error?.code || '').trim() && /network|socket|fetch failed|连接失败/.test(message)) code = 'NETWORK_ERROR';
  return Object.freeze({
    code,
    status: status || null,
    fallbackEligible: FALLBACK_CODES.has(code) || FALLBACK_STATUS.has(status)
  });
}

export function shouldFallback({
  error,
  policy,
  businessExecutionStarted = false,
  businessWriteStarted = false,
  attemptNumber = 1,
  emittedOutput = false
} = {}) {
  if (!policy?.allowFallback || policy.maxAttempts < 2) return false;
  if (businessExecutionStarted || businessWriteStarted || emittedOutput) return false;
  if (Number(attemptNumber) >= Number(policy.maxAttempts || 1)) return false;
  return classifyRouterError(error).fallbackEligible;
}

