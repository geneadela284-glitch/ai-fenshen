import { providerRegistry } from '../providers/providerRegistry.js';
import { providerManager } from '../providers/providerManager.js';
import { defaultRoutePolicy, normalizeCapability } from './CapabilityMap.js';
import { inferModelCapabilities, modelSupportsCapability } from './ModelCapabilities.js';
import { classifyRouterError } from './RouterErrorClassifier.js';

function candidateModels(provider = {}, route = null) {
  return [
    route?.model,
    provider.defaultModel,
    provider.model,
    provider.reasoningModel,
    provider.advancedModel,
    ...(provider.modelOptions || []).map((option) => option?.value)
  ].filter((value, index, list) => value && list.indexOf(value) === index);
}

function healthRank(provider = {}) {
  if (provider.healthy === true) return 0;
  if (provider.status === '可用' && (provider.lastTestedAt || provider.lastSuccessAt)) return 0;
  if (provider.status === '连接失败' || provider.healthy === false) return 2;
  return 1;
}

function hasCredential(provider = {}) {
  return Boolean(provider.apiKey || provider.apiKeyConfigured);
}

function retryablePolicyHealthFailure(provider = {}) {
  if (provider.healthy !== false) return false;
  const errorCode = String(provider.lastErrorCode || provider.lastError || '').trim();
  return Boolean(errorCode && classifyRouterError({ code: errorCode }).fallbackEligible);
}

export class ModelRegistry {
  constructor({ providerRegistryStore = null, providers = providerManager } = {}) {
    this.providerRegistryStore = providerRegistryStore;
    this.providers = providers;
  }

  supportsDelivery(providerId, deliveryMode = 'chat') {
    if (!this.providers?.getCapabilities) return true;
    let capabilities;
    try {
      capabilities = this.providers.getCapabilities(providerId);
    } catch {
      return false;
    }
    if (deliveryMode === 'sse') {
      return capabilities.supportsStreaming === true ||
        capabilities.supportsSingleShotSseBridge === true;
    }
    return capabilities.supportsChat === true;
  }

  listProviders(settings = {}) {
    const providers = settings.providers || {};
    return providerRegistry.list().map((provider) => ({
      ...provider,
      ...(providers[provider.id] || providerRegistry.createDefaultConfig(provider.id))
    }));
  }

  getProvider(settings = {}, providerId = '') {
    return this.listProviders(settings).find((provider) => provider.id === providerId) || null;
  }

  getRoutePolicy(settings = {}, capability = '') {
    const key = normalizeCapability(capability);
    const configured = settings.router?.routes?.[key] || {};
    return {
      ...defaultRoutePolicy[key],
      ...configured,
      capability: key
    };
  }

  listRoutes(settings = {}) {
    return Object.keys(defaultRoutePolicy).map((capability) => ({
      ...this.getRoutePolicy(settings, capability),
      capability
    }));
  }

  resolveRoute(settings = {}, capability = '') {
    const policy = this.getRoutePolicy(settings, capability);
    const provider = this.getProvider(settings, policy.providerId);
    return {
      ...policy,
      provider,
      enabled: Boolean(provider?.enabled && hasCredential(provider)),
      status: hasCredential(provider) ? provider.status : '未启用',
      model: policy.model || provider?.defaultModel || provider?.model || ''
    };
  }

  listCandidates(settings = {}, capability = '') {
    const normalized = normalizeCapability(capability);
    const preferred = this.getRoutePolicy(settings, normalized);
    const candidates = [];

    this.listProviders(settings).forEach((provider) => {
      if (!provider.enabled || !hasCredential(provider) || provider.healthy !== true) return;
      const providerRoute = preferred.providerId === provider.id ? preferred : null;
      const modelId = candidateModels(provider, providerRoute)
        .find((candidate) => modelSupportsCapability(provider.id, candidate, normalized, provider));
      if (!modelId) return;
      candidates.push({
        providerId: provider.id,
        modelId,
        provider,
        capabilities: inferModelCapabilities(provider.id, modelId, provider),
        preferred: provider.id === preferred.providerId && modelId === preferred.model,
        healthRank: healthRank(provider),
        priority: Number(provider.priority || 999),
        latency: Number(provider.averageLatencyMs || provider.lastLatency || Number.MAX_SAFE_INTEGER),
        estimatedCost: Number(provider.costInput || 0) + Number(provider.costOutput || 0)
      });
    });

    return candidates.sort((a, b) =>
      Number(b.preferred) - Number(a.preferred)
      || a.healthRank - b.healthRank
      || a.priority - b.priority
      || a.latency - b.latency
      || a.estimatedCost - b.estimatedCost
    );
  }

  listPolicyCandidates(settings = {}, policy = {}, capability = '', { deliveryMode = 'chat' } = {}) {
    const normalized = normalizeCapability(capability);
    let registryById = null;
    let catalogIds = null;
    if (this.providerRegistryStore) {
      const registry = this.providerRegistryStore.readRegistry();
      const catalog = this.providerRegistryStore.readModelCatalog();
      registryById = new Map(registry.providers.map((provider) => [provider.provider_id, provider]));
      catalogIds = new Set(catalog.models
        .filter((model) => model.availability !== 'unavailable')
        .map((model) => `${model.provider_id}:${model.model_id}`));
    }

    const approvedCandidates = policy.allowFallback
      ? (policy.candidates || [])
      : (policy.candidates || []).slice(0, 1);
    const select = ({ allowTransientRecovery = false } = {}) => approvedCandidates.flatMap((approved, index) => {
      const provider = this.getProvider(settings, approved.providerId);
      const registryProvider = registryById?.get(approved.providerId) || null;
      const healthEligible = provider?.healthy === true || (
        allowTransientRecovery && retryablePolicyHealthFailure(provider)
      );
      if (!provider?.enabled || !hasCredential(provider) || !healthEligible) return [];
      if (registryById && registryProvider?.enabled !== true) return [];
      if (catalogIds && !catalogIds.has(`${approved.providerId}:${approved.modelId}`)) return [];
      if (!modelSupportsCapability(approved.providerId, approved.modelId, normalized, provider)) return [];
      if (!this.supportsDelivery(approved.providerId, deliveryMode)) return [];
      return [{
        providerId: approved.providerId,
        modelId: approved.modelId,
        provider,
        policyIndex: index,
        capabilities: inferModelCapabilities(approved.providerId, approved.modelId, provider),
        preferred: index === 0,
        healthRank: healthRank(provider),
        priority: index + 1,
        latency: Number(provider.averageLatencyMs || provider.lastLatency || Number.MAX_SAFE_INTEGER),
        estimatedCost: Number(provider.costInput || 0) + Number(provider.costOutput || 0)
      }];
    });
    const healthyCandidates = select();
    return healthyCandidates.length > 0
      ? healthyCandidates
      : select({ allowTransientRecovery: true });
  }
}

export const modelRegistry = new ModelRegistry();
export default modelRegistry;
