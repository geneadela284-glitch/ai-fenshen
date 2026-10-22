import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAssistantSemanticPlanner } from '../../server/agent/assistantSemanticPlanner.js';
import { createAssistantSemanticIngress } from '../../server/agent/assistantSemanticIngress.js';
import { createCoreAiService } from '../../server/coreAiService.js';
import { createAssistantToolRegistry } from '../../server/tools/assistantToolRegistry.js';
import { createCalendarTool } from '../../server/tools/calendar/calendarTool.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`PLANNER_CANARY_${name.toUpperCase().replaceAll('-', '_')}_REQUIRED`);
  return path.resolve(value);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'router-core-planner-canary-'));
let output;
try {
  const caseId = argument('case') || 'solar';
  const messages = {
    solar: '请记住我妈妈是公历5月20日生日',
    lunar: '请记住我妈妈是农历7月16日生日',
    lunar_update: '请记住我妈妈是农历7月16日生日'
  };
  if (!messages[caseId]) throw new Error('PLANNER_CANARY_CASE_INVALID');
  const trustedContext = {
    owner: 'isolated-planner-canary',
    conversation: 'isolated-planner-canary-conversation',
    owner_id: 'isolated-planner-canary',
    conversation_id: 'isolated-planner-canary-conversation',
    values: caseId === 'lunar_update'
      ? {
          'entity.relation_to_owner': 'mother',
          relation_to_owner: 'mother',
          predicate: 'birthday'
        }
      : {},
    ...(caseId === 'lunar_update'
      ? {
          active_entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
          active_predicate: 'birthday',
          active_domain: 'memory',
          memory_context: {
            previous_entity: 'mother',
            previous_predicate: 'birthday',
            relation_to_owner: 'mother',
            predicate: 'birthday',
            qualifiers: { calendar_type: 'gregorian', month: 5, day: 20 }
          }
        }
      : {})
  };
  const configPath = path.join(root, 'ai-settings.json');
  const healthPath = path.join(root, 'provider-health.json');
  await copyFile(required('ai-config'), configPath);
  await copyFile(required('health-store'), healthPath);
  const aiService = createCoreAiService({
    configPath,
    healthStorePath: healthPath,
    providerRegistryConfig: {
      enabled: true,
      registryPath: required('registry'),
      modelCatalogPath: required('catalog'),
      vaultPath: required('vault'),
      kekCredentialPath: required('kek'),
      auditLogPath: path.join(root, 'provider-security-audit.ndjson')
    }
  });
  const tools = createAssistantToolRegistry();
  tools.register(createCalendarTool());
  const planner = createAssistantSemanticPlanner({
    aiService,
    toolDescriptors: tools.descriptors()
  });
  const planned = await createAssistantSemanticIngress({ planner }).interpret({
    message: messages[caseId],
    sourceMessageId: 'planner-canary-source',
    ownerId: 'isolated-planner-canary',
    conversationId: 'isolated-planner-canary-conversation',
    contextPack: {
      semantic_context: trustedContext,
      memory_context: trustedContext.memory_context || null
    },
    trustedContext,
    routeDomain: 'memory',
    requestId: 'req-router-core-planner-canary',
    clientRequestId: 'client-router-core-planner-canary',
    ownerId: 'isolated-planner-canary'
  });
  const traces = aiService.listTraces(4).filter(({ requestId }) =>
    requestId === 'req-router-core-planner-canary');
  output = {
    case_id: caseId,
    passed: planned.ok === true,
    code: planned.code || null,
    attempts: planned.attempts || 0,
    repair: planned.repair || null,
    schema_errors: (planned.errors || []).slice(0, 24),
    domain: planned.plan?.domain || null,
    intent: planned.plan?.intent || null,
    action: planned.plan?.action || null,
    requires_confirmation: planned.plan?.requires_confirmation === true,
    confidence_score: Number.isFinite(planned.plan?.confidence) ? planned.plan.confidence : null,
    provider_trace: traces.map((trace) => ({
      request_id: trace.requestId,
      execution_id: trace.executionId,
      attempt_id: trace.attemptId,
      attempt_number: trace.attemptNumber,
      attempt_type: trace.attemptType,
      provider_id: trace.providerId,
      model_id: trace.modelId,
      success: trace.success,
      error_class: trace.errorClass || trace.errorCode || null
    })),
    temporary_data_cleaned: true
  };
  if (!planned.ok) process.exitCode = 1;
} catch (error) {
  output = {
    passed: false,
    code: error?.code || 'PLANNER_CANARY_FAILED',
    message: String(error?.message || '').slice(0, 200),
    temporary_data_cleaned: true
  };
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
