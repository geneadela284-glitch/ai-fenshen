import { assertOwnerContext } from '../stage3a/transcriptContracts.js';

export const DIARIZATION_SCHEMA_VERSION = 1;
export const DIARIZATION_SOURCES = Object.freeze(['provider_role_separation', 'unknown']);
export const DIARIZATION_STATUSES = Object.freeze(['ready', 'partial', 'failed', 'blocked']);

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

function timestamp(value, code) {
  const normalized = new Date(value || new Date()).toISOString();
  if (Number.isNaN(Date.parse(normalized))) throw codedError(code);
  return normalized;
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  return Object.freeze(value);
}

function assertOwnerOverride(context, ownerId) {
  if (ownerId !== undefined && String(ownerId) !== context.ownerId) throw codedError('OWNER_ID_OVERRIDE_REJECTED');
}

function anonymousSpeakerId(value) {
  const normalized = required(value, 'DIARIZATION_SPEAKER_ID_REQUIRED');
  if (!/^speaker-[1-9][0-9]*$/.test(normalized)) throw codedError('DIARIZATION_SPEAKER_ID_INVALID');
  return normalized;
}

function anonymousLabelFor(speakerId) {
  return `说话人${speakerId.slice('speaker-'.length)}`;
}

function anonymousLabel(value, speakerId) {
  const expected = anonymousLabelFor(speakerId);
  if (value === undefined || value === null || String(value).trim() === '') return expected;
  const normalized = String(value).trim();
  if (normalized !== expected) throw codedError('DIARIZATION_REAL_NAME_FORBIDDEN');
  return normalized;
}

function confidence(value) {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) throw codedError('DIARIZATION_CONFIDENCE_INVALID');
  return normalized;
}

function source(value) {
  const normalized = required(value, 'DIARIZATION_SOURCE_REQUIRED');
  if (!DIARIZATION_SOURCES.includes(normalized)) throw codedError('DIARIZATION_SOURCE_INVALID');
  return normalized;
}

function assertSpeakerShape(value, { ownerContext, meetingId } = {}) {
  if (!value || typeof value !== 'object') throw codedError('DIARIZATION_SPEAKER_REF_INVALID');
  const speakerId = anonymousSpeakerId(value.speakerId);
  if (ownerContext && value.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (meetingId && value.meetingId !== meetingId) throw codedError('DIARIZATION_MEETING_MISMATCH');
  if (value.schemaVersion !== DIARIZATION_SCHEMA_VERSION) throw codedError('DIARIZATION_SCHEMA_VERSION_INVALID');
  if (value.label !== anonymousLabelFor(speakerId)) throw codedError('DIARIZATION_REAL_NAME_FORBIDDEN');
  source(value.source);
  timestamp(value.createdAt, 'DIARIZATION_CREATED_AT_INVALID');
  timestamp(value.updatedAt, 'DIARIZATION_UPDATED_AT_INVALID');
  positiveInteger(value.revision, 'DIARIZATION_REVISION_INVALID');
  return value;
}

function assertSegmentShape(value, {
  meetingId,
  transcriptId,
  transcriptRevision,
  previousEndMs = null,
  speakerIds = null
} = {}) {
  if (!value || typeof value !== 'object') throw codedError('DIARIZATION_SEGMENT_INVALID');
  if (value.schemaVersion !== DIARIZATION_SCHEMA_VERSION) throw codedError('DIARIZATION_SCHEMA_VERSION_INVALID');
  if (meetingId && value.meetingId !== meetingId) throw codedError('DIARIZATION_MEETING_MISMATCH');
  if (transcriptId && value.transcriptId !== transcriptId) throw codedError('DIARIZATION_TRANSCRIPT_MISMATCH');
  if (Number(value.transcriptRevision) !== Number(transcriptRevision)) throw codedError('DIARIZATION_SEGMENT_TRANSCRIPT_REVISION_MISMATCH');
  required(value.transcriptSegmentId, 'DIARIZATION_TRANSCRIPT_SEGMENT_ID_REQUIRED');
  const startMs = nonNegativeInteger(value.startMs, 'DIARIZATION_SEGMENT_START_INVALID');
  const endMs = nonNegativeInteger(value.endMs, 'DIARIZATION_SEGMENT_END_INVALID');
  if (endMs <= startMs) throw codedError('DIARIZATION_TIMELINE_INVALID');
  if (previousEndMs !== null && startMs < previousEndMs) throw codedError('DIARIZATION_TIMELINE_NOT_MONOTONIC');
  const speakerRef = required(value.speakerRef, 'DIARIZATION_SPEAKER_REF_REQUIRED');
  if (speakerRef !== 'unknown' && !/^speaker-[1-9][0-9]*$/.test(speakerRef)) throw codedError('DIARIZATION_SPEAKER_REF_INVALID');
  if (speakerIds && speakerRef !== 'unknown' && !speakerIds.has(speakerRef)) throw codedError('DIARIZATION_SPEAKER_REF_NOT_DECLARED');
  confidence(value.confidence);
  source(value.source);
  positiveInteger(value.revision, 'DIARIZATION_SEGMENT_REVISION_INVALID');
  return value;
}

export function createSpeakerRef({
  ownerContext: inputOwnerContext,
  ownerId,
  meetingId,
  speakerId,
  label,
  source: inputSource = 'provider_role_separation',
  createdAt,
  updatedAt,
  revision = 1
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerOverride(ownerContext, ownerId);
  const normalizedSpeakerId = anonymousSpeakerId(speakerId);
  const created = timestamp(createdAt, 'DIARIZATION_CREATED_AT_INVALID');
  return freeze({
    schemaVersion: DIARIZATION_SCHEMA_VERSION,
    speakerId: normalizedSpeakerId,
    ownerId: ownerContext.ownerId,
    meetingId: required(meetingId, 'DIARIZATION_MEETING_ID_REQUIRED'),
    label: anonymousLabel(label, normalizedSpeakerId),
    source: source(inputSource),
    createdAt: created,
    updatedAt: timestamp(updatedAt || created, 'DIARIZATION_UPDATED_AT_INVALID'),
    revision: positiveInteger(revision, 'DIARIZATION_REVISION_INVALID')
  });
}

export function createDiarizationSegment({
  meetingId,
  transcriptId,
  transcriptRevision,
  transcriptSegmentId,
  startMs,
  endMs,
  speakerRef,
  confidence: inputConfidence = null,
  source: inputSource = 'provider_role_separation',
  revision = 1
} = {}) {
  const value = {
    schemaVersion: DIARIZATION_SCHEMA_VERSION,
    meetingId: required(meetingId, 'DIARIZATION_MEETING_ID_REQUIRED'),
    transcriptId: required(transcriptId, 'DIARIZATION_TRANSCRIPT_ID_REQUIRED'),
    transcriptRevision: positiveInteger(transcriptRevision, 'DIARIZATION_TRANSCRIPT_REVISION_INVALID'),
    transcriptSegmentId: required(transcriptSegmentId, 'DIARIZATION_TRANSCRIPT_SEGMENT_ID_REQUIRED'),
    startMs: nonNegativeInteger(startMs, 'DIARIZATION_SEGMENT_START_INVALID'),
    endMs: nonNegativeInteger(endMs, 'DIARIZATION_SEGMENT_END_INVALID'),
    speakerRef: required(speakerRef, 'DIARIZATION_SPEAKER_REF_REQUIRED'),
    confidence: confidence(inputConfidence),
    source: source(inputSource),
    revision: positiveInteger(revision, 'DIARIZATION_SEGMENT_REVISION_INVALID')
  };
  assertSegmentShape(value, { meetingId: value.meetingId, transcriptId: value.transcriptId, transcriptRevision: value.transcriptRevision });
  return freeze(value);
}

export function createDiarizationRevision({
  ownerContext: inputOwnerContext,
  ownerId,
  diarizationRevisionId,
  meetingId,
  transcriptId,
  transcriptRevision,
  source: inputSource = 'provider_role_separation',
  status = 'ready',
  speakerRefs = [],
  segments,
  createdAt,
  updatedAt,
  revision = 1
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerOverride(ownerContext, ownerId);
  const normalizedMeetingId = required(meetingId, 'DIARIZATION_MEETING_ID_REQUIRED');
  const normalizedTranscriptId = required(transcriptId, 'DIARIZATION_TRANSCRIPT_ID_REQUIRED');
  const normalizedTranscriptRevision = positiveInteger(transcriptRevision, 'DIARIZATION_TRANSCRIPT_REVISION_INVALID');
  const normalizedSpeakers = Array.isArray(speakerRefs) ? speakerRefs.map((value) => {
    assertSpeakerShape(value, { ownerContext, meetingId: normalizedMeetingId });
    return clone(value);
  }) : null;
  if (!normalizedSpeakers) throw codedError('DIARIZATION_SPEAKER_REFS_REQUIRED');
  const normalizedSegments = Array.isArray(segments) ? segments.map((value) => clone(value)) : null;
  if (!normalizedSegments || !normalizedSegments.length) throw codedError('DIARIZATION_SEGMENTS_REQUIRED');
  const created = timestamp(createdAt, 'DIARIZATION_CREATED_AT_INVALID');
  const value = {
    schemaVersion: DIARIZATION_SCHEMA_VERSION,
    diarizationRevisionId: required(diarizationRevisionId, 'DIARIZATION_REVISION_ID_REQUIRED'),
    ownerId: ownerContext.ownerId,
    meetingId: normalizedMeetingId,
    transcriptId: normalizedTranscriptId,
    transcriptRevision: normalizedTranscriptRevision,
    source: source(inputSource),
    status: String(status || '').trim(),
    speakerRefs: normalizedSpeakers,
    segments: normalizedSegments,
    createdAt: created,
    updatedAt: timestamp(updatedAt || created, 'DIARIZATION_UPDATED_AT_INVALID'),
    revision: positiveInteger(revision, 'DIARIZATION_REVISION_INVALID')
  };
  const check = validateDiarizationRevision(value, { ownerContext });
  if (!check.valid) throw codedError(check.errors[0], check.errors);
  return freeze({
    ...value,
    speakerRefs: Object.freeze(normalizedSpeakers),
    segments: Object.freeze(normalizedSegments)
  });
}

export function validateDiarizationRevision(value, { ownerContext: inputOwnerContext, meetingId, transcriptId, transcriptRevision } = {}) {
  const errors = [];
  let ownerContext = null;
  try {
    ownerContext = assertOwnerContext(inputOwnerContext);
  } catch (error) {
    errors.push(error.code);
  }
  if (!value || typeof value !== 'object') return { valid: false, errors: ['DIARIZATION_REVISION_INVALID'] };
  if (value.schemaVersion !== DIARIZATION_SCHEMA_VERSION) errors.push('DIARIZATION_SCHEMA_VERSION_INVALID');
  for (const field of ['diarizationRevisionId', 'ownerId', 'meetingId', 'transcriptId', 'createdAt', 'updatedAt']) {
    if (!String(value[field] || '').trim()) errors.push(`DIARIZATION_${field.toUpperCase()}_REQUIRED`);
  }
  if (ownerContext && value.ownerId !== ownerContext.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (meetingId && value.meetingId !== meetingId) errors.push('DIARIZATION_MEETING_MISMATCH');
  if (transcriptId && value.transcriptId !== transcriptId) errors.push('DIARIZATION_TRANSCRIPT_MISMATCH');
  if (transcriptRevision !== undefined && value.transcriptRevision !== transcriptRevision) errors.push('DIARIZATION_TRANSCRIPT_REVISION_MISMATCH');
  try {
    positiveInteger(value.transcriptRevision, 'DIARIZATION_TRANSCRIPT_REVISION_INVALID');
  } catch (error) {
    errors.push(error.code);
  }
  try {
    source(value.source);
  } catch (error) {
    errors.push(error.code);
  }
  if (!DIARIZATION_STATUSES.includes(value.status)) errors.push('DIARIZATION_STATUS_INVALID');
  try {
    timestamp(value.createdAt, 'DIARIZATION_CREATED_AT_INVALID');
    timestamp(value.updatedAt, 'DIARIZATION_UPDATED_AT_INVALID');
  } catch (error) {
    errors.push(error.code);
  }
  try {
    positiveInteger(value.revision, 'DIARIZATION_REVISION_INVALID');
  } catch (error) {
    errors.push(error.code);
  }
  const speakerIds = new Set();
  if (!Array.isArray(value.speakerRefs)) {
    errors.push('DIARIZATION_SPEAKER_REFS_REQUIRED');
  } else {
    for (const speaker of value.speakerRefs) {
      try {
        assertSpeakerShape(speaker, { ownerContext, meetingId: value.meetingId });
        if (speakerIds.has(speaker.speakerId)) errors.push('DIARIZATION_SPEAKER_DUPLICATE');
        speakerIds.add(speaker.speakerId);
      } catch (error) {
        errors.push(error.code);
      }
    }
  }
  if (!Array.isArray(value.segments) || !value.segments.length) {
    errors.push('DIARIZATION_SEGMENTS_REQUIRED');
  } else {
    let previousEndMs = null;
    const segmentIds = new Set();
    for (const segment of value.segments) {
      try {
        assertSegmentShape(segment, {
          meetingId: value.meetingId,
          transcriptId: value.transcriptId,
          transcriptRevision: value.transcriptRevision,
          previousEndMs,
          speakerIds
        });
        if (segmentIds.has(segment.transcriptSegmentId)) errors.push('DIARIZATION_TRANSCRIPT_SEGMENT_DUPLICATE');
        segmentIds.add(segment.transcriptSegmentId);
        previousEndMs = segment.endMs;
      } catch (error) {
        errors.push(error.code);
      }
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function anonymousSpeakerLabel(speakerRef) {
  if (speakerRef === 'unknown') return '未识别说话人';
  return anonymousLabelFor(anonymousSpeakerId(speakerRef));
}
