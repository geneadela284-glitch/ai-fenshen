import { ACTION_TYPES } from './actionTypes.js';

const DIRECT_TYPES = new Set([
  ACTION_TYPES.READ,
  ACTION_TYPES.EXPENSE,
  ACTION_TYPES.INCOME,
  ACTION_TYPES.SCHEDULE,
  ACTION_TYPES.REMINDER,
  ACTION_TYPES.TODO,
  ACTION_TYPES.MEETING,
  ACTION_TYPES.KNOWLEDGE_SEARCH,
  ACTION_TYPES.CONTRACT_LOOKUP,
  ACTION_TYPES.DOCUMENT_SUMMARY
]);

const CONFIRM_TYPES = new Set([
  ACTION_TYPES.DELETE,
  ACTION_TYPES.SEND_EMAIL,
  ACTION_TYPES.MEMORY_SAVE
]);

export function getConfirmationPolicy(actionType) {
  if (DIRECT_TYPES.has(actionType)) {
    return Object.freeze({ mode: 'direct', reason: 'policy_allows_direct_execution' });
  }
  if (CONFIRM_TYPES.has(actionType)) {
    return Object.freeze({ mode: 'confirm', reason: 'policy_requires_confirmation' });
  }
  return Object.freeze({ mode: 'confirm', reason: 'unknown_action_requires_confirmation' });
}
