export const AI_CAPABILITIES = Object.freeze([
  'chat',
  'writing',
  'reasoning',
  'summarization',
  'structured_extraction',
  'data_explanation',
  'vision',
  'ocr',
  'translation',
  'meeting_transcription',
  'meeting_summary',
  'tool_call',
  'knowledge_query',
  'memory_query'
]);

export const DETERMINISTIC_SYSTEM_CAPABILITIES = Object.freeze([
  'current_date',
  'current_time',
  'expense_calculation',
  'income_calculation',
  'balance_calculation',
  'schedule_lookup'
]);

export const CAPABILITY_GROUPS = Object.freeze({
  ai: Object.freeze(AI_CAPABILITIES.slice(0, 12)),
  businessQuery: Object.freeze(AI_CAPABILITIES.slice(12)),
  deterministicSystem: DETERMINISTIC_SYSTEM_CAPABILITIES
});

export function isAICapability(value) {
  return AI_CAPABILITIES.includes(value);
}
