import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBetaServer } from '../../server/betaServer.js';
import { createAssistantAgentOrchestrator } from '../../server/agent/assistantAgentOrchestrator.js';
import { createAssistantSemanticIngress } from '../../server/agent/assistantSemanticIngress.js';
import { createAssistantSemanticPlanner } from '../../server/agent/assistantSemanticPlanner.js';
import { createConversationRuntime } from '../../server/conversation/runtime.js';
import { createCoreAiService } from '../../server/coreAiService.js';
import { createFinanceRuntime } from '../../server/finance/runtime.js';
import { createProtectedMemoryRuntime } from '../../server/memory/protectedMemoryRuntime.js';
import { validateSemanticMemoryPlan } from '../../server/memory/semanticMemoryPlanSchema.js';
import { createAssistantToolRegistry } from '../../server/tools/assistantToolRegistry.js';
import { createCalendarTool } from '../../server/tools/calendar/calendarTool.js';

const ACTION_ID = 'ROUTER_CORE_M12_B2_IMPLEMENTATION';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`ROUTER_ACCEPTANCE_${name.toUpperCase().replaceAll('-', '_')}_REQUIRED`);
  return path.resolve(value);
}

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => ({
    type: block.match(/^event:\s*(.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}')
  }));
}

function visible(events) {
  return events.filter((event) => event.type === 'delta').map((event) => event.data.text).join('');
}

const aiConfigSource = requiredArgument('ai-config');
const healthStoreSource = requiredArgument('health-store');
const registryPath = requiredArgument('registry');
const modelCatalogPath = requiredArgument('catalog');
const vaultPath = requiredArgument('vault');
const kekCredentialPath = requiredArgument('kek');
const publicDir = requiredArgument('public-dir');
const requestedPort = Number(argument('port', 18118));
const outputPath = argument('output') ? path.resolve(argument('output')) : null;
const acceptanceCase = argument('case', 'full');
const root = await mkdtemp(path.join(os.tmpdir(), 'router-core-m12-b2-real-'));
const memoryPath = path.join(root, 'memory.sqlite');
const originalMemoryPath = path.join(root, 'original-memory.sqlite');
const copiedAiConfig = path.join(root, 'ai-settings.json');
const authorization = {
  scope: 'router-core-m12-b2-isolated',
  environment: 'router-core-m12-b2-isolated',
  database_kind: 'isolated_acceptance_memory',
  database_path: memoryPath,
  owner_source: 'authenticated_session',
  allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
  original_memory_database: { path: originalMemoryPath, access: 'read_only' },
  cross_owner_access: 'denied',
  migration_allowed: false,
  bulk_import_allowed: false,
  active_action_ids: [ACTION_ID]
};

let instance = null;
let protectedMemory = null;
let financeRuntime = null;
let aiService = null;
let output = null;
const semanticObservations = [];
const memoryObservations = [];
const toolObservations = [];
const requestObservations = [];
try {
  await copyFile(aiConfigSource, copiedAiConfig);
  await copyFile(healthStoreSource, path.join(root, 'provider-health.json'));
  await writeFile(originalMemoryPath, 'isolated sentinel\n', { mode: 0o600 });
  aiService = createCoreAiService({
    configPath: copiedAiConfig,
    healthStorePath: path.join(root, 'provider-health.json'),
    providerRegistryConfig: {
      enabled: true,
      registryPath,
      modelCatalogPath,
      vaultPath,
      kekCredentialPath,
      auditLogPath: path.join(root, 'provider-security-audit.ndjson')
    }
  });
  let tick = 0;
  protectedMemory = createProtectedMemoryRuntime({
    databasePath: memoryPath,
    repositoryRoot: process.cwd(),
    authorization,
    scope: authorization.scope,
    actionId: ACTION_ID,
    now: () => new Date(Date.UTC(2026, 6, 28, 4, 0, tick++)).toISOString()
  });
  financeRuntime = createFinanceRuntime({
    databasePath: path.join(root, 'finance.sqlite'),
    timezone: 'Asia/Shanghai',
    applyMigrations: true,
    clock: () => new Date('2026-07-28T04:00:00.000Z')
  });
  const toolRegistry = createAssistantToolRegistry();
  toolRegistry.register(createCalendarTool());
  const observedToolRegistry = {
    descriptors: () => toolRegistry.descriptors(),
    validatePlan: (...args) => toolRegistry.validatePlan(...args),
    async invoke(id, input) {
      const result = await toolRegistry.invoke(id, input);
      const args = input?.plan?.arguments || {};
      toolObservations.push({
        tool: id,
        action: input?.plan?.action || null,
        decision: result?.decision || null,
        code: result?.code || null,
        errors: (result?.errors || []).slice(0, 24),
        source_calendar: args.source_calendar || null,
        target_calendar: args.target_calendar || null,
        target_year_reference: args.target_year_reference || null,
        occurrence: args.occurrence || null,
        target_year_present: Number.isInteger(args.target_year),
        evidence_items: Array.isArray(input?.evidenceBundle?.items)
          ? input.evidenceBundle.items.length
          : 0
      });
      return result;
    }
  };
  const semanticPlanner = createAssistantSemanticPlanner({
    aiService,
    toolDescriptors: toolRegistry.descriptors()
  });
  const productionIngress = createAssistantSemanticIngress({ planner: semanticPlanner });
  const observedIngress = {
    async interpret(input) {
      const result = await productionIngress.interpret(input);
      const plan = result?.plan || null;
      semanticObservations.push({
        source_message_id: String(input.sourceMessageId || ''),
        ok: result?.ok === true,
        code: result?.code || null,
        attempts: result?.attempts || 0,
        repair: result?.repair || null,
        domain: plan?.domain || null,
        intent: plan?.intent || null,
        action: plan?.action || null,
        tool: plan?.tool || null,
        qualifier_keys: plan?.qualifiers && typeof plan.qualifiers === 'object'
          ? Object.keys(plan.qualifiers).sort()
          : [],
        argument_keys: plan?.canonical_arguments && typeof plan.canonical_arguments === 'object'
          ? Object.keys(plan.canonical_arguments).sort()
          : [],
        evidence_requirements: Array.isArray(plan?.required_evidence) ? plan.required_evidence.length : 0,
        route_attempts: Array.isArray(result?.route?.routeTrace)
          ? result.route.routeTrace.map(({ attemptNumber, attemptType, providerId }) => ({
              attempt_number: attemptNumber,
              attempt_type: attemptType,
              provider_id: providerId
            }))
          : []
      });
      return result;
    }
  };
  const observedMemory = {
    ...protectedMemory,
    async processSemanticPlan(input, plan) {
        const validation = validateSemanticMemoryPlan(plan, {
          text: input?.message || '',
          minimumConfidence: 0
        });
        const result = await protectedMemory.processSemanticPlan(input, plan);
        memoryObservations.push({
          intent: plan?.intent || null,
          predicate: plan?.predicate || null,
          relation_to_owner: plan?.subject?.relation_to_owner || null,
          calendar_type: plan?.qualifiers?.calendar_type || null,
          month_present: Number.isInteger(plan?.qualifiers?.month),
          day_present: Number.isInteger(plan?.qualifiers?.day),
          lunar_leap_month: [true, false, 'unknown'].includes(plan?.qualifiers?.lunar_leap_month)
            ? plan.qualifiers.lunar_leap_month
            : null,
          uncertainty: plan?.qualifiers?.uncertainty === true,
          confidence_valid: Number.isFinite(plan?.confidence),
          schema_valid: validation.valid,
          schema_errors: validation.errors.slice(0, 24),
          result_kind: result?.kind || null,
          result_outcome: result?.outcome || null
        });
        return result;
    }
  };
  const assistantAgent = createAssistantAgentOrchestrator({
    financeService: financeRuntime.service,
    memoryIntegration: observedMemory,
    semanticPlanner,
    semanticIngress: observedIngress,
    toolRegistry: observedToolRegistry,
    timezone: financeRuntime.timezone,
    clock: financeRuntime.clock
  });
  const conversationRuntime = createConversationRuntime({
    databasePath: path.join(root, 'conversations.sqlite'),
    aiService,
    applyMigrations: true,
    memoryPolicy: 'protected_acceptance',
    assistantAgent
  });
  instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(root, 'auth.sqlite'),
      conversationDb: path.join(root, 'conversations.sqlite'),
      cookieSecret: 'router-core-m12-b2-isolated-cookie-secret',
      secureCookie: false,
      financeTimezone: 'Asia/Shanghai'
    },
    aiService,
    conversationRuntime,
    memoryRuntime: {
      service: {},
      initialize: async () => ({ status: 'disabled' }),
      close: async () => {}
    },
    protectedMemoryRuntime: protectedMemory,
    financeRuntime
  });
  await instance.auth.createAccount({
    username: 'router_acceptance_owner',
    displayName: 'Router Acceptance Owner',
    password: 'RouterAcceptanceA1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(requestedPort, '127.0.0.1', resolve);
  });
  const port = instance.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'router_acceptance_owner', password: 'RouterAcceptanceA1!' })
  });
  assert.equal(login.status, 200);
  const ownerId = (await login.json()).user.id;
  const cookie = login.headers.get('set-cookie');

  async function send(message, clientRequestId, conversationId = null) {
    const response = await fetch(`${baseUrl}/api/ai/chat/stream`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        clientRequestId,
        ...(conversationId ? { conversationId } : {})
      })
    });
    const events = parseSse(await response.text());
    const result = {
      status: response.status,
      text: visible(events),
      conversationId: events.find((event) => event.type === 'started')?.data?.conversationId || null,
      terminal: events.at(-1)?.type || null
    };
    requestObservations.push({
      client_request_id: clientRequestId,
      status: result.status,
      terminal: result.terminal,
      visible_text_length: result.text.length,
      event_types: events.map(({ type }) => type).filter(Boolean),
      terminal_code: events.at(-1)?.data?.code || null,
      terminal_status: events.at(-1)?.data?.status || null
    });
    return result;
  }

  const saved = await send('请记住我妈妈是公历5月20日生日', 'real-memory-save');
  assert.equal(saved.status, 200);
  assert.notEqual(saved.text, '我还不能确定你的意思，请再明确一点。');
  if (acceptanceCase === 'memory-save') {
    const providerTraces = aiService.listTraces(10).filter(({ domain }) => domain);
    const memories = protectedMemory.inspectOwner(ownerId).currentMemories;
    assert.equal(memories.filter(({ predicate }) => predicate === 'birthday').length, 1);
    assert.equal(providerTraces.length >= 1 && providerTraces.length <= 2, true);
    assert.equal(providerTraces.every(({ providerId }) => providerId === 'deepseek'), true);
    output = {
      schema_version: 1,
      acceptance: 'router-core-m12-b2-real-isolated-memory-save',
      generated_at: new Date().toISOString(),
      port,
      provider_calls: providerTraces.length,
      qwen_calls: providerTraces.filter(({ providerId }) => providerId === 'qwen').length,
      max_attempts_observed: Math.max(...providerTraces.map(({ attemptNumber }) => attemptNumber)),
      schema_repair_calls: providerTraces.filter(({ attemptType }) => attemptType === 'schema_repair').length,
      temporary_account_persisted: false,
      temporary_data_cleaned: true,
      semantic_observations: semanticObservations,
      memory_observations: memoryObservations,
      request_observations: requestObservations,
      passed: true
    };
  } else {
    const recalled = await send('我妈妈生日是哪天？', 'real-memory-recall');
    const next = await send('妈妈的下一个生日是哪天？', 'real-calendar-next', recalled.conversationId);
    const days = await send('距离妈妈下一个生日还有多少天？', 'real-calendar-days', recalled.conversationId);
    const lunarSeed = await send('请记住我爸爸是农历7月16日生日', 'real-memory-lunar');
    const lunar = await send('爸爸今年的农历生日换成公历是哪天？', 'real-calendar-lunar', lunarSeed.conversationId);
    const finance = await send('今天打车花了18元', 'real-finance');
    const chat = await send('为什么天空通常看起来是蓝色的？', 'real-chat');

    assert.match(recalled.text, /公历五月二十|公历5月20/);
    assert.match(next.text, /2027年.*5月20日/);
    assert.match(days.text, /还有296天/);
    assert.match(lunar.text, /2026年.*8月28日/);
    assert.equal(finance.text, '已记录');
    assert.ok(chat.text.length > 0);
    assert.equal(financeRuntime.repository.list({ ownerId, limit: 20 }).length, 1);
    const memories = protectedMemory.inspectOwner(ownerId).currentMemories;
    assert.equal(memories.filter(({ predicate }) => predicate === 'birthday').length, 2);

    const providerTraces = aiService.listTraces(50).filter(({ domain }) => domain);
    assert.ok(providerTraces.length >= 8);
    assert.equal(providerTraces.every(({ providerId }) => providerId === 'deepseek'), true);
    assert.equal(providerTraces.some(({ providerId }) => providerId === 'qwen'), false);
    assert.equal(providerTraces.every(({ attemptNumber }) => attemptNumber >= 1 && attemptNumber <= 2), true);
    assert.equal(providerTraces.every(({ attemptType }) =>
      ['planning', 'schema_repair'].includes(attemptType)), true);
    const attemptsByExecution = new Map();
    providerTraces.forEach(({ executionId, attemptNumber }) => {
      attemptsByExecution.set(executionId, Math.max(attemptsByExecution.get(executionId) || 0, attemptNumber));
    });
    assert.equal([...attemptsByExecution.values()].every((attempts) => attempts <= 2), true);
    assert.doesNotMatch(JSON.stringify(providerTraces), /请记住|生日|打车|天空|api.?key|cookie|password/i);

    output = {
      schema_version: 1,
      acceptance: 'router-core-m12-b2-real-isolated',
      generated_at: new Date().toISOString(),
      port,
      provider_calls: providerTraces.length,
      final_providers: [...new Set(providerTraces.map(({ providerId, modelId }) => `${providerId}/${modelId}`))],
      qwen_calls: providerTraces.filter(({ providerId }) => providerId === 'qwen').length,
      max_attempts_observed: Math.max(...providerTraces.map(({ attemptNumber }) => attemptNumber)),
      schema_repair_calls: providerTraces.filter(({ attemptType }) => attemptType === 'schema_repair').length,
      temporary_account_persisted: false,
      temporary_data_cleaned: true,
      cases: {
        memory_save: saved.terminal === 'completed',
        new_conversation_recall: recalled.terminal === 'completed',
        solar_next_birthday: next.terminal === 'completed',
        days_until_next_birthday: days.terminal === 'completed',
        lunar_conversion: lunar.terminal === 'completed',
        finance_single_write: financeRuntime.repository.list({ ownerId, limit: 20 }).length === 1,
        ordinary_chat: chat.terminal === 'completed'
      },
      semantic_observations: semanticObservations,
      memory_observations: memoryObservations,
      tool_observations: toolObservations,
      request_observations: requestObservations,
      passed: true
    };
  }
} catch (error) {
  const safeTraces = aiService?.listTraces?.(50)
    ?.filter(({ domain }) => domain)
    ?.map(({ requestId, executionId, attemptId, attemptNumber, attemptType, domain, providerId, modelId, success, errorClass, errorCode }) => ({
      request_id: requestId,
      execution_id: executionId,
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      attempt_type: attemptType,
      domain,
      provider_id: providerId,
      model_id: modelId,
      success,
      error_class: errorClass || errorCode || null
    })) || [];
  output = {
    schema_version: 1,
    acceptance: 'router-core-m12-b2-real-isolated',
    generated_at: new Date().toISOString(),
    passed: false,
    code: error?.code || 'ACCEPTANCE_FAILED',
    message: String(error?.message || '').slice(0, 200),
    acceptance_case: acceptanceCase,
    failure_location: String(error?.stack || '').split('\n').slice(1, 3),
    semantic_observations: semanticObservations,
    memory_observations: memoryObservations,
    tool_observations: toolObservations,
    request_observations: requestObservations,
    provider_trace: safeTraces,
    temporary_account_persisted: false,
    temporary_data_cleaned: true
  };
  process.exitCode = 1;
} finally {
  if (instance?.server?.listening) {
    await new Promise((resolve) => instance.server.close(resolve));
  }
  instance?.auth?.close?.();
  instance?.conversationRuntime?.close?.();
  protectedMemory?.close?.();
  financeRuntime?.close?.();
  await rm(root, { recursive: true, force: true });
}

if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
