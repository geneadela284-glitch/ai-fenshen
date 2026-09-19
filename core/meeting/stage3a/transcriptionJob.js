export const TRANSCRIPTION_JOB_SCHEMA_VERSION = 1;
export const TRANSCRIPTION_JOB_STATES = Object.freeze([
  'queued',
  'preparing',
  'transcribing',
  'stitching',
  'ready',
  'cancelled',
  'failed_retryable',
  'paused_retryable',
  'failed_terminal'
]);
export const MAX_AUTOMATIC_TRANSCRIPTION_RETRIES = 3;
export const MAX_AUTOMATIC_RETRY_WINDOW_MS = 10 * 60 * 1000;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function iso(value) {
  const normalized = new Date(value || new Date()).toISOString();
  if (Number.isNaN(Date.parse(normalized))) throw codedError('TRANSCRIPTION_JOB_TIMESTAMP_INVALID');
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

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function result(state, { accepted = false, idempotent = false, errorCode = '' } = {}) {
  return Object.freeze({ state, accepted, idempotent, errorCode });
}

function nextState(job, changes, now) {
  return Object.freeze({
    ...job,
    ...changes,
    updatedAt: iso(now),
    revision: job.revision + 1
  });
}

function invalid(job, errorCode) {
  return result(job, { errorCode });
}

export function createTranscriptionJob({
  ownerId,
  meetingId,
  sourceId,
  sourceRevision,
  transcriptId = `transcript-${sourceId}-${sourceRevision}`,
  jobId = `transcription-${sourceId}-${sourceRevision}`,
  now = new Date().toISOString()
} = {}) {
  const createdAt = iso(now);
  return Object.freeze({
    schemaVersion: TRANSCRIPTION_JOB_SCHEMA_VERSION,
    jobId: required(jobId, 'TRANSCRIPTION_JOB_ID_REQUIRED'),
    transcriptId: required(transcriptId, 'TRANSCRIPT_ID_REQUIRED'),
    ownerId: required(ownerId, 'OWNER_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    sourceId: required(sourceId, 'SOURCE_ID_REQUIRED'),
    sourceRevision: positiveInteger(sourceRevision, 'TRANSCRIPTION_SOURCE_REVISION_INVALID'),
    status: 'queued',
    attempts: 0,
    retryWindowStartedAt: createdAt,
    nextChunkSequence: 0,
    chunkCount: 0,
    completedChunkSequences: [],
    requestId: '',
    lease: null,
    cursor: null,
    errorCode: '',
    transcriptRevision: 1,
    createdAt,
    updatedAt: createdAt,
    revision: 1
  });
}

export function validateTranscriptionJob(job, { ownerId, sourceRevision } = {}) {
  const errors = [];
  if (!job || typeof job !== 'object') return { valid: false, errors: ['TRANSCRIPTION_JOB_INVALID'] };
  if (job.schemaVersion !== TRANSCRIPTION_JOB_SCHEMA_VERSION) errors.push('TRANSCRIPTION_JOB_SCHEMA_VERSION_INVALID');
  for (const field of ['jobId', 'transcriptId', 'ownerId', 'meetingId', 'sourceId', 'status', 'createdAt', 'updatedAt']) if (!String(job[field] || '').trim()) errors.push(`TRANSCRIPTION_JOB_${field.toUpperCase()}_REQUIRED`);
  if (ownerId && job.ownerId !== ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (sourceRevision !== undefined && job.sourceRevision !== sourceRevision) errors.push('SOURCE_REVISION_MISMATCH');
  if (!TRANSCRIPTION_JOB_STATES.includes(job.status)) errors.push('TRANSCRIPTION_JOB_STATUS_INVALID');
  for (const field of ['sourceRevision', 'nextChunkSequence', 'chunkCount', 'attempts', 'transcriptRevision', 'revision']) if (!Number.isSafeInteger(job[field]) || job[field] < 0 || (['sourceRevision', 'transcriptRevision', 'revision'].includes(field) && job[field] < 1)) errors.push(`TRANSCRIPTION_JOB_${field.toUpperCase()}_INVALID`);
  if (!Array.isArray(job.completedChunkSequences) || job.completedChunkSequences.some((value, index) => value !== index)) errors.push('TRANSCRIPTION_JOB_CHUNKS_INVALID');
  if (job.nextChunkSequence !== job.completedChunkSequences.length) errors.push('TRANSCRIPTION_JOB_CURSOR_INVALID');
  return { valid: errors.length === 0, errors };
}

export function transitionTranscriptionJob(job, event = {}, { now = new Date().toISOString() } = {}) {
  if (!validateTranscriptionJob(job).valid) throw codedError('TRANSCRIPTION_JOB_INVALID');
  const type = String(event.type || '').trim();
  const current = job.status;
  const at = iso(now);

  if (type === 'prepare') {
    if (current === 'preparing') return result(job, { idempotent: true });
    if (current !== 'queued') return invalid(job, 'TRANSCRIPTION_JOB_NOT_QUEUED');
    return result(nextState(job, { status: 'preparing', errorCode: '' }, at), { accepted: true });
  }

  if (type === 'begin_transcribing') {
    if (current === 'transcribing') return result(job, { idempotent: true });
    if (current !== 'preparing') return invalid(job, 'TRANSCRIPTION_JOB_NOT_PREPARING');
    return result(nextState(job, { status: 'transcribing', errorCode: '', requestId: String(event.requestId || job.requestId || '') }, at), { accepted: true });
  }

  if (type === 'reset_source_pipeline') {
    if (current !== 'transcribing') return invalid(job, 'TRANSCRIPTION_JOB_NOT_TRANSCRIBING');
    return result(nextState(job, {
      nextChunkSequence: 0,
      chunkCount: 0,
      completedChunkSequences: [],
      requestId: '',
      lease: null,
      cursor: null,
      errorCode: ''
    }, at), { accepted: true });
  }

  if (type === 'chunk_completed') {
    if (current !== 'transcribing') return invalid(job, 'TRANSCRIPTION_JOB_NOT_TRANSCRIBING');
    const sequence = nonNegativeInteger(event.sequence, 'TRANSCRIPTION_CHUNK_SEQUENCE_INVALID');
    if (sequence < job.nextChunkSequence && job.completedChunkSequences.includes(sequence)) return result(job, { idempotent: true });
    if (sequence !== job.nextChunkSequence) return invalid(job, 'TRANSCRIPTION_CHUNK_OUT_OF_ORDER');
    const completed = [...job.completedChunkSequences, sequence];
    return result(nextState(job, {
      completedChunkSequences: completed,
      nextChunkSequence: sequence + 1,
      chunkCount: event.chunkCount === undefined ? Math.max(job.chunkCount, completed.length) : positiveInteger(event.chunkCount, 'TRANSCRIPTION_CHUNK_COUNT_INVALID'),
      requestId: String(event.requestId || job.requestId || ''),
      lease: event.lease ?? job.lease,
      cursor: event.cursor ?? job.cursor,
      errorCode: ''
    }, at), { accepted: true });
  }

  if (type === 'begin_stitching') {
    if (current === 'stitching') return result(job, { idempotent: true });
    if (current !== 'transcribing') return invalid(job, 'TRANSCRIPTION_JOB_NOT_TRANSCRIBING');
    const expected = event.chunkCount === undefined ? job.chunkCount : positiveInteger(event.chunkCount, 'TRANSCRIPTION_CHUNK_COUNT_INVALID');
    if (job.completedChunkSequences.length !== expected) return invalid(job, 'TRANSCRIPTION_CHUNKS_INCOMPLETE');
    return result(nextState(job, { status: 'stitching', chunkCount: expected, errorCode: '' }, at), { accepted: true });
  }

  if (type === 'ready') {
    if (current === 'ready') return result(job, { idempotent: true });
    if (current !== 'stitching') return invalid(job, 'TRANSCRIPTION_JOB_NOT_STITCHING');
    return result(nextState(job, { status: 'ready', transcriptRevision: positiveInteger(event.transcriptRevision || job.transcriptRevision, 'TRANSCRIPT_REVISION_INVALID'), errorCode: '' }, at), { accepted: true });
  }

  if (type === 'provider_failed') {
    if (!['preparing', 'transcribing', 'stitching'].includes(current)) return invalid(job, 'TRANSCRIPTION_JOB_NOT_ACTIVE');
    const retryable = event.retryable !== false;
    if (!retryable) return result(nextState(job, { status: 'failed_terminal', errorCode: String(event.errorCode || 'TRANSCRIPTION_FAILED_TERMINAL') }, at), { accepted: true, errorCode: event.errorCode });
    const attempts = job.attempts + 1;
    const windowExpired = Date.parse(at) - Date.parse(job.retryWindowStartedAt) >= MAX_AUTOMATIC_RETRY_WINDOW_MS;
    const exhausted = attempts >= MAX_AUTOMATIC_TRANSCRIPTION_RETRIES;
    const status = windowExpired || exhausted ? 'paused_retryable' : 'failed_retryable';
    return result(nextState(job, {
      status,
      attempts,
      errorCode: String(event.errorCode || 'TRANSCRIPTION_PROVIDER_FAILED'),
      requestId: String(event.requestId || job.requestId || ''),
      lease: event.lease ?? job.lease,
      cursor: event.cursor ?? job.cursor
    }, at), { accepted: true, errorCode: event.errorCode });
  }

  if (type === 'retry') {
    if (current === 'queued') return result(job, { idempotent: true });
    if (current !== 'failed_retryable') return invalid(job, 'TRANSCRIPTION_JOB_NOT_RETRYABLE');
    if (job.attempts >= MAX_AUTOMATIC_TRANSCRIPTION_RETRIES || Date.parse(at) - Date.parse(job.retryWindowStartedAt) >= MAX_AUTOMATIC_RETRY_WINDOW_MS) {
      return result(nextState(job, { status: 'paused_retryable' }, at), { accepted: true });
    }
    return result(nextState(job, { status: 'queued', errorCode: '' }, at), { accepted: true });
  }

  if (type === 'manual_resume') {
    if (current === 'queued') return result(job, { idempotent: true });
    if (!['paused_retryable', 'failed_retryable', 'failed_terminal'].includes(current)) return invalid(job, 'TRANSCRIPTION_JOB_NOT_RESUMABLE');
    return result(nextState(job, {
      status: 'queued',
      attempts: 0,
      retryWindowStartedAt: at,
      nextChunkSequence: event.resetChunks === true ? 0 : job.completedChunkSequences.length,
      chunkCount: event.resetChunks === true ? 0 : job.chunkCount,
      completedChunkSequences: event.resetChunks === true ? [] : job.completedChunkSequences,
      lease: event.resetChunks === true ? null : job.lease,
      cursor: event.resetChunks === true ? null : job.cursor,
      errorCode: ''
    }, at), { accepted: true });
  }

  if (type === 'source_revision_changed') {
    return result(nextState(job, { status: 'failed_terminal', errorCode: 'SOURCE_REVISION_MISMATCH' }, at), { accepted: true, errorCode: 'SOURCE_REVISION_MISMATCH' });
  }

  if (type === 'cancel') {
    if (current === 'cancelled') return result(job, { idempotent: true });
    if (current === 'ready') return invalid(job, 'TRANSCRIPTION_JOB_ALREADY_READY');
    if (!['queued', 'preparing', 'transcribing', 'stitching', 'failed_retryable', 'paused_retryable'].includes(current)) return invalid(job, 'TRANSCRIPTION_JOB_NOT_CANCELLABLE');
    return result(nextState(job, { status: 'cancelled', errorCode: 'TRANSCRIPTION_CANCELLED', lease: null }, at), { accepted: true, errorCode: 'TRANSCRIPTION_CANCELLED' });
  }

  return invalid(job, 'TRANSCRIPTION_JOB_EVENT_INVALID');
}

export { codedError, clone };
