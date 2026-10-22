import { runVoiceReasonedAnswer } from './voiceReasonedAnswer.js';
import { runVoicePublicSearch } from './voicePublicSearch.js';
import { createMockEmbedding, createMockImage, createMockText } from '../utils/mockResponse.js';
import { classifyHttpError, classifyProviderError } from '../utils/providerErrors.js';

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

  async function callVoiceStreamingChat(request = {}, { signal, onDelta = () => {} } = {}) {
    const settings = resolveOpenAICompatibleSettings(request, { baseUrl, model });
    if (!settings.apiKey) throw classifyHttpError(401, 'missing api key', metadata.id);
    if (!settings.baseUrl || !settings.model) throw classifyHttpError(400, 'missing base url or model', metadata.id);
    const controller = new AbortController(); let timedOut = false; let reader = null;
    const forwardAbort = () => { controller.abort(signal?.reason); void reader?.cancel().catch(() => {}); };
    if (signal?.aborted) forwardAbort(); else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutMs);
    const fail = (code, message = code) => Object.assign(new Error(message), { code, provider: metadata.id });
    try {
      const response = await fetch(resolveChatCompletionsUrl(metadata.id, settings.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }, body: JSON.stringify({ model: settings.model, messages: normalizeMessages(request), temperature: settings.temperature, max_tokens: settings.maxTokens, stream: true, stream_options: { include_usage: true } }), signal: controller.signal });
      if (!response.ok) throw classifyHttpError(response.status, await response.text().catch(() => ''), metadata.id);
      if (!response.body) throw fail('SSE_BODY_MISSING');
      reader = response.body.getReader(); if (controller.signal.aborted) throw fail('ABORTED'); const decoder = new TextDecoder(); let buffer = '', content = '', done = false, finished = false, finishReason = null, usage = null;
      const consume = async block => {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean).join('\n');
        if (!data) return;
        if (data === '[DONE]') { done = true; return; }
        let payload; try { payload = JSON.parse(data); } catch { throw fail('SSE_MALFORMED'); }
        if (payload?.error) throw fail('SSE_PROVIDER_ERROR');
        if (payload?.usage) usage = payload.usage;
        const choice = payload?.choices?.[0];
        if (choice?.finish_reason) { finishReason = String(choice.finish_reason); if (finishReason === 'stop') finished = true; else throw fail('SSE_INCOMPLETE'); }
        const delta = choice?.delta?.content;
        if (delta !== undefined && delta !== null && String(delta)) { const text = String(delta); content += text; await onDelta(text); }
      };
      while (!done) {
        const next = await reader.read(); buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
        let boundary; while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) { const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length || 2; const block = buffer.slice(0,boundary); buffer = buffer.slice(boundary + delimiter); await consume(block); if (done) break; }
        if (next.done) { buffer += decoder.decode(); if (buffer.trim()) await consume(buffer); break; }
      }
      if (!done || !finished) throw fail('SSE_INCOMPLETE');
      if (controller.signal.aborted) throw fail('ABORTED');
      if (!content.trim()) throw fail('EMPTY_PROVIDER_RESPONSE');
      return { provider: metadata.id, mode: 'chat', model: settings.model, content, usage, finishReason, mocked: false, createdAt: new Date().toISOString() };
    } catch (error) {
      if (timedOut) throw fail('TIMEOUT');
      if (signal?.aborted || controller.signal.aborted) throw fail('ABORTED');
      if (error?.code?.startsWith('SSE_') || error?.code === 'EMPTY_PROVIDER_RESPONSE') throw error;
      throw classifyProviderError(error, metadata.id);
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', forwardAbort); try { await reader?.cancel(); } catch {} try { reader?.releaseLock(); } catch {} }
  }

  return {
    ...metadata,
    supportsChat: true,
    supportsStreaming: false,
    supportsVoiceStreaming: nativeVoiceStreaming,
    supportsSingleShotSseBridge: true,

    async generate(request = {}) {
      return callChatCompletions(request);
    },

    async chat(request = {}) {
      return callChatCompletions(request);
    },

    ...(nativeVoiceStreaming ? { async streamVoiceChat(request = {}, options = {}) { return callVoiceStreamingChat(request, options); } } : {}),
    ...(id === 'qwen' ? { async answerWithTools(request = {}, options = {}) { return runVoiceReasonedAnswer(request, resolveOpenAICompatibleSettings(request, { baseUrl, model }), options); }, async searchPublicInformation(request = {}, options = {}) { return runVoicePublicSearch(request, resolveOpenAICompatibleSettings(request, { baseUrl, model }), options); } } : {}),

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
