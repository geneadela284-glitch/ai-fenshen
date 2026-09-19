export const ERROR_CODES = Object.freeze([
  'INVALID_REQUEST',
  'AUTH_FAILED',
  'MODEL_NOT_FOUND',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'CAPABILITY_NOT_SUPPORTED',
  'SAFETY_BLOCKED',
  'ATTACHMENT_NOT_SUPPORTED',
  'STRUCTURED_OUTPUT_INVALID',
  'TOOL_VALIDATION_FAILED',
  'TOOL_CONFIRMATION_REQUIRED',
  'ALL_PROVIDERS_FAILED',
  'INTERNAL_ERROR'
]);

export const ERROR_RETRYABILITY = Object.freeze({
  INVALID_REQUEST: false,
  AUTH_FAILED: false,
  MODEL_NOT_FOUND: true,
  PROVIDER_UNAVAILABLE: true,
  RATE_LIMITED: true,
  TIMEOUT: true,
  INVALID_RESPONSE: true,
  CAPABILITY_NOT_SUPPORTED: true,
  SAFETY_BLOCKED: false,
  ATTACHMENT_NOT_SUPPORTED: false,
  STRUCTURED_OUTPUT_INVALID: true,
  TOOL_VALIDATION_FAILED: false,
  TOOL_CONFIRMATION_REQUIRED: false,
  ALL_PROVIDERS_FAILED: false,
  INTERNAL_ERROR: false
});

export const DEFAULT_ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: '请求格式无效，请检查后重试。',
  AUTH_FAILED: 'AI 服务配置无效，请联系管理员。',
  MODEL_NOT_FOUND: '当前模型不可用，请稍后重试。',
  PROVIDER_UNAVAILABLE: 'AI 服务暂时不可用，请稍后重试。',
  RATE_LIMITED: 'AI 服务当前繁忙，请稍后重试。',
  TIMEOUT: 'AI 服务响应超时，请稍后重试。',
  INVALID_RESPONSE: 'AI 服务返回了无效结果，请稍后重试。',
  CAPABILITY_NOT_SUPPORTED: '当前 AI 服务暂不支持此能力。',
  SAFETY_BLOCKED: '该请求因安全策略无法处理。',
  ATTACHMENT_NOT_SUPPORTED: '当前附件类型或大小不受支持。',
  STRUCTURED_OUTPUT_INVALID: 'AI 返回的结构化结果无效。',
  TOOL_VALIDATION_FAILED: '操作参数校验失败。',
  TOOL_CONFIRMATION_REQUIRED: '该操作需要用户确认。',
  ALL_PROVIDERS_FAILED: 'AI 服务暂时不可用，请稍后重试。',
  INTERNAL_ERROR: '系统暂时无法处理该请求，请稍后重试。'
});

export function isGatewayErrorCode(value) {
  return ERROR_CODES.includes(value);
}

const UNSAFE_MESSAGE = /(api[-_\s]?key|authorization|cookie|password|passwd|secret|bearer\s+|sk-[\w-]+|\/Users\/|\/home\/|\/root\/|[A-Za-z]:[\\/])/i;
const UNSAFE_DIAGNOSTIC_KEY = /(api[-_]?key|authorization|cookie|password|passwd|secret|stack|path|input|prompt|content|body|messages|attachments?)/i;

function sanitizeDiagnostic(value) {
  if (Array.isArray(value)) return value.map(sanitizeDiagnostic);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && UNSAFE_MESSAGE.test(value)) return '[REDACTED]';
    return value;
  }
  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (UNSAFE_DIAGNOSTIC_KEY.test(key)) continue;
    sanitized[key] = sanitizeDiagnostic(nested);
  }
  return sanitized;
}

export function createGatewayError({
  code = 'INTERNAL_ERROR',
  message,
  providerId = null,
  modelId = null,
  details = null,
  cause = null,
  occurredAt = new Date().toISOString()
} = {}) {
  const normalizedCode = isGatewayErrorCode(code) ? code : 'INTERNAL_ERROR';
  const safeMessage = typeof message === 'string' && message.trim() && !UNSAFE_MESSAGE.test(message)
    ? message
    : DEFAULT_ERROR_MESSAGES[normalizedCode];
  return {
    code: normalizedCode,
    message: safeMessage,
    retryable: ERROR_RETRYABILITY[normalizedCode],
    providerId,
    modelId,
    details: sanitizeDiagnostic(details),
    cause: sanitizeDiagnostic(cause),
    occurredAt
  };
}
