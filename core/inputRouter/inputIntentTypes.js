export const inputIntentTypes = {
  QUESTION: 'question',
  CASUAL_CHAT: 'casual_chat',
  WORK_TASK: 'work_task',
  MEMORY_RECORD: 'memory_record',
  EXPENSE: 'expense',
  INCOME: 'income',
  SCHEDULE: 'schedule',
  TODO: 'todo',
  REMINDER: 'reminder',
  CUSTOMER_FACT: 'customer_fact',
  PROJECT_FACT: 'project_fact',
  QUOTE: 'quote',
  MEMORY_QUERY: 'memory_query',
  EXPLANATION_QUERY: 'explanation_query',
  PROVENANCE_QUERY: 'provenance_query',
  CALCULATION_QUERY: 'calculation_query',
  CORRECTION_REQUEST: 'correction_request',
  AMBIGUOUS: 'ambiguous',
  REJECTED: 'rejected'
};

export const recordIntentTypes = new Set([
  inputIntentTypes.MEMORY_RECORD,
  inputIntentTypes.EXPENSE,
  inputIntentTypes.INCOME,
  inputIntentTypes.SCHEDULE,
  inputIntentTypes.TODO,
  inputIntentTypes.REMINDER,
  inputIntentTypes.CUSTOMER_FACT,
  inputIntentTypes.PROJECT_FACT,
  inputIntentTypes.QUOTE
]);
