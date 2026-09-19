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

export const SUMMARY_STATUSES = Object.freeze([
  'ready',
  'partial',
  'blocked',
  'failed',
  'stale',
  'superseded'
]);

export const SUMMARY_GROUNDING_STATUSES = Object.freeze(['grounded', 'unresolved']);
export const SUMMARY_KEY_POINT_CATEGORIES = Object.freeze(['discussion', 'fact', 'risk', 'context']);

function errorFor(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeEvidenceRefs(refs, refMap) {
  return asList(refs).map((ref) => {
    const id = ref?.evidenceRefId;
    if (!id) return ref;
    if (!refMap.has(id)) refMap.set(id, ref);
    return refMap.get(id);
  });
}

function normalizeSummaryField(value, field, refMap) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const refs = normalizeEvidenceRefs(raw.evidenceRefs, refMap);
  const normalizedValue = String(raw.value ?? raw.content ?? '').trim();
  const groundingStatus = raw.groundingStatus || (normalizedValue.toLowerCase() === 'unresolved' ? 'unresolved' : 'grounded');
  const result = {
    value: normalizedValue || 'unresolved',
    groundingStatus,
    evidenceRefs: refs
  };
  if (raw.unresolvedReason !== undefined) result.unresolvedReason = String(raw.unresolvedReason).trim();
  if (field === 'topic' || field === 'overview') return result;
  return result;
}

function normalizeListItem(item, kind, index, refMap, binding) {
  const raw = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  const content = String(raw.content ?? raw.value ?? '').trim() || 'unresolved';
  const prefix = kind === 'keyPoints' ? 'key-point' : kind === 'conclusions' ? 'conclusion' : 'open-question';
  const idField = kind === 'keyPoints' ? 'keyPointId' : kind === 'conclusions' ? 'conclusionId' : 'openQuestionId';
  const id = String(raw[idField] || '').trim() || deterministicId(prefix, {
    ...binding,
    index,
    content,
    evidenceRefIds: asList(raw.evidenceRefs).map((ref) => ref?.evidenceRefId || null)
  });
  const result = {
    [idField]: id,
    ...(kind === 'keyPoints' ? { category: SUMMARY_KEY_POINT_CATEGORIES.includes(raw.category) ? raw.category : 'discussion' } : {}),
    content,
    evidenceRefs: normalizeEvidenceRefs(raw.evidenceRefs, refMap)
  };
  if (raw.groundingStatus !== undefined) result.groundingStatus = raw.groundingStatus;
  if (raw.unresolvedReason !== undefined) result.unresolvedReason = String(raw.unresolvedReason).trim();
  return result;
}

function collectNestedRefs(value) {
  const refs = [
    ...(value.topic?.evidenceRefs || []),
    ...(value.overview?.evidenceRefs || []),
    ...asList(value.keyPoints).flatMap((item) => item?.evidenceRefs || []),
    ...asList(value.conclusions).flatMap((item) => item?.evidenceRefs || []),
    ...asList(value.openQuestions).flatMap((item) => item?.evidenceRefs || [])
  ];
  return dedupeEvidenceRefs([...(value.evidenceRefs || []), ...refs]);
}

function validateField(field, errors, path) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    errors.push(`${path}_INVALID`);
    return;
  }
  if (!SUMMARY_GROUNDING_STATUSES.includes(field.groundingStatus)) errors.push(`${path}_GROUNDING_STATUS_INVALID`);
  if (typeof field.value !== 'string' || !field.value.trim()) errors.push(`${path}_VALUE_REQUIRED`);
  if (field.groundingStatus === 'unresolved') {
    if (field.value !== 'unresolved') errors.push(`${path}_UNRESOLVED_VALUE_REQUIRED`);
    if (!String(field.unresolvedReason || '').trim()) errors.push(`${path}_UNRESOLVED_REASON_REQUIRED`);
  } else if (!Array.isArray(field.evidenceRefs) || field.evidenceRefs.length === 0) {
    errors.push('EVIDENCE_REQUIRED');
  }
}

function validateList(list, kind, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${kind.toUpperCase()}_INVALID`);
    return;
  }
  const idField = kind === 'keyPoints' ? 'keyPointId' : kind === 'conclusions' ? 'conclusionId' : 'openQuestionId';
  const ids = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${kind.toUpperCase()}_ITEM_INVALID`);
      continue;
    }
    if (!String(item[idField] || '').trim()) errors.push(`${idField.toUpperCase()}_REQUIRED`);
    if (ids.has(item[idField])) errors.push(`${idField.toUpperCase()}_DUPLICATE`);
    ids.add(item[idField]);
    if (typeof item.content !== 'string' || !item.content.trim()) errors.push(`${idField.toUpperCase()}_CONTENT_REQUIRED`);
    if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0) errors.push('EVIDENCE_REQUIRED');
    if (kind === 'keyPoints' && !SUMMARY_KEY_POINT_CATEGORIES.includes(item.category)) errors.push('KEY_POINT_CATEGORY_INVALID');
    if (item.groundingStatus === 'unresolved' && item.content !== 'unresolved') errors.push(`${idField.toUpperCase()}_UNRESOLVED_VALUE_REQUIRED`);
    if (item.groundingStatus === 'unresolved' && !String(item.unresolvedReason || '').trim()) errors.push(`${idField.toUpperCase()}_UNRESOLVED_REASON_REQUIRED`);
  }
}

export function validateMeetingSummary(value, input = {}) {
  const errors = [];
  let trusted = null;
  try {
    trusted = compareBinding(value, input, errors);
  } catch (error) {
    errors.push(error.code);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['SUMMARY_INVALID'] };
  if (value.schemaVersion !== MEETING_STAGE4_RESULT_SCHEMA_VERSION) errors.push('SUMMARY_SCHEMA_VERSION_INVALID');
  for (const field of ['summaryId', 'resultRevisionId', 'ownerId', 'scope', 'meetingId', 'sourceId', 'transcriptId', 'generatedAt', 'status']) {
    if (!String(value[field] || '').trim()) errors.push(`SUMMARY_${field.toUpperCase()}_REQUIRED`);
  }
  for (const field of ['resultRevision', 'sourceRevision', 'transcriptRevision']) {
    try { positiveInteger(value[field], `SUMMARY_${field.toUpperCase()}_INVALID`); } catch (error) { errors.push(error.code); }
  }
  if (!SUMMARY_STATUSES.includes(value.status)) errors.push('SUMMARY_STATUS_INVALID');
  if (trusted) {
    const expected = bindingFields(trusted);
    for (const field of Object.keys(expected)) if (value[field] !== expected[field]) errors.push(`SUMMARY_${field.toUpperCase()}_MISMATCH`);
  }
  try { timestamp(value.generatedAt, 'SUMMARY_GENERATED_AT_INVALID'); } catch (error) { errors.push(error.code); }
  validateField(value.topic, errors, 'SUMMARY_TOPIC');
  validateField(value.overview, errors, 'SUMMARY_OVERVIEW');
  validateList(value.keyPoints, 'keyPoints', errors);
  validateList(value.conclusions, 'conclusions', errors);
  validateList(value.openQuestions, 'openQuestions', errors);
  const refs = validateResultEvidenceRefs(value.evidenceRefs, trusted || input, errors, { requiredEvidence: false });
  const topIds = new Set(refs.map((ref) => ref?.evidenceRefId).filter(Boolean));
  for (const ref of collectNestedRefs(value)) if (!topIds.has(ref?.evidenceRefId)) errors.push('SUMMARY_EVIDENCE_REF_NOT_IN_COLLECTION');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function createMeetingSummary({
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
  const refMap = new Map();
  const summaryId = String(raw.summaryId || '').trim() || deterministicId('summary', binding);
  const resultRevision = raw.resultRevision === undefined ? 1 : positiveInteger(raw.resultRevision, 'SUMMARY_RESULT_REVISION_INVALID');
  const resultRevisionId = String(raw.resultRevisionId || '').trim() || deterministicId('summary-revision', { ...binding, summaryId, resultRevision });
  const result = {
    schemaVersion: MEETING_STAGE4_RESULT_SCHEMA_VERSION,
    summaryId,
    resultRevisionId,
    resultRevision,
    parentResultRevisionId: raw.parentResultRevisionId === undefined ? null : raw.parentResultRevisionId,
    ...binding,
    ...optionalSpeakerRevisionFields({ diarizationRevision, speakerCorrectionRevision }),
    generatedAt: timestamp(raw.generatedAt || now),
    status: raw.status || 'ready',
    topic: normalizeSummaryField(raw.topic, 'topic', refMap),
    overview: normalizeSummaryField(raw.overview, 'overview', refMap),
    keyPoints: asList(raw.keyPoints).map((item, index) => normalizeListItem(item, 'keyPoints', index, refMap, binding)),
    conclusions: asList(raw.conclusions).map((item, index) => normalizeListItem(item, 'conclusions', index, refMap, binding)),
    openQuestions: asList(raw.openQuestions).map((item, index) => normalizeListItem(item, 'openQuestions', index, refMap, binding)),
    evidenceRefs: []
  };
  result.evidenceRefs = collectNestedRefs({ ...result, evidenceRefs: normalizeEvidenceRefs(raw.evidenceRefs, refMap) });
  const check = validateMeetingSummary(result, input);
  if (!check.valid) throw errorFor(check.errors[0], check.errors);
  return deepFreeze(result);
}
