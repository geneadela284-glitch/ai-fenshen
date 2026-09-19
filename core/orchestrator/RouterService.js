import { capabilityEngine } from './CapabilityEngine.js';

const domesticProviderIds = ['deepseek', 'qwen', 'kimi', 'zhipu', 'doubao'];
const costStrategies = ['Cheap', 'Balanced', 'Quality', 'Fast'];

function providerConfigured(provider = {}) {
  return Boolean(provider.enabled && provider.apiKey && provider.baseUrl && (provider.defaultModel || provider.model));
}

function providerHealthy(provider = {}) {
  return ['可用', '未测试'].includes(provider.status) || (provider.apiKey && provider.status !== '已禁用');
}

function strategyScore(provider = {}, strategy = 'Balanced') {
  if (strategy === 'Cheap') return Number(provider.costInput || 0) + Number(provider.costOutput || 0);
  if (strategy === 'Fast') return Number(provider.lastLatency || 0) || Number(provider.priority || 100);
  if (strategy === 'Quality') return -(Number(provider.maxContext || 0) + Number(provider.maxOutput || 0));
  return Number(provider.priority || 100);
}

export class RouterService {
  constructor({ capabilities = capabilityEngine, allowInternational = false } = {}) {
    this.capabilities = capabilities;
    this.allowInternational = allowInternational;
  }

  listCandidates(providerConfig = {}, requiredCapabilities = []) {
    const providers = Object.values(providerConfig.providerConfigs || providerConfig.providers || {});
    return providers
      .filter((provider) => this.allowInternational || domesticProviderIds.includes(provider.id))
      .filter((provider) => providerConfigured(provider))
      .filter((provider) => providerHealthy(provider))
      .filter((provider) => this.capabilities.supports(provider, requiredCapabilities));
  }

  selectProvider({ taskType = 'general', providerConfig = {}, requiredCapabilities = null, costStrategy = '' } = {}) {
    const required = requiredCapabilities || this.capabilities.requiredForTask(taskType);
    const strategy = costStrategies.includes(costStrategy || providerConfig.costStrategy) ? (costStrategy || providerConfig.costStrategy) : 'Balanced';
    const candidates = this.listCandidates(providerConfig, required);
    const sorted = candidates.sort((a, b) => {
      const score = strategyScore(a, strategy) - strategyScore(b, strategy);
      return score || Number(a.priority || 100) - Number(b.priority || 100);
    });
    const selected = sorted[0] || this.getFallbackDefault(providerConfig);
    const fallbackProviders = this.buildFallbacks(selected, providerConfig, required);

    return {
      taskType,
      requiredCapabilities: required,
      selectedProvider: selected?.id || 'deepseek',
      selectedModel: this.resolveModelForTask(selected, taskType),
      fallbackProviders,
      costStrategy: strategy,
      candidates: sorted.map((provider) => ({
        id: provider.id,
        name: provider.name,
        priority: provider.priority,
        status: provider.status,
        latency: provider.lastLatency || 0,
        capabilities: this.capabilities.normalizeCapabilities(provider)
      })),
      capabilityMatch: selected ? this.capabilities.explain(selected, required) : null
    };
  }

  getFallbackDefault(providerConfig = {}) {
    const providers = providerConfig.providerConfigs || providerConfig.providers || {};
    return providers.deepseek || Object.values(providers)[0] || null;
  }

  resolveModelForTask(provider = {}, taskType = 'general') {
    if (!provider) return '';
    if (taskType === 'reasoning' || taskType === 'data_analysis' || taskType === 'contract_review') {
      return provider.reasoningModel || provider.defaultModel || provider.model || '';
    }
    return provider.defaultModel || provider.model || '';
  }

  buildFallbacks(selected, providerConfig = {}, requiredCapabilities = []) {
    const providers = providerConfig.providerConfigs || providerConfig.providers || {};
    const explicit = selected?.fallbackProviders || [];
    const explicitFallbacks = explicit
      .map((providerId) => providers[providerId])
      .filter(Boolean)
      .filter((provider) => provider.id !== selected?.id)
      .filter((provider) => providerConfigured(provider) && providerHealthy(provider));
    const automatic = Object.values(providers)
      .filter((provider) => domesticProviderIds.includes(provider.id))
      .filter((provider) => provider.id !== selected?.id)
      .filter((provider) => providerConfigured(provider) && providerHealthy(provider))
      .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));
    return [...new Set([...explicitFallbacks, ...automatic].map((provider) => provider.id))];
  }
}

export const routerService = new RouterService();
export default routerService;
