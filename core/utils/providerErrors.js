export class ProviderError extends Error {
  constructor(message, { code = 'UNKNOWN', status = null, provider = null, cause = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.cause = cause;
  }
}

export function classifyProviderError(error, provider) {
  if (error instanceof ProviderError) return error;

  if (error?.name === 'AbortError' || error?.code === 'TIMEOUT') {
    return new ProviderError('超时', { code: 'TIMEOUT', provider, cause: error });
  }

  return new ProviderError('网络错误', { code: 'NETWORK_ERROR', provider, cause: error });
}

export function classifyHttpError(status, body, provider) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  const lower = text.toLowerCase();

  if (status === 401 || status === 403 || lower.includes('invalid api key') || lower.includes('unauthorized')) {
    return new ProviderError('API Key 无效', { code: 'INVALID_API_KEY', status, provider });
  }

  if (status === 402 || lower.includes('insufficient') || lower.includes('balance') || lower.includes('quota')) {
    return new ProviderError('余额不足', { code: 'INSUFFICIENT_BALANCE', status, provider });
  }

  if (status === 408 || status === 504) {
    return new ProviderError('超时', { code: 'TIMEOUT', status, provider });
  }

  return new ProviderError('网络错误', { code: 'HTTP_ERROR', status, provider });
}
