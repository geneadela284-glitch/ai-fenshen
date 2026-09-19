import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderManager } from '../../core/providers/providerManager.js';
import { AIRouter } from '../../core/router/AIRouter.js';
import { allowingAccessControl } from '../../core/router/testing/allowingAccessControl.js';
import { CoreAiService } from '../coreAiService.js';

function noOpProviderMethods() {
  return {
    async generate() { return { content: '' }; },
    async chat() { return { content: '' }; },
    async image() { return { content: '' }; },
    async embedding() { return { content: '' }; }
  };
}

test('CoreAiService streams through AIRouter and ProviderManager with server-forced Memory disabled', async () => {
  const received = [];
  const provider = {
    id: 'mock-stream', name: 'Mock Stream', type: 'test', status: 'ready',
    ...noOpProviderMethods(),
    supportsStreaming: true,
    async streamChat(request, options) {
      received.push({ request, options });
      for (const delta of ['你好，', '我是你的', 'AI分身。']) options.onDelta(delta);
      return { content: '你好，我是你的AI分身。', usage: null };
    }
  };
  const providers = new ProviderManager({ providers: [provider], defaultProvider: provider.id });
  const settings = { load: () => ({ providers: { [provider.id]: { apiKey: 'configured' } } }), recordProviderHealth() {} };
  const registry = {
    listCandidates: () => [{ providerId: provider.id, modelId: 'mock-model', preferred: true, healthRank: 0, priority: 1 }],
    getRoutePolicy: () => ({ providerId: provider.id, model: 'mock-model' })
  };
  const router = new AIRouter({
    accessControl: allowingAccessControl,
    providers, settings, registry,
    classifier: { classify: () => 'CHAT' },
    prompts: { build: (task) => ({ ...task, messages: [{ role: 'user', content: task.input }] }) },
    traces: { record() {} }, responsePolicy: { applyContent: (value) => value }
  });
  const service = new CoreAiService({ settings, providers, registry, router });
  const deltas = [];
  const result = await service.stream({ input: '你好', metadata: { memoryPolicy: 'enabled', mockOnly: true } }, {
    onDelta: (delta) => deltas.push(delta)
  });
  assert.equal(result.ok, true);
  assert.deepEqual(deltas, ['你好，', '我是你的', 'AI分身。']);
  assert.equal(received.length, 1);
  assert.equal(received[0].request.metadata.memoryPolicy, 'disabled');
  assert.equal('mockOnly' in received[0].request.metadata, false);
});

test('ordinary voice response budget reaches the Provider request', async () => {
  let received;
  const provider = {
    id: 'mock-voice-budget', name: 'Mock Voice Budget', type: 'test', status: 'ready',
    ...noOpProviderMethods(),
    supportsStreaming: true,
    async streamChat(request, options) {
      received = request;
      await options.onDelta('可以。');
      return { content: '可以。', usage: null };
    }
  };
  const providers = new ProviderManager({ providers: [provider], defaultProvider: provider.id });
  const settings = { load: () => ({ providers: { [provider.id]: { apiKey: 'configured' } } }), recordProviderHealth() {} };
  const registry = {
    listCandidates: () => [{ providerId: provider.id, modelId: 'mock-model', preferred: true, healthRank: 0, priority: 1 }],
    getRoutePolicy: () => ({ providerId: provider.id, model: 'mock-model' })
  };
  const router = new AIRouter({
    accessControl: allowingAccessControl,
    providers, settings, registry,
    classifier: { classify: () => 'CHAT' },
    prompts: { build: (task) => ({ ...task, messages: [{ role: 'user', content: task.input }] }) },
    traces: { record() {} }, responsePolicy: { applyContent: (value) => value }
  });
  const service = new CoreAiService({ settings, providers, registry, router });
  const result = await service.stream({
    input: '给我一个简单建议',
    options: { maxTokens: 256 },
    metadata: { voiceOrdinaryChat: true }
  }, { onDelta() {} });
  assert.equal(result.ok, true);
  assert.equal(received.options.maxTokens, 256);
  assert.equal(received.metadata.voiceOrdinaryChat, undefined);

  await service.stream({
    input: '普通文字请求',
    options: { maxTokens: 512 },
    metadata: {}
  }, { onDelta() {} });
  assert.equal(received.options.maxTokens, undefined);
});

test('ProviderManager reports streaming capability and rejects unsupported providers', async () => {
  const unsupported = { id: 'plain', name: 'Plain', type: 'test', status: 'ready', ...noOpProviderMethods() };
  const manager = new ProviderManager({ providers: [unsupported], defaultProvider: unsupported.id });
  assert.equal(manager.supportsStreaming('plain'), false);
  await assert.rejects(manager.streamChat({ provider: 'plain' }, {}), (error) => error.code === 'STREAMING_NOT_SUPPORTED');
});

test('AIRouter never falls back after a provider has emitted a partial stream', async () => {
  let fallbackCalls = 0;
  const primary = {
    id: 'primary', name: 'Primary', type: 'test', status: 'ready', ...noOpProviderMethods(), supportsStreaming: true,
    async streamChat(_request, { onDelta }) {
      await onDelta('部分');
      throw Object.assign(new Error('interrupted'), { code: 'NETWORK_ERROR' });
    }
  };
  const fallback = {
    id: 'fallback', name: 'Fallback', type: 'test', status: 'ready', ...noOpProviderMethods(), supportsStreaming: true,
    async streamChat() { fallbackCalls += 1; return { content: '不应调用' }; }
  };
  const providers = new ProviderManager({ providers: [primary, fallback], defaultProvider: primary.id });
  const settings = { load: () => ({ providers: {} }), recordProviderHealth() {} };
  const router = new AIRouter({
    accessControl: allowingAccessControl,
    providers, settings,
    registry: {
      listCandidates: () => [
        { providerId: primary.id, modelId: 'primary-model', preferred: true },
        { providerId: fallback.id, modelId: 'fallback-model', preferred: false }
      ],
      getRoutePolicy: () => ({ providerId: primary.id, model: 'primary-model' })
    },
    classifier: { classify: () => 'CHAT' }, prompts: { build: (task) => task },
    traces: { record() {} }, responsePolicy: { applyContent: (value) => value }
  });
  const deltas = [];
  const result = await router.stream({ input: '测试' }, { onDelta: (delta) => deltas.push(delta) });
  assert.deepEqual(deltas, ['部分']);
  assert.equal(fallbackCalls, 0);
  assert.equal(result.error.code, 'NETWORK_ERROR');
});
