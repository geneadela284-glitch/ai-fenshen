export const AI_GATEWAY_SCHEMA_VERSION = 'v1';
export const MAX_CONTEXT_BYTES = 64 * 1024;
export const MAX_METADATA_BYTES = 16 * 1024;

export const AI_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'requestId', 'userId', 'workspaceId', 'conversationId',
  'input', 'attachments', 'intent', 'capability', 'context', 'locale',
  'timezone', 'privacyLevel', 'maxLatencyMs', 'maxCost', 'preferredPolicy',
  'metadata', 'createdAt'
]);

export const AI_REQUEST_SCHEMA_V1 = Object.freeze({
  schemaVersion: AI_GATEWAY_SCHEMA_VERSION,
  required: Object.freeze([
    'schemaVersion', 'requestId', 'userId', 'workspaceId', 'input',
    'attachments', 'capability', 'context', 'metadata', 'createdAt'
  ]),
  fields: AI_REQUEST_FIELDS,
  unknownFieldPolicy: 'reject',
  contextMaxBytes: MAX_CONTEXT_BYTES,
  metadataMaxBytes: MAX_METADATA_BYTES
});

const SENSITIVE_REQUEST_KEY = /(api[-_]?key|authorization|cookie|password|passwd|secret|session[-_]?cookie)/i;

function findSensitiveRequestKey(value, path = '') {
  if (!value || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_REQUEST_KEY.test(key)) return nextPath;
    const nestedMatch = findSensitiveRequestKey(nested, nextPath);
    if (nestedMatch) return nestedMatch;
  }
  return null;
}

function cloneSerializable(value, fallback) {
  if (value === undefined) return fallback;
  return structuredClone(value);
}

export function createAIRequest(input = {}) {
  const unknownField = Object.keys(input).find((field) => !AI_REQUEST_FIELDS.includes(field));
  if (unknownField) throw new TypeError(`Unknown AIRequest field: ${unknownField}`);
  const sensitiveField = findSensitiveRequestKey({ context: input.context, metadata: input.metadata, attachments: input.attachments });
  if (sensitiveField) throw new TypeError(`Sensitive AIRequest field is forbidden: ${sensitiveField}`);
  return {
    schemaVersion: input.schemaVersion || AI_GATEWAY_SCHEMA_VERSION,
    requestId: input.requestId || '',
    userId: input.userId || '',
    workspaceId: input.workspaceId || '',
    conversationId: input.conversationId ?? null,
    input: typeof input.input === 'string' ? input.input : '',
    attachments: cloneSerializable(input.attachments, []),
    intent: input.intent ?? null,
    capability: input.capability || 'chat',
    context: cloneSerializable(input.context, {}),
    locale: input.locale || 'zh-CN',
    timezone: input.timezone || 'Asia/Shanghai',
    privacyLevel: input.privacyLevel || 'private',
    maxLatencyMs: input.maxLatencyMs ?? 30000,
    maxCost: cloneSerializable(input.maxCost, null),
    preferredPolicy: input.preferredPolicy || 'balanced',
    metadata: cloneSerializable(input.metadata, {}),
    createdAt: input.createdAt || new Date().toISOString()
  };
}
