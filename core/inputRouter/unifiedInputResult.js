import { inputIntentTypes } from './inputIntentTypes.js';

export function createInputIntentResult(fields = {}) {
  const intent = fields.intent || inputIntentTypes.REJECTED;
  return {
    intent,
    confidence: Number(fields.confidence ?? 0),
    reason: String(fields.reason || ''),
    entities: fields.entities && typeof fields.entities === 'object' ? fields.entities : {},
    requiresConfirmation: Boolean(fields.requiresConfirmation),
    shouldRemember: Boolean(fields.shouldRemember),
    proposedAction: String(fields.proposedAction || ''),
    normalizedInput: String(fields.normalizedInput || ''),
    warnings: Array.isArray(fields.warnings) ? fields.warnings.map(String) : [],
    memoryCandidate: fields.memoryCandidate || null,
    metadata: fields.metadata && typeof fields.metadata === 'object' ? fields.metadata : {}
  };
}

export function createUnifiedInputResult(fields = {}) {
  return {
    handled: Boolean(fields.handled),
    status: String(fields.status || 'pass_through'),
    intent: fields.intent || createInputIntentResult(),
    result: String(fields.result || ''),
    sources: Array.isArray(fields.sources) ? fields.sources : [],
    memoryWrite: fields.memoryWrite || null,
    memoryContext: fields.memoryContext || { items: [] },
    error: String(fields.error || ''),
    metadata: fields.metadata && typeof fields.metadata === 'object' ? fields.metadata : {}
  };
}

