import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProviderAdapter } from '../aiGateway/protocol/validators.js';
import { getProviderAdapter } from './providerAdapters.js';
import { resolveChatCompletionsUrl } from './providerFactory.js';
import { ProviderManager } from './providerManager.js';
import { providerRegistry } from './providerRegistry.js';

test('doubao provider uses model field instead of a separate endpoint id field', () => {
  const config = providerRegistry.createDefaultConfig('doubao');
  assert.equal(config.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(config.modelPlaceholder, 'Model');
  assert.ok(config.defaultModel);
  assert.equal(config.defaultModel, config.model);
});

test('doubao legacy endpoint id config is migrated into model', () => {
  const config = providerRegistry.normalizeConfig('doubao', {
    endpointId: 'legacy-ark-endpoint',
    apiKey: 'test-key'
  });
  assert.equal(config.defaultModel, 'legacy-ark-endpoint');
  assert.equal(config.model, 'legacy-ark-endpoint');
});

test('doubao request uses persisted provider model config', () => {
  const manager = new ProviderManager();
  manager.configure({
    activeProvider: 'doubao',
    providerConfigs: {
      doubao: providerRegistry.normalizeConfig('doubao', {
        apiKey: 'test-key',
        defaultModel: 'doubao-custom-model',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
      })
    }
  });

  const request = manager.buildRequest({
    provider: 'doubao',
    messages: [{ role: 'user', content: 'ping' }]
  });
  assert.equal(request.options.model, 'doubao-custom-model');
  assert.equal(request.options.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(request.options.apiKey, 'test-key');
});

test('doubao request url is normalized to volcengine ark chat completions endpoint', () => {
  const expected = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
  assert.equal(resolveChatCompletionsUrl('doubao', 'https://ark.cn-beijing.volces.com/api/v3'), expected);
  assert.equal(resolveChatCompletionsUrl('doubao', 'https://ark.cn-beijing.volces.com/api/v3/api/v3'), expected);
  assert.equal(resolveChatCompletionsUrl('doubao', 'https://ark.cn-beijing.volces.com/v1'), expected);
  assert.equal(resolveChatCompletionsUrl('doubao', 'https://ark.cn-beijing.volces.com/v1/chat/completions'), expected);
  assert.equal(resolveChatCompletionsUrl('doubao', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'), expected);
});

test('non-doubao compatible providers keep existing chat completions url behavior', () => {
  assert.equal(
    resolveChatCompletionsUrl('openai', 'https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions'
  );
});

test('doubao resolves to a complete ProviderAdapterContract V1 adapter', () => {
  const adapter = getProviderAdapter(providerRegistry.get('doubao'), {
    manager: { chat: async () => ({ content: 'ok' }) }
  });

  assert.equal(adapter.constructor.name, 'DoubaoAdapter');
  assert.deepEqual(validateProviderAdapter(adapter), { valid: true, errors: [], warnings: [] });
});

test('doubao invokeVision preserves the Ark multimodal message body', async () => {
  const calls = [];
  const adapter = getProviderAdapter(providerRegistry.get('doubao'), {
    manager: {
      async chat(request) {
        calls.push(request);
        return {
          provider: 'doubao',
          model: request.options.model,
          content: '图片中有一个蓝色方块。',
          httpStatus: 200,
          usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 }
        };
      }
    }
  });
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '请描述图片' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
    ]
  }];

  const result = await adapter.invokeVision({
    requestId: 'doubao-vision-request',
    capability: 'vision',
    input: '请描述图片'
  }, {
    providerConfig: { apiKey: 'test-key', defaultModel: 'doubao-seed-2-0-lite-260215' },
    legacyRequest: { messages, options: { model: 'doubao-seed-2-0-lite-260215' } }
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'doubao');
  assert.equal(calls[0].options.model, 'doubao-seed-2-0-lite-260215');
  assert.deepEqual(calls[0].messages, messages);
});

test('only doubao treats legacy endpointId as the canonical model value', () => {
  const doubao = providerRegistry.normalizeConfig('doubao', { endpointId: 'ep-doubao-vision' });
  const qwen = providerRegistry.normalizeConfig('qwen', { endpointId: 'ep-not-qwen-model' });

  assert.equal(doubao.model, 'ep-doubao-vision');
  assert.notEqual(qwen.model, 'ep-not-qwen-model');
});

test('doubao validateConfig rejects non-HTTPS Ark endpoints', () => {
  const adapter = getProviderAdapter(providerRegistry.get('doubao'), {
    manager: { chat: async () => ({ content: 'ok' }) }
  });
  const result = adapter.validateConfig({
    apiKey: 'test-key',
    baseUrl: 'http://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-lite-260215'
  });

  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.path === 'baseUrl'), true);
});

test('doubao listModels reports only the configured model or Endpoint ID', async () => {
  const adapter = getProviderAdapter(providerRegistry.get('doubao'), {
    manager: { chat: async () => ({ content: 'ok' }) }
  });
  const endpointId = 'ep-20260714-doubao';
  const models = await adapter.listModels({
    endpointId,
    modelCapabilities: { [endpointId]: ['chat', 'vision', 'ocr'] }
  });

  assert.deepEqual(models, [{
    id: endpointId,
    name: endpointId,
    providerId: 'doubao',
    capabilities: ['chat', 'vision', 'ocr'],
    source: 'configured'
  }]);
});

test('doubao uses an Endpoint ID-only config for health and invoke requests', async () => {
  const calls = [];
  const adapter = getProviderAdapter(providerRegistry.get('doubao'), {
    manager: {
      async chat(request) {
        calls.push(request);
        return {
          provider: 'doubao',
          model: request.options.model,
          content: 'ok',
          httpStatus: 200
        };
      }
    }
  });
  const config = {
    apiKey: 'test-key',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    endpointId: 'ep-doubao-only'
  };

  const health = await adapter.healthCheck(config);
  const result = await adapter.invoke({ requestId: 'endpoint-only', input: 'ping' }, {
    providerConfig: config,
    legacyRequest: { messages: [{ role: 'user', content: 'ping' }] }
  });

  assert.equal(health.healthy, true);
  assert.equal(health.modelId, 'ep-doubao-only');
  assert.equal(result.model, 'ep-doubao-only');
  assert.deepEqual(calls.map((request) => request.options.model), [
    'ep-doubao-only',
    'ep-doubao-only'
  ]);
});
