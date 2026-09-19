export const ACTION_TYPES = Object.freeze({
  EXPENSE: 'expense',
  INCOME: 'income',
  SCHEDULE: 'schedule',
  REMINDER: 'reminder',
  TODO: 'todo',
  MEETING: 'meeting',
  KNOWLEDGE_SEARCH: 'knowledge_search',
  MEMORY_SAVE: 'memory_save',
  CONTRACT_LOOKUP: 'contract_lookup',
  DOCUMENT_SUMMARY: 'document_summary',
  READ: 'read',
  DELETE: 'delete',
  SEND_EMAIL: 'send_email'
});

export const ACTION_TYPE_VALUES = Object.freeze(Object.values(ACTION_TYPES));

export function isActionType(value) {
  return ACTION_TYPE_VALUES.includes(value);
}
