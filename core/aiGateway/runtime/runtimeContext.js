const CAPABILITY_MAP = Object.freeze({
  CHAT: 'chat',
  WRITE: 'writing',
  WRITING: 'writing',
  REASONING: 'reasoning',
  SUMMARY: 'summarization',
  SUMMARIZATION: 'summarization',
  STRUCTURED_EXTRACTION: 'structured_extraction',
  REPORT: 'data_explanation',
  DATA_ANALYSIS: 'data_explanation',
  VISION: 'vision',
  OCR: 'ocr',
  TRANSLATE: 'translation',
  TRANSLATION: 'translation',
  MEETING_SUMMARY: 'meeting_summary',
  TOOL_CALL: 'tool_call',
  KNOWLEDGE_QUERY: 'knowledge_query',
  MEMORY_QUERY: 'memory_query'
});

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function currentDateInTimezone(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeDeep);
  return Object.freeze(value);
}

function normalizeAttachment(attachment = {}, index = 0) {
  const mimeType = attachment.mimeType || attachment.mime || 'application/octet-stream';
  const type = attachment.type || (String(mimeType).startsWith('image/') ? 'image' : String(mimeType).startsWith('audio/') ? 'audio' : 'document');
  return {
    id: attachment.id || `attachment-${index + 1}`,
    type,
    mimeType,
    fileName: attachment.fileName || attachment.name || `attachment-${index + 1}`,
    sizeBytes: Math.max(0, Number(attachment.sizeBytes ?? attachment.size ?? 0)),
    storageRef: attachment.storageRef || attachment.ref || `local-transient:${attachment.id || index + 1}`,
    checksum: attachment.checksum || null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    durationMs: attachment.durationMs ?? null,
    metadata: attachment.metadata && typeof attachment.metadata === 'object' ? structuredClone(attachment.metadata) : {}
  };
}

export function toGatewayCapability(capability = '') {
  const normalized = String(capability || 'CHAT').trim();
  return CAPABILITY_MAP[normalized.toUpperCase()] || normalized.toLowerCase() || 'chat';
}

export function createAIRequestRuntimeContext(request = {}, { capability } = {}) {
  const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  const timezone = request.timezone || metadata.timezone || metadata.timeZone || 'Asia/Shanghai';
  const locale = request.locale || metadata.locale || 'zh-CN';
  const deterministicResult = metadata.deterministicResult ?? metadata.dataTrustResult ?? null;
  return freezeDeep({
    requestId: String(metadata.requestId || request.requestId || newRequestId()),
    conversationId: String(request.conversationId || metadata.conversationId || ''),
    userId: String(request.userId || metadata.userId || request.context?.userId || 'local-user'),
    workspaceId: String(request.workspaceId || metadata.workspaceId || request.context?.workspaceId || 'local-workspace'),
    timezone,
    locale,
    currentDate: metadata.currentDate || currentDateInTimezone(timezone),
    deterministicResult: deterministicResult === null ? null : structuredClone(deterministicResult),
    capability: toGatewayCapability(capability || request.capability || request.taskType || request.type),
    attachments: (Array.isArray(request.attachments) ? request.attachments : []).map(normalizeAttachment)
  });
}
