const SAFE_ATTACHMENT_ERROR = '图片暂时无法处理，请稍后重试。';

export const ATTACHMENT_DEFAULT_QUESTION = Object.freeze({
  one: '请描述这张图片的主要内容。',
  many: '请概括这些图片，并说明主要区别。'
});

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function safeError(status, payload = {}) {
  if (status === 401) return clientError('AUTH_REQUIRED', '请先登录。');
  if (payload.code === 'PRIVACY_CONSENT_REQUIRED') {
    return clientError(payload.code, '请先阅读并同意当前隐私说明。');
  }
  const allowed = new Set([
    'ATTACHMENT_FEATURE_DISABLED',
    'UPLOAD_FAILED',
    'UNSUPPORTED_FILE_TYPE',
    'FILE_TOO_LARGE',
    'TOO_MANY_ATTACHMENTS',
    'DAILY_UPLOAD_LIMIT_EXCEEDED',
    'MIME_SIGNATURE_MISMATCH',
    'IMAGE_DIMENSION_LIMIT_EXCEEDED',
    'FILE_EMPTY',
    'FILE_CORRUPT',
    'ATTACHMENT_NOT_FOUND',
    'ATTACHMENT_FORBIDDEN',
    'ATTACHMENT_EXPIRED',
    'ATTACHMENT_DELETED',
    'ATTACHMENT_STORE_UNAVAILABLE',
    'ACCOUNT_CONCURRENCY_LIMITED',
    'ACCOUNT_REQUEST_RATE_LIMITED',
    'ACCOUNT_QUOTA_EXCEEDED'
  ]);
  const code = allowed.has(payload.code) ? payload.code : 'ATTACHMENT_SERVICE_UNAVAILABLE';
  const message = typeof payload.message === 'string' && payload.message.length <= 160
    ? payload.message
    : SAFE_ATTACHMENT_ERROR;
  return clientError(code, message);
}

function attachmentUrl(attachmentId, suffix = '') {
  const id = encodeURIComponent(String(attachmentId || ''));
  if (!id) throw clientError('ATTACHMENT_NOT_FOUND', '附件不存在。');
  return `/api/attachments/${id}${suffix}`;
}

export function attachmentContentUrl(attachmentId) {
  return attachmentUrl(attachmentId, '/content');
}

export function createAttachmentClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');

  async function json(url, options = {}) {
    const response = await fetchImpl(url, { credentials: 'include', ...options });
    const payload = await readJson(response);
    if (!response.ok) throw safeError(response.status, payload);
    return payload;
  }

  return Object.freeze({
    async getCapabilities() {
      return json('/api/attachments/capabilities');
    },
    async upload({
      files,
      conversationId = null,
      clientRequestId,
      signal
    } = {}) {
      if (!clientRequestId) throw clientError('UPLOAD_FAILED', '上传请求标识无效。');
      const form = new FormData();
      for (const file of Array.isArray(files) ? files : []) form.append('files', file, file.name);
      if (conversationId) form.append('conversation_id', String(conversationId));
      return json('/api/attachments', {
        method: 'POST',
        headers: { 'X-Client-Request-Id': String(clientRequestId) },
        body: form,
        signal
      });
    },
    async get(attachmentId, { signal } = {}) {
      return (await json(attachmentUrl(attachmentId), { signal })).attachment;
    },
    async delete(attachmentId) {
      return json(attachmentUrl(attachmentId), { method: 'DELETE' });
    },
    contentUrl(attachmentId) {
      return attachmentContentUrl(attachmentId);
    }
  });
}

// The native app authenticates fetch through MobileTransport; an <img> request
// does not pass through that bridge. Keep image bytes in memory, never in URLs
// carrying credentials or in persistent storage.
export function createAttachmentPreviewResource(source, {
  fetchImpl = globalThis.fetch,
  createObjectURL = blob => URL.createObjectURL(blob),
  revokeObjectURL = url => URL.revokeObjectURL(url)
} = {}) {
  const controller = new AbortController();
  let objectUrl = '';
  let disposed = false;
  const ready = (async () => {
    if (!/^\/api\/attachments\/[^/?#]+\/content$/.test(source)) {
      throw clientError('ATTACHMENT_NOT_FOUND', '图片地址无效。');
    }
    const response = await fetchImpl(`${source}?preview=1`, { credentials: 'include', signal: controller.signal });
    if (!response.ok) throw safeError(response.status, await readJson(response));
    const blob = await response.blob();
    if (disposed) throw new DOMException('Aborted', 'AbortError');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size) {
      throw clientError('FILE_CORRUPT', '图片暂时无法显示。');
    }
    objectUrl = createObjectURL(blob);
    return objectUrl;
  })();
  return { ready, dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    if (objectUrl) revokeObjectURL(objectUrl);
  } };
}
