import { assertOwnerContext } from '../stage3a/transcriptContracts.js';
import { resolveEvidenceRef } from './meetingEvidenceRefResolver.js';
import {
  MEETING_STAGE4_RESULT_SCHEMA_VERSION,
  assertResultInput,
  bindingFields,
  clone,
  deepFreeze,
  deterministicId,
  optionalSpeakerRevisionFields,
  positiveInteger,
  required,
  timestamp
} from './meetingBrainContractUtils.js';
import { validateMeetingActionItem } from './meetingActionItemContracts.js';
import { validateMeetingDecision } from './meetingDecisionContracts.js';
import { validateEvidenceRef } from './meetingEvidenceRefContracts.js';
import { validateMeetingSummary } from './meetingSummaryContracts.js';

export const MEETING_ANALYSIS_BUNDLE_SCHEMA_VERSION = MEETING_STAGE4_RESULT_SCHEMA_VERSION;
export const MEETING_ANALYSIS_BUNDLE_STATUSES = Object.freeze([
  'CURRENT',
  'STALE',
  'SUPERSEDED',
  'REVALIDATION_REQUIRED',
  'INVALID'
]);
export const MEETING_ANALYSIS_BUNDLE_GROUNDING_STATUSES = Object.freeze([
  'GROUNDING_SUPPORTED',
  'STALE',
  'INVALID',
  'REVALIDATION_REQUIRED'
]);

const FORBIDDEN_RAW_KEYS = Object.freeze(new Set([
  'audio',
  'audioBytes',
  'audioData',
  'transcript',
  'rawTranscript',
  'segments',
  'diarization',
  'rawDiarization',
  'speakerCorrection',
  'source'
]));
const FORBIDDEN_CREDENTIAL_KEY = /(api.?key|credential|password|secret|token|authorization)/i;

function codedError(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function assertNoForbiddenPayload(value, { credentials = false, seen = new Set() } = {}) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertNoForbiddenPayload(child, { credentials, seen });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RAW_KEYS.has(key)) throw codedError('ANALYSIS_RAW_SOURCE_FORBIDDEN', key);
    if (credentials && FORBIDDEN_CREDENTIAL_KEY.test(key)) throw codedError('ANALYSIS_CREDENTIAL_FORBIDDEN', key);
    assertNoForbiddenPayload(child, { credentials, seen });
  }
}

function normalizeProvenance(value) {
  if (value === undefined || value === null) return {};
  if (!plainObject(value)) throw codedError('ANALYSIS_PROVENANCE_INVALID');
  assertNoForbiddenPayload(value, { credentials: true });
  return clone(value);
}

function trustedInput(input) {
  try {
    return assertResultInput(input);
  } catch (error) {
    throw error?.code ? error : codedError('ANALYSIS_SOURCE_BINDING_INVALID', error);
  }
}

function validateEvidenceCollection({ evidenceRefs, input, errors }) {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    errors.push('ANALYSIS_EVIDENCE_REFS_REQUIRED');
    return;
  }
  const ids = new Set();
  for (const evidenceRef of evidenceRefs) {
    if (!plainObject(evidenceRef)) {
      errors.push('EVIDENCE_REF_INVALID');
      continue;
    }
    if (ids.has(evidenceRef.evidenceRefId)) errors.push('EVIDENCE_REF_DUPLICATE');
    ids.add(evidenceRef.evidenceRefId);
    const check = validateEvidenceRef(evidenceRef, {
      ownerContext: input.ownerContext,
      source: input.source,
      transcriptRevision: input.transcriptRevision,
      diarizationRevision: input.diarizationRevision,
      speakerCorrectionRevision: input.speakerCorrectionRevision
    });
    if (!check.valid) errors.push(...check.errors);
    if (evidenceRef.status !== 'VALID') errors.push('EVIDENCE_STATUS_NOT_VALID');
  }
}

function resultEvidenceIds(result) {
  const ids = new Set();
  for (const ref of [
    ...(result.summary?.evidenceRefs || []),
    ...(result.decisions || []).flatMap((item) => item.evidenceRefs || []),
    ...(result.actionItems || []).flatMap((item) => item.evidenceRefs || [])
  ]) {
    if (ref?.evidenceRefId) ids.add(ref.evidenceRefId);
  }
  return ids;
}

function assertGroundedPhase2Result(result, input) {
  if (!plainObject(result) || result.ok !== true || !plainObject(result.data)) {
    throw codedError('ANALYSIS_RESULT_NOT_GROUNDED');
  }
  if (result.status !== 'ready' && result.status !== 'partial') {
    throw codedError('ANALYSIS_RESULT_NOT_GROUNDED');
  }
  assertNoForbiddenPayload(result.data);
  const { summary, decisions, actionItems, evidenceRefs } = result.data;
  const summaryCheck = validateMeetingSummary(summary, input);
  if (!summaryCheck.valid) throw codedError('ANALYSIS_SUMMARY_INVALID', summaryCheck.errors);
  if (!Array.isArray(decisions) || !Array.isArray(actionItems)) throw codedError('ANALYSIS_RESULT_NOT_GROUNDED');
  for (const decision of decisions) {
    const check = validateMeetingDecision(decision, input);
    if (!check.valid) throw codedError('ANALYSIS_DECISION_INVALID', check.errors);
  }
  for (const actionItem of actionItems) {
    const check = validateMeetingActionItem(actionItem, input);
    if (!check.valid) throw codedError('ANALYSIS_ACTION_ITEM_INVALID', check.errors);
  }
  const ids = resultEvidenceIds({ summary, decisions, actionItems });
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length !== ids.size || evidenceRefs.some((ref) => !ids.has(ref?.evidenceRefId))) {
    throw codedError('ANALYSIS_EVIDENCE_COLLECTION_INVALID');
  }
  const evidenceErrors = [];
  validateEvidenceCollection({ evidenceRefs, input, errors: evidenceErrors });
  if (evidenceErrors.length) throw codedError('ANALYSIS_EVIDENCE_INVALID', evidenceErrors);
  return { summary, decisions, actionItems, evidenceRefs };
}

function assertBundleShape(value, input = {}) {
  const errors = [];
  if (!plainObject(value)) return { valid: false, errors: ['ANALYSIS_BUNDLE_INVALID'] };
  if (value.schemaVersion !== MEETING_ANALYSIS_BUNDLE_SCHEMA_VERSION) errors.push('ANALYSIS_SCHEMA_VERSION_INVALID');
  for (const field of ['analysisId', 'idempotencyKey', 'ownerId', 'scope', 'meetingId', 'sourceId', 'transcriptId', 'createdAt', 'updatedAt', 'groundingPolicyVersion']) {
    if (!String(value[field] || '').trim()) errors.push(`ANALYSIS_${field.toUpperCase()}_REQUIRED`);
  }
  for (const field of ['analysisRevision', 'sourceRevision', 'transcriptRevision', 'sourceTranscriptRevision']) {
    try { positiveInteger(value[field], `ANALYSIS_${field.toUpperCase()}_INVALID`); } catch (error) { errors.push(error.code); }
  }
  if (!MEETING_ANALYSIS_BUNDLE_STATUSES.includes(value.status)) errors.push('ANALYSIS_STATUS_INVALID');
  if (!MEETING_ANALYSIS_BUNDLE_GROUNDING_STATUSES.includes(value.groundingStatus)) errors.push('ANALYSIS_GROUNDING_STATUS_INVALID');
  try { timestamp(value.createdAt, 'ANALYSIS_CREATED_AT_INVALID'); } catch (error) { errors.push(error.code); }
  try { timestamp(value.updatedAt, 'ANALYSIS_UPDATED_AT_INVALID'); } catch (error) { errors.push(error.code); }
  if (input.ownerContext && value.ownerId !== input.ownerContext.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (value.scope !== 'meeting') errors.push('ANALYSIS_SCOPE_MISMATCH');
  if (value.sourceTranscriptRevision !== value.transcriptRevision) errors.push('ANALYSIS_TRANSCRIPT_REVISION_MISMATCH');
  if (input.source && value.sourceRevision !== Number(input.source.revision)) errors.push('ANALYSIS_SOURCE_REVISION_MISMATCH');
  if (input.transcriptRevision && value.transcriptRevision !== Number(input.transcriptRevision.transcriptRevision)) errors.push('ANALYSIS_TRANSCRIPT_REVISION_MISMATCH');
  if (!plainObject(value.summary)) errors.push('ANALYSIS_SUMMARY_REQUIRED');
  if (!Array.isArray(value.decisions)) errors.push('ANALYSIS_DECISIONS_REQUIRED');
  if (!Array.isArray(value.actionItems)) errors.push('ANALYSIS_ACTION_ITEMS_REQUIRED');
  if (!Array.isArray(value.evidenceRefs)) errors.push('ANALYSIS_EVIDENCE_REFS_REQUIRED');
  try { assertNoForbiddenPayload(value, { credentials: true }); } catch (error) { errors.push(error.code); }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateMeetingAnalysisBundle(value, input = {}) {
  const errors = [];
  const shape = assertBundleShape(value, input);
  errors.push(...shape.errors);
  if (!shape.valid) return { valid: false, errors: [...new Set(errors)] };
  const trusted = trustedInput(input);
  const expected = bindingFields(trusted);
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) errors.push(`ANALYSIS_${field.toUpperCase()}_MISMATCH`);
  }
  const summaryCheck = validateMeetingSummary(value.summary, input);
  if (!summaryCheck.valid) errors.push(...summaryCheck.errors);
  for (const decision of value.decisions) {
    const check = validateMeetingDecision(decision, input);
    if (!check.valid) errors.push(...check.errors);
  }
  for (const actionItem of value.actionItems) {
    const check = validateMeetingActionItem(actionItem, input);
    if (!check.valid) errors.push(...check.errors);
  }
  validateEvidenceCollection({ evidenceRefs: value.evidenceRefs, input, errors });
  const allIds = resultEvidenceIds(value);
  for (const id of allIds) if (!value.evidenceRefs.some((ref) => ref.evidenceRefId === id)) errors.push('ANALYSIS_EVIDENCE_COLLECTION_INVALID');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function createMeetingAnalysisBundle({
  ownerContext: inputOwnerContext,
  source,
  transcriptRevision,
  diarizationRevision,
  speakerCorrectionRevision,
  analysisId,
  analysisRevision = 1,
  parentAnalysisId = null,
  idempotencyKey,
  groundingPolicyVersion = 'meeting-grounding-v1',
  analysisEngineVersion = 'stage4-phase2',
  provenance,
  result,
  createdAt,
  updatedAt
} = {}) {
  const input = { ownerContext: inputOwnerContext, source, transcriptRevision, diarizationRevision, speakerCorrectionRevision };
  const trusted = trustedInput(input);
  const data = assertGroundedPhase2Result(result, input);
  const binding = bindingFields(trusted);
  const normalizedAnalysisId = String(analysisId || '').trim() || deterministicId('analysis', { binding, idempotencyKey });
  const normalizedIdempotencyKey = required(idempotencyKey || normalizedAnalysisId, 'ANALYSIS_IDEMPOTENCY_KEY_REQUIRED');
  const normalizedRevision = positiveInteger(analysisRevision, 'ANALYSIS_REVISION_INVALID');
  const normalizedPolicy = required(groundingPolicyVersion, 'GROUNDING_POLICY_VERSION_REQUIRED');
  const normalizedEngine = required(analysisEngineVersion, 'ANALYSIS_ENGINE_VERSION_REQUIRED');
  const normalizedProvenance = normalizeProvenance(provenance);
  const now = timestamp(createdAt || updatedAt, 'ANALYSIS_TIMESTAMP_INVALID');
  const value = {
    schemaVersion: MEETING_ANALYSIS_BUNDLE_SCHEMA_VERSION,
    analysisId: normalizedAnalysisId,
    analysisRevision: normalizedRevision,
    parentAnalysisId: parentAnalysisId === null || parentAnalysisId === undefined ? null : required(parentAnalysisId, 'ANALYSIS_PARENT_ID_INVALID'),
    idempotencyKey: normalizedIdempotencyKey,
    ...binding,
    sourceTranscriptRevision: binding.transcriptRevision,
    ...optionalSpeakerRevisionFields({ diarizationRevision, speakerCorrectionRevision }),
    createdAt: now,
    updatedAt: timestamp(updatedAt || createdAt || now, 'ANALYSIS_TIMESTAMP_INVALID'),
    status: 'CURRENT',
    groundingStatus: 'GROUNDING_SUPPORTED',
    groundingPolicyVersion: normalizedPolicy,
    schemaVersionOfResults: MEETING_STAGE4_RESULT_SCHEMA_VERSION,
    analysisEngineVersion: normalizedEngine,
    provenance: normalizedProvenance,
    summary: clone(data.summary),
    decisions: clone(data.decisions),
    actionItems: clone(data.actionItems),
    evidenceRefs: clone(data.evidenceRefs)
  };
  const check = validateMeetingAnalysisBundle(value, input);
  if (!check.valid) throw codedError(check.errors[0], check.errors);
  return deepFreeze(value);
}

function resolutionStatus(resolutions) {
  if (resolutions.some((item) => item.status === 'INVALID')) return 'INVALID';
  if (resolutions.some((item) => item.status === 'STALE')) return 'STALE';
  if (resolutions.some((item) => item.status === 'REVALIDATION_REQUIRED')) return 'REVALIDATION_REQUIRED';
  return 'CURRENT';
}

export function revalidateMeetingAnalysisBundle(bundle, options = {}) {
  const {
    ownerContext: inputOwnerContext,
    source,
    currentTranscriptRevision,
    currentDiarizationRevision,
    currentSpeakerCorrectionRevision
  } = options || {};
  const ownerContext = assertOwnerContext(inputOwnerContext);
  if (!bundle || bundle.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (bundle.scope !== 'meeting') throw codedError('ANALYSIS_SCOPE_MISMATCH');
  const evidenceRefs = asArray(bundle.evidenceRefs);
  if (!source || !currentTranscriptRevision) {
    const evidenceRefResolutions = evidenceRefs.map((evidenceRef) => ({
      evidenceRefId: evidenceRef.evidenceRefId,
      status: 'REVALIDATION_REQUIRED',
      reason: 'CURRENT_SOURCE_AND_TRANSCRIPT_REQUIRED'
    }));
    return deepFreeze({
      ...clone(bundle),
      status: 'REVALIDATION_REQUIRED',
      groundingStatus: 'REVALIDATION_REQUIRED',
      evidenceRefResolutions
    });
  }
  trustedInput({ ownerContext, source, transcriptRevision: currentTranscriptRevision, currentDiarizationRevision, currentSpeakerCorrectionRevision });
  const evidenceRefResolutions = evidenceRefs.map((evidenceRef) => {
    try {
      const resolved = resolveEvidenceRef({
        ownerContext,
        evidenceRef,
        source,
        currentTranscriptRevision,
        currentDiarizationRevision,
        currentSpeakerCorrectionRevision
      });
      return {
        evidenceRefId: evidenceRef.evidenceRefId,
        status: resolved.status,
        reason: resolved.reason
      };
    } catch (error) {
      if (['OWNER_SCOPE_MISMATCH', 'EVIDENCE_SCOPE_MISMATCH', 'MEETING_SCOPE_MISMATCH', 'SOURCE_SCOPE_MISMATCH', 'TRANSCRIPT_SCOPE_MISMATCH'].includes(error?.code)) throw error;
      return { evidenceRefId: evidenceRef.evidenceRefId, status: 'INVALID', reason: error?.code || 'EVIDENCE_RESOLUTION_FAILED' };
    }
  });
  const status = resolutionStatus(evidenceRefResolutions);
  return deepFreeze({
    ...clone(bundle),
    status,
    groundingStatus: status === 'CURRENT' ? 'GROUNDING_SUPPORTED' : status,
    evidenceRefResolutions
  });
}
