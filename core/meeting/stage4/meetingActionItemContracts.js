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
  validDecimal,
  validIsoDate,
  validateResultEvidenceRefs
} from './meetingBrainContractUtils.js';

export const ACTION_ITEM_STATUSES = Object.freeze([
  'candidate',
  'unresolved',
  'confirmed',
  'created',
  'completed',
  'dismissed'
]);

function errorFor(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function validateOwner(value, errors) {
  if (value === 'unresolved') return;
  if (typeof value !== 'string' || !value.trim()) errors.push('ACTION_OWNER_INVALID');
}

function validateDate(value, errors) {
  if (value === 'unresolved') return;
  if (!validIsoDate(value)) errors.push('ACTION_DUE_DATE_INVALID');
}

function validateMeasure(value, kind, errors) {
  if (value === 'unresolved') return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`ACTION_${kind.toUpperCase()}_INVALID`);
    return;
  }
  if (!validDecimal(value.value)) errors.push(`ACTION_${kind.toUpperCase()}_VALUE_INVALID`);
  if (!String(value[kind === 'amount' ? 'currency' : 'unit'] || '').trim()) errors.push(`ACTION_${kind.toUpperCase()}_${kind === 'amount' ? 'CURRENCY' : 'UNIT'}_REQUIRED`);
}

export function validateMeetingActionItem(value, input = {}) {
  const errors = [];
  let trusted = null;
  try { trusted = compareBinding(value, input, errors); } catch (error) { errors.push(error.code); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['ACTION_ITEM_INVALID'] };
  if (value.schemaVersion !== MEETING_STAGE4_RESULT_SCHEMA_VERSION) errors.push('ACTION_SCHEMA_VERSION_INVALID');
  for (const field of ['actionId', 'ownerId', 'scope', 'meetingId', 'sourceId', 'transcriptId', 'content', 'status', 'createdAt']) {
    if (!String(value[field] || '').trim()) errors.push(`ACTION_${field.toUpperCase()}_REQUIRED`);
  }
  for (const field of ['sourceRevision', 'transcriptRevision']) {
    try { positiveInteger(value[field], `ACTION_${field.toUpperCase()}_INVALID`); } catch (error) { errors.push(error.code); }
  }
  if (!ACTION_ITEM_STATUSES.includes(value.status)) errors.push('ACTION_STATUS_INVALID');
  validateOwner(value.owner, errors);
  if (value.ownerRef !== null && (typeof value.ownerRef !== 'object' || Array.isArray(value.ownerRef))) errors.push('ACTION_OWNER_REF_INVALID');
  validateDate(value.dueDate, errors);
  validateMeasure(value.amount, 'amount', errors);
  validateMeasure(value.quantity, 'quantity', errors);
  if (!Array.isArray(value.unresolvedReasons)) errors.push('ACTION_UNRESOLVED_REASONS_INVALID');
  if (value.status === 'unresolved' && Array.isArray(value.unresolvedReasons) && value.unresolvedReasons.length === 0) errors.push('ACTION_UNRESOLVED_REASON_REQUIRED');
  if (trusted) {
    const expected = bindingFields(trusted);
    for (const field of Object.keys(expected)) if (value[field] !== expected[field]) errors.push(`ACTION_${field.toUpperCase()}_MISMATCH`);
  }
  try { timestamp(value.createdAt, 'ACTION_CREATED_AT_INVALID'); } catch (error) { errors.push(error.code); }
  validateResultEvidenceRefs(value.evidenceRefs, trusted || input, errors, { requiredEvidence: true });
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function createMeetingActionItem({
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
  const content = required(raw.content, 'ACTION_CONTENT_REQUIRED');
  const actionId = String(raw.actionId || '').trim() || deterministicId('action', { ...binding, content, evidenceRefIds: evidenceRefs.map((ref) => ref?.evidenceRefId) });
  const result = {
    schemaVersion: MEETING_STAGE4_RESULT_SCHEMA_VERSION,
    actionId,
    ...binding,
    ...optionalSpeakerRevisionFields({ diarizationRevision, speakerCorrectionRevision }),
    content,
    owner: raw.owner === undefined ? 'unresolved' : raw.owner,
    ownerRef: raw.ownerRef === undefined ? null : raw.ownerRef,
    dueDate: raw.dueDate === undefined ? 'unresolved' : raw.dueDate,
    amount: raw.amount === undefined ? 'unresolved' : raw.amount,
    quantity: raw.quantity === undefined ? 'unresolved' : raw.quantity,
    status: raw.status || 'unresolved',
    unresolvedReasons: Array.isArray(raw.unresolvedReasons) ? [...raw.unresolvedReasons] : [],
    evidenceRefs,
    createdAt: timestamp(raw.createdAt || now)
  };
  const check = validateMeetingActionItem(result, input);
  if (!check.valid) throw errorFor(check.errors[0], check.errors);
  return deepFreeze(result);
}
