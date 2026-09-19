import { inputIntentTypes, recordIntentTypes } from './inputIntentTypes.js';

export function shouldPassThrough(intent) {
  return [
    inputIntentTypes.QUESTION,
    inputIntentTypes.CASUAL_CHAT,
    inputIntentTypes.WORK_TASK
  ].includes(intent);
}

export function shouldRememberIntent(intent) {
  return recordIntentTypes.has(intent);
}

export function shouldAskFollowup(intentResult) {
  return intentResult.intent === inputIntentTypes.AMBIGUOUS
    || (shouldRememberIntent(intentResult.intent) && intentResult.requiresConfirmation);
}

