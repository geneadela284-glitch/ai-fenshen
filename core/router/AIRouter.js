import { providerManager } from '../providers/providerManager.js';
import { gatewayRuntime } from '../aiGateway/runtime/GatewayRuntime.js';
import { isGatewayRuntimeEnabled } from '../aiGateway/runtime/featureFlags.js';
import { responsePolicyRuntime } from '../aiGateway/runtime/responsePolicyRuntime.js';
import { createAIRequestRuntimeContext } from '../aiGateway/runtime/runtimeContext.js';
import { settingsManager } from '../settings/settingsManager.js';
import { normalizeCapability } from './CapabilityMap.js';
import { ACCESS_CONTROL_ERROR_CODES } from './AccessControlErrorCodes.js';
import { invocationTraceRepository } from './InvocationTraceRepository.js';
import { modelRegistry } from './ModelRegistry.js';
import { promptBuilder } from './PromptBuilder.js';
import { classifyRouterError, shouldFallback } from './RouterErrorClassifier.js';
import { createRouterExecutionContext } from './RouterExecutionContext.js';
import { resolveRouterPolicy } from './RouterPolicy.js';
import {
  ASSISTANT_PROVIDER_PLAN_SCHEMA_ID,
  buildSchemaRepairMessages
} from './SchemaRepairContract.js';
import { taskClassifier } from './TaskClassifier.js';

function clockMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function resultContent(result) {
  return result?.content || result?.text || result?.output || '';
}

function normalizedErrorCode(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  if (ACCESS_CONTROL_ERROR_CODES.has(code)) return code;
  if (code === 'MODEL_NOT_FOUND' || status === 404 || /model.*not found|模型不存在/.test(message)) return 'MODEL_NOT_FOUND';
  if (['INVALID_API_KEY', 'AUTH_FAILED', 'HTTP_401', 'HTTP_403'].includes(code) || [401, 403].includes(status) || /unauthorized|api key/.test(message)) return 'AUTH_FAILED';
  if (code === 'RATE_LIMITED' || code === 'HTTP_429' || status === 429 || /rate.?limit|限流/.test(message)) return 'RATE_LIMITED';
  if (code === 'TIMEOUT' || [408, 504].includes(status) || /timeout|超时/.test(message)) return 'TIMEOUT';
  if (code === 'NO_CAPABLE_MODEL') return code;
  return classifyRouterError(error).code || code || 'PROVIDER_ERROR';
}

function normalizeError(error, providerId = '') {
  if (!error) return null;
  const code = normalizedErrorCode(error);
  const messages = {
    MODEL_NOT_FOUND: '管理员配置的模型不存在或当前不可用。',
    AUTH_FAILED: 'AI 服务认证失败，请管理员检查配置。',
    RATE_LIMITED: 'AI 服务请求过多，请稍后重试。',
    TIMEOUT: 'AI 服务响应超时，请稍后重试。',
    NO_CAPABLE_MODEL: '没有已配置且支持该能力的 AI 模型。'
  };
  return {
    message: messages[code] || 'AI 服务调用失败，请稍后重试。',
    code,
    provider: providerId || null
  };
}

function isMockOnly(task = {}) {
  return Boolean(task.mockOnly || task.metadata?.mockOnly || task.options?.mockOnly);
}

function mockResult(task = {}, capability = '') {
  const input = task.input || task.prompt || '当前任务';
  const content = `已收到任务：“${input}”。AI Router 已识别能力：${capability}。`;
  return {
    provider: 'ai-router-mock',
    model: 'mock',
    content,
    usage: { inputTokens: Math.ceil(String(input).length / 2), outputTokens: Math.ceil(content.length / 2) },
    mocked: true,
    createdAt: new Date().toISOString()
  };
}

const unavailableAccessControl = Object.freeze({
  reserveProviderAttempt() {
    const error = new Error('ACCESS_CONTROL_UNAVAILABLE');
    error.code = 'ACCESS_CONTROL_UNAVAILABLE';
    throw error;
  },
  settleProviderAttempt() {
    const error = new Error('ACCESS_CONTROL_UNAVAILABLE');
    error.code = 'ACCESS_CONTROL_UNAVAILABLE';
    throw error;
  }
});

export class AIRouter {
  constructor({
    providers = providerManager,
    settings = settingsManager,
    registry = modelRegistry,
    classifier = taskClassifier,
    prompts = promptBuilder,
    traces = invocationTraceRepository,
    gateway = gatewayRuntime,
    gatewayRuntime: gatewayOverride,
    responsePolicy = responsePolicyRuntime,
    accessControl = unavailableAccessControl,
    speechRuntime = null,
    maxAttempts = 2
  } = {}) {
    this.providers = providers;
    this.settings = settings;
    this.registry = registry;
    this.classifier = classifier;
    this.prompts = prompts;
    this.traces = traces;
    this.gatewayRuntime = gatewayOverride || gateway;
    this.responsePolicy = responsePolicy;
    this.accessControl = accessControl || unavailableAccessControl;
    this.speechRuntime = speechRuntime;
    this.maxAttempts = Math.max(1, Math.min(2, Number(maxAttempts || 2)));
  }

  run(task = {}, invocation = {}) {
    if (task.capability === 'VOICE_CHAT_ASR' || task.capability === 'VOICE_CHAT_TTS') {
      if (!this.voiceChatRuntime) return Promise.reject(Object.assign(new Error('VOICE_UNAVAILABLE'), { code: 'VOICE_UNAVAILABLE' }));
      return this.voiceChatRuntime.run(task, invocation);
    }
    if (task.capability === 'SPEECH_TO_TEXT' || task.capability === 'TEXT_TO_SPEECH') {
      if (!this.speechRuntime) return Promise.reject(Object.assign(new Error('LEARNING_SPEECH_UNAVAILABLE'), { code: 'LEARNING_SPEECH_UNAVAILABLE', status: 503 }));
      return this.speechRuntime.run(task, invocation);
    }
    return this.dispatch(task.method || task.type || 'chat', task, invocation);
  }

  async stream(task = {}, options = {}, invocation = {}) {
    if (task.metadata?.routeDomain) return this.streamPolicy(task, options, invocation);
    const overallStarted = clockMs();
    const settings = this.settings.load();
    const capability = normalizeCapability(this.classifier.classify(task));
    const runtimeContext = createAIRequestRuntimeContext(task, { capability });
    const quotaExecution = createRouterExecutionContext({
      requestId: runtimeContext.requestId,
      executionId: task.metadata?.executionId,
      clientRequestId: task.metadata?.clientRequestId,
      ownerId: runtimeContext.userId,
      domain: `capability:${capability}`
    });
    const candidates = this.registry.listCandidates(settings, capability).slice(0, this.maxAttempts);
    const policy = this.registry.getRoutePolicy(settings, capability);
    if (!candidates.length) {
      return this.buildResponse({
        requestId: runtimeContext.requestId, task, capability,
        candidate: { providerId: policy.providerId || '', modelId: policy.model || '' },
        preferredProvider: policy.providerId, result: null, fallbackUsed: false, fallbackFrom: '',
        latency: Math.round(clockMs() - overallStarted),
        error: Object.assign(new Error('no capable model'), { code: 'NO_CAPABLE_MODEL' }), routeReason: 'no_eligible_model'
      });
    }

    let lastError;
    const primary = candidates[0];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const quotaAttempt = quotaExecution.attempt(
        index + 1,
        candidate,
        index === 0 ? 'planning' : 'fallback'
      );
      const started = clockMs();
      const request = this.prompts.build(task, { capability, providerId: candidate.providerId, model: candidate.modelId });
      let emittedDelta = false;
      const streamOptions = {
        ...options,
        onDelta: async (delta) => {
          emittedDelta = true;
          await options.onDelta?.(delta);
        }
      };
      try {
        const result = await this.invokeProviderAttempt({
          method: 'streamChat',
          candidate,
          request,
          runtimeContext,
          settings,
          attempt: quotaAttempt,
          invocation,
          streamOptions
        });
        const durationMs = Math.round(clockMs() - started);
        this.recordTrace({
          requestId: runtimeContext.requestId, task, capability, candidate, routeReason: 'streaming_capability_route',
          fallbackFrom: index ? primary.providerId : '', fallbackTo: index ? candidate.providerId : '',
          startedAt: new Date().toISOString(), durationMs, success: true, tokenUsage: result?.usage || null
        });
        this.recordHealth(candidate.providerId, { success: true, durationMs });
        return this.buildResponse({
          requestId: runtimeContext.requestId, task, capability, candidate, preferredProvider: primary.providerId,
          result, fallbackUsed: index > 0, fallbackFrom: index ? primary.providerId : '',
          latency: Math.round(clockMs() - overallStarted), error: null, routeReason: 'streaming_capability_route'
        });
      } catch (error) {
        lastError = error;
        const durationMs = Math.round(clockMs() - started);
        const errorCode = normalizedErrorCode(error);
        const userCancelled = options.signal?.aborted || error?.code === 'ABORTED';
        this.recordTrace({
          requestId: runtimeContext.requestId, task, capability, candidate, routeReason: 'streaming_capability_route',
          fallbackFrom: index ? primary.providerId : '', fallbackTo: candidates[index + 1]?.providerId || '',
          startedAt: new Date().toISOString(), durationMs, success: false, errorCode
        });
        if (!userCancelled) this.recordHealth(candidate.providerId, { success: false, durationMs, errorCode });
        if (emittedDelta || userCancelled || ACCESS_CONTROL_ERROR_CODES.has(errorCode)) break;
      }
    }
    const candidate = candidates.at(-1);
    return this.buildResponse({
      requestId: runtimeContext.requestId, task, capability, candidate, preferredProvider: primary.providerId,
      result: null, fallbackUsed: candidates.length > 1, fallbackFrom: candidates.length > 1 ? primary.providerId : '',
      latency: Math.round(clockMs() - overallStarted), error: lastError, routeReason: 'all_eligible_models_failed'
    });
  }

  async dispatch(method = 'chat', task = {}, invocation = {}) {
    if (task.metadata?.routeDomain) return this.dispatchPolicy(method, task, invocation);
    const overallStarted = clockMs();
    const settings = this.settings.load();
    const capability = normalizeCapability(this.classifier.classify(task));
    const runtimeContext = createAIRequestRuntimeContext(task, { capability });
    const id = runtimeContext.requestId;
    const quotaExecution = createRouterExecutionContext({
      requestId: id,
      executionId: task.metadata?.executionId,
      clientRequestId: task.metadata?.clientRequestId,
      ownerId: runtimeContext.userId,
      domain: `capability:${capability}`
    });
    const candidates = this.registry.listCandidates(settings, capability).slice(0, this.maxAttempts);
    const policy = this.registry.getRoutePolicy(settings, capability);

    if (isMockOnly(task)) {
      const candidate = candidates[0] || { providerId: policy.providerId, modelId: policy.model };
      const result = mockResult(task, capability);
      return this.buildResponse({
        requestId: id,
        task,
        capability,
        candidate,
        preferredProvider: policy.providerId,
        result,
        fallbackUsed: false,
        fallbackFrom: '',
        latency: Math.round(clockMs() - overallStarted),
        error: null,
        routeReason: 'mock_only'
      });
    }

    if (!candidates.length) {
      const error = Object.assign(new Error('no capable model'), { code: 'NO_CAPABLE_MODEL' });
      const candidate = { providerId: policy.providerId || '', modelId: policy.model || '' };
      const latency = Math.round(clockMs() - overallStarted);
      this.recordTrace({
        requestId: id,
        task,
        capability,
        candidate,
        routeReason: 'no_eligible_model',
        fallbackFrom: '',
        fallbackTo: '',
        startedAt: new Date().toISOString(),
        durationMs: latency,
        success: false,
        errorCode: 'NO_CAPABLE_MODEL'
      });
      return this.buildResponse({
        requestId: id,
        task,
        capability,
        candidate,
        preferredProvider: policy.providerId,
        result: null,
        fallbackUsed: false,
        fallbackFrom: '',
        latency,
        error,
        routeReason: 'no_eligible_model'
      });
    }

    let lastError = null;
    const primary = candidates[0];

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const quotaAttempt = quotaExecution.attempt(
        index + 1,
        candidate,
        index === 0 ? 'planning' : 'fallback'
      );
      const attemptStartedAt = new Date().toISOString();
      const attemptStarted = clockMs();
      const fallbackUsed = index > 0;
      const routeReason = candidate.preferred
        ? 'administrator_capability_route'
        : `capability_match_health_${candidate.healthRank}_priority_${candidate.priority}`;
      const request = this.prompts.build(task, {
        capability,
        providerId: candidate.providerId,
        model: candidate.modelId
      });

      // Only the trusted meeting HTTP path supplies this deadline. Share its
      // remaining budget across recovery and fallback. Expiry before a call
      // is not a health failure of an untried provider.
      if (invocation.meetingAnalysis === true && capability === 'MEETING_SUMMARY' &&
          Number.isFinite(invocation.meetingAnalysisDeadlineAt)) {
        const remaining = invocation.meetingAnalysisDeadlineAt - Date.now();
        if (remaining <= 0) {
          lastError = Object.assign(new Error('meeting timeout'), { code: 'TIMEOUT' });
          break;
        }
        request.options.timeoutMs = Math.min(request.options.timeoutMs, remaining);
      }
      try {
        const result = await this.invokeProviderAttempt({
          method,
          candidate,
          request,
          runtimeContext,
          settings,
          attempt: quotaAttempt,
          invocation
        });
        const durationMs = Math.round(clockMs() - attemptStarted);
        this.recordTrace({
          requestId: id,
          task,
          capability,
          candidate,
          routeReason,
          fallbackFrom: fallbackUsed ? primary.providerId : '',
          fallbackTo: fallbackUsed ? candidate.providerId : '',
          startedAt: attemptStartedAt,
          durationMs,
          success: true,
          tokenUsage: result?.usage || null
        });
        this.recordHealth(candidate.providerId, { success: true, durationMs });
        return this.buildResponse({
          requestId: id,
          task,
          capability,
          candidate,
          preferredProvider: primary.providerId,
          result,
          fallbackUsed,
          fallbackFrom: fallbackUsed ? primary.providerId : '',
          latency: Math.round(clockMs() - overallStarted),
          error: null,
          routeReason
        });
      } catch (error) {
        lastError = error;
        const durationMs = Math.round(clockMs() - attemptStarted);
        this.recordTrace({
          requestId: id,
          task,
          capability,
          candidate,
          routeReason,
          fallbackFrom: index > 0 ? primary.providerId : '',
          fallbackTo: candidates[index + 1]?.providerId || '',
          startedAt: attemptStartedAt,
          durationMs,
          success: false,
          errorCode: normalizedErrorCode(error)
        });
        this.recordHealth(candidate.providerId, { success: false, durationMs, errorCode: normalizedErrorCode(error) });
        if (ACCESS_CONTROL_ERROR_CODES.has(normalizedErrorCode(error))) break;
      }
    }

    const candidate = candidates.at(-1);
    return this.buildResponse({
      requestId: id,
      task,
      capability,
      candidate,
      preferredProvider: primary.providerId,
      result: null,
      fallbackUsed: candidates.length > 1,
      fallbackFrom: candidates.length > 1 ? primary.providerId : '',
      latency: Math.round(clockMs() - overallStarted),
      error: lastError || Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_ERROR' }),
      routeReason: 'all_eligible_models_failed'
    });
  }

  policyState(task = {}, capability = '') {
    const runtimeContext = createAIRequestRuntimeContext(task, { capability });
    const policy = resolveRouterPolicy(task.metadata?.routeDomain);
    const execution = createRouterExecutionContext({
      requestId: runtimeContext.requestId,
      executionId: task.metadata?.executionId,
      clientRequestId: task.metadata?.clientRequestId,
      ownerId: task.metadata?.ownerId || runtimeContext.userId,
      domain: policy.domain,
      businessExecutionStarted: task.metadata?.businessExecutionStarted,
      businessWriteStarted: task.metadata?.businessWriteStarted
    });
    return { runtimeContext, policy, execution };
  }

  safeRouteTrace({
    attempt,
    domain,
    fallbackReason = '',
    durationMs = 0,
    errorClass = '',
    success = false,
    businessWriteStarted = false
  }) {
    return Object.freeze({
      requestId: attempt.requestId,
      executionId: attempt.executionId,
      attemptId: attempt.attemptId,
      domain,
      providerId: attempt.providerId,
      modelId: attempt.modelId,
      attemptNumber: attempt.attemptNumber,
      attemptType: attempt.attemptType,
      fallbackReason,
      latency: Math.max(0, Number(durationMs || 0)),
      errorClass,
      success: Boolean(success),
      businessWriteStarted: Boolean(businessWriteStarted)
    });
  }

  async dispatchPolicy(method = 'chat', task = {}, invocation = {}) {
    const overallStarted = clockMs();
    const settings = this.settings.load();
    const capability = normalizeCapability(this.classifier.classify(task));
    const { runtimeContext, policy, execution } = this.policyState(task, capability);
    const eligible = this.registry.listPolicyCandidates(settings, policy, capability, {
      deliveryMode: method === 'streamChat' ? 'sse' : 'chat'
    });
    const candidates = eligible.slice(0, policy.maxAttempts);
    const routeTrace = [];
    if (!candidates.length) {
      const error = Object.assign(new Error('no usable runtime connection'), { code: 'NO_USABLE_RUNTIME_CONNECTION' });
      return this.buildResponse({
        requestId: execution.requestId,
        task,
        capability,
        candidate: policy.candidates[0],
        preferredProvider: policy.candidates[0]?.providerId || '',
        result: null,
        fallbackUsed: false,
        fallbackFrom: '',
        latency: Math.round(clockMs() - overallStarted),
        error,
        routeReason: 'router_policy_no_eligible_provider',
        execution,
        routeTrace
      });
    }

    let lastError = null;
    let lastCandidate = candidates[0];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      lastCandidate = candidate;
      const attempt = execution.attempt(index + 1, candidate, index === 0 ? 'planning' : 'fallback');
      const startedAt = new Date().toISOString();
      const started = clockMs();
      const request = this.prompts.build(task, {
        capability,
        providerId: candidate.providerId,
        model: candidate.modelId
      });
      try {
        const result = await this.invokeProviderAttempt({
          method,
          candidate,
          request,
          runtimeContext,
          settings,
          attempt,
          invocation
        });
        const durationMs = Math.round(clockMs() - started);
        const fallbackUsed = candidate.policyIndex > 0;
        const entry = this.safeRouteTrace({
          attempt,
          domain: policy.domain,
          fallbackReason: fallbackUsed
            ? routeTrace.at(-1)?.errorClass || 'PRIMARY_RUNTIME_UNAVAILABLE'
            : '',
          durationMs,
          success: true,
          businessWriteStarted: execution.businessWriteStarted
        });
        routeTrace.push(entry);
        this.recordTrace({
          ...entry,
          candidate,
          capability,
          routeReason: 'router_core_m12_b2_policy',
          startedAt,
          durationMs,
          tokenUsage: result?.usage || null
        });
        this.recordHealth(candidate.providerId, { success: true, durationMs });
        return this.buildResponse({
          requestId: execution.requestId,
          task,
          capability,
          candidate,
          preferredProvider: policy.candidates[0].providerId,
          result,
          fallbackUsed,
          fallbackFrom: fallbackUsed ? policy.candidates[0].providerId : '',
          latency: Math.round(clockMs() - overallStarted),
          error: null,
          routeReason: 'router_core_m12_b2_policy',
          execution,
          routeTrace
        });
      } catch (error) {
        lastError = error;
        const durationMs = Math.round(clockMs() - started);
        const classified = classifyRouterError(error);
        const entry = this.safeRouteTrace({
          attempt,
          domain: policy.domain,
          durationMs,
          errorClass: classified.code,
          success: false,
          businessWriteStarted: execution.businessWriteStarted
        });
        routeTrace.push(entry);
        this.recordTrace({
          ...entry,
          candidate,
          capability,
          routeReason: 'router_core_m12_b2_policy',
          startedAt,
          durationMs,
          errorCode: classified.code
        });
        this.recordHealth(candidate.providerId, {
          success: false,
          durationMs,
          errorCode: classified.code,
          httpStatus: classified.status
        });
        if (ACCESS_CONTROL_ERROR_CODES.has(classified.code) || !shouldFallback({
          error,
          policy,
          businessExecutionStarted: execution.businessExecutionStarted,
          businessWriteStarted: execution.businessWriteStarted,
          attemptNumber: attempt.attemptNumber
        })) break;
      }
    }

    return this.buildResponse({
      requestId: execution.requestId,
      task,
      capability,
      candidate: lastCandidate,
      preferredProvider: policy.candidates[0]?.providerId || '',
      result: null,
      fallbackUsed: routeTrace.length > 1,
      fallbackFrom: routeTrace.length > 1 ? policy.candidates[0]?.providerId || '' : '',
      latency: Math.round(clockMs() - overallStarted),
      error: lastError || Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' }),
      routeReason: 'router_core_m12_b2_failed',
      execution,
      routeTrace
    });
  }

  async streamPolicy(task = {}, options = {}, invocation = {}) {
    const settings = this.settings.load();
    const capability = normalizeCapability(this.classifier.classify(task));
    const { runtimeContext, policy, execution } = this.policyState(task, capability);
    const deliveryMode = task.metadata?.voiceRealtimeOnly === true ? 'voice_sse' : 'sse';
    const candidates = this.registry.listPolicyCandidates(settings, policy, capability, {
      deliveryMode
    }).slice(0, policy.maxAttempts);
    const overallStarted = clockMs();
    const routeTrace = [];
    if (!candidates.length) {
      return this.buildResponse({
        requestId: execution.requestId,
        task,
        capability,
        candidate: policy.candidates[0],
        preferredProvider: policy.candidates[0]?.providerId || '',
        result: null,
        fallbackUsed: false,
        fallbackFrom: '',
        latency: Math.round(clockMs() - overallStarted),
        error: Object.assign(new Error('no usable runtime connection'), { code: 'NO_USABLE_RUNTIME_CONNECTION' }),
        routeReason: 'router_policy_no_eligible_provider',
        execution,
        routeTrace
      });
    }

    let lastError = null;
    let lastCandidate = candidates[0];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      lastCandidate = candidate;
      const attempt = execution.attempt(index + 1, candidate, index === 0 ? 'planning' : 'fallback');
      const startedAt = new Date().toISOString();
      const started = clockMs();
      const request = this.prompts.build(task, {
        capability,
        providerId: candidate.providerId,
        model: candidate.modelId
      });
      let emittedOutput = false;
      try {
        const result = await this.invokeProviderAttempt({
          method: 'streamChat',
          candidate,
          request,
          runtimeContext,
          settings,
          attempt,
          invocation,
          streamOptions: {
            ...options,
            onDelta: async (delta) => {
              emittedOutput = true;
              await options.onDelta?.(delta);
            }
          }
        });
        const durationMs = Math.round(clockMs() - started);
        const fallbackUsed = candidate.policyIndex > 0;
        const entry = this.safeRouteTrace({
          attempt,
          domain: policy.domain,
          fallbackReason: fallbackUsed
            ? routeTrace.at(-1)?.errorClass || 'PRIMARY_RUNTIME_UNAVAILABLE'
            : '',
          durationMs,
          success: true,
          businessWriteStarted: execution.businessWriteStarted
        });
        routeTrace.push(entry);
        this.recordTrace({
          ...entry,
          candidate,
          capability,
          routeReason: 'router_core_m12_b2_stream',
          startedAt,
          durationMs,
          tokenUsage: result?.usage || null
        });
        this.recordHealth(candidate.providerId, { success: true, durationMs });
        return this.buildResponse({
          requestId: execution.requestId,
          task,
          capability,
          candidate,
          preferredProvider: policy.candidates[0].providerId,
          result,
          fallbackUsed,
          fallbackFrom: fallbackUsed ? policy.candidates[0].providerId : '',
          latency: Math.round(clockMs() - overallStarted),
          error: null,
          routeReason: 'router_core_m12_b2_stream',
          execution,
          routeTrace
        });
      } catch (error) {
        lastError = error;
        const durationMs = Math.round(clockMs() - started);
        const classified = classifyRouterError(error);
        const entry = this.safeRouteTrace({
          attempt,
          domain: policy.domain,
          durationMs,
          errorClass: classified.code,
          success: false,
          businessWriteStarted: execution.businessWriteStarted
        });
        routeTrace.push(entry);
        this.recordTrace({
          ...entry,
          candidate,
          capability,
          routeReason: 'router_core_m12_b2_stream',
          startedAt,
          durationMs,
          errorCode: classified.code
        });
        const cancelled = options.signal?.aborted || error?.code === 'ABORTED';
        if (!cancelled) this.recordHealth(candidate.providerId, { success: false, durationMs, errorCode: classified.code });
        if (ACCESS_CONTROL_ERROR_CODES.has(classified.code) || !shouldFallback({
          error,
          policy,
          businessExecutionStarted: execution.businessExecutionStarted,
          businessWriteStarted: execution.businessWriteStarted,
          attemptNumber: attempt.attemptNumber,
          emittedOutput: emittedOutput || cancelled
        })) break;
      }
    }
    return this.buildResponse({
      requestId: execution.requestId,
      task,
      capability,
      candidate: lastCandidate,
      preferredProvider: policy.candidates[0]?.providerId || '',
      result: null,
      fallbackUsed: routeTrace.length > 1,
      fallbackFrom: routeTrace.length > 1 ? policy.candidates[0]?.providerId || '' : '',
      latency: Math.round(clockMs() - overallStarted),
      error: lastError,
      routeReason: 'router_core_m12_b2_stream_failed',
      execution,
      routeTrace
    });
  }

  schemaRepairFailure({
    code,
    task,
    capability,
    candidate,
    execution,
    routeTrace
  }) {
    const error = Object.assign(new Error(code), { code });
    return this.buildResponse({
      requestId: execution.requestId,
      task,
      capability,
      candidate,
      preferredProvider: 'deepseek',
      result: null,
      fallbackUsed: false,
      fallbackFrom: '',
      latency: 0,
      error,
      routeReason: 'router_core_m12_b2_schema_repair_rejected',
      execution,
      routeTrace
    });
  }

  async repairSchema({
    route = {},
    domain = '',
    rawContent = '',
    schemaContract = '',
    errors = [],
    timeoutMs = 8000,
    businessExecutionStarted = false,
    businessWriteStarted = false
  } = {}, invocation = {}) {
    const routeTrace = Array.isArray(route.routeTrace)
      ? route.routeTrace.map((entry) => Object.freeze({ ...entry }))
      : [];
    const capability = normalizeCapability('chat');
    const policy = resolveRouterPolicy(domain);
    const execution = createRouterExecutionContext({
      requestId: route.requestId,
      executionId: route.executionId,
      idempotencyKey: route.idempotencyKey,
      domain: policy.domain,
      businessExecutionStarted,
      businessWriteStarted
    });
    const primary = {
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      policyIndex: 0,
      preferred: true
    };
    const initial = routeTrace[0] || {};
    if (routeTrace.length > 1 || Number(initial.attemptNumber) > 1) {
      return this.schemaRepairFailure({
        code: 'SCHEMA_REPAIR_ATTEMPT_LIMIT',
        task: {},
        capability,
        candidate: primary,
        execution,
        routeTrace
      });
    }
    const repairForbidden = businessExecutionStarted ||
      businessWriteStarted ||
      !policy.domain ||
      schemaContract !== ASSISTANT_PROVIDER_PLAN_SCHEMA_ID ||
      !String(rawContent || '').trim() ||
      String(rawContent).length > 65536 ||
      route.selectedProvider !== primary.providerId ||
      route.selectedModel !== primary.modelId ||
      routeTrace.length !== 1 ||
      initial.success !== true ||
      initial.providerId !== primary.providerId ||
      initial.modelId !== primary.modelId ||
      initial.requestId !== execution.requestId ||
      initial.executionId !== execution.executionId ||
      (initial.domain && initial.domain !== policy.domain);
    if (repairForbidden) {
      return this.schemaRepairFailure({
        code: 'SCHEMA_REPAIR_FORBIDDEN',
        task: {},
        capability,
        candidate: primary,
        execution,
        routeTrace
      });
    }
    if (Number(initial.attemptNumber) !== 1) {
      return this.schemaRepairFailure({
        code: 'SCHEMA_REPAIR_ATTEMPT_LIMIT',
        task: {},
        capability,
        candidate: primary,
        execution,
        routeTrace
      });
    }

    const settings = this.settings.load();
    const candidate = this.registry.listPolicyCandidates(settings, policy, capability)
      .find((item) => item.providerId === primary.providerId && item.modelId === primary.modelId);
    if (!candidate) {
      return this.schemaRepairFailure({
        code: 'NO_USABLE_RUNTIME_CONNECTION',
        task: {},
        capability,
        candidate: primary,
        execution,
        routeTrace
      });
    }

    const task = {
      input: String(rawContent),
      messages: buildSchemaRepairMessages({ schemaContract, rawContent, errors }),
      capability,
      metadata: {
        purpose: 'assistant_provider_plan_schema_repair_v1',
        memoryPolicy: 'disabled',
        routeDomain: policy.domain,
        attemptType: 'schema_repair',
        requestId: execution.requestId,
        executionId: execution.executionId
      },
      options: {
        model: primary.modelId,
        timeoutMs: Math.max(1000, Math.min(30000, Number(timeoutMs || 8000)))
      }
    };
    const runtimeContext = createAIRequestRuntimeContext(task, { capability });
    const attempt = execution.attempt(2, candidate, 'schema_repair');
    const startedAt = new Date().toISOString();
    const started = clockMs();
    try {
      const result = await this.invokeProviderAttempt({
        method: 'generate',
        candidate,
        request: task,
        runtimeContext,
        settings,
        attempt,
        invocation
      });
      const durationMs = Math.round(clockMs() - started);
      const entry = this.safeRouteTrace({
        attempt,
        domain: policy.domain,
        durationMs,
        success: true,
        businessWriteStarted: false
      });
      const combinedTrace = [...routeTrace, entry];
      this.recordTrace({
        ...entry,
        candidate,
        capability,
        routeReason: 'router_core_m12_b2_schema_repair',
        startedAt,
        durationMs,
        tokenUsage: result?.usage || null
      });
      this.recordHealth(primary.providerId, { success: true, durationMs });
      return this.buildResponse({
        requestId: execution.requestId,
        task,
        capability,
        candidate,
        preferredProvider: primary.providerId,
        result,
        fallbackUsed: false,
        fallbackFrom: '',
        latency: durationMs,
        error: null,
        routeReason: 'router_core_m12_b2_schema_repair',
        execution,
        routeTrace: combinedTrace
      });
    } catch (error) {
      const durationMs = Math.round(clockMs() - started);
      const classified = classifyRouterError(error);
      const entry = this.safeRouteTrace({
        attempt,
        domain: policy.domain,
        durationMs,
        errorClass: classified.code,
        success: false,
        businessWriteStarted: false
      });
      const combinedTrace = [...routeTrace, entry];
      this.recordTrace({
        ...entry,
        candidate,
        capability,
        routeReason: 'router_core_m12_b2_schema_repair',
        startedAt,
        durationMs,
        errorCode: classified.code
      });
      this.recordHealth(primary.providerId, {
        success: false,
        durationMs,
        errorCode: classified.code,
        httpStatus: classified.status
      });
      return this.buildResponse({
        requestId: execution.requestId,
        task,
        capability,
        candidate,
        preferredProvider: primary.providerId,
        result: null,
        fallbackUsed: false,
        fallbackFrom: '',
        latency: durationMs,
        error,
        routeReason: 'router_core_m12_b2_schema_repair_failed',
        execution,
        routeTrace: combinedTrace
      });
    }
  }

  pricingForCandidate(candidate = {}, settings = {}) {
    return candidate.pricing ||
      candidate.provider?.pricing ||
      settings.providers?.[candidate.providerId]?.pricing ||
      null;
  }

  async invokeProviderAttempt({
    method,
    candidate,
    request = {},
    runtimeContext = null,
    settings = {},
    attempt,
    invocation = {},
    streamOptions = {}
  } = {}) {
    return this.invokeGuardedOperation({
      candidate,
      request,
      attempt,
      invocation,
      pricing: this.pricingForCandidate(candidate, settings),
      operation: (guardedRequest) => this.callProvider(
        method,
        candidate.providerId,
        guardedRequest,
        runtimeContext,
        settings,
        streamOptions
      )
    });
  }

  async invokeGuardedOperation({
    candidate,
    request = {},
    attempt,
    invocation = {},
    pricing = null,
    operation
  } = {}) {
    if (typeof operation !== 'function') {
      const error = new Error('ACCESS_CONTROL_UNAVAILABLE');
      error.code = 'ACCESS_CONTROL_UNAVAILABLE';
      throw error;
    }
    const reservation = this.accessControl.reserveProviderAttempt({
      subject: invocation.subject,
      requestLease: invocation.requestLease,
      attempt,
      request,
      pricing
    });
    let result;
    let providerError = null;
    try {
      result = await operation(reservation.request);
    } catch (error) {
      providerError = error;
    }

    this.accessControl.settleProviderAttempt({
      reservation,
      usage: result?.usage || providerError?.usage || null,
      outcome: providerError ? 'failed' : 'success'
    });
    if (providerError) throw providerError;
    return result;
  }

  async callProvider(
    method,
    providerId,
    request = {},
    runtimeContext = null,
    settings = {},
    streamOptions = {}
  ) {
    const nextRequest = { ...request, provider: providerId };
    if (method === 'streamChat') {
      return this.providers.streamChat(nextRequest, streamOptions);
    }
    if (isGatewayRuntimeEnabled(settings)) {
      return this.gatewayRuntime.invoke({
        method,
        providerId,
        request: nextRequest,
        runtimeContext,
        providerConfig: settings.providers?.[providerId] || {}
      });
    }
    return method === 'generate' ? this.providers.generate(nextRequest) : this.providers.chat(nextRequest);
  }

  recordTrace(trace) {
    try {
      const { candidate = {}, ...safeTrace } = trace;
      this.traces?.record({
        ...safeTrace,
        providerId: candidate.providerId || '',
        modelId: candidate.modelId || ''
      });
    } catch { /* Trace failures must not block user requests. */ }
  }

  recordHealth(providerId, outcome) {
    try { this.settings.recordProviderHealth?.(providerId, outcome); } catch { /* Health persistence is best effort. */ }
  }

  markBusinessExecution(route = {}, outcome = {}) {
    try {
      return this.traces?.markExecution?.({
        requestId: route.requestId,
        executionId: route.executionId,
        finalProvider: route.selectedProvider,
        businessWriteStarted: outcome.businessExecutionStarted === true || outcome.businessWriteStarted === true,
        businessWriteOccurred: outcome.businessWriteOccurred === true
      }) || 0;
    } catch {
      return 0;
    }
  }

  buildResponse({
    requestId: id,
    task,
    capability,
    candidate,
    preferredProvider,
    result,
    fallbackUsed,
    fallbackFrom,
    latency,
    error,
    routeReason,
    execution = null,
    routeTrace = []
  }) {
    const errorPayload = normalizeError(error, candidate?.providerId);
    const rawContent = errorPayload ? errorPayload.message : resultContent(result);
    const content = this.responsePolicy.applyContent(rawContent, { programResult: task.metadata?.programResult || '' });
    return {
      requestId: id,
      executionId: execution?.executionId || '',
      idempotencyKey: execution?.idempotencyKey || '',
      routeTrace: [...routeTrace],
      taskType: task.metadata?.taskType || '',
      capability,
      selectedProvider: candidate?.providerId || '',
      selectedModel: candidate?.modelId || result?.model || '',
      routeReason,
      fallbackUsed,
      fallbackFrom: fallbackFrom || '',
      fallbackTo: fallbackUsed ? candidate?.providerId || '' : '',
      result,
      latency,
      usage: result?.usage || null,
      error: errorPayload,
      provider: candidate?.providerId || '',
      model: candidate?.modelId || result?.model || '',
      content,
      mocked: Boolean(result?.mocked),
      raw: result?.raw || null,
      createdAt: result?.createdAt || new Date().toISOString(),
      metadata: {
        ...(task.metadata || {}),
        capability,
        routedBy: 'AIRouter',
        preferredProvider
      }
    };
  }
}

export const aiRouter = new AIRouter();
export default aiRouter;
