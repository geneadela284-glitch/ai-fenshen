export const defaultAiSettings = {
  appearanceTheme: 'classic',
  provider: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  defaultModel: 'deepseek-v4-flash',
  costStrategy: 'Balanced',
  router: {
    routes: {}
  },
  gateway: {
    runtime: {
      enabled: false
    }
  },
  temperature: 0.7,
  maxTokens: 2048
};

export const providerModelDefaults = {
  deepseek: 'deepseek-v4-flash',
  qwen: 'qwen-max',
  kimi: 'moonshot-v1-8k',
  doubao: 'doubao-seed-2-0-lite-260215',
  zhipu: 'glm-4.5',
  openai: 'gpt-4.1',
  claude: 'claude-sonnet-4',
  gemini: 'gemini-2.5-pro'
};

export const providerModelOptions = {
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
    { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' }
  ],
  qwen: [
    { value: 'qwen-max', label: 'qwen-max' },
    { value: 'qwen-plus', label: 'qwen-plus' },
    { value: 'qwen-turbo', label: 'qwen-turbo' },
    { value: 'qwen3-vl-plus', label: 'qwen3-vl-plus（视觉）' },
    { value: 'qwen3.5-ocr', label: 'qwen3.5-ocr（OCR）' },
    { value: 'qwen-vl-plus', label: 'qwen-vl-plus（视觉）' },
    { value: 'qwen-vl-max', label: 'qwen-vl-max（视觉）' },
    { value: 'qwen3.7-max', label: 'qwen3.7-max' },
    { value: 'qwen3.7-plus', label: 'qwen3.7-plus' },
    { value: 'qwen3.6-flash', label: 'qwen3.6-flash' }
  ],
  kimi: [
    { value: 'moonshot-v1-8k', label: 'moonshot-v1-8k' },
    { value: 'moonshot-v1-32k', label: 'moonshot-v1-32k' },
    { value: 'moonshot-v1-128k', label: 'moonshot-v1-128k' },
    { value: 'kimi-k2.7-code', label: 'kimi-k2.7-code' }
  ],
  doubao: [
    { value: 'doubao-seed-2-0-lite-260215', label: 'doubao-seed-2-0-lite-260215（视觉）' },
    { value: 'doubao-seed-1-8-251228', label: 'doubao-seed-1-8-251228（视觉）' },
    { value: 'doubao-seed-1-6-250615', label: 'doubao-seed-1-6-250615' },
    { value: 'doubao-1.5-pro-32k', label: 'doubao-1.5-pro-32k' },
    { value: 'doubao-1.5-lite-32k', label: 'doubao-1.5-lite-32k' },
    { value: 'doubao-pro-32k', label: 'doubao-pro-32k' }
  ],
  zhipu: [
    { value: 'glm-4.5', label: 'glm-4.5' },
    { value: 'glm-4.5-air', label: 'glm-4.5-air' },
    { value: 'glm-4v-plus', label: 'glm-4v-plus（视觉）' }
  ],
  openai: [
    { value: 'gpt-4.1', label: 'gpt-4.1' },
    { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
    { value: 'o4-mini', label: 'o4-mini' },
    { value: 'gpt-5.6', label: 'gpt-5.6' }
  ],
  claude: [
    { value: 'claude-sonnet-4', label: 'claude-sonnet-4' },
    { value: 'claude-opus-4', label: 'claude-opus-4' },
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
    { value: 'claude-opus-4-8', label: 'claude-opus-4-8' }
  ],
  gemini: [
    { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' }
  ]
};

export function getProviderModelOptions(providerId, currentModel = '') {
  const options = providerModelOptions[providerId] || [];
  if (!currentModel || options.some((option) => option.value === currentModel)) return options;
  return [{ value: currentModel, label: `${currentModel} (saved)` }, ...options];
}
