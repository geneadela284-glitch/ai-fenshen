import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIRouter } from '../../router/AIRouter.js';
import { allowingAccessControl } from '../../router/testing/allowingAccessControl.js';
import { defaultAiSettings } from '../../settings/defaultSettings.js';
import {
  ClaudeAdapter,
  GeminiAdapter,
  GrokAdapter,
  OpenAIAdapter
} from '../adapters/internationalAdapters.js';
import { validateProviderAdapter } from '../protocol/validators.js';
import { isGatewayRuntimeEnabled } from './featureFlags.js';
import { GatewayRuntime } from './GatewayRuntime.js';
import { createAIRequestRuntimeContext } from './runtimeContext.js';
import { responsePolicyRuntime } from './responsePolicyRuntime.js';

function providerConfig(id, model, priority) {
  return {
    id,
    enabled: true,
    apiKey: 'local-test-key',
    baseUrl: `https://${id}.example/v1`,
    defaultModel: model,
    priority,
    status: '可用',
    healthy: true,
    modelCapabilities: { [model]: ['chat'] }
  };
}

function createSettings(enabled) {
  return {
    load() {
      return {
        gateway: { runtime: { enabled } },
        provider: 'deepseek',
        router: { routes: {} },
        providers: {
          deepseek: providerConfig('deepseek', 'deepseek-chat', 1),
          qwen: providerConfig('qwen', 'qwen-plus', 2)
        }
      };
    },
    recordProviderHealth() {}
  };
}

function createLegacyProviders() {
  return {
    calls: [],
    async chat(request) {
      this.calls.push(request);
      return { provider: request.provider, model: request.options?.model, content: '旧链回复' };
    },
    async generate(request) { return this.chat(request); }
  };
}

function withContract(overrides = {}) {
  return {
    providerId: 'deepseek',
    validateConfig() { return { valid: true, errors: [], warnings: [] }; },
    async healthCheck() { return { healthy: true }; },
    async listModels() { return []; },
    supportsCapability() { return { supported: true }; },
    async invoke() { return {}; },
    async invokeVision(request, context) { return this.invoke(request, context); },
    async invokeStructured(request, schema, context) { return this.invoke(request, context); },
    normalizeResponse(raw) { return raw; },
    normalizeError(error) { return error; },
    normalizeUsage() { return null; },
    estimateCost() { return null; },
    ...overrides
  };
}

test('gateway.runtime.enabled defaults to false', () => {
  assert.equal(isGatewayRuntimeEnabled(defaultAiSettings), false);
});

test('runtime context is built once and carries the frozen request fields', async () => {
  const contexts = [];
  const gatewayRuntime = {
    async invoke({ providerId, runtimeContext }) {
      contexts.push(runtimeContext);
      if (providerId === 'deepseek') throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      return { provider: providerId, model: 'qwen-plus', content: '作为通义千问模型，统一入口回复' };
    }
  };
  const router = new AIRouter({
    accessControl: allowingAccessControl,
    providers: createLegacyProviders(),
    settings: createSettings(true),
    gatewayRuntime
  });

  const result = await router.run({
    input: '测试 Runtime',
    capability: 'CHAT',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    attachments: [{ id: 'file-1', type: 'document', mimeType: 'text/plain', sizeBytes: 12, storageRef: 'local:file-1' }],
    metadata: {
      requestId: 'runtime-request-1',
      conversationId: 'conversation-1',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      currentDate: '2026-07-14',
      deterministicResult: { total: 100 }
    }
  });

  assert.equal(contexts.length, 2);
  assert.equal(contexts[0], contexts[1]);
  assert.equal(Object.isFrozen(contexts[0]), true);
  assert.deepEqual(contexts[0], {
    requestId: 'runtime-request-1',
    conversationId: 'conversation-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    currentDate: '2026-07-14',
    deterministicResult: { total: 100 },
    capability: 'chat',
    attachments: [{ id: 'file-1', type: 'document', mimeType: 'text/plain', fileName: 'attachment-1', sizeBytes: 12, storageRef: 'local:file-1', checksum: null, width: null, height: null, durationMs: null, metadata: {} }]
  });
  assert.equal(result.content, '统一入口回复');
});

test('disabled feature flag keeps the legacy provider path', async () => {
  const providers = createLegacyProviders();
  let gatewayCalls = 0;
  const router = new AIRouter({
    accessControl: allowingAccessControl,
    providers,
    settings: createSettings(false),
    gatewayRuntime: { async invoke() { gatewayCalls += 1; } }
  });

  const result = await router.run({ input: '保持旧链', capability: 'CHAT' });
  assert.equal(result.content, '旧链回复');
  assert.equal(providers.calls.length, 1);
  assert.equal(gatewayCalls, 0);
});

test('Gateway Runtime validates V1 protocol and returns a legacy-compatible provider result', async () => {
  let capturedRequest;
  let capturedContext;
  const adapter = withContract({
    providerId: 'deepseek',
    async invoke(request, context) {
      capturedRequest = request;
      capturedContext = context;
      return {
        provider: 'deepseek',
        model: 'deepseek-chat',
        content: '作为 DeepSeek 模型，Gateway 回复',
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      };
    },
    normalizeResponse(raw, context) {
      return {
        schemaVersion: 'v1', requestId: context.requestId, success: true,
        content: raw.content, structuredOutput: null, deterministicResult: null,
        capability: context.capability, providerId: 'deepseek', modelId: raw.model,
        routeReason: null, fallbackChain: [], durationMs: 0,
        tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        estimatedCost: null, error: null, traceId: null, warnings: [],
        createdAt: '2026-07-14T00:00:00.000Z'
      };
    }
  });
  const runtime = new GatewayRuntime({ adapterResolver: () => adapter });
  const runtimeContext = createAIRequestRuntimeContext({
    input: 'Gateway 测试', userId: 'user-1', workspaceId: 'workspace-1',
    metadata: { requestId: 'gateway-request-1', currentDate: '2026-07-14' }
  });

  const result = await runtime.invoke({
    providerId: 'deepseek',
    request: { input: 'Gateway 测试', options: { timeoutMs: 1000 } },
    runtimeContext,
    providerConfig: { apiKey: 'must-stay-outside-protocol', defaultModel: 'deepseek-chat' }
  });

  assert.equal(result.content, 'Gateway 回复');
  assert.equal(result.gatewayResponse.schemaVersion, 'v1');
  assert.doesNotMatch(JSON.stringify(capturedRequest), /must-stay-outside-protocol/);
  assert.equal(capturedContext.providerConfig.apiKey, 'must-stay-outside-protocol');
});

test('Gateway Runtime normalizes Adapter failures before returning to AIRouter', async () => {
  const adapter = withContract({
    providerId: 'deepseek',
    async invoke() { throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }); },
    normalizeError(error) {
      return { ...error, code: 'PROVIDER_UNAVAILABLE', retryable: true };
    }
  });
  const runtime = new GatewayRuntime({ adapterResolver: () => adapter });
  const runtimeContext = createAIRequestRuntimeContext({
    input: '失败测试', userId: 'user-1', workspaceId: 'workspace-1',
    metadata: { requestId: 'gateway-error-1', currentDate: '2026-07-14' }
  });

  await assert.rejects(
    runtime.invoke({ providerId: 'deepseek', request: { input: '失败测试' }, runtimeContext }),
    (error) => error?.code === 'PROVIDER_UNAVAILABLE' && error?.retryable === true
  );
});

test('Gateway Runtime fails closed before invoking an Adapter that has not migrated', async () => {
  let invoked = false;
  const legacyAdapter = {
    providerId: 'legacy',
    async invoke() { invoked = true; return { content: '不应调用' }; }
  };
  const runtime = new GatewayRuntime({ adapterResolver: () => legacyAdapter });
  const runtimeContext = createAIRequestRuntimeContext({
    input: '兼容检查', userId: 'user-1', workspaceId: 'workspace-1',
    metadata: { requestId: 'gateway-legacy-1', currentDate: '2026-07-14' }
  });

  await assert.rejects(
    runtime.invoke({ providerId: 'legacy', request: { input: '兼容检查' }, runtimeContext }),
    (error) => error?.code === 'CAPABILITY_NOT_SUPPORTED'
  );
  assert.equal(invoked, false);
});

test('response policy runtime preserves existing policy behavior', () => {
  const unchanged = responsePolicyRuntime.apply({ content: '正常回复', structuredOutput: null });
  assert.equal(unchanged.content, '正常回复');
  const protectedResult = responsePolicyRuntime.apply(
    { content: '模型猜测为 999 元' },
    { programResult: '程序结果为 100 元' }
  );
  assert.equal(protectedResult.content, '程序结果为 100 元');
});

test('runtime context factory is deterministic for supplied values', () => {
  const first = createAIRequestRuntimeContext({ input: 'A', metadata: { requestId: 'fixed', currentDate: '2026-07-14' } });
  const second = createAIRequestRuntimeContext({ input: 'B', metadata: { requestId: 'fixed', currentDate: '2026-07-14' } });
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.currentDate, second.currentDate);
});

test('international adapters reserve the contract without network access', async () => {
  for (const Adapter of [OpenAIAdapter, ClaudeAdapter, GeminiAdapter, GrokAdapter]) {
    const adapter = new Adapter();
    assert.equal(validateProviderAdapter(adapter).valid, true);
    await assert.rejects(adapter.invoke({}), /TODO/);
  }
});
