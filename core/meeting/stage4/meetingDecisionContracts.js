import {
  MEETING_STAGE4_RESULT_SCHEMA_VERSION,
  assertResultInput,
  bindingFields,
  clone,
  compareBinding,
  deepFreeze,
  dedupeEvidenceRefs,
  deterministicId,
  optionalSpeakerRevisionFields,
  positiveInteger,
  required,
  timestamp,
  validateResultEvidenceRefs
} from './meetingBrainContractUtils.js';

export const DECISION_STATUSES = Object.freeze(['confirmed', 'unresolved']);
export const DECISION_CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);

function errorFor(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
export function validateMeetingDecision(value, input = {}) {
  const errors = [];
  let trusted = null;
  try { trusted = compareBinding(value, input, errors); } catch (error) { errors.push(error.code); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['DECISION_INVALID'] };
  if (value.schemaVersion !== MEETING_STAGE4_RESULT_SCHEMA_VERSION) errors.push('DECISION_SCHEMA_VERSION_INVALID');
  for (const field of ['decisionId', 'ownerId', 'scope', 'meetingId', 'sourceId', 'transcriptId', 'content', 'status', 'createdAt']) {
    if (!String(value[field] || '').trim()) errors.push(`DECISION_${field.toUpperCase()}_REQUIRED`);
  }
  for (const field of ['sourceRevision', 'transcriptRevision']) {
    try { positiveInteger(value[field], `DECISION_${field.toUpperCase()}_INVALID`); } catch (error) { errors.push(error.code); }
  }
  if (!DECISION_STATUSES.includes(value.status)) errors.push('DECISION_STATUS_INVALID');
  if (!DECISION_CONFIDENCE_LEVELS.includes(value.confidence?.level)) errors.push('DECISION_CONFIDENCE_LEVEL_INVALID');
  if (!String(value.confidence?.basis || '').trim()) errors.push('DECISION_CONFIDENCE_BASIS_REQUIRED');
  if (trusted) {
    const expected = bindingFields(trusted);
    for (const field of Object.keys(expected)) if (value[field] !== expected[field]) errors.push(`DECISION_${field.toUpperCase()}_MISMATCH`);
  }
  try { timestamp(value.createdAt, 'DECISION_CREATED_AT_INVALID'); } catch (error) { errors.push(error.code); }
  validateResultEvidenceRefs(value.evidenceRefs, trusted || input, errors, { requiredEvidence: true });
  if (value.status === 'unresolved' && !String(value.unresolvedReason || '').trim()) errors.push('DECISION_UNRESOLVED_REASON_REQUIRED');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function createMeetingDecision({
  ownerContext: inputOwnerContext,
  source,
  transcriptRevision,
  diarizationRevision,
  speakerCorrectionRevision,
  value = {},
  now
} = {}) {
  const input = { ownerContext: inputOwnerContext, source, transcriptRevision, diarizationRevision, speakerCorrectionRevision };
  const trusted = assertResultInput(input);
  const binding = bindingFields(trusted);
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const evidenceRefs = dedupeEvidenceRefs(Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs : []);
  const content = required(raw.content, 'DECISION_CONTENT_REQUIRED');
  const decisionId = String(raw.decisionId || '').trim() || deterministicId('decision', { ...binding, content, evidenceRefIds: evidenceRefs.map((ref) => ref?.evidenceRefId) });
  const result = {
    schemaVersion: MEETING_STAGE4_RESULT_SCHEMA_VERSION,
    decisionId,
    ...binding,
    ...optionalSpeakerRevisionFields({ diarizationRevision, speakerCorrectionRevision }),
    content,
    status: raw.status || 'unresolved',
    confidence: {
      level: raw.confidence?.level || 'low',
      basis: String(raw.confidence?.basis || 'grounding_validation')
    },
    evidenceRefs,
    createdAt: timestamp(raw.createdAt || now)
  };
  if (raw.unresolvedReason !== undefined) result.unresolvedReason = String(raw.unresolvedReason).trim();
  const check = validateMeetingDecision(result, input);
  if (!check.valid) throw errorFor(check.errors[0], check.errors);
  return deepFreeze(result);
}
