export const MEETING_TRANSCRIPT_SCHEMA_VERSION = 1;
export const TRANSCRIPT_KINDS = Object.freeze(['raw_asr', 'user_correction']);
export const TRANSCRIPT_DOCUMENT_STATUSES = Object.freeze([
  'not_started',
  'queued',
  'preparing',
  'transcribing',
  'stitching',
  'partial',
  'ready',
  'failed',
  'blocked',
  'cancelled'
]);

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

function timestamp(value, code = 'TRANSCRIPT_TIMESTAMP_INVALID') {
  const normalized = required(value || new Date().toISOString(), code);
  if (Number.isNaN(Date.parse(normalized))) throw codedError(code);
  return new Date(normalized).toISOString();
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

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  return Object.freeze(value);
}

export function assertOwnerContext(ownerContext) {
  if (!ownerContext || typeof ownerContext !== 'object' || ownerContext.trusted !== true) throw codedError('OWNER_CONTEXT_UNTRUSTED');
  return freeze({
    trusted: true,
    ownerId: required(ownerContext.ownerId, 'OWNER_REQUIRED'),
    sessionId: required(ownerContext.sessionId, 'OWNER_SESSION_REQUIRED'),
    spaceId: required(ownerContext.spaceId || 'meeting-space', 'SPACE_ID_REQUIRED')
  });
}

function assertOwnerOverride(context, ownerId) {
  if (ownerId !== undefined && String(ownerId) !== context.ownerId) throw codedError('OWNER_ID_OVERRIDE_REJECTED');
}

function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

export function stableTranscriptSegmentId({ transcriptId, sequence, startMs, endMs } = {}) {
  const id = required(transcriptId, 'TRANSCRIPT_ID_REQUIRED');
  const order = nonNegativeInteger(sequence, 'TRANSCRIPT_SEGMENT_SEQUENCE_INVALID');
  const start = nonNegativeInteger(startMs, 'TRANSCRIPT_SEGMENT_START_INVALID');
  const end = positiveInteger(endMs, 'TRANSCRIPT_SEGMENT_END_INVALID');
  if (end <= start) throw codedError('TRANSCRIPT_SEGMENT_TIME_INVALID');
  return `segment-${encodeURIComponent(`${id}:${order}:${start}:${end}`)}`;
}

export function assertCommittedAudioSource({ ownerContext: inputOwnerContext, source, expectedScope = 'meeting' } = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  if (!source || typeof source !== 'object') throw codedError('AUDIO_SOURCE_INVALID');
  if (source.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (String(source.scope || '') !== String(expectedScope || 'meeting')) throw codedError('AUDIO_SCOPE_MISMATCH');
  if (!['recorded', 'imported'].includes(source.origin)) throw codedError('AUDIO_SOURCE_ORIGIN_INVALID');
  if (source.importState !== 'committed') throw codedError('AUDIO_SOURCE_NOT_COMMITTED');
  required(source.sourceId, 'SOURCE_ID_REQUIRED');
  required(source.meetingId, 'MEETING_ID_REQUIRED');
  positiveInteger(source.revision, 'AUDIO_SOURCE_REVISION_INVALID');
  if (!validHash(source.checksum)) throw codedError('AUDIO_SOURCE_CHECKSUM_INVALID');
  return source;
}

export function createTranscriptDocument({
  ownerContext: inputOwnerContext,
  ownerId,
  transcriptId,
  meetingId,
  sourceId,
  scope = 'meeting',
  sourceRevision,
  transcriptRevision = 1,
  language = 'zh-CN',
  provider,
  model,
  status = 'not_started',
  sourceChecksum = '',
  createdAt,
  updatedAt
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerOverride(ownerContext, ownerId);
  const created = timestamp(createdAt);
  const updated = timestamp(updatedAt || created);
  const value = {
    schemaVersion: MEETING_TRANSCRIPT_SCHEMA_VERSION,
    transcriptId: required(transcriptId, 'TRANSCRIPT_ID_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    sourceId: required(sourceId, 'SOURCE_ID_REQUIRED'),
    ownerId: ownerContext.ownerId,
    scope: required(scope, 'TRANSCRIPT_SCOPE_REQUIRED'),
    sourceRevision: positiveInteger(sourceRevision, 'TRANSCRIPT_SOURCE_REVISION_INVALID'),
    transcriptRevision: positiveInteger(transcriptRevision, 'TRANSCRIPT_REVISION_INVALID'),
    language: required(language, 'TRANSCRIPT_LANGUAGE_REQUIRED'),
    provider: required(provider, 'TRANSCRIPT_PROVIDER_REQUIRED'),
    model: required(model, 'TRANSCRIPT_MODEL_REQUIRED'),
    status: required(status, 'TRANSCRIPT_STATUS_REQUIRED'),
    createdAt: created,
    updatedAt: updated
  };
  if (sourceChecksum !== '') {
    if (!validHash(sourceChecksum)) throw codedError('TRANSCRIPT_SOURCE_CHECKSUM_INVALID');
    value.sourceChecksum = sourceChecksum.toLowerCase();
  }
  if (!TRANSCRIPT_DOCUMENT_STATUSES.includes(value.status)) throw codedError('TRANSCRIPT_STATUS_INVALID');
  return freeze(value);
}

export function validateTranscriptDocument(value, { ownerContext: inputOwnerContext, source, expectedScope = 'meeting' } = {}) {
  const errors = [];
  let ownerContext = null;
  try {
    ownerContext = assertOwnerContext(inputOwnerContext);
  } catch (error) {
    errors.push(error.code);
  }
  if (!value || typeof value !== 'object') return { valid: false, errors: ['TRANSCRIPT_DOCUMENT_INVALID'] };
  if (value.schemaVersion !== MEETING_TRANSCRIPT_SCHEMA_VERSION) errors.push('TRANSCRIPT_SCHEMA_VERSION_INVALID');
  for (const field of ['transcriptId', 'meetingId', 'sourceId', 'ownerId', 'scope', 'language', 'provider', 'model', 'status', 'createdAt', 'updatedAt']) {
    if (!String(value[field] || '').trim()) errors.push(`TRANSCRIPT_${field.toUpperCase()}_REQUIRED`);
  }
  if (ownerContext && value.ownerId !== ownerContext.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (expectedScope && value.scope !== expectedScope) errors.push('TRANSCRIPT_SCOPE_MISMATCH');
  if (!Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 1) errors.push('TRANSCRIPT_SOURCE_REVISION_INVALID');
  if (!Number.isSafeInteger(value.transcriptRevision) || value.transcriptRevision < 1) errors.push('TRANSCRIPT_REVISION_INVALID');
  if (!TRANSCRIPT_DOCUMENT_STATUSES.includes(value.status)) errors.push('TRANSCRIPT_STATUS_INVALID');
  for (const field of ['createdAt', 'updatedAt']) if (Number.isNaN(Date.parse(value[field]))) errors.push(`TRANSCRIPT_${field.toUpperCase()}_INVALID`);
  if (value.sourceChecksum !== undefined && !validHash(value.sourceChecksum)) errors.push('TRANSCRIPT_SOURCE_CHECKSUM_INVALID');
  if (source) {
    if (value.sourceId !== source.sourceId) errors.push('SOURCE_SCOPE_MISMATCH');
    if (value.meetingId !== source.meetingId) errors.push('MEETING_SCOPE_MISMATCH');
    if (value.sourceRevision !== source.revision) errors.push('SOURCE_REVISION_MISMATCH');
    if (ownerContext && source.ownerId !== ownerContext.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  }
  return { valid: errors.length === 0, errors };
}

export function createTranscriptSegment({
  transcriptId,
  transcriptRevision,
  segmentId,
  sequence,
  startMs,
  endMs,
  text,
  confidence = null,
  speakerRef = null,
  sourceChunkRefs,
  wordTimings = null,
  revision = transcriptRevision
} = {}) {
  const normalizedTranscriptId = required(transcriptId, 'TRANSCRIPT_ID_REQUIRED');
  const normalizedSequence = nonNegativeInteger(sequence, 'TRANSCRIPT_SEGMENT_SEQUENCE_INVALID');
  const normalizedStart = nonNegativeInteger(startMs, 'TRANSCRIPT_SEGMENT_START_INVALID');
  const normalizedEnd = positiveInteger(endMs, 'TRANSCRIPT_SEGMENT_END_INVALID');
  if (normalizedEnd <= normalizedStart) throw codedError('TRANSCRIPT_SEGMENT_TIME_INVALID');
  const stableId = stableTranscriptSegmentId({ transcriptId: normalizedTranscriptId, sequence: normalizedSequence, startMs: normalizedStart, endMs: normalizedEnd });
  if (segmentId !== undefined && String(segmentId) !== stableId) throw codedError('TRANSCRIPT_SEGMENT_ID_UNSTABLE');
  if (confidence !== null && (!Number.isFinite(Number(confidence)) || Number(confidence) < 0 || Number(confidence) > 1)) throw codedError('TRANSCRIPT_CONFIDENCE_INVALID');
  if (!['unknown', null].includes(speakerRef)) throw codedError('SPEAKER_REF_MUST_BE_NULL');
  const refs = Array.isArray(sourceChunkRefs) ? [...new Set(sourceChunkRefs.map((ref) => String(ref || '').trim()).filter(Boolean))] : [];
  if (!refs.length) throw codedError('TRANSCRIPT_SOURCE_CHUNK_REF_REQUIRED');
  const normalizedRevision = positiveInteger(revision, 'TRANSCRIPT_SEGMENT_REVISION_INVALID');
  return freeze({
    schemaVersion: MEETING_TRANSCRIPT_SCHEMA_VERSION,
    segmentId: stableId,
    transcriptId: normalizedTranscriptId,
    transcriptRevision: positiveInteger(transcriptRevision, 'TRANSCRIPT_REVISION_INVALID'),
    sequence: normalizedSequence,
    startMs: normalizedStart,
    endMs: normalizedEnd,
    text: String(text ?? ''),
    confidence: confidence === null ? null : Number(confidence),
    speakerRef: speakerRef === 'unknown' ? 'unknown' : null,
    sourceChunkRefs: refs,
    wordTimings: wordTimings === null ? null : clone(wordTimings),
    revision: normalizedRevision
  });
}

export function validateTranscriptSegment(value, { transcriptId, revision, previousEndMs = null } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['TRANSCRIPT_SEGMENT_INVALID'] };
  if (value.schemaVersion !== MEETING_TRANSCRIPT_SCHEMA_VERSION) errors.push('TRANSCRIPT_SCHEMA_VERSION_INVALID');
  for (const field of ['segmentId', 'transcriptId', 'text']) if (typeof value[field] !== 'string' || !value[field].trim()) errors.push(`TRANSCRIPT_SEGMENT_${field.toUpperCase()}_REQUIRED`);
  if (transcriptId && value.transcriptId !== transcriptId) errors.push('TRANSCRIPT_ID_MISMATCH');
  if (!Number.isSafeInteger(value.transcriptRevision) || value.transcriptRevision < 1) errors.push('TRANSCRIPT_REVISION_INVALID');
  if (revision !== undefined && value.transcriptRevision !== revision) errors.push('TRANSCRIPT_SEGMENT_REVISION_MISMATCH');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) errors.push('TRANSCRIPT_SEGMENT_SEQUENCE_INVALID');
  if (!Number.isSafeInteger(value.startMs) || value.startMs < 0) errors.push('TRANSCRIPT_SEGMENT_START_INVALID');
  if (!Number.isSafeInteger(value.endMs) || value.endMs <= value.startMs) errors.push('TRANSCRIPT_SEGMENT_TIME_INVALID');
  if (previousEndMs !== null && Number.isSafeInteger(value.startMs) && value.startMs < previousEndMs) errors.push('TRANSCRIPT_SEGMENT_TIME_NOT_MONOTONIC');
  if (value.speakerRef !== null && value.speakerRef !== 'unknown') errors.push('SPEAKER_REF_FORBIDDEN');
  if (!Array.isArray(value.sourceChunkRefs) || !value.sourceChunkRefs.length || value.sourceChunkRefs.some((ref) => !String(ref || '').trim())) errors.push('TRANSCRIPT_SOURCE_CHUNK_REF_REQUIRED');
  if (value.confidence !== null && (!Number.isFinite(Number(value.confidence)) || Number(value.confidence) < 0 || Number(value.confidence) > 1)) errors.push('TRANSCRIPT_CONFIDENCE_INVALID');
  if (Number.isSafeInteger(value.sequence) && Number.isSafeInteger(value.startMs) && Number.isSafeInteger(value.endMs) && value.endMs > value.startMs) {
    const expected = stableTranscriptSegmentId({ transcriptId: value.transcriptId, sequence: value.sequence, startMs: value.startMs, endMs: value.endMs });
    if (value.segmentId !== expected) errors.push('TRANSCRIPT_SEGMENT_ID_UNSTABLE');
  }
  return { valid: errors.length === 0, errors };
}

function validateSegments(segments, transcriptId, revision) {
  if (!Array.isArray(segments) || !segments.length) throw codedError('TRANSCRIPT_SEGMENTS_REQUIRED');
  let previousEnd = 0;
  const normalized = segments.map((value, index) => {
    const check = validateTranscriptSegment(value, { transcriptId, revision, previousEndMs: previousEnd });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    if (value.sequence !== index) throw codedError('TRANSCRIPT_SEGMENT_SEQUENCE_NOT_CONTIGUOUS');
    previousEnd = value.endMs;
    return clone(value);
  });
  return normalized;
}

export function createTranscriptRevision({
  ownerContext: inputOwnerContext,
  ownerId,
  transcriptId,
  meetingId,
  sourceId,
  scope = 'meeting',
  sourceRevision,
  transcriptRevision,
  kind = 'raw_asr',
  segments,
  createdAt,
  createdBy = 'system',
  changes = []
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerOverride(ownerContext, ownerId);
  const normalizedRevision = positiveInteger(transcriptRevision, 'TRANSCRIPT_REVISION_INVALID');
  if (!TRANSCRIPT_KINDS.includes(kind)) throw codedError('TRANSCRIPT_KIND_INVALID');
  return freeze({
    schemaVersion: MEETING_TRANSCRIPT_SCHEMA_VERSION,
    transcriptId: required(transcriptId, 'TRANSCRIPT_ID_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    sourceId: required(sourceId, 'SOURCE_ID_REQUIRED'),
    ownerId: ownerContext.ownerId,
    scope: required(scope, 'TRANSCRIPT_SCOPE_REQUIRED'),
    sourceRevision: positiveInteger(sourceRevision, 'TRANSCRIPT_SOURCE_REVISION_INVALID'),
    transcriptRevision: normalizedRevision,
    kind,
    segments: validateSegments(segments, transcriptId, normalizedRevision),
    changes: clone(changes),
    createdAt: timestamp(createdAt),
    createdBy: required(createdBy, 'TRANSCRIPT_CREATED_BY_REQUIRED')
  });
}

export function createCorrectionRevision({ ownerContext: inputOwnerContext, ownerId, parent, actorId, edits, now } = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerOverride(ownerContext, ownerId);
  if (!parent || parent.kind !== 'raw_asr' && parent.kind !== 'user_correction') throw codedError('TRANSCRIPT_PARENT_INVALID');
  if (parent.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  const actor = required(actorId, 'TRANSCRIPT_ACTOR_REQUIRED');
  if (!Array.isArray(edits) || !edits.length) throw codedError('TRANSCRIPT_EDITS_REQUIRED');
  const nextRevision = positiveInteger(Number(parent.transcriptRevision) + 1, 'TRANSCRIPT_REVISION_INVALID');
  const byId = new Map(parent.segments.map((item) => [item.segmentId, item]));
  const changes = [];
  const nextSegments = parent.segments.map((item) => ({ ...item }));
  for (const edit of edits) {
    const current = byId.get(edit?.segmentId);
    if (!current) throw codedError('TRANSCRIPT_SEGMENT_NOT_FOUND');
    for (const key of ['sequence', 'startMs', 'endMs', 'sourceChunkRefs', 'speakerRef']) {
      if (Object.hasOwn(edit || {}, key)) throw codedError('TRANSCRIPT_TIMELINE_IMMUTABLE');
    }
    const nextText = String(edit.text ?? '');
    const startOffset = nonNegativeInteger(edit.startOffset ?? 0, 'TRANSCRIPT_EDIT_RANGE_INVALID');
    const endOffset = nonNegativeInteger(edit.endOffset ?? current.text.length, 'TRANSCRIPT_EDIT_RANGE_INVALID');
    if (endOffset < startOffset || endOffset > current.text.length) throw codedError('TRANSCRIPT_EDIT_RANGE_INVALID');
    const index = nextSegments.findIndex((item) => item.segmentId === current.segmentId);
    nextSegments[index] = { ...current, text: nextText };
    changes.push({
      segmentId: current.segmentId,
      startOffset,
      endOffset,
      previousText: current.text,
      nextText
    });
  }
  return createTranscriptRevision({
    ownerContext,
    meetingId: parent.meetingId,
    sourceId: parent.sourceId,
    scope: parent.scope,
    sourceRevision: parent.sourceRevision,
    transcriptId: parent.transcriptId,
    transcriptRevision: nextRevision,
    kind: 'user_correction',
    segments: nextSegments.map((item) => createTranscriptSegment({
      ...item,
      transcriptRevision: nextRevision,
      revision: nextRevision
    })),
    createdAt: now,
    createdBy: actor,
    changes
  });
}

export { codedError };
