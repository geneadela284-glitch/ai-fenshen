const SAFE_SERVICE_ERROR = 'AI服务暂时不可用，请稍后重试。';
const ACCOUNT_CONTEXT_MESSAGE = '账号状态已变化，请重新登录。';

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function safeHttpError(status, payload = {}) {
  if (status === 401) return clientError('AUTH_REQUIRED', '请先登录。');
  if (payload.code === 'ACCOUNT_CONTEXT_MISMATCH') {
    return clientError('ACCOUNT_CONTEXT_MISMATCH', ACCOUNT_CONTEXT_MESSAGE);
  }
  if (status === 404) return clientError('NOT_FOUND', '对话不存在。');
  return clientError(payload.code || 'SERVICE_UNAVAILABLE', payload.message === '请输入内容。' ? payload.message : SAFE_SERVICE_ERROR);
}

function parseEventBlock(block) {
  let type = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { type, data: JSON.parse(data.join('\n')) };
}

export function createSseEventParser(onEvent = () => {}) {
  let buffer = '';
  const drain = (flush = false) => {
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (block) {
        const event = parseEventBlock(block);
        if (event) onEvent(event);
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (flush && buffer.trim()) {
      const event = parseEventBlock(buffer.trim());
      buffer = '';
      if (event) onEvent(event);
    }
  };
  return {
    push(chunk) {
      buffer += String(chunk || '');
      drain(false);
    },
    finish() {
      drain(true);
    }
  };
}

function defaultId() {
  return globalThis.crypto?.randomUUID?.() || `client_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeAccountId(value) {
  return String(value || '').trim();
}

function assertAccountContext(response, payload, expectedAccountId, { requireBody = true } = {}) {
  if (!expectedAccountId) return;
  const responseAccountId = normalizeAccountId(response.headers?.get?.('x-ai-account-context'));
  const bodyAccountId = requireBody ? normalizeAccountId(payload?.accountContext) : expectedAccountId;
  if (responseAccountId !== expectedAccountId || bodyAccountId !== expectedAccountId) {
    throw clientError('ACCOUNT_CONTEXT_MISMATCH', ACCOUNT_CONTEXT_MESSAGE);
  }
}

function bindExpectedAccount(options, expectedAccountId) {
  if (!expectedAccountId) return options;
  return {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-AI-Expected-Account-Context': expectedAccountId
    }
  };
}

export function createRealConversationClient({
  fetchImpl = globalThis.fetch,
  idFactory = defaultId,
  expectedAccountId = null
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const currentExpectedAccountId = () => normalizeAccountId(
    typeof expectedAccountId === 'function' ? expectedAccountId() : expectedAccountId
  );

  async function requestJson(url, options = {}) {
    const expected = currentExpectedAccountId();
    const response = await fetchImpl(url, bindExpectedAccount({ credentials: 'include', ...options }, expected));
    const payload = await readJson(response);
    if (!response.ok) {
      if (response.status !== 401) assertAccountContext(response, payload, expected);
      throw safeHttpError(response.status, payload);
    }
    assertAccountContext(response, payload, expected);
    return payload;
  }

  return {
    async listConversations() {
      return (await requestJson('/api/ai/conversations')).conversations || [];
    },
    async createConversation() {
      return (await requestJson('/api/ai/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新的对话' })
      })).conversation;
    },
    async loadMessages(conversationId) {
      return (await requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`)).messages || [];
    },
    async cancelRequest(requestId) {
      return requestJson(`/api/ai/chat/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' });
    },
    async streamMessage({ conversationId = null, message, clientRequestId = idFactory(), retry = false,
      timezone = null, attachmentIds = [], meetingQuery = null, documentQuery = null, localMemory = null, signal, onEvent = () => {} }) {
      const expected = currentExpectedAccountId();
      const response = await fetchImpl('/api/ai/chat/stream', bindExpectedAccount({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          message: String(message || ''),
          clientRequestId,
          retry: retry === true,
          ...(timezone ? { timezone: String(timezone) } : {}),
          ...(meetingQuery ? { meetingQuery } : {}),
          ...(documentQuery ? { documentQuery } : {}),
          ...(localMemory ? { localMemory } : {}),
          ...(attachmentIds.length
            ? { attachmentIds: [...new Set(attachmentIds.map(String))] }
            : {})
        }),
        signal
      }, expected));
      if (!response.ok) {
        const payload = await readJson(response);
        if (response.status !== 401) assertAccountContext(response, payload, expected);
        throw safeHttpError(response.status, payload);
      }
      assertAccountContext(response, null, expected, { requireBody: false });
      if (!response.body) throw clientError('STREAM_UNAVAILABLE', SAFE_SERVICE_ERROR);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseEventParser(onEvent);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (value) parser.push(decoder.decode(value, { stream: !done }));
          if (done) break;
        }
        parser.push(decoder.decode());
        parser.finish();
      } finally {
        reader.releaseLock?.();
      }
      return { clientRequestId };
    }
  };
}
