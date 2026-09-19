import {
  assertCommittedAudioSource,
  assertOwnerContext,
  validateTranscriptSegment
} from '../stage3a/transcriptContracts.js';
import { validateDiarizationRevision } from '../stage3b/diarizationContracts.js';
import { validateSpeakerCorrectionRevision } from '../stage3b/speakerCorrectionContracts.js';
import { sha256 as portableSha256 } from '../shared/sha256.js';

export const MEETING_STAGE4_SCHEMA_VERSION = 1;
export const EVIDENCE_REF_SCHEMA_VERSION = MEETING_STAGE4_SCHEMA_VERSION;
export const EVIDENCE_REF_STATUSES = Object.freeze(['VALID', 'STALE', 'INVALID']);
export const EVIDENCE_REF_STATUS_VALID = 'VALID';
export const EVIDENCE_REF_STATUS_STALE = 'STALE';
export const EVIDENCE_REF_STATUS_INVALID = 'INVALID';

function codedError(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function positiveInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw codedError(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw codedError(code);
  return normalized;
}

function timestamp(value, code = 'EVIDENCE_CREATED_AT_INVALID') {
  const date = value === undefined || value === null ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw codedError(code);
  return date.toISOString();
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value) {
  return portableSha256(value);
}

function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function assertOwnerOverride(context, ownerId) {
  if (ownerId !== undefined && String(ownerId) !== context.ownerId) {
    throw codedError('OWNER_ID_OVERRIDE_REJECTED');
  }
}

function assertSourceBinding(ownerContext, source, expected = {}) {
  const committed = assertCommittedAudioSource({ ownerContext, source, expectedScope: 'meeting' });
  if (committed.scope !== 'meeting') throw codedError('EVIDENCE_SCOPE_MISMATCH');
  if (expected.meetingId !== undefined && committed.meetingId !== expected.meetingId) {
    throw codedError('MEETING_SCOPE_MISMATCH');
  }
  if (expected.sourceId !== undefined && committed.sourceId !== expected.sourceId) {
    throw codedError('SOURCE_SCOPE_MISMATCH');
  }
  if (expected.sourceRevision !== undefined && Number(committed.revision) !== Number(expected.sourceRevision)) {
    throw codedError('SOURCE_REVISION_MISMATCH');
  }
  if (!Number.isSafeInteger(Number(committed.durationMs)) || Number(committed.durationMs) < 1) {
    throw codedError('AUDIO_DURATION_REQUIRED');
  }
  return committed;
}

function assertTranscriptRevisionShape(ownerContext, value, expected = {}) {
  if (!value || typeof value !== 'object') throw codedError('TRANSCRIPT_REVISION_INVALID');
  if (value.schemaVersion !== 1) throw codedError('TRANSCRIPT_SCHEMA_VERSION_INVALID');
  const ownerId = required(value.ownerId, 'TRANSCRIPT_OWNER_REQUIRED');
  if (ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  const meetingId = required(value.meetingId, 'MEETING_ID_REQUIRED');
  const sourceId = required(value.sourceId, 'SOURCE_ID_REQUIRED');
  const transcriptId = required(value.transcriptId, 'TRANSCRIPT_ID_REQUIRED');
  if (value.scope !== 'meeting') throw codedError('TRANSCRIPT_SCOPE_MISMATCH');
  const sourceRevision = positiveInteger(value.sourceRevision, 'TRANSCRIPT_SOURCE_REVISION_INVALID');
  const transcriptRevision = positiveInteger(value.transcriptRevision, 'TRANSCRIPT_REVISION_INVALID');
  if (expected.meetingId !== undefined && meetingId !== expected.meetingId) throw codedError('MEETING_SCOPE_MISMATCH');
  if (expected.sourceId !== undefined && sourceId !== expected.sourceId) throw codedError('SOURCE_SCOPE_MISMATCH');
  if (expected.sourceRevision !== undefined && sourceRevision !== Number(expected.sourceRevision)) throw codedError('SOURCE_REVISION_MISMATCH');
  if (expected.transcriptId !== undefined && transcriptId !== expected.transcriptId) throw codedError('TRANSCRIPT_ID_MISMATCH');
  if (expected.transcriptRevision !== undefined && transcriptRevision !== Number(expected.transcriptRevision)) throw codedError('TRANSCRIPT_REVISION_MISMATCH');
  if (!Array.isArray(value.segments) || value.segments.length === 0) throw codedError('TRANSCRIPT_SEGMENTS_REQUIRED');

  let previousEndMs = null;
  const seen = new Set();
  for (const [index, segment] of value.segments.entries()) {
    const check = validateTranscriptSegment(segment, {
      transcriptId,
      revision: transcriptRevision,
      previousEndMs
    });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    if (segment.sequence !== index) throw codedError('TRANSCRIPT_SEGMENT_SEQUENCE_NOT_CONTIGUOUS');
    if (seen.has(segment.segmentId)) throw codedError('TRANSCRIPT_SEGMENT_DUPLICATE');
    seen.add(segment.segmentId);
    previousEndMs = segment.endMs;
  }
  return value;
}

function segmentById(transcriptRevision, segmentId) {
  return transcriptRevision.segments.find((segment) => segment.segmentId === segmentId) || null;
}

function normalizeTextSpan(textSpan, segmentText) {
  if (!textSpan || typeof textSpan !== 'object' || Array.isArray(textSpan)) {
    throw codedError('EVIDENCE_TEXT_SPAN_INVALID');
  }
  const keys = Object.keys(textSpan).sort();
  if (keys.join(',') !== 'endOffset,quote,startOffset') throw codedError('EVIDENCE_TEXT_SPAN_SHAPE_INVALID');
  const startOffset = nonNegativeInteger(textSpan.startOffset, 'EVIDENCE_TEXT_OFFSET_INVALID');
  const endOffset = nonNegativeInteger(textSpan.endOffset, 'EVIDENCE_TEXT_OFFSET_INVALID');
  const quote = String(textSpan.quote ?? '');
  if (endOffset <= startOffset || endOffset > segmentText.length) throw codedError('EVIDENCE_TEXT_OFFSET_INVALID');
  if (quote !== segmentText.slice(startOffset, endOffset)) throw codedError('EVIDENCE_TEXT_SPAN_MISMATCH');
  return Object.freeze({ startOffset, endOffset, quote });
}

function correctionProfile(correction, speakerId) {
  if (!correction || speakerId === 'unknown') return null;
  const profiles = new Map((correction.speakerRefs || []).map((item) => [item.speakerId, item]));
  let profile = profiles.get(speakerId) || null;
  const visited = new Set();
  while (profile?.state === 'merged' && profile.mergedIntoSpeakerId && !visited.has(profile.speakerId)) {
    visited.add(profile.speakerId);
    profile = profiles.get(profile.mergedIntoSpeakerId) || null;
  }
  if (profile?.state !== 'active' || profile.labelSource !== 'user_entered') return null;
  return profile;
}

function projectSpeaker({ ownerContext, transcriptRevision, segment, diarizationRevision, speakerCorrectionRevision }) {
  let speakerId = 'unknown';
  let diarizationBinding = null;
  let correctionBinding = null;

  if (diarizationRevision !== undefined && diarizationRevision !== null) {
    const check = validateDiarizationRevision(diarizationRevision, {
      ownerContext,
      meetingId: transcriptRevision.meetingId,
      transcriptId: transcriptRevision.transcriptId,
      transcriptRevision: transcriptRevision.transcriptRevision
    });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    const diarizationSegment = diarizationRevision.segments.find((item) => item.transcriptSegmentId === segment.segmentId);
    if (!diarizationSegment) throw codedError('DIARIZATION_SEGMENT_NOT_FOUND');
    if (diarizationSegment.startMs !== segment.startMs || diarizationSegment.endMs !== segment.endMs) {
      throw codedError('DIARIZATION_TIMELINE_MISMATCH');
    }
    speakerId = diarizationSegment.speakerRef;
    diarizationBinding = {
      diarizationRevisionId: diarizationRevision.diarizationRevisionId,
      diarizationRevision: diarizationRevision.revision
    };
  }

  if (speakerCorrectionRevision !== undefined && speakerCorrectionRevision !== null) {
    if (!diarizationBinding) throw codedError('SPEAKER_CONTEXT_REQUIRED');
    const check = validateSpeakerCorrectionRevision(speakerCorrectionRevision, { ownerContext });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    if (speakerCorrectionRevision.meetingId !== transcriptRevision.meetingId ||
        speakerCorrectionRevision.transcriptId !== transcriptRevision.transcriptId ||
        speakerCorrectionRevision.transcriptRevision !== transcriptRevision.transcriptRevision) {
      throw codedError('SPEAKER_CORRECTION_SCOPE_MISMATCH');
    }
    const profile = correctionProfile(speakerCorrectionRevision, speakerId);
    correctionBinding = {
      speakerCorrectionRevisionId: speakerCorrectionRevision.correctionRevisionId,
      speakerCorrectionRevision: speakerCorrectionRevision.correctionRevision
    };
    return { speakerId, resolvedSpeakerName: profile?.displayLabel || null, diarizationBinding, correctionBinding };
  }

  return { speakerId, resolvedSpeakerName: null, diarizationBinding, correctionBinding };
}

function validateSegmentBinding(value, segment) {
  if (!segment) return ['EVIDENCE_SEGMENT_NOT_FOUND'];
  const errors = [];
  if (value.startMs !== segment.startMs || value.endMs !== segment.endMs) errors.push('EVIDENCE_TIMELINE_MISMATCH');
  let spanValid = false;
  try {
    normalizeTextSpan(value.textSpan, segment.text);
    spanValid = true;
  } catch (error) {
    errors.push(error.code);
  }
  if (!validHash(value.textHash)) errors.push('EVIDENCE_TEXT_HASH_INVALID');
  else if (spanValid && value.textHash !== sha256(segment.text)) errors.push('TEXT_HASH_MISMATCH');
  return [...new Set(errors)];
}

function validateStructuralFields(value, errors) {
  if (value.schemaVersion !== MEETING_STAGE4_SCHEMA_VERSION) errors.push('EVIDENCE_SCHEMA_VERSION_INVALID');
  for (const field of ['evidenceRefId', 'ownerId', 'scope', 'meetingId', 'sourceId', 'transcriptId', 'segmentId', 'createdAt']) {
    if (!String(value[field] || '').trim()) errors.push(`EVIDENCE_${field.toUpperCase()}_REQUIRED`);
  }
  if (value.scope !== 'meeting') errors.push('EVIDENCE_SCOPE_MISMATCH');
  try { positiveInteger(value.sourceRevision, 'EVIDENCE_SOURCE_REVISION_INVALID'); } catch (error) { errors.push(error.code); }
  try { positiveInteger(value.transcriptRevision, 'EVIDENCE_TRANSCRIPT_REVISION_INVALID'); } catch (error) { errors.push(error.code); }
  try { nonNegativeInteger(value.startMs, 'EVIDENCE_START_INVALID'); } catch (error) { errors.push(error.code); }
  try {
    const endMs = positiveInteger(value.endMs, 'EVIDENCE_END_INVALID');
    if (Number.isSafeInteger(value.startMs) && endMs <= value.startMs) errors.push('EVIDENCE_TIMELINE_INVALID');
  } catch (error) { errors.push(error.code); }
  if (!EVIDENCE_REF_STATUSES.includes(value.status)) errors.push('EVIDENCE_STATUS_INVALID');
  if (!['unknown', ...(Array.from({ length: 100 }, (_, index) => `speaker-${index + 1}`))].includes(value.speakerId) && !/^speaker-[1-9][0-9]*$/.test(value.speakerId || '')) {
    errors.push('EVIDENCE_SPEAKER_ID_INVALID');
  }
  if (value.resolvedSpeakerName !== null && (typeof value.resolvedSpeakerName !== 'string' || !value.resolvedSpeakerName.trim())) {
    errors.push('EVIDENCE_RESOLVED_SPEAKER_NAME_INVALID');
  }
  if (value.speakerId === 'unknown' && value.resolvedSpeakerName !== null) errors.push('EVIDENCE_UNKNOWN_SPEAKER_NAME_INVALID');
  try { timestamp(value.createdAt); } catch (error) { errors.push(error.code); }
  if (!Number.isSafeInteger(value.textSpan?.startOffset) || !Number.isSafeInteger(value.textSpan?.endOffset) || typeof value.textSpan?.quote !== 'string') {
    errors.push('EVIDENCE_TEXT_SPAN_INVALID');
  }
  return errors;
}

export function validateEvidenceRef(value, {
  ownerContext: inputOwnerContext,
  source,
  transcriptRevision,
  diarizationRevision,
  speakerCorrectionRevision
} = {}) {
  const errors = [];
  let ownerContext;
  try {
    ownerContext = assertOwnerContext(inputOwnerContext);
  } catch (error) {
    errors.push(error.code);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['EVIDENCE_REF_INVALID'] };
  errors.push(...validateStructuralFields(value, []));
  if (ownerContext && value.ownerId !== ownerContext.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (source && ownerContext) {
    try {
      assertSourceBinding(ownerContext, source, {
        meetingId: value.meetingId,
        sourceId: value.sourceId,
        sourceRevision: value.sourceRevision
      });
    } catch (error) {
      errors.push(error.code);
    }
  }
  if (transcriptRevision && ownerContext) {
    try {
      assertTranscriptRevisionShape(ownerContext, transcriptRevision, {
        meetingId: value.meetingId,
        sourceId: value.sourceId,
        sourceRevision: value.sourceRevision,
        transcriptId: value.transcriptId,
        transcriptRevision: value.transcriptRevision
      });
      errors.push(...validateSegmentBinding(value, segmentById(transcriptRevision, value.segmentId)));
    } catch (error) {
      errors.push(error.code);
    }
  }
  if (diarizationRevision || speakerCorrectionRevision) {
    try {
      const projection = projectSpeaker({
        ownerContext,
        transcriptRevision: transcriptRevision || {
          meetingId: value.meetingId,
          transcriptId: value.transcriptId,
          transcriptRevision: value.transcriptRevision
        },
        segment: transcriptRevision ? segmentById(transcriptRevision, value.segmentId) : { segmentId: value.segmentId, startMs: value.startMs, endMs: value.endMs },
        diarizationRevision,
        speakerCorrectionRevision
      });
      if (projection.speakerId !== value.speakerId) errors.push('EVIDENCE_SPEAKER_MISMATCH');
      if (projection.resolvedSpeakerName !== value.resolvedSpeakerName) errors.push('EVIDENCE_SPEAKER_NAME_MISMATCH');
    } catch (error) {
      errors.push(error.code);
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function createEvidenceRef({
  ownerContext: inputOwnerContext,
  ownerId,
  source,
  transcriptRevision,
  segmentId,
  textSpan,
  diarizationRevision,
  speakerCorrectionRevision,
  evidenceRefId,
  createdAt
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerOverride(ownerContext, ownerId);
  const committedSource = assertSourceBinding(ownerContext, source);
  const revision = assertTranscriptRevisionShape(ownerContext, transcriptRevision);
  if (revision.meetingId !== committedSource.meetingId || revision.sourceId !== committedSource.sourceId || revision.sourceRevision !== committedSource.revision) {
    throw codedError('SOURCE_SCOPE_MISMATCH');
  }
  const segment = segmentById(revision, required(segmentId, 'EVIDENCE_SEGMENT_ID_REQUIRED'));
  if (!segment) throw codedError('EVIDENCE_SEGMENT_NOT_FOUND');
  if (segment.endMs > Number(committedSource.durationMs)) throw codedError('EVIDENCE_AUDIO_DURATION_MISMATCH');
  const normalizedSpan = normalizeTextSpan(textSpan, segment.text);
  const projection = projectSpeaker({ ownerContext, transcriptRevision: revision, segment, diarizationRevision, speakerCorrectionRevision });
  if (Object.hasOwn(arguments[0] || {}, 'speakerId') || Object.hasOwn(arguments[0] || {}, 'resolvedSpeakerName')) {
    throw codedError('EVIDENCE_SPEAKER_OVERRIDE_REJECTED');
  }
  const textHash = sha256(segment.text);
  const identity = [
    ownerContext.ownerId, 'meeting', committedSource.meetingId, committedSource.sourceId, committedSource.revision,
    revision.transcriptId, revision.transcriptRevision, segment.segmentId, projection.speakerId,
    projection.resolvedSpeakerName || '', normalizedSpan.startOffset, normalizedSpan.endOffset, textHash
  ];
  const generatedId = `evidence-${sha256(JSON.stringify(identity)).slice(0, 48)}`;
  if (evidenceRefId !== undefined && String(evidenceRefId) !== generatedId) throw codedError('EVIDENCE_REF_ID_MISMATCH');
  const value = {
    schemaVersion: MEETING_STAGE4_SCHEMA_VERSION,
    evidenceRefId: generatedId,
    ownerId: ownerContext.ownerId,
    scope: 'meeting',
    meetingId: committedSource.meetingId,
    sourceId: committedSource.sourceId,
    sourceRevision: committedSource.revision,
    transcriptId: revision.transcriptId,
    transcriptRevision: revision.transcriptRevision,
    segmentId: segment.segmentId,
    speakerId: projection.speakerId,
    resolvedSpeakerName: projection.resolvedSpeakerName,
    startMs: segment.startMs,
    endMs: segment.endMs,
    textSpan: normalizedSpan,
    textHash,
    createdAt: timestamp(createdAt)
  };
  if (projection.diarizationBinding) Object.assign(value, projection.diarizationBinding);
  if (projection.correctionBinding) Object.assign(value, projection.correctionBinding);
  value.status = EVIDENCE_REF_STATUS_VALID;
  const check = validateEvidenceRef(value, {
    ownerContext,
    source: committedSource,
    transcriptRevision: revision,
    diarizationRevision,
    speakerCorrectionRevision
  });
  if (!check.valid) throw codedError(check.errors[0], check.errors);
  return deepFreeze(value);
}

export function createMeetingEvidenceRef(input = {}) {
  return createEvidenceRef(input);
}

export function validateMeetingEvidenceRef(value, options = {}) {
  return validateEvidenceRef(value, options);
}

export { codedError, sha256 as evidenceTextHash };
