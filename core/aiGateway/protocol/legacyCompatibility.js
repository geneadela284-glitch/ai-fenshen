import { createAIRequest } from './aiRequest.js';
import { createAIResponse } from './aiResponse.js';
import { createGatewayError } from './errorCodes.js';

const LEGACY_CAPABILITY_MAP = Object.freeze({
  chat: 'chat',
  write: 'writing',
  writing: 'writing',
  reasoning: 'reasoning',
  summary: 'summarization',
  summarize: 'summarization',
  extraction: 'structured_extraction',
  report: 'data_explanation',
  vision: 'vision',
  ocr: 'ocr',
  translate: 'translation',
  translation: 'translation',
  meeting_summary: 'meeting_summary'
});

const LEGACY_ERROR_MAP = Object.freeze({
  INVALID_API_KEY: 'AUTH_FAILED',
  HTTP_401: 'AUTH_FAILED',
  HTTP_403: 'AUTH_FAILED',
  NETWORK_ERROR: 'PROVIDER_UNAVAILABLE',
  HTTP_ERROR: 'PROVIDER_UNAVAILABLE',
  NOT_FOUND: 'MODEL_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  SAFETY_BLOCKED: 'SAFETY_BLOCKED'
});

function normalizeLegacyAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((attachment, index) => ({
    id: attachment.id || `legacy-attachment-${index + 1}`,
    type: attachment.type || (String(attachment.mimeType || attachment.type || '').startsWith('image/') ? 'image' : 'document'),
    mimeType: attachment.mimeType || attachment.mime || 'application/octet-stream',
    fileName: attachment.fileName || attachment.name || `attachment-${index + 1}`,
    sizeBytes: Number(attachment.sizeBytes ?? attachment.size ?? 0),
    storageRef: attachment.storageRef || attachment.ref || '',
    checksum: attachment.checksum || null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    durationMs: attachment.durationMs ?? null,
    metadata: attachment.metadata ? structuredClone(attachment.metadata) : {}
  }));
}

export function normalizeLegacyUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const inputTokens = Number(rawUsage.inputTokens ?? rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0);
  const outputTokens = Number(rawUsage.outputTokens ?? rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0);
  const totalTokens = Number(rawUsage.totalTokens ?? rawUsage.total_tokens ?? inputTokens + outputTokens);
  if (![inputTokens, outputTokens, totalTokens].every((value) => Number.isFinite(value) && value >= 0)) return null;
  return { inputTokens, outputTokens, totalTokens };
}

export function legacyInputToAIRequest(legacyInput = {}, defaults = {}) {
  const legacy = typeof legacyInput === 'string' ? { input: legacyInput } : structuredClone(legacyInput || {});
  const taskType = String(legacy.capability || legacy.taskType || legacy.type || 'chat').toLowerCase();
  return createAIRequest({
    requestId: legacy.requestId || legacy.id || defaults.requestId || '',
    userId: legacy.userId || defaults.userId || '',
    workspaceId: legacy.workspaceId || defaults.workspaceId || '',
    conversationId: legacy.conversationId || defaults.conversationId || null,
    input: legacy.input || legacy.prompt || legacy.text || '',
    attachments: normalizeLegacyAttachments(legacy.attachments),
    intent: legacy.intent || defaults.intent || null,
    capability: LEGACY_CAPABILITY_MAP[taskType] || defaults.capability || 'chat',
    context: legacy.context || defaults.context || {},
    locale: legacy.locale || defaults.locale || 'zh-CN',
    timezone: legacy.timezone || defaults.timezone || 'Asia/Shanghai',
    privacyLevel: legacy.privacyLevel || defaults.privacyLevel || 'private',
    maxLatencyMs: legacy.maxLatencyMs || defaults.maxLatencyMs || 30000,
    maxCost: legacy.maxCost ?? defaults.maxCost ?? null,
    preferredPolicy: legacy.preferredPolicy || defaults.preferredPolicy || 'balanced',
    metadata: { ...(defaults.metadata || {}), legacySource: true },
    createdAt: legacy.createdAt || defaults.createdAt
  });
}

export function legacyErrorToGatewayError(error, context = {}) {
  const legacyCode = String(error?.code || context.code || '').toUpperCase();
  const status = Number(error?.status || context.status || 0);
  let code = LEGACY_ERROR_MAP[legacyCode];
  if (!code && [401, 403].includes(status)) code = 'AUTH_FAILED';
  if (!code && status === 429) code = 'RATE_LIMITED';
  if (!code && [408, 504].includes(status)) code = 'TIMEOUT';
  if (!code && status >= 500) code = 'PROVIDER_UNAVAILABLE';
  return createGatewayError({
    code: code || 'INTERNAL_ERROR',
    providerId: context.providerId || error?.provider || null,
    modelId: context.modelId || null,
    details: context.adminDetails || null,
    cause: legacyCode ? { code: legacyCode } : null,
    occurredAt: context.occurredAt
  });
}

export function legacyProviderResponseToAIResponse(rawResponse = {}, context = {}) {
  const raw = structuredClone(rawResponse || {});
  const error = raw.error ? legacyErrorToGatewayError(raw.error, context) : null;
  return createAIResponse({
    requestId: context.requestId || raw.requestId || '',
    success: !error && raw.success !== false,
    content: raw.content ?? raw.text ?? raw.response ?? null,
    structuredOutput: raw.structuredOutput ?? raw.data ?? null,
    deterministicResult: context.deterministicResult ?? null,
    capability: context.capability || raw.capability || 'chat',
    providerId: raw.providerId || raw.provider || context.providerId || null,
    modelId: raw.modelId || raw.model || context.modelId || null,
    routeReason: context.routeReason || null,
    fallbackChain: context.fallbackChain || [],
    durationMs: context.durationMs ?? raw.durationMs ?? 0,
    tokenUsage: normalizeLegacyUsage(raw.tokenUsage || raw.usage),
    estimatedCost: context.estimatedCost ?? null,
    error,
    traceId: context.traceId || raw.traceId || null,
    warnings: context.warnings || [],
    createdAt: context.createdAt || raw.createdAt
  });
}
