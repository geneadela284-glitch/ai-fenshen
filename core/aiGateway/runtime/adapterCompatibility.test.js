import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProviderAdapter } from '../../providers/providerAdapters.js';
import { providerRegistry } from '../../providers/providerRegistry.js';
import { validateProviderAdapter } from '../protocol/validators.js';
import { createAdapterCompatibilityReport } from './adapterCompatibilityReport.js';

const providerIds = ['deepseek', 'qwen', 'kimi', 'zhipu', 'doubao'];

function createOfflineManager() {
  return {
    calls: [],
    async chat(request) {
      this.calls.push(request);
      return {
        provider: request.provider,
        model: request.options?.model || 'offline-model',
        content: '{"summary":"offline"}',
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        createdAt: '2026-07-14T00:00:00.000Z'
      };
    }
  };
}

test('DeepSeek, Qwen, Kimi, Zhipu, and Doubao implement ProviderAdapterContract V1', () => {
  for (const providerId of providerIds) {
    const adapter = getProviderAdapter(providerRegistry.get(providerId), { manager: createOfflineManager() });
    const validation = validateProviderAdapter(adapter);
    assert.equal(validation.valid, true, `${providerId}: ${JSON.stringify(validation.errors)}`);
    assert.deepEqual(validation.warnings, []);
  }
});

test('domestic adapters normalize usage, errors, and structured responses offline', async () => {
  for (const providerId of providerIds) {
    const manager = createOfflineManager();
    const definition = providerRegistry.get(providerId);
    const adapter = getProviderAdapter(definition, { manager });
    const model = definition.defaultModel;
    const request = {
      schemaVersion: 'v1',
      requestId: `request-${providerId}`,
      input: '离线兼容测试',
      capability: 'structured_extraction',
      attachments: [],
      metadata: {}
    };

    const structured = await adapter.invokeStructured(request, { type: 'object' }, {
      providerConfig: { defaultModel: model },
      legacyRequest: { input: request.input, options: { model } }
    });
    assert.equal(structured.structuredOutput.summary, 'offline');
    assert.equal(manager.calls.length, 1);
    assert.deepEqual(adapter.normalizeUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }), {
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5
    });
    assert.equal(adapter.normalizeError(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })).code, 'TIMEOUT');
  }
});

test('vision and tool capability checks are explicit for all domestic adapters', async () => {
  const expectedVision = { deepseek: false, qwen: true, kimi: false, zhipu: true, doubao: true };
  for (const providerId of providerIds) {
    const definition = providerRegistry.get(providerId);
    const adapter = getProviderAdapter(definition, { manager: createOfflineManager() });
    const model = providerId === 'qwen'
      ? 'qwen3-vl-plus'
      : providerId === 'zhipu'
        ? 'glm-4v-plus'
        : providerId === 'doubao'
          ? 'doubao-seed-2-0-lite-260215'
          : definition.defaultModel;
    assert.equal(adapter.supportsCapability(model, 'vision').supported, expectedVision[providerId]);
    assert.equal(typeof adapter.supportsCapability(definition.defaultModel, 'tool_call').supported, 'boolean');
    if (!expectedVision[providerId]) {
      await assert.rejects(
        adapter.invokeVision({ requestId: `vision-${providerId}`, capability: 'vision' }, { providerConfig: { defaultModel: model } }),
        (error) => error?.code === 'CAPABILITY_NOT_SUPPORTED'
      );
    }
  }
});

test('compatibility report is complete for all five domestic adapters', () => {
  const adapters = Object.fromEntries(providerIds.map((providerId) => [
    providerId,
    getProviderAdapter(providerRegistry.get(providerId), { manager: createOfflineManager() })
  ]));
  const report = createAdapterCompatibilityReport(adapters);

  for (const providerId of providerIds) {
    assert.deepEqual(report[providerId], {
      contract: 100,
      vision: 100,
      tool: 100,
      structured: 100,
      health: 'PASS'
    });
  }
});
