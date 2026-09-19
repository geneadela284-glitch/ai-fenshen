export const MEETING_AUDIO_IMPORT_SCHEMA_VERSION = 1;

export const MEETING_AUDIO_IMPORT_STATES = Object.freeze([
  'selected',
  'validating',
  'importing',
  'committed',
  'rejected',
  'failed_retryable',
  'cancelled',
  'deleting',
  'deleted'
]);

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

function timestamp(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const normalized = new Date(candidate || new Date()).toISOString();
  if (Number.isNaN(Date.parse(normalized))) throw codedError('MEETING_AUDIO_TIMESTAMP_INVALID');
  return normalized;
}

function result(state, { accepted = false, idempotent = false, errorCode = '' } = {}) {
  return Object.freeze({ state, accepted, idempotent, errorCode });
}

function nextState(session, changes, now) {
  return Object.freeze({
    ...session,
    ...changes,
    updatedAt: timestamp(now),
    revision: session.revision + 1
  });
}

function invalid(session, errorCode) {
  return result(session, { errorCode });
}

export function createMeetingAudioImportSession({
  importId,
  meetingId,
  ownerId,
  sourceId,
  scope = 'meeting',
  originalFileName = '',
  mimeType = '',
  format = '',
  byteLength = 0,
  durationMs = 0,
  fileIdentity = '',
  now = () => new Date().toISOString(),
  revision = 1
} = {}) {
  const createdAt = timestamp(now);
  const numericBytes = Number(byteLength);
  const numericDuration = Number(durationMs);
  if (!Number.isSafeInteger(numericBytes) || numericBytes < 0) throw codedError('AUDIO_BYTE_LENGTH_INVALID');
  if (!Number.isSafeInteger(numericDuration) || numericDuration < 0) throw codedError('AUDIO_DURATION_INVALID');
  return Object.freeze({
    schemaVersion: MEETING_AUDIO_IMPORT_SCHEMA_VERSION,
    importId: required(importId, 'IMPORT_ID_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    ownerId: required(ownerId, 'OWNER_REQUIRED'),
    sourceId: required(sourceId, 'SOURCE_ID_REQUIRED'),
    scope: required(scope, 'AUDIO_SCOPE_REQUIRED'),
    originalFileName: String(originalFileName || '').trim(),
    mimeType: String(mimeType || '').trim(),
    format: String(format || '').trim(),
    byteLength: numericBytes,
    durationMs: numericDuration,
    fileIdentity: String(fileIdentity || ''),
    importState: 'selected',
    checksum: '',
    chunkCount: 0,
    committedByteLength: 0,
    committedDurationMs: 0,
    errorCode: '',
    createdAt,
    updatedAt: createdAt,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1
  });
}

export function transitionMeetingAudioImport(session, event = {}, { now = () => new Date().toISOString() } = {}) {
  if (!session || typeof session !== 'object' || !MEETING_AUDIO_IMPORT_STATES.includes(session.importState)) {
    throw codedError('AUDIO_IMPORT_SESSION_INVALID');
  }
  const type = String(event.type || '').trim();
  const current = session.importState;

  if (type === 'begin_validation') {
    if (current === 'validating') return result(session, { idempotent: true });
    if (!['selected', 'cancelled', 'failed_retryable'].includes(current)) return invalid(session, 'IMPORT_NOT_VALIDATABLE');
    return result(nextState(session, { importState: 'validating', errorCode: '' }, now), { accepted: true });
  }

  if (type === 'validation_passed') {
    if (current === 'importing') return result(session, { idempotent: true });
    if (current !== 'validating') return invalid(session, 'IMPORT_NOT_VALIDATING');
    return result(nextState(session, {
      importState: 'importing',
      errorCode: '',
      checksum: '',
      chunkCount: 0,
      committedByteLength: 0,
      committedDurationMs: 0
    }, now), { accepted: true });
  }

  if (type === 'validation_rejected') {
    if (current === 'rejected') return result(session, { idempotent: true });
    if (current !== 'validating') return invalid(session, 'IMPORT_NOT_VALIDATING');
    return result(nextState(session, {
      importState: 'rejected',
      errorCode: required(event.errorCode || 'AUDIO_FILE_REJECTED', 'AUDIO_FILE_REJECTED')
    }, now), { accepted: true, errorCode: event.errorCode || 'AUDIO_FILE_REJECTED' });
  }

  if (type === 'chunk_committed') {
    if (current !== 'importing') return invalid(session, 'IMPORT_NOT_IMPORTING');
    const byteLength = Number(event.byteLength);
    const durationMs = Number(event.durationMs || 0);
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return invalid(session, 'AUDIO_CHUNK_SIZE_INVALID');
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) return invalid(session, 'AUDIO_CHUNK_DURATION_INVALID');
    return result(nextState(session, {
      chunkCount: session.chunkCount + 1,
      committedByteLength: session.committedByteLength + byteLength,
      committedDurationMs: session.committedDurationMs + durationMs,
      errorCode: ''
    }, now), { accepted: true });
  }

  if (type === 'commit') {
    if (current === 'committed') return result(session, { idempotent: true });
    if (current !== 'importing') return invalid(session, 'IMPORT_NOT_IMPORTING');
    const checksum = String(event.checksum || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(checksum)) return invalid(session, 'AUDIO_CHECKSUM_INVALID');
    return result(nextState(session, {
      importState: 'committed',
      checksum,
      errorCode: ''
    }, now), { accepted: true });
  }

  if (type === 'failed_retryable') {
    if (current === 'failed_retryable') return result(session, { idempotent: true });
    if (!['validating', 'importing'].includes(current)) return invalid(session, 'IMPORT_NOT_RETRYABLE');
    const errorCode = required(event.errorCode || 'IMPORT_FAILED_RETRYABLE', 'IMPORT_FAILED_RETRYABLE');
    return result(nextState(session, { importState: 'failed_retryable', errorCode }, now), { accepted: true, errorCode });
  }

  if (type === 'retry') {
    if (current === 'validating') return result(session, { idempotent: true });
    if (!['failed_retryable', 'cancelled', 'rejected'].includes(current)) return invalid(session, 'IMPORT_NOT_RETRYABLE');
    return result(nextState(session, { importState: 'validating', errorCode: '' }, now), { accepted: true });
  }

  if (type === 'cancel') {
    if (current === 'cancelled') return result(session, { idempotent: true });
    if (!['selected', 'validating', 'importing', 'failed_retryable'].includes(current)) return invalid(session, 'IMPORT_NOT_CANCELLABLE');
    return result(nextState(session, { importState: 'cancelled', errorCode: 'IMPORT_CANCELLED' }, now), { accepted: true, errorCode: 'IMPORT_CANCELLED' });
  }

  if (type === 'begin_delete') {
    if (current === 'deleting') return result(session, { idempotent: true });
    if (current === 'deleted') return invalid(session, 'IMPORT_ALREADY_DELETED');
    return result(nextState(session, { importState: 'deleting' }, now), { accepted: true });
  }

  if (type === 'delete') {
    if (current === 'deleted') return result(session, { idempotent: true });
    if (current !== 'deleting') return invalid(session, 'IMPORT_NOT_DELETING');
    return result(nextState(session, { importState: 'deleted' }, now), { accepted: true });
  }

  return invalid(session, 'IMPORT_EVENT_INVALID');
}
