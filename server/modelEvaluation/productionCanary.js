import { performance } from 'node:perf_hooks';

import { buildSchemaRepairMessages } from '../../core/router/SchemaRepairContract.js';
import { createAssistantSemanticPlanner } from '../agent/assistantSemanticPlanner.js';
import { EVALUATION_PARAMETERS } from './evaluationContract.js';

function normalizedUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens ?? input + output)
  };
}

export async function runProductionPlannerCanary({
  cases = [],
  providerTarget,
  invoke,
  toolDescriptors = [],
  maxCalls = 8,
  timezone = EVALUATION_PARAMETERS.timezone,
  now = new Date(EVALUATION_PARAMETERS.now)
} = {}) {
  if (!providerTarget?.provider_id || !providerTarget?.model_id) {
    throw new TypeError('Production canary requires one Provider target.');
  }
  if (typeof invoke !== 'function') throw new TypeError('Production canary requires invoke().');
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 8) {
    throw new RangeError('Production canary call limit must be between 1 and 8.');
  }

  let callCount = 0;
  let stoppedAtLimit = false;
  const upstreamRecords = [];
  let activeRoute = null;
  async function callProvider(messages) {
    if (callCount >= maxCalls) {
      stoppedAtLimit = true;
      return { ok: false };
    }
    callCount += 1;
    const started = performance.now();
    try {
      const result = await invoke({
        providerTarget,
        messages,
        options: {
          temperature: EVALUATION_PARAMETERS.temperature,
          max_tokens: EVALUATION_PARAMETERS.max_tokens,
          timeout_ms: EVALUATION_PARAMETERS.timeout_ms
        }
      });
      upstreamRecords.push({
        call_index: callCount,
        provider_id: providerTarget.provider_id,
        model_id: providerTarget.model_id,
        http_success: true,
        http_status: Number(result?.httpStatus || 200),
        latency_ms: Math.round(performance.now() - started),
        usage: normalizedUsage(result?.usage),
        content: String(result?.content || '')
      });
      return { ok: true, content: String(result?.content || '') };
    } catch (error) {
      upstreamRecords.push({
        call_index: callCount,
        provider_id: providerTarget.provider_id,
        model_id: providerTarget.model_id,
        http_success: false,
        http_status: Number(error?.status || 0) || null,
        latency_ms: Math.round(performance.now() - started),
        usage: null,
        content: '',
        error_code: String(error?.code || 'PROVIDER_ERROR')
      });
      return { ok: false };
    }
  }
  const aiService = {
    async run(request) {
      const result = await callProvider(request.messages);
      if (!result.ok) return result;
      const requestId = String(request.metadata?.requestId || `canary-request-${callCount}`);
      const executionId = `exec_canary_${callCount}`;
      activeRoute = {
        requestId,
        executionId,
        idempotencyKey: `idem_canary_${callCount}`,
        selectedProvider: providerTarget.provider_id,
        selectedModel: providerTarget.model_id,
        routeTrace: [{
          requestId,
          executionId,
          attemptId: `attempt_canary_${callCount}`,
          attemptNumber: 1,
          attemptType: 'planning',
          providerId: providerTarget.provider_id,
          modelId: providerTarget.model_id,
          domain: request.metadata?.routeDomain || 'semantic_planner',
          success: true
        }]
      };
      return { ...result, route: activeRoute };
    },
    async repairSchema(request) {
      if (providerTarget.provider_id !== 'deepseek' ||
          providerTarget.model_id !== 'deepseek-v4-flash' ||
          request.route?.requestId !== activeRoute?.requestId ||
          request.route?.executionId !== activeRoute?.executionId) {
        return { ok: false, route: activeRoute };
      }
      const result = await callProvider(buildSchemaRepairMessages({
        schemaContract: request.schemaContract,
        rawContent: request.rawContent,
        errors: request.errors
      }));
      if (!result.ok) return { ...result, route: activeRoute };
      activeRoute = {
        ...activeRoute,
        routeTrace: [...activeRoute.routeTrace, {
          requestId: activeRoute.requestId,
          executionId: activeRoute.executionId,
          attemptId: `attempt_canary_${callCount}`,
          attemptNumber: 2,
          attemptType: 'schema_repair',
          providerId: providerTarget.provider_id,
          modelId: providerTarget.model_id,
          domain: request.domain || 'semantic_planner',
          success: true
        }]
      };
      return { ...result, route: activeRoute };
    }
  };
  const planner = createAssistantSemanticPlanner({
    aiService,
    toolDescriptors,
    timeoutMs: EVALUATION_PARAMETERS.timeout_ms
  });
  const caseResults = [];
  for (const definition of cases) {
    if (callCount >= maxCalls) {
      stoppedAtLimit = true;
      caseResults.push({
        case_id: definition.id,
        ok: false,
        code: 'PRODUCTION_CANARY_CALL_LIMIT_REACHED',
        attempts: 0
      });
      continue;
    }
    const planned = await planner.plan({
      message: definition.message,
      sourceMessageId: `production-canary-${definition.id}`,
      contextPack: definition.contextPack || {},
      timezone,
      now
    });
    caseResults.push({
      case_id: definition.id,
      ok: planned?.ok === true,
      code: planned?.ok ? null : planned?.code || 'PRODUCTION_CANARY_FAILED',
      attempts: planned?.attempts || 0,
      plan: planned?.ok ? planned.plan : null,
      errors: planned?.errors || []
    });
  }
  return {
    provider_id: providerTarget.provider_id,
    model_id: providerTarget.model_id,
    call_count: callCount,
    call_limit: maxCalls,
    exceeded_call_limit: callCount > maxCalls,
    stopped_at_limit: stoppedAtLimit,
    cases: caseResults,
    upstream_records: upstreamRecords
  };
}
