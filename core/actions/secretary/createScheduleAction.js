import { ACTION_TYPES } from './actionTypes.js';
import { createMemoryAction } from './memoryActionFactory.js';

export function createScheduleAction({ memoryService } = {}) {
  return createMemoryAction({
    name: 'CreateSchedule',
    type: ACTION_TYPES.SCHEDULE,
    memoryService
  });
}
