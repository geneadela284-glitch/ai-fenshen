import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { AIRouter as ProductionAIRouter } from './AIRouter.js';
import { CAPABILITIES } from './CapabilityMap.js';
import { InvocationTraceRepository } from './InvocationTraceRepository.js';
import { allowingAccessControl } from './testing/allowingAccessControl.js';

class AIRouter extends ProductionAIRouter {
  constructor(options = {}) {
    super({ ...options, accessControl: allowingAccessControl });
  }
}

function providerConfig(id, model, capabilities, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    apiKey: `${id}-secret-key`,
    baseUrl: `https://${id}.example/v1`,
    defaultModel: model,
    priority: 10,
    status: '可用',
    healthy: true,
    modelCapabilities: { [model]: capabilities },
    ...overrides
  };
}

function createSettings(providers, routes = {}) {
  const snapshot = { provider: 'deepseek', providers, router: { routes } };
  return {
    load: () => snapshot,
    healthEvents: [],
    recordProviderHealth(providerId, outcome) {
      this.healthEvents.push({ providerId, outcome });
    }
  };
}

function createProviders(behaviors = {}) {
  const calls = [];
  return {
    calls,
    async chat(request) {
      calls.push(request);
      const behavior = behaviors[request.provider];
      if (behavior instanceof Error) throw behavior;
      return {
        provider: request.provider,
        model: request.options?.model,
        content: behavior?.content || `ok:${request.provider}`,
        usage: { total_tokens: 7 }
      };
    },
    async generate(request) {
      return this.chat(request);
    }
  };
}

test('routes only to models that explicitly support the requested capability', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-chat', ['chat', 'writing']),
    qwen: providerConfig('qwen', 'qwen-vl-plus', ['chat', 'vision', 'ocr'], { priority: 20 })
  }, {
    VISION: { providerId: 'deepseek', model: 'deepseek-chat' }
  });
  const providers = createProviders();
  const traces = new InvocationTraceRepository({ storage: createMemoryStorage() });
  const router = new AIRouter({ providers, settings, traces });

  const result = await router.run({ capability: CAPABILITIES.VISION, input: '看看这张图片' });

  assert.equal(result.selectedProvider, 'qwen');
  assert.equal(result.selectedModel, 'qwen-vl-plus');
  assert.equal(providers.calls.length, 1);
  assert.equal(providers.calls[0].provider, 'qwen');
});

test('routes chat, writing, and reasoning to their configured capable models', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-reasoner', ['chat', 'reasoning']),
    qwen: providerConfig('qwen', 'qwen-plus', ['chat', 'writing'], { priority: 20 })
  }, {
    CHAT: { providerId: 'qwen', model: 'qwen-plus' },
    WRITE: { providerId: 'qwen', model: 'qwen-plus' },
    REASONING: { providerId: 'deepseek', model: 'deepseek-reasoner' }
  });
  const providers = createProviders();
  const router = new AIRouter({ providers, settings, traces: new InvocationTraceRepository({ storage: createMemoryStorage() }) });

  const chat = await router.run({ capability: CAPABILITIES.CHAT, input: '你好' });
  const writing = await router.run({ capability: CAPABILITIES.WRITING, input: '写一段介绍' });
  const reasoning = await router.run({ capability: CAPABILITIES.REASONING, input: '分析风险' });

  assert.deepEqual(
    [chat.selectedModel, writing.selectedModel, reasoning.selectedModel],
    ['qwen-plus', 'qwen-plus', 'deepseek-reasoner']
  );
});

test('uses configured capability priority and falls back once without infinite retries', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-reasoner', ['chat', 'reasoning'], { priority: 1 }),
    qwen: providerConfig('qwen', 'qwen-max', ['chat', 'reasoning'], { priority: 2 }),
    zhipu: providerConfig('zhipu', 'glm-4.5', ['chat', 'reasoning'], { priority: 3 })
  }, {
    REASONING: { providerId: 'deepseek', model: 'deepseek-reasoner' }
  });
  const providers = createProviders({ deepseek: timeout, qwen: { content: '备用成功' } });
  const traces = new InvocationTraceRepository({ storage: createMemoryStorage() });
  const router = new AIRouter({ providers, settings, traces, maxAttempts: 2 });

  const result = await router.run({ capability: CAPABILITIES.REASONING, input: '分析风险' });

  assert.equal(result.selectedProvider, 'qwen');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackFrom, 'deepseek');
  assert.equal(providers.calls.length, 2);
  assert.equal(new Set(providers.calls.map((call) => `${call.provider}/${call.options.model}`)).size, 2);
});

test('records auditable invocation traces without secrets or full user text', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-v4-flash', ['chat'])
  });
  const traces = new InvocationTraceRepository({ storage: createMemoryStorage() });
  const router = new AIRouter({ providers: createProviders(), settings, traces });

  const result = await router.run({
    capability: CAPABILITIES.CHAT,
    input: '这是不应进入审计记录的完整敏感原文',
    metadata: {
      taskType: 'general',
      requestId: 'request-test-1',
      authorization: 'Bearer must-not-be-stored',
      cookie: 'session=must-not-be-stored'
    }
  });
  const [trace] = traces.listRecent(10);

  assert.equal(result.requestId, 'request-test-1');
  assert.equal(trace.requestId, 'request-test-1');
  assert.equal(trace.providerId, 'deepseek');
  assert.equal(trace.modelId, 'deepseek-v4-flash');
  assert.equal(trace.success, true);
  assert.equal(trace.tokenUsage.total_tokens, 7);
  assert.equal('input' in trace, false);
  assert.equal('apiKey' in trace, false);
  assert.doesNotMatch(JSON.stringify(trace), /secret-key|完整敏感原文|must-not-be-stored/);
});

test('returns stable error codes and trace when all eligible models fail', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'missing-model', ['chat']),
    qwen: providerConfig('qwen', 'qwen-plus', ['chat'])
  });
  const modelError = Object.assign(new Error('model not found'), { code: 'MODEL_NOT_FOUND' });
  const authError = Object.assign(new Error('unauthorized'), { code: 'INVALID_API_KEY' });
  const providers = createProviders({ deepseek: modelError, qwen: authError });
  const traces = new InvocationTraceRepository({ storage: createMemoryStorage() });
  const router = new AIRouter({ providers, settings, traces, maxAttempts: 2 });

  const result = await router.run({ capability: CAPABILITIES.CHAT, input: '测试失败' });

  assert.equal(result.error.code, 'AUTH_FAILED');
  assert.equal(providers.calls.length, 2);
  assert.equal(traces.listRecent(10).length, 2);
  assert.deepEqual(traces.listRecent(10).map((item) => item.errorCode).sort(), ['AUTH_FAILED', 'MODEL_NOT_FOUND']);
});

test('normalizes rate limit and timeout failures without unbounded retry', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-chat', ['chat'])
  });
  const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
  const timeout = Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });

  const rateProviders = createProviders({ deepseek: rateLimited });
  const rateResult = await new AIRouter({ providers: rateProviders, settings }).run({ capability: CAPABILITIES.CHAT, input: '测试限流' });
  assert.equal(rateResult.error.code, 'RATE_LIMITED');
  assert.equal(rateProviders.calls.length, 1);

  const timeoutProviders = createProviders({ deepseek: timeout });
  const timeoutResult = await new AIRouter({ providers: timeoutProviders, settings }).run({ capability: CAPABILITIES.CHAT, input: '测试超时' });
  assert.equal(timeoutResult.error.code, 'TIMEOUT');
  assert.equal(timeoutProviders.calls.length, 1);
});

test('user-cancelled streaming does not mark a healthy Provider as failed', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-chat', ['chat'])
  });
  const controller = new AbortController();
  const providers = {
    async streamChat(_request, options) {
      await options.onDelta('部分回复');
      controller.abort('user_stopped');
      throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
  };
  const router = new AIRouter({ providers, settings });

  const result = await router.stream(
    { capability: CAPABILITIES.CHAT, input: '停止生成' },
    { signal: controller.signal, onDelta: () => {} }
  );

  assert.equal(result.error.code, 'ABORTED');
  assert.deepEqual(settings.healthEvents, []);
});

test('returns a stable no-capable-model result when no provider is configured', async () => {
  const settings = createSettings({});
  const providers = createProviders();
  const traces = new InvocationTraceRepository({ storage: createMemoryStorage() });
  const result = await new AIRouter({ providers, settings, traces }).run({ capability: CAPABILITIES.CHAT, input: '无 Provider 也不能崩溃' });

  assert.equal(result.error.code, 'NO_CAPABLE_MODEL');
  assert.equal(providers.calls.length, 0);
  assert.deepEqual(traces.listRecent(10).map((trace) => ({
    routeReason: trace.routeReason,
    success: trace.success,
    errorCode: trace.errorCode
  })), [{ routeReason: 'no_eligible_model', success: false, errorCode: 'NO_CAPABLE_MODEL' }]);
  assert.doesNotMatch(JSON.stringify(traces.listRecent(10)), /无 Provider 也不能崩溃/);
});

test('never routes normal requests to configured but unverified providers', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-chat', ['chat'], { healthy: undefined, status: '未测试' }),
    qwen: providerConfig('qwen', 'qwen-plus', ['chat'], { healthy: false, status: '连接失败' })
  });
  const providers = createProviders();
  const result = await new AIRouter({ providers, settings }).run({ capability: CAPABILITIES.CHAT, input: '你好' });

  assert.equal(result.error.code, 'NO_CAPABLE_MODEL');
  assert.equal(providers.calls.length, 0);
});

test('response policy removes provider self-identification from normal user content', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-chat', ['chat'])
  });
  const providers = createProviders({ deepseek: { content: '作为 DeepSeek 模型，我建议先整理目标。' } });
  const router = new AIRouter({ providers, settings, traces: new InvocationTraceRepository({ storage: createMemoryStorage() }) });

  const result = await router.run({ capability: CAPABILITIES.CHAT, input: '给个建议' });

  assert.doesNotMatch(result.content, /DeepSeek|通义|Kimi|智谱/i);
  assert.match(result.content, /建议先整理目标/);
});

test('trusted program totals cannot be changed by model output', async () => {
  const settings = createSettings({
    deepseek: providerConfig('deepseek', 'deepseek-chat', ['chat'])
  });
  const providers = createProviders({ deepseek: { content: '今日支出合计为 999 元。' } });
  const router = new AIRouter({ providers, settings, traces: new InvocationTraceRepository({ storage: createMemoryStorage() }) });

  const result = await router.run({
    capability: CAPABILITIES.CHAT,
    input: '解释今天支出',
    metadata: { programResult: '今日支出合计为 100 元。来源：长期记忆 1 条。' }
  });

  assert.equal(result.content, '今日支出合计为 100 元。来源：长期记忆 1 条。');
});
