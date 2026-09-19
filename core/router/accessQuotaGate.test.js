import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccessControlService } from '../../server/access/accessControlService.js';
import { AccessControlStore } from '../../server/access/accessControlStore.js';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { AIRouter } from './AIRouter.js';
import { CAPABILITIES } from './CapabilityMap.js';
import { InvocationTraceRepository } from './InvocationTraceRepository.js';

function config(id, model, priority) {
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
    priority
  };
}

function settings() {
  const snapshot = {
    providers: {
      deepseek: config('deepseek', 'deepseek-v4-flash', 1),
      qwen: config('qwen', 'qwen-max', 2)
    },
    router: { routes: {} }
  };
  return {
    load: () => snapshot,
    recordProviderHealth() {}
  };
}

function fakeProviders(behaviors = {}) {
  const calls = [];
  async function invoke(request) {
    calls.push(structuredClone(request));
    const behavior = behaviors[request.provider];
    if (behavior instanceof Error) throw behavior;
    if (typeof behavior === 'function') return behavior(request, calls.length);
    return {
      provider: request.provider,
      model: request.options?.model,
      content: behavior?.content || `ok:${request.provider}`,
      usage: { input_tokens: 5, output_tokens: 3 }
    };
  }
  return {
    calls,
    generate: invoke,
    chat: invoke,
    async streamChat(request, options = {}) {
      const result = await invoke(request);
      await options.onDelta?.(result.content);
      return result;
    }
  };
}

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-router-access-'));
  const store = new AccessControlStore({
    dbPath: path.join(directory, 'access-control.sqlite'),
    clock: () => new Date('2026-07-28T08:00:00.000Z')
  }).initialize();
  const accessControl = new AccessControlService({
    store,
    hmacSecret: 'router-access-test-secret-32-bytes',
    clock: () => new Date('2026-07-28T08:00:00.000Z')
  });
  store.putCustomProfile({
    id: 'router_test_v1',
    requestsPerMinute: 30,
    maxConcurrentRequests: 10,
    providerCallsPerDay: 20,
    inputTokensPerDay: 100000,
    outputTokensPerDay: 100000,
    dailyCostMicros: 100000000,
    monthlyCostMicros: 1000000000,
    lifetimeCostMicros: 10000000000,
    enabled: true
  });
  return {
    directory,
    store,
    accessControl,
    subject(accountId, profileId = 'router_test_v1') {
      accessControl.bindAccountProfile({ accountId, profileId, enabled: true });
      return accessControl.createAuthenticatedSubject({ accountId, role: 'beta_user' });
    },
    invocation(subject, requestId) {
      return {
        subject,
        requestLease: accessControl.beginRequest({ subject, requestId })
      };
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function router(accessControl, providerAdapter) {
  return new AIRouter({
    accessControl,
    providers: providerAdapter,
    settings: settings(),
    traces: new InvocationTraceRepository({ storage: createMemoryStorage() }),
    maxAttempts: 2
  });
}

function policyTask(requestId, domain = 'ordinary_chat', overrides = {}) {
  return {
    capability: CAPABILITIES.CHAT,
    input: 'quota gate input',
    metadata: {
      routeDomain: domain,
      requestId,
      executionId: `exec-${requestId}`,
      clientRequestId: `client-${requestId}`,
      ...overrides
    }
  };
}

function timeout() {
  return Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
}

test('an exhausted account makes zero Provider calls while another account remains usable', async () => {
  const h = harness();
  try {
    h.store.putCustomProfile({
      id: 'one_call_v1',
      requestsPerMinute: 10,
      maxConcurrentRequests: 3,
      providerCallsPerDay: 1,
      inputTokensPerDay: 10000,
      outputTokensPerDay: 10000,
      dailyCostMicros: 1000000,
      monthlyCostMicros: 5000000,
      lifetimeCostMicros: 10000000,
      enabled: true
    });
    const subjectA = h.subject('account-a', 'one_call_v1');
    const seed = h.invocation(subjectA, 'req-seed');
    const reservation = h.accessControl.reserveProviderAttempt({
      ...seed,
      attempt: {
        requestId: 'req-seed',
        executionId: 'exec-seed',
        attemptType: 'planning',
        attemptNumber: 1,
        providerId: 'deepseek',
        modelId: 'deepseek-v4-flash'
      },
      request: { input: 'seed', options: { maxTokens: 1 } }
    });
    h.accessControl.settleProviderAttempt({
      reservation,
      usage: { inputTokens: 1, outputTokens: 1 },
      outcome: 'success'
    });
    h.accessControl.releaseRequest(seed.requestLease);

    const providersA = fakeProviders();
    const resultA = await router(h.accessControl, providersA).run(
      policyTask('req-a'),
      h.invocation(subjectA, 'req-a')
    );
    assert.equal(resultA.error.code, 'ACCOUNT_USAGE_LIMIT_REACHED');
    assert.equal(providersA.calls.length, 0);

    const subjectB = h.subject('account-b');
    const providersB = fakeProviders();
    const resultB = await router(h.accessControl, providersB).run(
      policyTask('req-b'),
      h.invocation(subjectB, 'req-b')
    );
    assert.equal(resultB.error, null);
    assert.equal(providersB.calls.length, 1);
  } finally {
    h.close();
  }
});

test('main, fallback, schema repair, policy stream, and capability stream all use the quota gate', async () => {
  const h = harness();
  try {
    const subject = h.subject('account-a');
    const providerAdapter = fakeProviders({
      deepseek: timeout(),
      qwen: { content: 'fallback ok' }
    });
    const subjectRouter = router(h.accessControl, providerAdapter);
    const fallbackInvocation = h.invocation(subject, 'req-fallback');
    const fallback = await subjectRouter.run(
      policyTask('req-fallback'),
      fallbackInvocation
    );
    assert.equal(fallback.error, null);
    assert.deepEqual(providerAdapter.calls.map((call) => call.provider), ['deepseek', 'qwen']);
    h.accessControl.releaseRequest(fallbackInvocation.requestLease);

    const schemaProviders = fakeProviders({
      deepseek(request, callNumber) {
        return {
          content: callNumber === 1
            ? '{"domain":"memory","intent":"add","action":"add"}'
            : '{"domain":"memory","intent":"add","action":"add","entity":{"type":null,"reference":null,"relation_to_owner":null},"predicate":null,"value":null,"qualifiers":{},"tool":null,"arguments":{},"required_evidence":[],"explicit_fields":[],"inherited_fields":[],"ambiguity_reasons":[]}',
          usage: { input_tokens: 5, output_tokens: 3 }
        };
      }
    });
    const schemaRouter = router(h.accessControl, schemaProviders);
    const schemaInvocation = h.invocation(subject, 'req-schema');
    const initial = await schemaRouter.run(
      policyTask('req-schema', 'memory'),
      schemaInvocation
    );
    const repaired = await schemaRouter.repairSchema({
      route: {
        requestId: initial.requestId,
        executionId: initial.executionId,
        idempotencyKey: initial.idempotencyKey,
        selectedProvider: initial.selectedProvider,
        selectedModel: initial.selectedModel,
        routeTrace: initial.routeTrace
      },
      domain: 'memory',
      rawContent: initial.content,
      schemaContract: 'assistant-provider-plan-candidate-v1',
      errors: ['plan.entity: required']
    }, schemaInvocation);
    assert.equal(repaired.error, null);
    assert.equal(schemaProviders.calls.length, 2);
    h.accessControl.releaseRequest(schemaInvocation.requestLease);

    const policyStreamProviders = fakeProviders();
    const policyStreamRouter = router(h.accessControl, policyStreamProviders);
    const policyStreamInvocation = h.invocation(subject, 'req-policy-stream');
    const policyStream = await policyStreamRouter.stream(
      policyTask('req-policy-stream'),
      { onDelta() {} },
      policyStreamInvocation
    );
    assert.equal(policyStream.error, null);
    assert.equal(policyStreamProviders.calls.length, 1);
    h.accessControl.releaseRequest(policyStreamInvocation.requestLease);

    const capabilityStreamProviders = fakeProviders();
    const capabilityStreamRouter = router(h.accessControl, capabilityStreamProviders);
    const capabilityInvocation = h.invocation(subject, 'req-capability-stream');
    const capabilityStream = await capabilityStreamRouter.stream({
      capability: CAPABILITIES.CHAT,
      input: 'capability stream',
      metadata: {
        requestId: 'req-capability-stream',
        executionId: 'exec-req-capability-stream'
      }
    }, { onDelta() {} }, capabilityInvocation);
    assert.equal(capabilityStream.error, null);
    assert.equal(capabilityStreamProviders.calls.length, 1);

    const daily = h.store.getUsageBucket({
      accountId: 'account-a',
      bucketType: 'day',
      bucketKey: '2026-07-28'
    });
    assert.equal(daily.providerCalls, 6);
    assert.equal(daily.outputTokens, 4111);
  } finally {
    h.close();
  }
});

test('replaying one attempt identity or losing the security store never calls Provider twice', async () => {
  const h = harness();
  try {
    const subject = h.subject('account-a');
    const providerAdapter = fakeProviders();
    const subjectRouter = router(h.accessControl, providerAdapter);
    const invocation = h.invocation(subject, 'req-duplicate');
    const task = policyTask('req-duplicate');
    const first = await subjectRouter.run(task, invocation);
    assert.equal(first.error, null);
    const duplicate = await subjectRouter.run(task, invocation);
    assert.equal(duplicate.error.code, 'DUPLICATE_PROVIDER_ATTEMPT');
    assert.equal(providerAdapter.calls.length, 1);

    const failedSubject = h.subject('account-b');
    const failedInvocation = h.invocation(failedSubject, 'req-store-failure');
    h.store.close();
    const providersAfterFailure = fakeProviders();
    const failed = await router(h.accessControl, providersAfterFailure).run(
      policyTask('req-store-failure'),
      failedInvocation
    );
    assert.equal(failed.error.code, 'ACCESS_CONTROL_UNAVAILABLE');
    assert.equal(providersAfterFailure.calls.length, 0);
  } finally {
    h.close();
  }
});
