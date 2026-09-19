export const domesticProviders = ['qwen', 'deepseek', 'kimi', 'doubao', 'zhipu'];

export const providerModelMap = {
  qwen: 'qwen-plus',
  deepseek: 'deepseek-v4-flash',
  kimi: 'moonshot-v1-32k',
  doubao: '',
  zhipu: 'glm-4.5',
  openai: 'gpt-5'
};

export const taskRoutingPolicies = {
  writing: {
    preferredProvider: 'qwen',
    fallbackProviders: ['deepseek']
  },
  reasoning: {
    preferredProvider: 'deepseek',
    fallbackProviders: []
  },
  data_analysis: {
    preferredProvider: 'deepseek',
    fallbackProviders: []
  },
  presentation: {
    preferredProvider: 'qwen',
    fallbackProviders: ['deepseek']
  },
  general: {
    preferredProvider: 'default',
    fallbackProviders: ['deepseek']
  }
};

export function isDomesticProvider(providerId) {
  return domesticProviders.includes(providerId);
}

export function getProviderModel(providerId, settings = {}) {
  if (settings.model && settings.activeProvider === providerId) {
    return settings.model;
  }
  return providerModelMap[providerId] || settings.model || '';
}
