import { ACTION_TYPES } from './actionTypes.js';
import { createMemoryAction } from './memoryActionFactory.js';

export function createExpenseAction({ memoryService } = {}) {
  return createMemoryAction({
    name: 'CreateExpense',
    type: ACTION_TYPES.EXPENSE,
    memoryService
  });
}
