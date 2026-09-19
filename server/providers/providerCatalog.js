import { createHash } from 'node:crypto';
import { CREDENTIAL_SCHEMAS } from './credentialSchemas.js';
import {
  assertModelCatalogEntry,
  assertProviderRegistryEntry
} from './providerRegistryContract.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export const CAPABILITY_CATALOG = deepFreeze([
  'chat',
  'reasoning',
  'memory_semantic',
  'tool_calling',
  'structured_output',
  'long_context',
  'vision',
  'image_generation',
  'image_editing',
  'video_generation',
  'speech_to_text',
  'text_to_speech',
  'ocr',
  'web_search',
  'code',
  'document_analysis',
  'ppt_content',
  'data_analysis'
]);

export const CURRENT_DOMESTIC_PROVIDER_IDS = deepFreeze([
  'deepseek',
  'qwen',
  'kimi',
  'zhipu',
  'doubao'
]);

const RETRY_POLICY = deepFreeze({
  max_attempts: 1,
  retry_on: ['network_error', 'timeout', 'http_502', 'http_503', 'http_504'],
  never_retry: ['auth_failed', 'quota_exhausted', 'invalid_request']
});

const providerSeeds = [
  ['deepseek', 'DeepSeek', 'domestic', 'cn-mainland', 'https://api.deepseek.com', 'pay_as_you_go', 'openai_compatible', ['chat', 'reasoning', 'structured_output', 'tool_calling']],
  ['qwen', '阿里云百炼/通义千问', 'domestic', 'cn-mainland', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'cn_beijing_payg', 'openai_compatible', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'long_context', 'vision', 'ocr']],
  ['doubao', '火山方舟/豆包', 'domestic', 'cn-mainland', 'https://ark.cn-beijing.volces.com/api/v3', 'cn_beijing_payg', 'openai_compatible', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'vision']],
  ['zhipu', '智谱 GLM', 'domestic', 'cn-mainland', 'https://open.bigmodel.cn/api/paas/v4', 'general', 'openai_compatible', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'vision', 'web_search']],
  ['minimax', 'MiniMax', 'domestic', 'cn-mainland', 'https://api.minimaxi.com/v1', 'pay_as_you_go', 'openai_compatible', ['chat', 'reasoning', 'structured_output', 'tool_calling']],
  ['hunyuan', '腾讯混元', 'domestic', 'cn-mainland', 'https://api.hunyuan.cloud.tencent.com/v1', 'tokenhub', 'openai_compatible', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'vision']],
  ['qianfan', '百度千帆/文心', 'domestic', 'cn-mainland', 'https://qianfan.baidubce.com/v2', 'v2_bearer', 'openai_compatible', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'vision']],
  ['iflytek', '科大讯飞星火', 'domestic', 'cn-mainland', 'https://spark-api-open.xf-yun.com/v2', 'x2_http', 'iflytek_http', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'vision']],
  ['stepfun', '阶跃星辰', 'domestic', 'cn-mainland', 'https://api.stepfun.com/v1', 'pay_as_you_go', 'openai_compatible', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'vision']],
  ['baichuan', '百川智能', 'domestic', 'cn-mainland', 'https://api.baichuan-ai.com/v1', 'pay_as_you_go', 'openai_compatible', ['chat', 'reasoning']],
  ['kimi', 'Kimi / Moonshot', 'domestic', 'cn-mainland', 'https://api.moonshot.cn/v1', 'pay_as_you_go', 'openai_compatible', ['chat', 'long_context', 'tool_calling']],
  ['openai', 'OpenAI', 'international', 'international', 'https://api.openai.com/v1', 'reserved', 'openai', ['chat', 'reasoning', 'vision', 'image_generation', 'speech_to_text', 'text_to_speech', 'structured_output', 'tool_calling']],
  ['anthropic', 'Anthropic', 'international', 'international', 'https://api.anthropic.com/v1', 'reserved', 'anthropic', ['chat', 'reasoning', 'vision', 'tool_calling', 'long_context']],
  ['gemini', 'Google Gemini', 'international', 'international', 'https://generativelanguage.googleapis.com/v1beta', 'reserved', 'gemini', ['chat', 'reasoning', 'vision', 'image_generation', 'video_generation', 'tool_calling']],
  ['xai', 'xAI', 'international', 'international', 'https://api.x.ai/v1', 'reserved', 'openai_compatible', ['chat', 'reasoning', 'tool_calling']],
  ['mistral', 'Mistral', 'international', 'international', 'https://api.mistral.ai/v1', 'reserved', 'mistral', ['chat', 'reasoning', 'ocr', 'tool_calling']],
  ['runway', 'Runway', 'international', 'international', 'https://api.dev.runwayml.com/v1', 'reserved', 'async_media', ['video_generation']],
  ['elevenlabs', 'ElevenLabs', 'international', 'international', 'https://api.elevenlabs.io/v1', 'reserved', 'speech_api', ['text_to_speech', 'speech_to_text']],
  ['black_forest_labs', 'Black Forest Labs', 'international', 'international', 'https://api.bfl.ai/v1', 'reserved', 'async_image', ['image_generation', 'image_editing']]
];

const modelSeeds = [
  ['deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', ['chat', 'reasoning', 'structured_output', 'tool_calling'], 'pay_as_you_go'],
  ['deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', ['chat', 'reasoning', 'structured_output', 'tool_calling'], 'pay_as_you_go'],
  ['qwen', 'qwen-max', 'Qwen Max', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'long_context'], 'cn_beijing_payg'],
  ['qwen', 'qwen-plus', 'Qwen Plus', ['chat', 'reasoning', 'structured_output', 'tool_calling', 'long_context'], 'cn_beijing_payg'],
  ['qwen', 'qwen-turbo', 'Qwen Turbo', ['chat', 'structured_output', 'tool_calling'], 'cn_beijing_payg'],
  ['qwen', 'qwen3-vl-plus', 'Qwen3 VL Plus', ['chat', 'vision', 'structured_output', 'tool_calling'], 'cn_beijing_payg'],
  ['qwen', 'qwen3.5-ocr', 'Qwen3.5 OCR', ['ocr', 'structured_output'], 'cn_beijing_payg'],
  ['kimi', 'moonshot-v1-8k', 'Moonshot V1 8K', ['chat', 'tool_calling'], 'pay_as_you_go'],
  ['kimi', 'moonshot-v1-32k', 'Moonshot V1 32K', ['chat', 'long_context', 'tool_calling'], 'pay_as_you_go'],
  ['kimi', 'moonshot-v1-128k', 'Moonshot V1 128K', ['chat', 'long_context', 'tool_calling'], 'pay_as_you_go'],
  ['zhipu', 'glm-4.5', 'GLM 4.5', ['chat', 'reasoning', 'structured_output', 'tool_calling'], 'general'],
  ['zhipu', 'glm-4.5-air', 'GLM 4.5 Air', ['chat', 'reasoning', 'structured_output', 'tool_calling'], 'general'],
  ['zhipu', 'glm-4v-plus', 'GLM-4V Plus', ['chat', 'vision', 'structured_output'], 'general'],
  ['doubao', 'doubao-seed-2-0-lite-260215', 'Doubao Seed 2.0 Lite', ['chat', 'vision', 'structured_output', 'tool_calling'], 'cn_beijing_payg'],
  ['doubao', 'doubao-seed-1-8-251228', 'Doubao Seed 1.8', ['chat', 'vision', 'structured_output', 'tool_calling'], 'cn_beijing_payg'],
  ['doubao', 'doubao-seed-1-6-250615', 'Doubao Seed 1.6', ['chat', 'structured_output', 'tool_calling'], 'cn_beijing_payg']
];

function modelRecord([providerId, modelId, displayName, capabilities, endpointProfile]) {
  const verifiedCapability = modelId === 'qwen3-vl-plus'
    ? 'vision'
    : modelId === 'qwen3.5-ocr'
      ? 'ocr'
      : null;
  return assertModelCatalogEntry({
    provider_id: providerId,
    model_id: modelId,
    display_name: displayName,
    capabilities: [...capabilities],
    capability_status: Object.fromEntries(capabilities.map((capability) => [
      capability,
      capability === verifiedCapability ? 'verified' : 'declared'
    ])),
    endpoint_profile: endpointProfile,
    context_window: null,
    max_output_tokens: null,
    pricing: {
      version: null,
      currency: 'CNY',
      input_per_million: null,
      output_per_million: null
    },
    availability: verifiedCapability ? 'available' : 'unknown',
    source: 'official_catalog',
    synced_at: verifiedCapability ? '2026-07-29T00:00:00.000Z' : null
  });
}

const models = modelSeeds.map(modelRecord);
const modelCounts = models.reduce((counts, model) => {
  counts[model.provider_id] = (counts[model.provider_id] || 0) + 1;
  return counts;
}, {});

function providerRecord([providerId, displayName, edition, region, baseUrl, profile, protocol, capabilities], index) {
  const international = edition === 'international';
  return assertProviderRegistryEntry({
    schema_version: 1,
    provider_id: providerId,
    display_name: displayName,
    region,
    enabled: false,
    edition,
    capabilities: [...capabilities],
    credential_schema: CREDENTIAL_SCHEMAS[providerId],
    endpoint_config: {
      profile,
      base_url: baseUrl,
      region,
      allow_custom_base_url: false
    },
    model_catalog: {
      source: 'official_catalog',
      catalog_version: null,
      model_count: modelCounts[providerId] || 0,
      last_synced_at: null
    },
    health_status: {
      state: international ? 'disabled' : 'unconfigured',
      reason_code: null,
      last_checked_at: null,
      latency_ms: null
    },
    timeout_policy: { connect_ms: 5000, request_ms: 30000 },
    retry_policy: RETRY_POLICY,
    concurrency_limit: 1,
    spending_limit: { currency: 'CNY', daily_minor: null, monthly_minor: null },
    priority: index + 1,
    metadata: {
      protocol,
      catalog_source_url: null,
      verified_at: null
    }
  });
}

export const MODEL_CATALOG = deepFreeze(models);
export const PROVIDER_CATALOG = deepFreeze(providerSeeds.map(providerRecord));

function catalogVersion(records) {
  return `sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`;
}

export const PROVIDER_CATALOG_VERSION = catalogVersion(PROVIDER_CATALOG);
export const MODEL_CATALOG_VERSION = catalogVersion(MODEL_CATALOG);

export function createInitialRegistryState({ now = null } = {}) {
  return {
    schema_version: 1,
    credential_backend: 'legacy_settings_v1',
    providers: structuredClone(PROVIDER_CATALOG),
    created_at: now,
    updated_at: now
  };
}

export function createInitialModelCatalogState({ now = null } = {}) {
  return {
    schema_version: 1,
    catalog_version: MODEL_CATALOG_VERSION,
    models: structuredClone(MODEL_CATALOG),
    created_at: now,
    updated_at: now
  };
}
