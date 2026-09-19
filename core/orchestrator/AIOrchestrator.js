import providerManager from '../providers/providerManager.js';
import { promptManager } from '../prompts/index.js';
import { memoryManager } from '../memory/memoryManager.js';
import taskRouter from './TaskRouter.js';

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return usage;
}

function getErrorPayload(error) {
  if (!error) return null;
  return {
    message: error.message || 'AI 调度失败',
    code: error.code || 'AI_ORCHESTRATOR_ERROR',
    provider: error.provider || null
  };
}

function getResultContent(result) {
  if (!result) return '';
  return result.content || result.text || result.output || '';
}

function isMockOnlyRequest(request = {}) {
  return Boolean(request.mockOnly || request.metadata?.mockOnly || request.options?.mockOnly);
}

function requiresRealAi(request = {}) {
  return Boolean(request.requiresRealAi || request.metadata?.requiresRealAi || request.options?.requiresRealAi);
}

function buildMockContent(route) {
  const input = route.input || '当前任务';
  const templates = {
    writing: `已理解你的写作目标：“${input}”。建议先确认受众、产品卖点和使用场景，然后生成一版正式、清晰、适合企业客户阅读的内容草稿。`,
    reasoning: `已开始梳理这项判断：“${input}”。建议从目标、风险、资源、时间和可执行步骤五个方面拆解，先输出可确认的方案框架。`,
    data_analysis: `已收到销售数据分析任务：“${input}”。建议先整理门店、单品、销售额、成交率和异常项，再输出排行与风险提醒。`,
    presentation: `已准备生成汇报结构：“${input}”。建议按背景、目标、关键数据、问题、方案和下一步安排组织 PPT 大纲。`,
    general: `已收到你的工作请求：“${input}”。我会先判断任务类型，再整理成可执行的下一步。`
  };
  return templates[route.taskType] || templates.general;
}

function createMockResult(route, method) {
  const content = buildMockContent(route);
  return {
    provider: 'work-secretary-mock',
    mode: method,
    model: 'mock',
    content,
    usage: {
      inputTokens: Math.ceil((route.input || '').length / 2),
      outputTokens: Math.ceil(content.length / 2)
    },
    mocked: true,
    createdAt: new Date().toISOString()
  };
}

export class AIOrchestrator {
  constructor({
    providers = providerManager,
    router = taskRouter,
    prompts = promptManager,
    memory = memoryManager
  } = {}) {
    this.providers = providers;
    this.router = router;
    this.prompts = prompts;
    this.memory = memory;
  }

  getProviderConfig() {
    return typeof this.providers.getConfig === 'function'
      ? this.providers.getConfig()
      : {
          activeProvider: this.providers.activeProvider || 'deepseek',
          defaultProvider: this.providers.defaultProvider || 'deepseek',
          settings: this.providers.settings || {}
        };
  }

  async generate(request = {}) {
    return this.dispatch('generate', request);
  }

  async chat(request = {}) {
    return this.dispatch('chat', request);
  }

  async dispatch(method = 'chat', request = {}) {
    const startedAt = nowMs();
    const providerConfig = this.getProviderConfig();
    const route = this.router.route(request, providerConfig);
    const attempts = this.buildAttempts(route, request);
    const normalizedRequest = this.buildRequest(request, route);
    let lastError = null;

    if (isMockOnlyRequest(request)) {
      const result = createMockResult(route, method);
      return this.buildResponse({
        request,
        route,
        providerId: route.preferredProvider,
        result,
        fallbackUsed: false,
        latency: Math.round(nowMs() - startedAt),
        error: null
      });
    }

    for (const providerId of attempts) {
      const fallbackUsed = providerId !== route.preferredProvider;
      try {
        const result = await this.callProvider(method, providerId, normalizedRequest, route);
        return this.buildResponse({
          request,
          route,
          providerId,
          result,
          fallbackUsed,
          latency: Math.round(nowMs() - startedAt),
          error: null
        });
      } catch (error) {
        lastError = error;
        if (!route.fallbackProviders.length || providerId === attempts.at(-1)) break;
      }
    }

    const fallbackUsed = attempts.length > 1;
    const providerId = attempts.at(-1) || route.preferredProvider || 'deepseek';
    return this.buildResponse({
      request,
      route,
      providerId,
      result: null,
      fallbackUsed,
      latency: Math.round(nowMs() - startedAt),
      error: lastError || new Error('DeepSeek 不可用，请检查 Provider 配置。')
    });
  }

  buildRequest(request, route) {
    return {
      ...request,
      provider: undefined,
      providerId: undefined,
      metadata: {
        ...(request.metadata || {}),
        taskType: route.taskType,
        orchestrated: true
      },
      context: {
        ...(request.context || {}),
        workspaceId: request.workspaceId || request.context?.workspaceId || '',
        memory: request.memory ?? request.context?.memory ?? null,
        knowledge: request.knowledge ?? request.context?.knowledge ?? null,
        prompt: request.prompt ?? request.context?.prompt ?? null,
        metadata: request.metadata || {}
      }
    };
  }

  async callProvider(method, providerId, request, route) {
    const providerMethod = method === 'generate' ? 'generate' : 'chat';
    const nextRequest = {
      ...request,
      provider: providerId,
      options: {
        ...(request.options || {}),
        model: this.resolveProviderModel(providerId, route) || request.options?.model
      }
    };

    if (providerMethod === 'generate') {
      return this.providers.generate(nextRequest);
    }
    return this.providers.chat(nextRequest);
  }

  buildResponse({ request, route, providerId, result, fallbackUsed, latency, error }) {
    const selectedModel = this.resolveProviderModel(providerId, route) || result?.model || result?.raw?.model || '';
    const errorPayload = getErrorPayload(error);
    const content = errorPayload ? errorPayload.message : getResultContent(result);

    return {
      taskType: route.taskType,
      selectedProvider: providerId,
      selectedModel,
      fallbackUsed,
      result,
      latency,
      usage: normalizeUsage(result?.usage),
      error: errorPayload,
      debug: {
        originalGoal: route.input,
        taskType: route.taskType,
        preferredProvider: route.preferredProvider,
        selectedProvider: providerId,
        requiredCapabilities: route.requiredCapabilities || [],
        costStrategy: route.costStrategy || '',
        fallbackUsed,
        latency,
        usage: normalizeUsage(result?.usage),
        error: errorPayload?.message || ''
      },
      provider: providerId,
      model: selectedModel,
      content,
      mocked: Boolean(result?.mocked),
      raw: result?.raw || null,
      createdAt: result?.createdAt || new Date().toISOString(),
      metadata: {
        ...(request.metadata || {}),
        taskType: route.taskType,
        orchestrated: true
      }
    };
  }

  buildAttempts(route, request) {
    const attempts = [route.preferredProvider, ...route.fallbackProviders];
    if (!requiresRealAi(request)) return attempts;

    const realAttempts = attempts.filter((providerId) => {
      try {
        return this.providers.getProvider(providerId)?.status !== 'mock';
      } catch {
        return false;
      }
    });

    return realAttempts.length ? realAttempts : ['deepseek'];
  }

  resolveProviderModel(providerId, route = {}) {
    if (route.preferredProvider === providerId && route.selectedModel) return route.selectedModel;
    const config = this.getProviderConfig();
    const provider = config.providerConfigs?.[providerId] || {};
    if ((route.taskType === 'reasoning' || route.taskType === 'data_analysis') && provider.reasoningModel) {
      return provider.reasoningModel;
    }
    return provider.defaultModel || provider.model || config.settings?.model || '';
  }
}

export const aiOrchestrator = new AIOrchestrator();

export default aiOrchestrator;
