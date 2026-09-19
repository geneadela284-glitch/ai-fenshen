export const memorySourceTypes = [
  'conversation',
  'voice',
  'quick_note',
  'schedule',
  'todo',
  'reminder',
  'meeting',
  'knowledge',
  'file',
  'result',
  'manual',
  'unknown'
];

export const memoryCategories = [
  'expense',
  'income',
  'schedule',
  'todo',
  'reminder',
  'customer_fact',
  'project_fact',
  'quote',
  'preference',
  'generic_memory'
];

export const memoryDirections = ['income', 'expense', 'neutral'];

export const memorySensitivityLevels = ['low', 'medium', 'high'];

export const memoryRetentionPolicies = ['short_term', 'long_term', 'until_deleted', 'needs_review'];

export const memoryStatuses = ['candidate', 'pending_confirmation', 'confirmed', 'active', 'superseded', 'archived', 'rejected', 'expired', 'needs_confirmation', 'deleted', 'forgotten'];

export const defaultMemoryType = 'generic_memory';

export function normalizeMemoryCategory(value = '') {
  return memoryCategories.includes(value) ? value : defaultMemoryType;
}

export function normalizeSourceType(value = '') {
  return memorySourceTypes.includes(value) ? value : 'unknown';
}
