import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryStorage } from '../storage/memoryStorage.js';
import { AIRouter } from './AIRouter.js';
import { ModelRegistry } from './ModelRegistry.js';
import { allowingAccessControl } from './testing/allowingAccessControl.js';
import { CAPABILITIES } from './CapabilityMap.js';
import { InvocationTraceRepository } from './InvocationTraceRepository.js';
import {
  APPROVED_ROUTER_CANDIDATES,
  ROUTER_DOMAINS,
  resolveRouterPolicy
} from './RouterPolicy.js';
import {
  classifyRouterError,
  shouldFallback
} from './RouterErrorClassifier.js';

function config(id, model, overrides = {}) {
  return {
    id,
    enabled: true,
    apiKeyConfigured: true,
    defaultModel: model,
    model,
    modelOptions: [{ value: model }],
    modelCapabilities: { [model]: ['chat', 'reasoning', 'writing'] },
    healthy: true,
    status: '可用',
    priority: 1,
    ...overrides
  };
}

function settings(overrides = {}) {
  const snapshot = {
    providers: {
      deepseek: config('deepseek', 'deepseek-v4-flash'),
      qwen: config('qwen', 'qwen-max', { priority: 2 }),
      kimi: config('kimi', 'moonshot-v1-8k', { priority: 3 }),
      zhipu: config('zhipu', 'glm-4.5', { priority: 4 }),
      doubao: config('doubao', 'doubao-pro-32k', { priority: 5 }),
      ...(overrides.providers || {})
    },
    router: { routes: {} }
  };
  return {
    healthEvents: [],
    load: () => snapshot,
    recordProviderHealth(providerId, outcome) {
      this.healthEvents.push({ providerId, outcome });
    }
  };
}

function providers(behaviors = {}, capabilityOverrides = {}) {
  const calls = [];
  async function invoke(request) {
    calls.push(structuredClone(request));
    const behavior = behaviors[request.provider];
    if (typeof behavior === 'function') return behavior(request, calls.length);
    if (behavior instanceof Error) throw behavior;
    return {
      provider: request.provider,
      model: request.options?.model,
      content: behavior?.content || `ok:${request.provider}`,
      usage: { input_tokens: 5, output_tokens: 3 }
    };
  }
  return {
    calls,
    getCapabilities(providerId) {
      return capabilityOverrides[providerId] || {
        supportsChat: true,
        supportsStreaming: true,
        supportsVoiceStreaming: true,
        supportsSingleShotSseBridge: false
      };
    },
    chat: invoke,
    generate: invoke,
    streamChat: async (request, options = {}) => {
      const result = await invoke(request);
      await options.onDelta?.(result.content);
      return result;
    }
  };
}

function routerFixture(behaviors = {}, settingsOverride = {}, capabilityOverrides = {}) {
  const providerAdapter = providers(behaviors, capabilityOverrides);
  const traces = new InvocationTraceRepository({ storage: createMemoryStorage() });
  const router = new AIRouter({
    accessControl: allowingAccessControl,
    providers: providerAdapter,
    registry: new ModelRegistry({ providers: providerAdapter }),
    settings: settings(settingsOverride),
    traces,
    maxAttempts: 2
  });
  return { router, providerAdapter, traces };
}

function task(domain, overrides = {}) {
  return {
    capability: CAPABILITIES.CHAT,
    input: 'synthetic input must not enter traces',
    metadata: {
      routeDomain: domain,
      requestId: overrides.requestId || 'req-fixed',
      clientRequestId: 'client-fixed',
      ...overrides.metadata
    }
  };
}

function fault(code, status = 0) {
  return Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
}

test('fixed policy contains only DeepSeek primary and Qwen backup', () => {
  assert.deepEqual(APPROVED_ROUTER_CANDIDATES, [
    { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    { providerId: 'qwen', modelId: 'qwen-max' }
  ]);
  assert.equal(resolveRouterPolicy(ROUTER_DOMAINS.ORDINARY_CHAT).allowFallback, true);
  assert.equal(resolveRouterPolicy(ROUTER_DOMAINS.FINANCE).allowFallback, true);
  assert.equal(resolveRouterPolicy(ROUTER_DOMAINS.MEMORY).allowFallback, false);
  assert.equal(resolveRouterPolicy(ROUTER_DOMAINS.CALENDAR).allowFallback, false);
});

test('error classifier permits only approved pre-write infrastructure failures', () => {
  for (const error of [
    fault('TIMEOUT'),
    fault('NETWORK_ERROR'),
    fault('HTTP_429', 429),
    fault('HTTP_502', 502),
    fault('HTTP_503', 503),
    fault('HTTP_504', 504),
    fault('PROVIDER_UNAVAILABLE'),
    fault('CREDENTIAL_RESOLVER_UNAVAILABLE')
  ]) {
    assert.equal(classifyRouterError(error).fallbackEligible, true, error.code);
    assert.equal(shouldFallback({ error, policy: resolveRouterPolicy('ordinary_chat'), businessExecutionStarted: false }), true);
  }
  for (const error of [
    fault('INVALID_USER_INPUT', 400),
    fault('TRUE_AMBIGUITY'),
    fault('RAW_SCHEMA_INVALID'),
    fault('CANONICAL_CONTRACT_REJECTED'),
    fault('MEMORY_EVIDENCE_NOT_FOUND'),
    fault('DATABASE_WRITE_FAILED'),
    fault('AUTH_FAILED', 401)
  ]) {
    assert.equal(classifyRouterError(error).fallbackEligible, false, error.code);
  }
  assert.equal(shouldFallback({
    error: fault('TIMEOUT'),
    policy: resolveRouterPolicy('ordinary_chat'),
    businessExecutionStarted: true
  }), false);
});

test('DeepSeek success makes zero Qwen calls and preserves fixed model IDs', async () => {
  const { router, providerAdapter } = routerFixture();
  const result = await router.run(task('ordinary_chat'));

  assert.equal(result.error, null);
  assert.equal(result.selectedProvider, 'deepseek');
  assert.equal(result.selectedModel, 'deepseek-v4-flash');
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek']);
  assert.equal(providerAdapter.calls.some((call) => call.provider === 'qwen'), false);
});

for (const [name, error] of [
  ['timeout', fault('TIMEOUT')],
  ['502', fault('HTTP_502', 502)],
  ['503', fault('HTTP_503', 503)],
  ['504', fault('HTTP_504', 504)],
  ['rate limit', fault('RATE_LIMITED', 429)]
]) {
  test(`ordinary chat falls back once on DeepSeek ${name}`, async () => {
    const { router, providerAdapter } = routerFixture({ deepseek: error, qwen: { content: 'qwen ok' } });
    const result = await router.run(task('ordinary_chat'));

    assert.equal(result.error, null);
    assert.equal(result.selectedProvider, 'qwen');
    assert.equal(result.selectedModel, 'qwen-max');
    assert.equal(result.fallbackUsed, true);
    assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek', 'qwen']);
  });
}

test('HTTP success with invalid Raw Plan never invokes Qwen', async () => {
  const { router, providerAdapter } = routerFixture({ deepseek: { content: '{"not":"canonical"}' } });
  const result = await router.run(task('semantic_planner'));

  assert.equal(result.error, null);
  assert.equal(result.content, '{"not":"canonical"}');
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek']);
});

test('same-DeepSeek schema repair is attempt 2 in the same logical execution and never invokes Qwen', async () => {
  const rawContent = '{"domain":"memory","intent":"add","action":"add"}';
  const repairedContent = '{"domain":"memory","intent":"add","action":"add","entity":{"type":null,"reference":null,"relation_to_owner":null},"predicate":null,"value":null,"qualifiers":{},"tool":null,"arguments":{},"required_evidence":[],"explicit_fields":[],"inherited_fields":[],"ambiguity_reasons":[]}';
  const { router, providerAdapter, traces } = routerFixture({
    deepseek(request, callNumber) {
      return { content: callNumber === 1 ? rawContent : repairedContent };
    },
    qwen: { content: 'must not run' }
  });
  const initial = await router.run(task('memory'));
  const route = {
    requestId: initial.requestId,
    executionId: initial.executionId,
    idempotencyKey: initial.idempotencyKey,
    selectedProvider: initial.selectedProvider,
    selectedModel: initial.selectedModel,
    routeTrace: initial.routeTrace
  };
  const repaired = await router.repairSchema({
    route,
    domain: 'memory',
    rawContent,
    schemaContract: 'assistant-provider-plan-candidate-v1',
    errors: ['plan.entity: required']
  });

  assert.equal(repaired.error, null);
  assert.equal(repaired.content, repairedContent);
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek', 'deepseek']);
  assert.equal(providerAdapter.calls.some((call) => call.provider === 'qwen'), false);
  assert.equal(repaired.requestId, initial.requestId);
  assert.equal(repaired.executionId, initial.executionId);
  assert.equal(repaired.idempotencyKey, initial.idempotencyKey);
  assert.deepEqual(repaired.routeTrace.map((entry) => entry.attemptNumber), [1, 2]);
  assert.deepEqual(repaired.routeTrace.map((entry) => entry.attemptType), ['planning', 'schema_repair']);
  assert.equal(new Set(repaired.routeTrace.map((entry) => entry.attemptId)).size, 2);
  const repairRequest = providerAdapter.calls[1];
  assert.equal(JSON.stringify(repairRequest).includes('synthetic input must not enter traces'), false);
  assert.equal(JSON.parse(repairRequest.messages[1].content).raw_result, rawContent);
  assert.equal(traces.listRecent(2)[0].attemptType, 'schema_repair');
});

test('schema repair is rejected after an existing second attempt or business execution', async () => {
  const { router, providerAdapter } = routerFixture();
  const initial = await router.run(task('finance'));
  const route = {
    requestId: initial.requestId,
    executionId: initial.executionId,
    idempotencyKey: initial.idempotencyKey,
    selectedProvider: initial.selectedProvider,
    selectedModel: initial.selectedModel,
    routeTrace: initial.routeTrace
  };
  const afterWrite = await router.repairSchema({
    route,
    domain: 'finance',
    rawContent: '{"domain":"finance"}',
    schemaContract: 'assistant-provider-plan-candidate-v1',
    businessExecutionStarted: true,
    businessWriteStarted: true
  });
  assert.equal(afterWrite.error.code, 'SCHEMA_REPAIR_FORBIDDEN');
  assert.equal(providerAdapter.calls.length, 1);

  const capped = await router.repairSchema({
    route: {
      ...route,
      routeTrace: [...route.routeTrace, {
        ...route.routeTrace[0],
        attemptId: 'attempt-existing-second',
        attemptNumber: 2
      }]
    },
    domain: 'finance',
    rawContent: '{"domain":"finance"}',
    schemaContract: 'assistant-provider-plan-candidate-v1'
  });
  assert.equal(capped.error.code, 'SCHEMA_REPAIR_ATTEMPT_LIMIT');
  assert.equal(providerAdapter.calls.length, 1);
});

test('true ambiguity response never invokes Qwen', async () => {
  const content = JSON.stringify({ domain: 'ambiguous', intent: 'ambiguous' });
  const { router, providerAdapter } = routerFixture({ deepseek: { content } });
  const result = await router.run(task('semantic_planner'));

  assert.equal(result.content, content);
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek']);
});

test('Finance pre-write Provider failure falls back once and one idempotency key writes once', async () => {
  const { router, providerAdapter } = routerFixture({ deepseek: fault('TIMEOUT'), qwen: { content: '{"domain":"finance"}' } });
  const result = await router.run(task('finance'));
  const writes = new Set();
  writes.add(result.idempotencyKey);
  writes.add(result.idempotencyKey);

  assert.equal(result.error, null);
  assert.equal(result.selectedProvider, 'qwen');
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek', 'qwen']);
  assert.equal(writes.size, 1);
});

test('Finance after execution starts never falls back and never duplicates writes', async () => {
  const { router, providerAdapter } = routerFixture({ deepseek: fault('DATABASE_WRITE_FAILED'), qwen: { content: 'must not run' } });
  const result = await router.run(task('finance', {
    metadata: { businessExecutionStarted: true, businessWriteStarted: true }
  }));

  assert.equal(result.error.code, 'DATABASE_WRITE_FAILED');
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek']);
  assert.equal(result.routeTrace.at(-1).businessWriteStarted, true);
});

for (const domain of ['memory', 'calendar']) {
  test(`${domain} Provider failure never crosses models`, async () => {
    const { router, providerAdapter } = routerFixture({ deepseek: fault('TIMEOUT'), qwen: { content: 'must not run' } });
    const result = await router.run(task(domain));

    assert.equal(result.error.code, 'TIMEOUT');
    assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek']);
  });
}

test('dual Provider failure returns the second explicit error and stops at two attempts', async () => {
  const { router, providerAdapter } = routerFixture({
    deepseek: fault('TIMEOUT'),
    qwen: fault('HTTP_503', 503)
  });
  const result = await router.run(task('ordinary_chat'));

  assert.equal(result.error.code, 'HTTP_503');
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek', 'qwen']);
  assert.equal(result.routeTrace.length, 2);
});

test('disabled Qwen and all non-approved Providers never enter candidates', async () => {
  const { router, providerAdapter } = routerFixture(
    { deepseek: fault('TIMEOUT'), qwen: { content: 'must not run' }, kimi: { content: 'must not run' } },
    { providers: { qwen: config('qwen', 'qwen-max', { enabled: false }) } }
  );
  const result = await router.run(task('ordinary_chat'));

  assert.equal(result.error.code, 'TIMEOUT');
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek']);
  assert.equal(providerAdapter.calls.some((call) => ['kimi', 'zhipu', 'doubao'].includes(call.provider)), false);
});

test('request/execution/attempt identity is stable and traces contain no sensitive content', async () => {
  const { router, traces } = routerFixture({ deepseek: fault('TIMEOUT'), qwen: { content: 'ok' } });
  const result = await router.run(task('ordinary_chat', {
    requestId: 'req-identity',
    metadata: {
      authorization: 'Bearer secret-token',
      cookie: 'session=private',
      password: 'password-private',
      apiKey: 'sk-private'
    }
  }));

  assert.equal(result.requestId, 'req-identity');
  assert.match(result.executionId, /^exec_/);
  assert.equal(result.routeTrace.length, 2);
  assert.equal(new Set(result.routeTrace.map((entry) => entry.requestId)).size, 1);
  assert.equal(new Set(result.routeTrace.map((entry) => entry.executionId)).size, 1);
  assert.equal(new Set(result.routeTrace.map((entry) => entry.attemptId)).size, 2);
  assert.deepEqual(result.routeTrace.map((entry) => entry.attemptNumber), [1, 2]);
  assert.deepEqual(result.routeTrace.map((entry) => entry.attemptType), ['planning', 'fallback']);
  const serialized = JSON.stringify({ routeTrace: result.routeTrace, stored: traces.listRecent(10) });
  assert.doesNotMatch(serialized, /synthetic input|secret-token|session=private|password-private|sk-private/);
});

test('client retry keeps one write idempotency key while receiving a new execution identity', async () => {
  const first = await routerFixture().router.run(task('finance', {
    requestId: 'req-first',
    metadata: { clientRequestId: 'stable-client-request', ownerId: 'owner-a' }
  }));
  const second = await routerFixture().router.run(task('finance', {
    requestId: 'req-retry',
    metadata: { clientRequestId: 'stable-client-request', ownerId: 'owner-a' }
  }));

  assert.notEqual(first.executionId, second.executionId);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
});

test('business execution outcome updates the secret-safe route trace without another Provider call', async () => {
  const { router, providerAdapter, traces } = routerFixture();
  const result = await router.run(task('finance'));
  const beforeCalls = providerAdapter.calls.length;

  const changed = router.markBusinessExecution({
    requestId: result.requestId,
    executionId: result.executionId,
    selectedProvider: result.selectedProvider
  }, {
    businessExecutionStarted: true,
    businessWriteOccurred: true
  });

  assert.equal(changed, 1);
  assert.equal(providerAdapter.calls.length, beforeCalls);
  const [trace] = traces.listRecent(1);
  assert.equal(trace.finalProvider, 'deepseek');
  assert.equal(trace.businessWriteStarted, true);
  assert.equal(trace.businessWriteOccurred, true);
});

test('ordinary-chat streaming falls back once before any delta and never after a partial delta', async () => {
  const fallback = routerFixture({ deepseek: fault('TIMEOUT'), qwen: { content: 'qwen stream' } });
  const deltas = [];
  const result = await fallback.router.stream(task('ordinary_chat'), {
    onDelta(delta) { deltas.push(delta); }
  });
  assert.equal(result.selectedProvider, 'qwen');
  assert.deepEqual(fallback.providerAdapter.calls.map((call) => call.provider), ['deepseek', 'qwen']);
  assert.deepEqual(deltas, ['qwen stream']);

  const calls = [];
  const partialProviders = {
    async streamChat(request, options) {
      calls.push(request.provider);
      if (request.provider === 'deepseek') {
        await options.onDelta('partial');
        throw fault('TIMEOUT');
      }
      return { content: 'must not run' };
    }
  };
  const partialRouter = new AIRouter({
    accessControl: allowingAccessControl,
    providers: partialProviders,
    settings: settings(),
    traces: new InvocationTraceRepository({ storage: createMemoryStorage() })
  });
  const partial = await partialRouter.stream(task('ordinary_chat'), { onDelta() {} });
  assert.equal(partial.error.code, 'TIMEOUT');
  assert.deepEqual(calls, ['deepseek']);
});

test('voice streaming does not fall back to a single-shot bridge before any delta', async () => {
  const voice = routerFixture(
    { deepseek: fault('TIMEOUT'), qwen: { content: 'qwen stream' } },
    {},
    {
      qwen: {
        supportsChat: true,
        supportsStreaming: false,
        supportsVoiceStreaming: false,
        supportsSingleShotSseBridge: true
      }
    }
  );
  const deltas = [];
  const result = await voice.router.stream(task('ordinary_chat', {
    metadata: { voiceRealtimeOnly: true }
  }), {
    onDelta(delta) { deltas.push(delta); }
  });

  assert.equal(result.selectedProvider, 'deepseek');
  assert.deepEqual(voice.providerAdapter.calls.map((call) => call.provider), ['deepseek']);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.deepEqual(deltas, []);
});

test('authentication and other forbidden 4xx failures never invoke Qwen', async () => {
  const { router, providerAdapter } = routerFixture({
    deepseek: fault('AUTH_FAILED', 401),
    qwen: { content: 'must not run' }
  });
  const result = await router.run(task('ordinary_chat'));
  assert.equal(result.error.code, 'AUTH_FAILED');
  assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek']);
});

test('missing primary runtime uses Qwen only for fallback-enabled domains and keeps fallback identity', async () => {
  const disabledDeepSeek = { providers: {
    deepseek: config('deepseek', 'deepseek-v4-flash', { enabled: false })
  } };
  const chat = routerFixture({ qwen: { content: 'qwen only' } }, disabledDeepSeek);
  const chatResult = await chat.router.run(task('ordinary_chat'));
  assert.equal(chatResult.selectedProvider, 'qwen');
  assert.equal(chatResult.fallbackUsed, true);
  assert.equal(chatResult.fallbackFrom, 'deepseek');
  assert.equal(chatResult.routeTrace[0].fallbackReason, 'PRIMARY_RUNTIME_UNAVAILABLE');
  assert.deepEqual(chat.providerAdapter.calls.map((call) => call.provider), ['qwen']);

  const memory = routerFixture({ qwen: { content: 'must not run' } }, disabledDeepSeek);
  const memoryResult = await memory.router.run(task('memory'));
  assert.equal(memoryResult.error.code, 'NO_USABLE_RUNTIME_CONNECTION');
  assert.deepEqual(memory.providerAdapter.calls, []);
});
