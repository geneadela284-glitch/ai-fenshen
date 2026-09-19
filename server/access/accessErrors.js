const PUBLIC_MESSAGES = Object.freeze({
  ACCOUNT_ACCESS_DISABLED: '该账号当前不可用，请联系管理员。',
  ACCOUNT_QUOTA_NOT_CONFIGURED: '该账号尚未配置使用额度，请联系管理员。',
  ACCOUNT_REQUEST_RATE_LIMITED: '请求过于频繁，请稍后再试。',
  ACCOUNT_CONCURRENCY_LIMITED: '当前正在处理的请求过多，请稍后再试。',
  ACCOUNT_USAGE_LIMIT_REACHED: '当前账号使用额度已达到上限，请稍后再试。',
  ACCESS_CONTROL_UNAVAILABLE: '访问控制服务暂时不可用，请稍后再试。'
});

export function codedAccessError(code, message = code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function publicAccessError(code, {
  status = code === 'ACCOUNT_ACCESS_DISABLED' ? 403 : code === 'ACCESS_CONTROL_UNAVAILABLE' ? 503 : 429,
  retryAfterSeconds = null
} = {}) {
  return codedAccessError(code, PUBLIC_MESSAGES[code] || '请求暂时无法处理。', {
    status,
    publicMessage: PUBLIC_MESSAGES[code] || '请求暂时无法处理。',
    retryAfterSeconds: Number.isFinite(retryAfterSeconds)
      ? Math.max(0, Math.ceil(retryAfterSeconds))
      : null
  });
}

export { PUBLIC_MESSAGES };
