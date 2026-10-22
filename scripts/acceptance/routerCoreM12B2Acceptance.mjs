import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AIRouter } from '../../core/router/AIRouter.js';
import { allowingAccessControl } from '../../core/router/testing/allowingAccessControl.js';
import { CAPABILITIES } from '../../core/router/CapabilityMap.js';
import { InvocationTraceRepository } from '../../core/router/InvocationTraceRepository.js';
import { createMemoryStorage } from '../../core/storage/memoryStorage.js';
import { createAssistantSemanticPlanner } from '../../server/agent/assistantSemanticPlanner.js';
import { createFinanceRuntime } from '../../server/finance/runtime.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

function providerConfig(id, model, overrides = {}) {
  return {
    id,
    enabled: true,
    apiKeyConfigured: true,
    defaultModel: model,
    model,
    modelOptions: [{ value: model }],
    healthy: true,
    status: '可用',
    priority: id === 'deepseek' ? 1 : 2,
    ...overrides
  };
}

function createSettings() {
  const snapshot = {
    providers: {
      deepseek: providerConfig('deepseek', 'deepseek-v4-flash'),
      qwen: providerConfig('qwen', 'qwen-max'),
      kimi: providerConfig('kimi', 'moonshot-v1-8k'),
      zhipu: providerConfig('zhipu', 'glm-4.5'),
      doubao: providerConfig('doubao', 'doubao-seed-2-0-lite-260215')
    },
    router: { routes: {} }
  };
  return {
    load: () => snapshot,
    recordProviderHealth() {}
  };
}

function fault(code, status = 0) {
  return Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
}

function createFaultRouter(behaviors = {}) {
  const calls = [];
  const invoke = async (request) => {
    calls.push({ provider: request.provider, model: request.options?.model });
    const behavior = behaviors[request.provider];
    if (typeof behavior === 'function') {
      return behavior(request, calls.filter(({ provider }) => provider === request.provider).length);
    }
    if (behavior instanceof Error) throw behavior;
    return {
      provider: request.provider,
      model: request.options?.model,
      content: behavior?.content || 'ok',
      usage: { input_tokens: 5, output_tokens: 3 }
    };
  };
  const providers = {
    generate: invoke,
    chat: invoke,
    async streamChat(request, options = {}) {
      const result = await invoke(request);
      await options.onDelta?.(result.content);
      return result;
    }
  };
  return {
    calls,
    traces: new InvocationTraceRepository({ storage: createMemoryStorage() }),
    router: new AIRouter({
      accessControl: allowingAccessControl,
      providers,
      settings: createSettings(),
      traces: new InvocationTraceRepository({ storage: createMemoryStorage() })
    })
  };
}

function routeSummary(result) {
  return {
    requestId: result.requestId,
    executionId: result.executionId,
    idempotencyKey: result.idempotencyKey,
    selectedProvider: result.selectedProvider,
    selectedModel: result.selectedModel,
    routeTrace: result.routeTrace
  };
}

function plannerAiService(router) {
  return {
    async run(request) {
      const result = await router.run({
        ...request,
        method: 'generate'
      });
      return {
        ok: !result.error,
        content: result.content,
        route: routeSummary(result)
      };
    },
    async repairSchema(request) {
      const result = await router.repairSchema(request);
      return {
        ok: !result.error,
        content: result.content,
        route: routeSummary(result)
      };
    }
  };
}

function memoryPlan(overrides = {}) {
  return {
    domain: 'memory',
    intent: 'state_fact',
    action: 'add',
    entity: { type: 'person', reference: '女儿', relation_to_owner: 'daughter' },
    relation_to_owner: 'daughter',
    predicate: 'birth_date',
    value: { year: 2012, month: 6, day: 8 },
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: ['entity.relation_to_owner', 'predicate', 'value.year', 'value.month', 'value.day'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.98,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null,
    ...overrides
  };
}

function task(domain, metadata = {}) {
  return {
    capability: CAPABILITIES.CHAT,
    input: 'synthetic acceptance input',
    metadata: {
      routeDomain: domain,
      requestId: `req-${domain}-${metadata.caseId || 'case'}`,
      clientRequestId: `client-${domain}-${metadata.caseId || 'case'}`,
      ownerId: 'isolated-owner',
      ...metadata
    }
  };
}

const cases = [];
async function verify(id, run) {
  try {
    const evidence = await run();
    cases.push({ id, pass: true, evidence });
  } catch (error) {
    cases.push({ id, pass: false, code: error?.code || 'ASSERTION_FAILED', message: String(error?.message || '') });
  }
}

await verify('deepseek_success_no_qwen', async () => {
  const fixture = createFaultRouter();
  const result = await fixture.router.run(task('ordinary_chat', { caseId: 'success' }));
  assert.equal(result.selectedProvider, 'deepseek');
  assert.deepEqual(fixture.calls.map(({ provider }) => provider), ['deepseek']);
  return { providers: fixture.calls.map(({ provider }) => provider), attempts: result.routeTrace.length };
});

for (const [id, error] of [
  ['timeout_fallback', fault('TIMEOUT')],
  ['http_503_fallback', fault('HTTP_503', 503)],
  ['rate_limit_fallback', fault('RATE_LIMITED', 429)]
]) {
  await verify(id, async () => {
    const fixture = createFaultRouter({ deepseek: error, qwen: { content: 'fallback ok' } });
    const result = await fixture.router.run(task('ordinary_chat', { caseId: id }));
    assert.equal(result.selectedProvider, 'qwen');
    assert.deepEqual(fixture.calls.map(({ provider }) => provider), ['deepseek', 'qwen']);
    assert.equal(result.routeTrace.length, 2);
    return { providers: fixture.calls.map(({ provider }) => provider), attempts: result.routeTrace.length };
  });
}

await verify('schema_invalid_no_fallback', async () => {
  const fixture = createFaultRouter({ deepseek: { content: '{}' }, qwen: { content: 'must not run' } });
  const result = await fixture.router.run(task('semantic_planner', { caseId: 'schema' }));
  assert.equal(result.content, '{}');
  assert.deepEqual(fixture.calls.map(({ provider }) => provider), ['deepseek']);
  return { providers: fixture.calls.map(({ provider }) => provider), attempts: result.routeTrace.length };
});

await verify('local_schema_repair_keeps_one_provider_call', async () => {
  const fixture = createFaultRouter({
    deepseek: { content: JSON.stringify({ plan: memoryPlan() }) },
    qwen: { content: 'must not run' }
  });
  const planner = createAssistantSemanticPlanner({ aiService: plannerAiService(fixture.router) });
  const result = await planner.plan({
    message: '我女儿出生于2012年6月8日',
    sourceMessageId: 'acceptance-source-local',
    routeDomain: 'memory',
    requestId: 'req-local-repair',
    clientRequestId: 'client-local-repair'
  });
  assert.equal(result.ok, true);
  assert.equal(result.repair, 'local');
  assert.equal(result.attempts, 1);
  assert.deepEqual(fixture.calls.map(({ provider }) => provider), ['deepseek']);
  return { providers: ['deepseek'], attempts: 1, repair: 'local' };
});

await verify('deepseek_format_only_repair_is_second_and_final_call', async () => {
  const raw = JSON.stringify(memoryPlan({
    qualifiers: [{ calendar_type: 'unknown', recurrence: 'one_time' }]
  }));
  const fixture = createFaultRouter({
    deepseek(_request, providerCallNumber) {
      return {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        content: providerCallNumber === 1 ? raw : JSON.stringify(memoryPlan()),
        usage: { input_tokens: 5, output_tokens: 3 }
      };
    },
    qwen: { content: 'must not run' }
  });
  const planner = createAssistantSemanticPlanner({ aiService: plannerAiService(fixture.router) });
  const result = await planner.plan({
    message: '我女儿出生于2012年6月8日',
    sourceMessageId: 'acceptance-source-provider-repair',
    routeDomain: 'memory',
    requestId: 'req-provider-repair',
    clientRequestId: 'client-provider-repair'
  });
  assert.equal(result.ok, true);
  assert.equal(result.repair, 'provider_format_only');
  assert.equal(result.attempts, 2);
  assert.deepEqual(fixture.calls.map(({ provider }) => provider), ['deepseek', 'deepseek']);
  assert.deepEqual(result.route.routeTrace.map(({ attemptType }) => attemptType), ['planning', 'schema_repair']);
  return {
    providers: fixture.calls.map(({ provider }) => provider),
    attempts: 2,
    attempt_types: result.route.routeTrace.map(({ attemptType }) => attemptType)
  };
});

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'router-core-m12-b2-'));
try {
  const finance = createFinanceRuntime({
    databasePath: path.join(temporaryRoot, 'finance.sqlite'),
    applyMigrations: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date('2026-07-28T04:00:00.000Z')
  });
  try {
    await verify('finance_prewrite_fallback_single_write', async () => {
      const fixture = createFaultRouter({ deepseek: fault('TIMEOUT'), qwen: { content: '{"domain":"finance"}' } });
      const route = await fixture.router.run(task('finance', { caseId: 'finance-prewrite' }));
      assert.equal(route.selectedProvider, 'qwen');
      const input = {
        ownerId: 'isolated-owner',
        conversationId: 'isolated-conversation',
        message: '今天打车花了18元',
        clientRequestId: route.idempotencyKey,
        sourceMessageId: 'isolated-source-message'
      };
      await finance.service.processUserMessage(input);
      await finance.service.processUserMessage(input);
      const entries = finance.repository.list({ ownerId: 'isolated-owner' });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].amountMinor, 1800);
      return { attempts: route.routeTrace.length, writes: entries.length, amount_minor: entries[0].amountMinor };
    });

    await verify('finance_postwrite_failure_no_fallback', async () => {
      const fixture = createFaultRouter({ deepseek: fault('DATABASE_WRITE_FAILED'), qwen: { content: 'must not run' } });
      const result = await fixture.router.run(task('finance', {
        caseId: 'finance-postwrite',
        businessExecutionStarted: true,
        businessWriteStarted: true
      }));
      assert.equal(result.error.code, 'DATABASE_WRITE_FAILED');
      assert.deepEqual(fixture.calls.map(({ provider }) => provider), ['deepseek']);
      return { providers: fixture.calls.map(({ provider }) => provider), attempts: result.routeTrace.length };
    });
  } finally {
    finance.close();
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

for (const domain of ['memory', 'calendar']) {
  await verify(`${domain}_no_cross_model`, async () => {
    const fixture = createFaultRouter({ deepseek: fault('TIMEOUT'), qwen: { content: 'must not run' } });
    const result = await fixture.router.run(task(domain, { caseId: `${domain}-failure` }));
    assert.equal(result.error.code, 'TIMEOUT');
    assert.deepEqual(fixture.calls.map(({ provider }) => provider), ['deepseek']);
    return { providers: fixture.calls.map(({ provider }) => provider), attempts: result.routeTrace.length };
  });
}

await verify('dual_provider_failure_stops_at_two', async () => {
  const fixture = createFaultRouter({ deepseek: fault('TIMEOUT'), qwen: fault('HTTP_503', 503) });
  const result = await fixture.router.run(task('ordinary_chat', { caseId: 'dual-failure' }));
  assert.equal(result.error.code, 'HTTP_503');
  assert.equal(fixture.calls.length, 2);
  assert.equal(result.routeTrace.length, 2);
  return { providers: fixture.calls.map(({ provider }) => provider), attempts: result.routeTrace.length };
});

const output = {
  schema_version: 1,
  acceptance: 'router-core-m12-b2-fault-injection',
  generated_at: new Date().toISOString(),
  provider_calls_are_injected: true,
  real_provider_calls: 0,
  temporary_data_cleaned: true,
  passed: cases.filter(({ pass }) => pass).length,
  failed: cases.filter(({ pass }) => !pass).length,
  cases
};
const outputPath = argument('output');
if (outputPath) {
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(path.resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (output.failed) process.exitCode = 1;
