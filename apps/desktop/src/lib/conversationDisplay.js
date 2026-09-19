import { applyResponsePolicy } from '../../../../core/router/ResponsePolicy.js';

const assistantFields = ['content', 'text', 'result', 'answer', 'message'];

function asText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text === '[object Object]') return fallback;
    try {
      return asText(JSON.parse(text), fallback);
    } catch {
      return text;
    }
  }
  if (Array.isArray(value)) return value.map((item) => asText(item)).filter(Boolean).join('\n') || fallback;
  if (typeof value === 'object') {
    for (const field of assistantFields) {
      const text = asText(value[field], '');
      if (text) return text;
    }
    return fallback;
  }
  return String(value).trim() || fallback;
}

export function getConversationText(record, fields = assistantFields) {
  if (typeof record !== 'object' || record === null) return asText(record, '');
  for (const field of fields) {
    const text = asText(record[field], '');
    if (text) return text;
  }
  return '';
}

export function getAssistantConversationText(record) {
  return applyResponsePolicy(getConversationText(record));
}

export function shouldRenderUserMessage(text) {
  return Boolean(asText(text, ''));
}

export function shouldCollapseAssistantResponse(value) {
  const text = asText(value, '');
  if (!text) return false;
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim()).length;
  return text.length > 220 || lineCount > 3;
}

export function isNearConversationBottom({ scrollTop = 0, clientHeight = 0, scrollHeight = 0 } = {}, threshold = 56) {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}
