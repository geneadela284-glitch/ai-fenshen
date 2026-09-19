import { createMockEmbedding, createMockImage } from '../utils/mockResponse.js';
import { classifyHttpError, classifyProviderError, ProviderError } from '../utils/providerErrors.js';

const metadata = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'cloud',
  region: 'cn'
};

function resolveSettings(request = {}) {
  const options = request.options || {};
  return {
    apiKey: options.apiKey || '',
    baseUrl: (options.baseUrl || 'https://api.deepseek.com').replace(/\/$/, ''),
    model: options.model || 'deepseek-v4-flash',
    temperature: Number(options.temperature ?? 0.7),
    maxTokens: Number(options.maxTokens ?? 2048),
    timeoutMs: Number(options.timeoutMs ?? 30000)
  };
}

function normalizeMessages(request = {}) {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return request.messages;
  }

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

async function callChatCompletions(request = {}) {
  const settings = resolveSettings(request);
  if (!settings.apiKey) {
    throw classifyHttpError(401, 'missing api key', metadata.id);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

  try {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        messages: normalizeMessages(request),
        thinking: {
          type: 'disabled'
        },
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        stream: false
      }),
      signal: controller.signal
    });

    const body = await response.json().catch(async () => response.text());
    if (!response.ok) {
      throw classifyHttpError(response.status, body, metadata.id);
    }

    const content = body?.choices?.[0]?.message?.content || '';
    return {
      provider: metadata.id,
      mode: 'chat',
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

async function callStreamingChat(request = {}, { signal, onDelta = () => {} } = {}) {
  const settings = resolveSettings(request);
  if (!settings.apiKey) throw classifyHttpError(401, 'missing api key', metadata.id);

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
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages: normalizeMessages(request),
        thinking: {
          type: 'disabled'
        },
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

const deepseekProvider = {
  ...metadata,
  status: 'real',
  supportsChat: true,
  supportsStreaming: true,
  supportsSingleShotSseBridge: false,

  async generate(request = {}) {
    return callChatCompletions(request);
  },

  async chat(request = {}) {
    return callChatCompletions(request);
  },

  async streamChat(request = {}, options = {}) {
    return callStreamingChat(request, options);
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

export default deepseekProvider;
