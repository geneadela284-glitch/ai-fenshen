import { getProviderModelOptions, providerModelDefaults } from '../settings/defaultSettings.js';

export const providerStatuses = ['未配置', '未测试', '可用', '连接失败', '已禁用'];

export const capabilityLabels = {
  Writing: '写作',
  Reasoning: '推理',
  Vision: '视觉',
  Coding: '编程',
  Meeting: '会议',
  Translation: '翻译',
  Knowledge: '知识库',
  OCR: 'OCR',
  'Table Analysis': '表格分析',
  Presentation: '汇报',
  Workflow: '工作流',
  'Long Context': '长文本',
  Embedding: '向量',
  Search: '搜索',
  'Tool Call': '工具调用'
};

const definitions = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: providerModelDefaults.deepseek,
    reasoningModel: 'deepseek-reasoner',
    adapter: 'openai-compatible',
    enabled: true,
    priority: 1,
    visionSupported: false,
    reasoningSupported: true,
    toolCallSupported: true,
    embeddingSupported: false,
    maxContext: 64000,
    maxOutput: 8192,
    rpm: 60,
    tpm: 120000,
    costInput: 0,
    costOutput: 0,
    tags: ['Writing', 'Reasoning', 'Table Analysis', 'Tool Call']
  },
  {
    id: 'qwen',
    name: '通义千问',
    vendor: 'DashScope',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: providerModelDefaults.qwen,
    advancedModel: 'qwen-max',
    adapter: 'openai-compatible',
    enabled: false,
    priority: 2,
    visionSupported: true,
    reasoningSupported: true,
    toolCallSupported: true,
    embeddingSupported: false,
    maxContext: 128000,
    maxOutput: 8192,
    rpm: 60,
    tpm: 120000,
    costInput: 0,
    costOutput: 0,
    tags: ['Writing', 'Reasoning', 'Vision', 'OCR', 'Translation', 'Presentation', 'Tool Call']
  },
  {
    id: 'kimi',
    name: 'Kimi / Moonshot',
    vendor: 'Moonshot',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: providerModelDefaults.kimi,
    adapter: 'openai-compatible',
    enabled: false,
    priority: 3,
    visionSupported: false,
    reasoningSupported: false,
    toolCallSupported: true,
    embeddingSupported: false,
    maxContext: 128000,
    maxOutput: 8192,
    rpm: 60,
    tpm: 120000,
    costInput: 0,
    costOutput: 0,
    tags: ['Long Context', 'Writing', 'Knowledge', 'Meeting']
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    vendor: 'Zhipu',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: providerModelDefaults.zhipu,
    adapter: 'openai-compatible',
    enabled: false,
    priority: 4,
    visionSupported: true,
    reasoningSupported: true,
    toolCallSupported: true,
    embeddingSupported: false,
    maxContext: 128000,
    maxOutput: 8192,
    rpm: 60,
    tpm: 120000,
    costInput: 0,
    costOutput: 0,
    tags: ['Reasoning', 'Vision', 'Writing', 'Tool Call']
  },
  {
    id: 'doubao',
    name: '豆包（Ark）',
    vendor: 'Volcengine Ark',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: providerModelDefaults.doubao,
    modelPlaceholder: 'Model',
    adapter: 'openai-compatible',
    enabled: false,
    priority: 5,
    visionSupported: true,
    reasoningSupported: false,
    toolCallSupported: true,
    embeddingSupported: false,
    maxContext: 128000,
    maxOutput: 8192,
    rpm: 60,
    tpm: 120000,
    costInput: 0,
    costOutput: 0,
    tags: ['Writing', 'Vision', 'Fast', 'Tool Call']
  },
  {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: providerModelDefaults.openai,
    adapter: 'openai-compatible',
    enabled: false,
    priority: 100,
    visionSupported: true,
    reasoningSupported: true,
    toolCallSupported: true,
    embeddingSupported: true,
    maxContext: 128000,
    maxOutput: 16384,
    rpm: 60,
    tpm: 120000,
    costInput: 0,
    costOutput: 0,
    tags: ['Writing', 'Reasoning', 'Vision', 'Embedding', 'Tool Call'],
    international: true
  },
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: providerModelDefaults.claude,
    adapter: 'anthropic',
    enabled: false,
    priority: 101,
    visionSupported: true,
    reasoningSupported: true,
    toolCallSupported: true,
    embeddingSupported: false,
    maxContext: 200000,
    maxOutput: 8192,
    rpm: 60,
    tpm: 120000,
    costInput: 0,
    costOutput: 0,
    tags: ['Writing', 'Reasoning', 'Vision', 'Coding', 'Translation', 'Long Context', 'Tool Call'],
    international: true
  },
  {
    id: 'gemini',
    name: 'Gemini',
    vendor: 'Google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: providerModelDefaults.gemini,
    adapter: 'gemini',
    enabled: false,
    priority: 102,
    visionSupported: true,
    reasoningSupported: true,
    toolCallSupported: false,
    embeddingSupported: false,
    maxContext: 1000000,
    maxOutput: 8192,
    rpm: 60,
    tpm: 120000,
    costInput: 0,
    costOutput: 0,
    tags: ['Writing', 'Reasoning', 'Vision', 'Translation', 'Long Context'],
    international: true
  }
];

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export const providerRegistry = {
  list() {
    return definitions.map((definition) => ({
      ...definition,
      displayName: definition.name,
      capabilities: [...definition.tags]
    }));
  },

  get(providerId) {
    return definitions.find((definition) => definition.id === providerId) || null;
  },

  createDefaultConfig(providerId) {
    const definition = this.get(providerId);
    if (!definition) throw new Error(`Provider not found: ${providerId}`);
    return {
      id: definition.id,
      name: definition.name,
      displayName: definition.name,
      vendor: definition.vendor,
      enabled: definition.enabled,
      priority: definition.priority,
      apiKey: '',
      baseUrl: definition.defaultBaseUrl,
      defaultModel: definition.defaultModel,
      model: definition.defaultModel,
      modelOptions: getProviderModelOptions(definition.id, definition.defaultModel),
      reasoningModel: definition.reasoningModel || '',
      advancedModel: definition.advancedModel || '',
      modelPlaceholder: definition.modelPlaceholder || 'Default Model',
      visionSupported: Boolean(definition.visionSupported),
      reasoningSupported: Boolean(definition.reasoningSupported),
      toolCallSupported: Boolean(definition.toolCallSupported),
      embeddingSupported: Boolean(definition.embeddingSupported),
      maxContext: definition.maxContext,
      maxOutput: definition.maxOutput,
      rpm: definition.rpm,
      tpm: definition.tpm,
      costInput: definition.costInput,
      costOutput: definition.costOutput,
      status: '未配置',
      configured: false,
      healthy: null,
      lastSuccessAt: '',
      lastFailureAt: '',
      lastErrorCode: '',
      averageLatencyMs: 0,
      healthSampleCount: 0,
      lastHealthCheck: '',
      lastTestedAt: '',
      lastLatency: 0,
      lastError: '',
      tags: [...definition.tags],
      capabilities: [...definition.tags],
      fallbackProviders: definitions
        .filter((item) => item.id !== definition.id && !item.international)
        .sort((a, b) => a.priority - b.priority)
        .map((item) => item.id),
      temperature: 0.7,
      maxTokens: definition.maxOutput || 2048,
      timeout: 30000,
      retryCount: 0,
      adapter: definition.adapter,
      international: Boolean(definition.international)
    };
  },

  normalizeConfig(providerId, config = {}) {
    const defaults = this.createDefaultConfig(providerId);
    const legacyEndpointModel = providerId === 'doubao' ? config.endpointId : undefined;
    const defaultModel = config.defaultModel ?? config.model ?? legacyEndpointModel ?? defaults.defaultModel;
    const next = {
      ...defaults,
      ...config,
      id: providerId,
      name: defaults.name,
      displayName: defaults.displayName,
      vendor: defaults.vendor,
      defaultModel,
      model: defaultModel
    };
    if (!providerStatuses.includes(next.status)) next.status = next.apiKey ? '未测试' : '未配置';
    if (!next.apiKey && next.status !== '已禁用') next.status = '未配置';
    if (next.enabled === false) next.status = next.apiKey ? next.status : '未配置';
    next.enabled = Boolean(next.enabled);
    next.configured = Boolean(next.apiKey && next.baseUrl && next.defaultModel);
    if (!next.configured) next.healthy = null;
    else if (next.healthy !== true && next.healthy !== false) next.healthy = null;
    next.priority = toNumber(next.priority, defaults.priority);
    next.maxContext = toNumber(next.maxContext, defaults.maxContext);
    next.maxOutput = toNumber(next.maxOutput, defaults.maxOutput);
    next.rpm = toNumber(next.rpm, defaults.rpm);
    next.tpm = toNumber(next.tpm, defaults.tpm);
    next.costInput = toNumber(next.costInput, defaults.costInput);
    next.costOutput = toNumber(next.costOutput, defaults.costOutput);
    next.lastLatency = toNumber(next.lastLatency, 0);
    next.averageLatencyMs = toNumber(next.averageLatencyMs, 0);
    next.healthSampleCount = toNumber(next.healthSampleCount, 0);
    next.temperature = toNumber(next.temperature, defaults.temperature);
    next.maxTokens = toNumber(next.maxTokens, defaults.maxTokens);
    next.timeout = toNumber(next.timeout, defaults.timeout);
    next.retryCount = toNumber(next.retryCount, defaults.retryCount);
    next.visionSupported = Boolean(next.visionSupported);
    next.reasoningSupported = Boolean(next.reasoningSupported);
    next.toolCallSupported = Boolean(next.toolCallSupported);
    next.embeddingSupported = Boolean(next.embeddingSupported);
    next.tags = Array.isArray(next.tags) ? [...new Set(next.tags)] : [...defaults.tags];
    next.capabilities = [...next.tags];
    next.modelOptions = getProviderModelOptions(providerId, next.defaultModel);
    next.fallbackProviders = Array.isArray(next.fallbackProviders) ? next.fallbackProviders.filter((id) => id !== providerId) : [...defaults.fallbackProviders];
    return next;
  }
};

export default providerRegistry;
