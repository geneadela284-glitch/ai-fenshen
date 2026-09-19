import { createMockEmbedding, createMockImage, createMockText } from '../utils/mockResponse.js';
import { classifyHttpError, classifyProviderError, ProviderError } from '../utils/providerErrors.js';

export function createMockProvider({ id, name, type = 'cloud', status = 'mock', region = 'global', reserved = false }) {
  const metadata = { id, name, type, status, region, reserved };

  return {
    ...metadata,
    supportsChat: true,
    supportsStreaming: false,
    supportsSingleShotSseBridge: false,

    async generate(request = {}) {
      return createMockText({
        provider: metadata,
        mode: 'generate',
        prompt: request.prompt,
        input: request.input,
        options: request.options
      });
    },

    async chat(request = {}) {
      return createMockText({
        provider: metadata,
        mode: 'chat',
        prompt: request.prompt,
        input: request.messages || request.input,
        options: request.options
      });
    },

    async image(request = {}) {
      return createMockImage({
        provider: metadata,
        prompt: request.prompt || request.input,
        options: request.options
      });
    },

    async embedding(request = {}) {
      return createMockEmbedding({
        provider: metadata,
        input: request.input || request.prompt,
        options: request.options
      });
    }
  };
}

function resolveOpenAICompatibleSettings(request = {}, defaults = {}) {
  const options = request.options || {};
  return {
    apiKey: options.apiKey || '',
    baseUrl: (options.baseUrl || defaults.baseUrl || '').replace(/\/$/, ''),
    model: options.model || options.defaultModel || defaults.model || '',
    temperature: Number(options.temperature ?? 0.7),
    maxTokens: Number(options.maxTokens ?? 2048),
    timeoutMs: Number(options.timeoutMs ?? options.timeout ?? 30000)
  };
}

export function resolveChatCompletionsUrl(providerId, baseUrl = '') {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (providerId !== 'doubao') return `${trimmed}/chat/completions`;

  let url;
  try {
    url = new URL(trimmed || 'https://ark.cn-beijing.volces.com/api/v3');
  } catch {
    url = new URL('https://ark.cn-beijing.volces.com/api/v3');
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/chat\/completions$/i, '');
  pathname = pathname.replace(/(?:\/api\/v3)+$/i, '/api/v3');
  pathname = pathname.replace(/\/v1$/i, '/api/v3');
  if (!pathname || pathname === '/' || !/\/api\/v3$/i.test(pathname)) pathname = '/api/v3';

  url.pathname = `${pathname}/chat/completions`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function normalizeMessages(request = {}) {
  if (Array.isArray(request.messages) && request.messages.length) return request.messages;
  const input = request.input || request.prompt || '';
  return [
    {
      role: 'system',
      content: '你是 AI Work Center 的中文办公助手，回答要清楚、实用、适合普通办公用户。'
    },
    {
      role: 'user',
      content: input
    }
  ];
}

export function createOpenAICompatibleProvider({ id, name, type = 'cloud', region = 'cn', reserved = false, baseUrl = '', model = '', nativeVoiceStreaming = false }) {
  const metadata = { id, name, type, status: 'real', region, reserved };

  async function callChatCompletions(request = {}) {
    const settings = resolveOpenAICompatibleSettings(request, { baseUrl, model });
    if (!settings.apiKey) throw classifyHttpError(401, 'missing api key', metadata.id);
    if (!settings.baseUrl || !settings.model) throw classifyHttpError(400, 'missing base url or model', metadata.id);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

    try {
      const requestUrl = resolveChatCompletionsUrl(metadata.id, settings.baseUrl);
      if (metadata.id === 'doubao') {
        console.info(`[Doubao Provider] request URL: ${requestUrl}`);
      }

      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          model: settings.model,
          messages: normalizeMessages(request),
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          stream: false
        }),
        signal: controller.signal
      });

      const body = await response.json().catch(async () => response.text());
      if (!response.ok) throw classifyHttpError(response.status, body, metadata.id);

      return {
        provider: metadata.id,
        mode: 'chat',
        model: settings.model,
        content: body?.choices?.[0]?.message?.content || '',
        raw: body,
        httpStatus: response.status,
        usage: body?.usage || null,
        mocked: false,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      throw classifyProviderError(error, metadata.id);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function callStreamingChat(request = {}, { signal, onDelta = () => {} } = {}) {
    const settings = resolveOpenAICompatibleSettings(request, { baseUrl, model });
    if (!settings.apiKey) throw classifyHttpError(401, 'missing api key', metadata.id);
    if (!settings.baseUrl || !settings.model) throw classifyHttpError(400, 'missing base url or model', metadata.id);

    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort(signal?.reason || 'caller_aborted');
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort('timeout');
    }, settings.timeoutMs);

    try {
      const requestUrl = resolveChatCompletionsUrl(metadata.id, settings.baseUrl);
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          model: settings.model,
          messages: normalizeMessages(request),
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          stream: true
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw classifyHttpError(response.status, body, metadata.id);
      }
      if (!response.body) throw new ProviderError('网络错误', { code: 'NETWORK_ERROR', provider: metadata.id });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let done = false;
      const consume = async (block) => {
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') {
            done = true;
            return;
          }
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }
          const delta = String(payload?.choices?.[0]?.delta?.content || '');
          if (!delta) continue;
          content += delta;
          await onDelta(delta);
        }
      };

      while (!done) {
        const next = await reader.read();
        buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length || 2;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + delimiter);
          await consume(block);
          if (done) break;
        }
        if (next.done) {
          if (buffer.trim()) await consume(buffer);
          break;
        }
      }
      return { provider: metadata.id, mode: 'chat', content, usage: null, mocked: false, createdAt: new Date().toISOString() };
    } catch (error) {
      if (signal?.aborted && !timedOut) throw new ProviderError('已停止', { code: 'ABORTED', provider: metadata.id, cause: error });
      throw classifyProviderError(error, metadata.id);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  return {
    ...metadata,
    supportsChat: true,
    // Generic text SSE keeps the existing single-shot compatibility bridge.
    // Only the explicitly opted-in voice path gets native Provider streaming.
    supportsStreaming: false,
    supportsVoiceStreaming: nativeVoiceStreaming,
    supportsSingleShotSseBridge: true,

    async generate(request = {}) {
      return callChatCompletions(request);
    },

    async chat(request = {}) {
      return callChatCompletions(request);
    },

    ...(nativeVoiceStreaming ? {
      async streamVoiceChat(request = {}, options = {}) {
        return callStreamingChat(request, options);
      }
    } : {}),

    async image() {
      throw classifyHttpError(400, 'vision adapter not implemented', metadata.id);
    },

    async embedding() {
      throw classifyHttpError(400, 'embedding adapter not implemented', metadata.id);
    }
  };
}

function buildTextFromMessages(request = {}) {
  return normalizeMessages(request)
    .map((message) => `${message.role === 'system' ? 'System' : 'User'}: ${message.content}`)
    .join('\n\n');
}

export function createAnthropicProvider({ id = 'claude', name = 'Claude', type = 'cloud', region = 'global', reserved = true, baseUrl = 'https://api.anthropic.com/v1', model = 'claude-sonnet-4-20250514' } = {}) {
  const metadata = { id, name, type, status: 'real', region, reserved };

  async function callMessages(request = {}) {
    const settings = resolveOpenAICompatibleSettings(request, { baseUrl, model });
    if (!settings.apiKey) throw classifyHttpError(401, 'missing api key', metadata.id);
    if (!settings.baseUrl || !settings.model) throw classifyHttpError(400, 'missing base url or model', metadata.id);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

    try {
      const messages = normalizeMessages(request);
      const system = messages.find((message) => message.role === 'system')?.content || 'You are AI Work Center.';
      const userMessages = messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: String(message.content || '')
        }));

      const response = await fetch(`${settings.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: settings.model,
          system,
          messages: userMessages.length ? userMessages : [{ role: 'user', content: buildTextFromMessages(request) }],
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          stream: false
        }),
        signal: controller.signal
      });

      const body = await response.json().catch(async () => response.text());
      if (!response.ok) throw classifyHttpError(response.status, body, metadata.id);
      const content = Array.isArray(body?.content)
        ? body.content.map((part) => part?.text || '').filter(Boolean).join('\n')
        : '';

      return {
        provider: metadata.id,
        mode: 'chat',
        model: settings.model,
        content,
        raw: body,
        httpStatus: response.status,
        usage: body?.usage || null,
        mocked: false,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      throw classifyProviderError(error, metadata.id);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ...metadata,
    supportsChat: true,
    supportsStreaming: false,
    supportsSingleShotSseBridge: false,
    async generate(request = {}) {
      return callMessages(request);
    },
    async chat(request = {}) {
      return callMessages(request);
    },
    async image() {
      throw classifyHttpError(400, 'vision adapter not implemented', metadata.id);
    },
    async embedding() {
      throw classifyHttpError(400, 'embedding adapter not implemented', metadata.id);
    }
  };
}

export function createGeminiProvider({ id = 'gemini', name = 'Gemini', type = 'cloud', region = 'global', reserved = true, baseUrl = 'https://generativelanguage.googleapis.com/v1beta', model = 'gemini-2.5-pro' } = {}) {
  const metadata = { id, name, type, status: 'real', region, reserved };

  async function callGenerateContent(request = {}) {
    const settings = resolveOpenAICompatibleSettings(request, { baseUrl, model });
    if (!settings.apiKey) throw classifyHttpError(401, 'missing api key', metadata.id);
    if (!settings.baseUrl || !settings.model) throw classifyHttpError(400, 'missing base url or model', metadata.id);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

    try {
      const response = await fetch(`${settings.baseUrl}/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: buildTextFromMessages(request) }]
            }
          ],
          generationConfig: {
            temperature: settings.temperature,
            maxOutputTokens: settings.maxTokens
          }
        }),
        signal: controller.signal
      });

      const body = await response.json().catch(async () => response.text());
      if (!response.ok) throw classifyHttpError(response.status, body, metadata.id);
      const content = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').filter(Boolean).join('\n') || '';

      return {
        provider: metadata.id,
        mode: 'chat',
        model: settings.model,
        content,
        raw: body,
        httpStatus: response.status,
        usage: body?.usageMetadata || null,
        mocked: false,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      throw classifyProviderError(error, metadata.id);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ...metadata,
    supportsChat: true,
    supportsStreaming: false,
    supportsSingleShotSseBridge: false,
    async generate(request = {}) {
      return callGenerateContent(request);
    },
    async chat(request = {}) {
      return callGenerateContent(request);
    },
    async image(request = {}) {
      return callGenerateContent(request);
    },
    async embedding() {
      throw classifyHttpError(400, 'embedding adapter not implemented', metadata.id);
    }
  };
}
