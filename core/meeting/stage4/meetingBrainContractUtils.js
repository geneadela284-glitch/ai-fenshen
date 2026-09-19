import {
  assertCommittedAudioSource,
  assertOwnerContext,
  validateTranscriptSegment
} from '../stage3a/transcriptContracts.js';
import { sha256 as portableSha256 } from '../shared/sha256.js';
import { validateEvidenceRef } from './meetingEvidenceRefContracts.js';

export const MEETING_STAGE4_RESULT_SCHEMA_VERSION = 1;

export function codedError(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

export function timestamp(value, code = 'RESULT_TIMESTAMP_INVALID') {
  const date = value === undefined || value === null ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw codedError(code);
  return date.toISOString();
}

export function positiveInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw codedError(code);
  return normalized;
}

export function sha256(value) {
  return portableSha256(value);
}

export function deterministicId(prefix, input) {
  return `${prefix}-${sha256(JSON.stringify(input)).slice(0, 48)}`;
}

function assertTranscriptRevision(ownerContext, source, transcriptRevision) {
  if (!transcriptRevision || typeof transcriptRevision !== 'object') {
    throw codedError('TRANSCRIPT_REVISION_INVALID');
  }
  if (transcriptRevision.schemaVersion !== MEETING_STAGE4_RESULT_SCHEMA_VERSION) {
    throw codedError('TRANSCRIPT_SCHEMA_VERSION_INVALID');
  }
  if (transcriptRevision.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (transcriptRevision.scope !== 'meeting') throw codedError('TRANSCRIPT_SCOPE_MISMATCH');
  if (transcriptRevision.meetingId !== source.meetingId) throw codedError('MEETING_SCOPE_MISMATCH');
  if (transcriptRevision.sourceId !== source.sourceId) throw codedError('SOURCE_SCOPE_MISMATCH');
  if (Number(transcriptRevision.sourceRevision) !== Number(source.revision)) {
    throw codedError('SOURCE_REVISION_MISMATCH');
  }
  positiveInteger(transcriptRevision.transcriptRevision, 'TRANSCRIPT_REVISION_INVALID');
  if (!Array.isArray(transcriptRevision.segments) || transcriptRevision.segments.length === 0) {
    throw codedError('TRANSCRIPT_SEGMENTS_REQUIRED');
  }
  let previousEndMs = null;
  for (const [index, segment] of transcriptRevision.segments.entries()) {
    const check = validateTranscriptSegment(segment, {
      transcriptId: transcriptRevision.transcriptId,
      revision: transcriptRevision.transcriptRevision,
      previousEndMs
    });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    if (segment.sequence !== index) throw codedError('TRANSCRIPT_SEGMENT_SEQUENCE_NOT_CONTIGUOUS');
    if (segment.endMs > Number(source.durationMs)) throw codedError('EVIDENCE_AUDIO_DURATION_MISMATCH');
    previousEndMs = segment.endMs;
  }
  return transcriptRevision;
}

export function assertResultInput({ ownerContext: inputOwnerContext, source, transcriptRevision } = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  const committedSource = assertCommittedAudioSource({ ownerContext, source, expectedScope: 'meeting' });
  const revision = assertTranscriptRevision(ownerContext, committedSource, transcriptRevision);
  return { ownerContext, source: committedSource, transcriptRevision: revision };
}

export function bindingFields({ ownerContext, source, transcriptRevision } = {}) {
  return {
    ownerId: ownerContext.ownerId,
    scope: 'meeting',
    meetingId: source.meetingId,
    sourceId: source.sourceId,
    sourceRevision: Number(source.revision),
    transcriptId: transcriptRevision.transcriptId,
    transcriptRevision: Number(transcriptRevision.transcriptRevision)
  };
}

export function optionalSpeakerRevisionFields({ diarizationRevision, speakerCorrectionRevision } = {}) {
  const value = {};
  if (diarizationRevision) {
    value.diarizationRevisionId = required(diarizationRevision.diarizationRevisionId, 'DIARIZATION_REVISION_ID_REQUIRED');
    value.diarizationRevision = positiveInteger(diarizationRevision.revision, 'DIARIZATION_REVISION_INVALID');
  }
  if (speakerCorrectionRevision) {
    const revision = Number(speakerCorrectionRevision.correctionRevision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw codedError('SPEAKER_CORRECTION_REVISION_INVALID');
    value.speakerCorrectionRevisionId = speakerCorrectionRevision.correctionRevisionId ?? null;
    value.speakerCorrectionRevision = revision;
  }
  return value;
}

export function compareBinding(value, input, errors) {
  let trusted;
  try {
    trusted = assertResultInput(input);
  } catch (error) {
    errors.push(error.code);
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return trusted;
  const expected = bindingFields(trusted);
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) errors.push(`RESULT_${field.toUpperCase()}_MISMATCH`);
  }
  return trusted;
}

export function validateResultEvidenceRefs(refs, input, errors, { requiredEvidence = true } = {}) {
  if (!Array.isArray(refs)) {
    errors.push('EVIDENCE_REFS_REQUIRED');
    return [];
  }
  if (requiredEvidence && refs.length === 0) errors.push('EVIDENCE_REQUIRED');
  const seen = new Set();
  for (const evidenceRef of refs) {
    if (!evidenceRef || typeof evidenceRef !== 'object') {
      errors.push('EVIDENCE_REF_INVALID');
      continue;
    }
    if (seen.has(evidenceRef.evidenceRefId)) errors.push('EVIDENCE_REF_DUPLICATE');
    seen.add(evidenceRef.evidenceRefId);
    const check = validateEvidenceRef(evidenceRef, {
      ownerContext: input?.ownerContext,
      source: input?.source,
      transcriptRevision: input?.transcriptRevision,
      diarizationRevision: input?.diarizationRevision,
      speakerCorrectionRevision: input?.speakerCorrectionRevision
    });
    if (!check.valid) errors.push(...check.errors);
    if (evidenceRef.status !== 'VALID') errors.push('EVIDENCE_STATUS_NOT_VALID');
  }
  return refs;
}

export function dedupeEvidenceRefs(refs = []) {
  const byId = new Map();
  for (const ref of refs) {
    if (ref?.evidenceRefId && !byId.has(ref.evidenceRefId)) byId.set(ref.evidenceRefId, ref);
  }
  return [...byId.values()];
}

export function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validDecimal(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || ''));
}

export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
