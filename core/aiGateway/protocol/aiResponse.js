import { AI_GATEWAY_SCHEMA_VERSION } from './aiRequest.js';

export const AI_RESPONSE_FIELDS = Object.freeze([
  'schemaVersion', 'requestId', 'success', 'content', 'structuredOutput',
  'deterministicResult', 'capability', 'providerId', 'modelId', 'routeReason',
  'fallbackChain', 'durationMs', 'tokenUsage', 'estimatedCost', 'error',
  'traceId', 'warnings', 'createdAt'
]);

export const AI_RESPONSE_SCHEMA_V1 = Object.freeze({
  schemaVersion: AI_GATEWAY_SCHEMA_VERSION,
  required: Object.freeze([
    'schemaVersion', 'requestId', 'success', 'content', 'structuredOutput',
    'deterministicResult', 'capability', 'fallbackChain', 'durationMs',
    'tokenUsage', 'estimatedCost', 'error', 'warnings', 'createdAt'
  ]),
  fields: AI_RESPONSE_FIELDS,
  unknownFieldPolicy: 'reject',
  auditOnlyFields: Object.freeze(['providerId', 'modelId', 'routeReason', 'fallbackChain', 'tokenUsage', 'estimatedCost', 'traceId'])
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function lockDeterministicResult(value) {
  if (value === null || value === undefined) return null;
  const cloned = structuredClone(value);
  return deepFreeze({ ...cloned, immutable: true });
}

export function createAIResponse(input = {}) {
  return {
    schemaVersion: input.schemaVersion || AI_GATEWAY_SCHEMA_VERSION,
    requestId: input.requestId || '',
    success: input.success !== false,
    content: input.content ?? null,
    structuredOutput: input.structuredOutput === undefined ? null : structuredClone(input.structuredOutput),
    deterministicResult: lockDeterministicResult(input.deterministicResult),
    capability: input.capability || 'chat',
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    routeReason: input.routeReason ?? null,
    fallbackChain: input.fallbackChain ? structuredClone(input.fallbackChain) : [],
    durationMs: input.durationMs ?? 0,
    tokenUsage: input.tokenUsage === undefined ? null : structuredClone(input.tokenUsage),
    estimatedCost: input.estimatedCost === undefined ? null : structuredClone(input.estimatedCost),
    error: input.error === undefined ? null : structuredClone(input.error),
    traceId: input.traceId ?? null,
    warnings: input.warnings ? structuredClone(input.warnings) : [],
    createdAt: input.createdAt || new Date().toISOString()
  };
}
