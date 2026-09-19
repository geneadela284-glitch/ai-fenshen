import {
  legacyErrorToGatewayError,
  legacyProviderResponseToAIResponse,
  normalizeLegacyUsage
} from '../aiGateway/protocol/legacyCompatibility.js';
import { createGatewayError } from '../aiGateway/protocol/errorCodes.js';
import { modelSupportsCapability } from '../router/ModelCapabilities.js';
import { getProviderModelOptions } from '../settings/defaultSettings.js';
import providerManager from './providerManager.js';

const GATEWAY_TO_ROUTER_CAPABILITY = Object.freeze({
  chat: 'CHAT',
  writing: 'WRITE',
  reasoning: 'REASONING',
  summarization: 'SUMMARY',
  structured_extraction: 'STRUCTURED_EXTRACTION',
  data_explanation: 'REPORT',
  vision: 'VISION',
  ocr: 'OCR',
  translation: 'TRANSLATE',
  meeting_summary: 'MEETING_SUMMARY',
  knowledge_query: 'CHAT',
  memory_query: 'CHAT'
});

function configModel(config = {}, fallback = '') {
  return config.defaultModel || config.model || fallback || '';
}

function legacyRequestFromGateway(request = {}, context = {}, providerId = '') {
  const legacy = context.legacyRequest && typeof context.legacyRequest === 'object'
    ? context.legacyRequest
    : {};
  const providerConfig = context.providerConfig || {};
  return {
    ...legacy,
    provider: providerId,
    input: legacy.input ?? request.input ?? '',
    attachments: legacy.attachments ?? request.attachments ?? [],
    metadata: { ...(legacy.metadata || {}), ...(request.metadata || {}), requestId: request.requestId },
    options: {
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      model: configModel(providerConfig, legacy.options?.model),
      temperature: providerConfig.temperature,
      maxTokens: providerConfig.maxTokens,
      timeoutMs: providerConfig.timeout,
      ...(legacy.options || {})
    }
  };
}

function parseStructuredContent(content) {
  if (content && typeof content === 'object') return structuredClone(content);
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw createGatewayError({ code: 'STRUCTURED_OUTPUT_INVALID' });
  }
}

export class ProviderAdapter {
  constructor({ providerId = '', definition = {}, manager = providerManager } = {}) {
    this.providerId = providerId || definition.id || '';
    this.definition = definition;
    this.manager = manager;
  }

  validateConfig(config = {}) {
    if (!config.apiKey) return { ok: false, valid: false, errors: [{ path: 'apiKey', code: 'MISSING_API_KEY', message: '请先配置 API Key' }], warnings: [], message: '请先配置 API Key', code: 'MISSING_API_KEY' };
    if (!config.baseUrl) return { ok: false, valid: false, errors: [{ path: 'baseUrl', code: 'INVALID_CONFIG', message: '请填写 Base URL' }], warnings: [], message: '请填写 Base URL', code: 'INVALID_CONFIG' };
    if (!configModel(config)) return { ok: false, valid: false, errors: [{ path: 'defaultModel', code: 'INVALID_CONFIG', message: '请填写 Default Model' }], warnings: [], message: '请填写 Default Model', code: 'INVALID_CONFIG' };
    return { ok: true, valid: true, errors: [], warnings: [] };
  }

  async testConnection(config = {}) {
    const validation = this.validateConfig(config);
    if (!validation.ok) return { ...validation, status: '未配置', latency: 0 };
    const startedAt = Date.now();
    try {
      const result = await this.manager.chat({
        provider: this.providerId,
        messages: [{ role: 'user', content: '请回复：连接成功' }],
        options: {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: configModel(config),
          temperature: config.temperature,
          maxTokens: Math.min(Number(config.maxTokens || 64), 64),
          timeoutMs: config.timeout
        },
        metadata: { source: 'admin-provider-test', provider: this.providerId }
      });
      return {
        ok: true,
        status: '可用',
        message: 'Connected',
        httpStatus: result.httpStatus || 200,
        latency: Date.now() - startedAt,
        model: result.model || configModel(config),
        result
      };
    } catch (error) {
      const normalized = this.normalizeError(error);
      return {
        ok: false,
        status: '连接失败',
        message: normalized.message,
        code: normalized.code,
        httpStatus: Number(error?.status || 0) || null,
        latency: Date.now() - startedAt
      };
    }
  }

  async healthCheck(config = {}, context = {}) {
    const result = await this.testConnection(config);
    return {
      providerId: this.providerId,
      healthy: result.ok === true,
      status: result.status,
      latencyMs: result.latency || 0,
      modelId: result.model || configModel(config) || null,
      error: result.ok ? null : this.normalizeError({ code: result.code, message: result.message }, context),
      checkedAt: new Date().toISOString()
    };
  }

  async listModels(config = {}) {
    return getProviderModelOptions(this.providerId, configModel(config, this.definition.defaultModel)).map((model) => ({
      id: model.value,
      name: model.label,
      providerId: this.providerId,
      capabilities: this.getCapabilities(model.value)
    }));
  }

  supportsCapability(model = '', capability = '') {
    const normalized = String(capability || '').toLowerCase();
    let supported;
    if (normalized === 'tool_call') supported = Boolean(this.definition.toolCallSupported);
    else if (normalized === 'meeting_transcription') supported = false;
    else {
      const routerCapability = GATEWAY_TO_ROUTER_CAPABILITY[normalized];
      supported = Boolean(routerCapability && modelSupportsCapability(this.providerId, model, routerCapability, this.definition));
    }
    return {
      providerId: this.providerId,
      modelId: model || null,
      capability: normalized,
      supported,
      reason: supported ? 'supported' : 'capability_not_supported'
    };
  }

  async invoke(request = {}, context = {}) {
    return this.manager.chat(legacyRequestFromGateway(request, context, this.providerId));
  }

  async invokeVision(request = {}, context = {}) {
    const model = configModel(context.providerConfig, context.legacyRequest?.options?.model || this.definition.defaultModel);
    if (!this.supportsCapability(model, 'vision').supported) {
      throw createGatewayError({ code: 'CAPABILITY_NOT_SUPPORTED', providerId: this.providerId, modelId: model || null });
    }
    return this.invoke(request, context);
  }

  async invokeStructured(request = {}, schema = {}, context = {}) {
    const raw = await this.invoke(request, {
      ...context,
      legacyRequest: {
        ...(context.legacyRequest || {}),
        metadata: { ...(context.legacyRequest?.metadata || {}), outputSchema: schema }
      }
    });
    return { ...raw, structuredOutput: raw.structuredOutput ?? parseStructuredContent(raw.content) };
  }

  normalizeResponse(rawResponse = {}, context = {}) {
    return legacyProviderResponseToAIResponse(rawResponse, {
      ...context,
      providerId: this.providerId,
      modelId: context.modelId || rawResponse.model || null
    });
  }

  normalizeError(error, context = {}) {
    return legacyErrorToGatewayError(error, { ...context, providerId: this.providerId });
  }

  normalizeUsage(rawUsage) {
    return normalizeLegacyUsage(rawUsage);
  }

  estimateCost(usage, model, pricing = {}) {
    const normalized = this.normalizeUsage(usage);
    if (!normalized || !pricing.version || !pricing.source) return null;
    const inputPerMillion = Number(pricing.inputPerMillion);
    const outputPerMillion = Number(pricing.outputPerMillion);
    if (![inputPerMillion, outputPerMillion].every((value) => Number.isFinite(value) && value >= 0)) return null;
    return {
      amount: ((normalized.inputTokens * inputPerMillion) + (normalized.outputTokens * outputPerMillion)) / 1_000_000,
      currency: pricing.currency || 'CNY',
      source: pricing.source,
      pricingVersion: pricing.version,
      modelId: model || null
    };
  }

  getCapabilities(model = this.definition.defaultModel || '') {
    return Object.keys(GATEWAY_TO_ROUTER_CAPABILITY)
      .filter((capability) => this.supportsCapability(model, capability).supported)
      .concat(this.supportsCapability(model, 'tool_call').supported ? ['tool_call'] : []);
  }
}

export class DeepSeekAdapter extends ProviderAdapter {}
export class QwenAdapter extends ProviderAdapter {}
export class KimiAdapter extends ProviderAdapter {}
export class ZhipuAdapter extends ProviderAdapter {}
export class DoubaoAdapter extends ProviderAdapter {
  canonicalizeConfig(config = {}) {
    const model = config.defaultModel || config.model || config.endpointId || '';
    return { ...config, defaultModel: model, model };
  }

  validateConfig(config = {}) {
    const validation = super.validateConfig(this.canonicalizeConfig(config));
    if (!validation.valid) return validation;
    try {
      const endpoint = new URL(config.baseUrl);
      if (endpoint.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
    } catch {
      return {
        ok: false,
        valid: false,
        errors: [{ path: 'baseUrl', code: 'INVALID_CONFIG', message: 'Doubao Ark Base URL 必须是有效的 HTTPS 地址' }],
        warnings: [],
        message: 'Doubao Ark Base URL 必须是有效的 HTTPS 地址',
        code: 'INVALID_CONFIG'
      };
    }
    return validation;
  }

  testConnection(config = {}) {
    return super.testConnection(this.canonicalizeConfig(config));
  }

  invoke(request = {}, context = {}) {
    return super.invoke(request, {
      ...context,
      providerConfig: this.canonicalizeConfig(context.providerConfig || {})
    });
  }

  async listModels(config = {}) {
    const model = config.defaultModel || config.model || config.endpointId || '';
    if (!model) return [];
    const configured = config.modelCapabilities?.[model];
    const capabilities = Array.isArray(configured)
      ? [...new Set(configured.map((capability) => String(capability || '').toLowerCase()).filter(Boolean))]
      : this.getCapabilities(model);
    return [{
      id: model,
      name: model,
      providerId: this.providerId,
      capabilities,
      source: 'configured'
    }];
  }

  supportsCapability(model = '', capability = '', config = this.definition) {
    const normalized = String(capability || '').toLowerCase();
    if (!['vision', 'ocr'].includes(normalized)) {
      return super.supportsCapability(model, capability);
    }
    const routerCapability = GATEWAY_TO_ROUTER_CAPABILITY[normalized];
    const supported = Boolean(routerCapability && modelSupportsCapability(
      this.providerId,
      model,
      routerCapability,
      config
    ));
    return {
      providerId: this.providerId,
      modelId: model || null,
      capability: normalized,
      supported,
      reason: supported ? 'supported' : 'capability_not_supported'
    };
  }

  async invokeVision(request = {}, context = {}) {
    const providerConfig = context.providerConfig || {};
    const model = providerConfig.defaultModel
      || providerConfig.model
      || providerConfig.endpointId
      || context.legacyRequest?.options?.model
      || this.definition.defaultModel
      || '';
    if (!this.supportsCapability(model, 'vision', providerConfig).supported) {
      throw createGatewayError({ code: 'CAPABILITY_NOT_SUPPORTED', providerId: this.providerId, modelId: model || null });
    }
    return this.invoke(request, context);
  }
}

class LegacyProviderAdapter {
  constructor({ providerId = '', definition = {}, manager = providerManager } = {}) {
    this.providerId = providerId || definition.id || '';
    this.definition = definition;
    this.manager = manager;
  }

  validateConfig(config = {}) {
    if (!config.apiKey) return { ok: false, message: '请先配置 API Key', code: 'MISSING_API_KEY' };
    if (!config.baseUrl) return { ok: false, message: '请填写 Base URL', code: 'INVALID_CONFIG' };
    if (!configModel(config)) return { ok: false, message: config.id === 'doubao' ? '请填写 Model' : '请填写 Default Model', code: 'INVALID_CONFIG' };
    return { ok: true };
  }

  testConnection(config = {}) {
    return new ProviderAdapter({ providerId: this.providerId, definition: this.definition, manager: this.manager }).testConnection(config);
  }

  invoke(request = {}) {
    return this.manager.chat({ ...request, provider: this.providerId });
  }

  normalizeError(error) {
    const code = error?.code || '';
    const status = error?.status || '';
    if (code === 'TIMEOUT' || error?.name === 'AbortError') return { message: 'Timeout', code: 'TIMEOUT' };
    if (code === 'NETWORK_ERROR') return { message: 'Network Error', code: 'NETWORK_ERROR' };
    if ([401, 403, 404].includes(Number(status))) return { message: String(status), code: `HTTP_${status}` };
    if (String(error?.message || '').includes('API Key')) return { message: '401', code: 'HTTP_401' };
    return { message: error?.message || 'Provider 连接失败', code: code || 'PROVIDER_ERROR' };
  }

  getCapabilities() {
    return Array.isArray(this.definition.tags) ? [...this.definition.tags] : [];
  }
}

const adapterClasses = Object.freeze({
  deepseek: DeepSeekAdapter,
  qwen: QwenAdapter,
  kimi: KimiAdapter,
  zhipu: ZhipuAdapter,
  doubao: DoubaoAdapter
});

export function getProviderAdapter(definition = {}, { manager = providerManager } = {}) {
  const Adapter = adapterClasses[definition.id] || LegacyProviderAdapter;
  return new Adapter({ providerId: definition.id || 'deepseek', definition, manager });
}

export default adapterClasses;
