import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderManager } from './providerManager.js';
import { getProviderAdapter } from './providerAdapters.js';
import deepseek from './deepseek.js';
import { providerRegistry } from './providerRegistry.js';
import { getProviderModel } from '../orchestrator/routingPolicies.js';
import { ModelRegistry } from '../router/ModelRegistry.js';
import { SettingsManager } from '../settings/settingsManager.js';

function successResponse() {
  return new Response(JSON.stringify({
    id: 'chatcmpl-deepseek-v4-flash-test',
    choices: [{ index: 0, message: { role: 'assistant', content: '连接成功' }, finish_reason: 'stop' }],
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function currentSettings() {
  const providers = new ProviderManager();
  const repository = { read: () => null };
  const healthRepository = { read: () => ({ schemaVersion: 1, providers: {} }) };
  return new SettingsManager({ repository, healthRepository, providers }).load();
}

test('DeepSeek current catalog and active routes select v4 flash without changing other domestic defaults', () => {
  const settings = currentSettings();
  const registry = new ModelRegistry();
  const deepseekConfig = settings.providers.deepseek;

  assert.equal(settings.model, 'deepseek-v4-flash');
  assert.equal(settings.defaultModel, 'deepseek-v4-flash');
  assert.equal(deepseekConfig.model, 'deepseek-v4-flash');
  assert.equal(deepseekConfig.defaultModel, 'deepseek-v4-flash');
  assert.deepEqual(
    deepseekConfig.modelOptions.map(({ value }) => value),
    ['deepseek-v4-flash', 'deepseek-v4-pro']
  );
  for (const capability of ['CHAT', 'WRITE', 'SUMMARY', 'REPORT', 'WORKFLOW']) {
    assert.equal(registry.getRoutePolicy(settings, capability).model, 'deepseek-v4-flash');
  }
  assert.equal(getProviderModel('deepseek'), 'deepseek-v4-flash');

  assert.equal(settings.providers.qwen.defaultModel, 'qwen-max');
  assert.equal(settings.providers.kimi.defaultModel, 'moonshot-v1-8k');
  assert.equal(settings.providers.zhipu.defaultModel, 'glm-4.5');
});

test('DeepSeek default chat request uses v4 flash with thinking disabled and preserves endpoint and auth format', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  try {
    globalThis.fetch = async (url, options) => {
      captured = { url: String(url), options, body: JSON.parse(options.body) };
      return successResponse();
    };
    const result = await deepseek.chat({
      input: '最小聊天验证',
      options: { apiKey: 'test-secret-key' }
    });

    assert.equal(result.httpStatus, 200);
    assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-secret-key');
    assert.equal(captured.body.model, 'deepseek-v4-flash');
    assert.deepEqual(captured.body.thinking, { type: 'disabled' });
    assert.equal(captured.body.stream, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DeepSeek explicit v4 flash request disables thinking', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  try {
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return successResponse();
    };

    await deepseek.chat({
      input: '非思考模式验证',
      options: {
        apiKey: 'test-secret-key',
        model: 'deepseek-v4-flash'
      }
    });

    assert.deepEqual(body.thinking, { type: 'disabled' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DeepSeek health check reuses v4 flash non-thinking request and succeeds', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  try {
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return successResponse();
    };
    const manager = new ProviderManager();
    const adapter = getProviderAdapter(providerRegistry.get('deepseek'), { manager });
    const config = {
      ...providerRegistry.createDefaultConfig('deepseek'),
      apiKey: 'test-secret-key',
      enabled: true
    };

    const result = await adapter.testConnection(config);

    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(body.model, 'deepseek-v4-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 64);
    assert.equal(body.stream, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
