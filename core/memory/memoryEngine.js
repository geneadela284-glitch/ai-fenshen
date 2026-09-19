import { createMemoryRecord, validateMemoryRecord } from './memorySchema.js';
import { extractMemoryFields } from './memoryExtractor.js';
import { detectSensitivity, shouldRemember } from './memoryPolicy.js';
import { normalizeMemoryInput } from './memoryNormalizer.js';

function hasOnlyTime(memoryFields = {}) {
  return Boolean(memoryFields.eventTime) && !memoryFields.summary && !memoryFields.amount;
}

function buildWarnings(sensitivity = {}) {
  if (sensitivity.sensitivity !== 'high') return [];
  return sensitivity.types.map((type) => `sensitive:${type}`);
}

export function analyzeMemoryCandidate(input = '', context = {}) {
  const originalText = String(input || '');
  const normalizedInput = normalizeMemoryInput(originalText);
  const decision = shouldRemember(normalizedInput, context);
  const sensitivity = detectSensitivity(normalizedInput);
  const warnings = buildWarnings(sensitivity);

  if (!decision.remember && sensitivity.sensitivity !== 'high') {
    return {
      decision,
      normalizedInput,
      memoryCandidate: null,
      validation: { valid: false, errors: ['not_worth_remembering'] },
      warnings
    };
  }

  const extracted = extractMemoryFields(normalizedInput, context);
  const needsConfirmation = Boolean(decision.needsConfirmation || sensitivity.sensitivity === 'high' || hasOnlyTime(extracted));
  const record = createMemoryRecord({
    ...extracted,
    metadata: {
      ...(extracted.metadata || {}),
      userId: String(context.userId || ''),
      workspaceId: String(context.workspaceId || ''),
      submissionId: String(context.submissionId || ''),
      sourceEventId: String(context.sourceEventId || context.sourceId || ''),
      inputRole: String(context.role || 'user'),
      isAiOutput: Boolean(context.isAiOutput),
      timezone: String(context.timezone || context.timeZone || '')
    },
    originalText,
    sensitivity: sensitivity.sensitivity,
    needsConfirmation,
    status: needsConfirmation ? 'needs_confirmation' : 'candidate',
    retentionPolicy: extracted.retentionPolicy || (decision.proposedType === 'preference' ? 'long_term' : 'short_term')
  }, context);
  const validation = validateMemoryRecord(record);

  return {
    decision: {
      ...decision,
      needsConfirmation
    },
    normalizedInput,
    memoryCandidate: record,
    validation,
    warnings
  };
}
