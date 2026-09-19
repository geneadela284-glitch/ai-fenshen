export const MEETING_PHASE0_SCHEMA_VERSION = 1;

export const MEETING_STATUSES = Object.freeze([
  'draft', 'consent_pending', 'recording', 'paused', 'interrupted', 'stopping',
  'importing', 'processing', 'completed', 'partial', 'failed', 'archived', 'deleted'
]);

export const AUDIO_SEGMENT_STATUSES = Object.freeze([
  'capturing', 'staged', 'validating', 'committed', 'queued', 'processing',
  'transcribed', 'verified', 'retryable', 'paused_retryable', 'deleted'
]);

export const TRANSCRIPT_SOURCES = Object.freeze(['raw_asr', 'user_correction', 'manual']);
export const TRANSCRIPT_STATUSES = Object.freeze(['not_started', 'queued', 'processing', 'raw_ready', 'partial', 'failed', 'blocked', 'editing', 'needs_review', 'verified', 'superseded']);

function error(code) {
  const value = new Error(code);
  value.code = code;
  return value;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw error(code);
  return normalized;
}

function iso(value, code) {
  const normalized = new Date(value || new Date()).toISOString();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw error(code);
  return normalized;
}

function clone(value) {
  return structuredClone(value);
}

function frozen(value) {
  return Object.freeze(value);
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function validateOwner(value, expectedOwnerId, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push('OWNER_REQUIRED');
  if (expectedOwnerId && value !== expectedOwnerId) errors.push('OWNER_MISMATCH');
}

export function createMeeting({
  meetingId,
  ownerId,
  trustedOwnerId = ownerId,
  title = '未命名会议',
  sourceType = 'recording',
  status = 'draft',
  createdAt = new Date().toISOString(),
  updatedAt = createdAt,
  revision = 1
} = {}) {
  const normalizedOwnerId = required(trustedOwnerId, 'OWNER_REQUIRED');
  const normalizedStatus = MEETING_STATUSES.includes(status) ? status : 'draft';
  return frozen({
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    ownerId: normalizedOwnerId,
    title: String(title || '未命名会议').trim() || '未命名会议',
    sourceType: required(sourceType, 'MEETING_SOURCE_REQUIRED'),
    status: normalizedStatus,
    createdAt: iso(createdAt, 'MEETING_CREATED_AT_INVALID'),
    updatedAt: iso(updatedAt, 'MEETING_UPDATED_AT_INVALID'),
    schemaVersion: MEETING_PHASE0_SCHEMA_VERSION,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1
  });
}

export function createAudioManifest({
  manifestId = null,
  meetingId,
  ownerId,
  expectedSegmentIndex = 0,
  committedDurationMs = 0,
  totalBytes = 0,
  status = 'active',
  revision = 1,
  committedSegmentIndexes = []
} = {}) {
  return frozen({
    manifestId: required(manifestId || `manifest-${meetingId}`, 'MANIFEST_ID_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    ownerId: required(ownerId, 'OWNER_REQUIRED'),
    expectedSegmentIndex,
    committedDurationMs,
    totalBytes,
    status: required(status, 'MANIFEST_STATUS_REQUIRED'),
    revision,
    committedSegmentIndexes: [...committedSegmentIndexes],
    schemaVersion: MEETING_PHASE0_SCHEMA_VERSION
  });
}

export function createAudioSegment({
  segmentId,
  meetingId,
  ownerId,
  segmentIndex,
  durationMs,
  plaintextHash,
  encryptedBlobRef,
  nonceRef,
  status = 'committed',
  committedAt = new Date().toISOString(),
  byteSize = 0,
  format = 'application/octet-stream',
  revision = 1
} = {}) {
  return frozen({
    segmentId: required(segmentId, 'SEGMENT_ID_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    ownerId: required(ownerId, 'OWNER_REQUIRED'),
    segmentIndex,
    durationMs,
    plaintextHash: required(plaintextHash, 'SEGMENT_HASH_REQUIRED'),
    encryptedBlobRef: required(encryptedBlobRef, 'SEGMENT_BLOB_REF_REQUIRED'),
    nonceRef: required(nonceRef, 'SEGMENT_NONCE_REF_REQUIRED'),
    status: required(status, 'SEGMENT_STATUS_REQUIRED'),
    committedAt: iso(committedAt, 'SEGMENT_COMMITTED_AT_INVALID'),
    byteSize,
    format: required(format, 'SEGMENT_FORMAT_REQUIRED'),
    revision,
    schemaVersion: MEETING_PHASE0_SCHEMA_VERSION
  });
}

export function createTranscriptRevision({
  transcriptRevisionId,
  meetingId,
  ownerId,
  parentRevisionId = null,
  source = 'raw_asr',
  status = 'raw_ready',
  createdAt = new Date().toISOString(),
  encryptedContentRef,
  revision = 1,
  content = null
} = {}) {
  return frozen({
    transcriptRevisionId: required(transcriptRevisionId, 'TRANSCRIPT_REVISION_ID_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    ownerId: required(ownerId, 'OWNER_REQUIRED'),
    parentRevisionId: parentRevisionId ? String(parentRevisionId) : null,
    source: required(source, 'TRANSCRIPT_SOURCE_REQUIRED'),
    status: required(status, 'TRANSCRIPT_STATUS_REQUIRED'),
    createdAt: iso(createdAt, 'TRANSCRIPT_CREATED_AT_INVALID'),
    encryptedContentRef: required(encryptedContentRef, 'TRANSCRIPT_CONTENT_REF_REQUIRED'),
    revision,
    schemaVersion: MEETING_PHASE0_SCHEMA_VERSION,
    ...(content === null ? {} : { content: clone(content) })
  });
}

export function validateMeeting(value, { ownerId } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['MEETING_INVALID'] };
  for (const field of ['meetingId', 'title', 'sourceType', 'createdAt', 'updatedAt']) if (!String(value[field] || '').trim()) errors.push(`MEETING_${field.toUpperCase()}_REQUIRED`);
  validateOwner(value.ownerId, ownerId, errors);
  if (!MEETING_STATUSES.includes(value.status)) errors.push('MEETING_STATUS_INVALID');
  if (value.schemaVersion !== MEETING_PHASE0_SCHEMA_VERSION) errors.push('MEETING_SCHEMA_VERSION_INVALID');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) errors.push('MEETING_REVISION_INVALID');
  return { valid: errors.length === 0, errors };
}

export function validateAudioManifest(value, { ownerId, meetingId } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['MANIFEST_INVALID'] };
  for (const field of ['manifestId', 'meetingId', 'ownerId', 'status']) if (!String(value[field] || '').trim()) errors.push(`MANIFEST_${field.toUpperCase()}_REQUIRED`);
  validateOwner(value.ownerId, ownerId, errors);
  if (meetingId && value.meetingId !== meetingId) errors.push('MEETING_MISMATCH');
  if (!Number.isSafeInteger(value.expectedSegmentIndex) || value.expectedSegmentIndex < 0) errors.push('MANIFEST_EXPECTED_INDEX_INVALID');
  if (!Number.isSafeInteger(value.committedDurationMs) || value.committedDurationMs < 0) errors.push('MANIFEST_DURATION_INVALID');
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0) errors.push('MANIFEST_BYTES_INVALID');
  if (!Array.isArray(value.committedSegmentIndexes) || value.committedSegmentIndexes.some((index, position) => index !== position)) errors.push('MANIFEST_SEGMENTS_INVALID');
  if (value.expectedSegmentIndex !== value.committedSegmentIndexes.length) errors.push('MANIFEST_INDEX_COUNT_MISMATCH');
  if (value.schemaVersion !== MEETING_PHASE0_SCHEMA_VERSION) errors.push('MANIFEST_SCHEMA_VERSION_INVALID');
  return { valid: errors.length === 0, errors };
}

export function validateAudioSegment(value, { ownerId, meetingId } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['SEGMENT_INVALID'] };
  for (const field of ['segmentId', 'meetingId', 'ownerId', 'plaintextHash', 'encryptedBlobRef', 'nonceRef', 'status', 'committedAt', 'format']) if (!String(value[field] || '').trim()) errors.push(`SEGMENT_${field.toUpperCase()}_REQUIRED`);
  validateOwner(value.ownerId, ownerId, errors);
  if (meetingId && value.meetingId !== meetingId) errors.push('MEETING_MISMATCH');
  if (!Number.isSafeInteger(value.segmentIndex) || value.segmentIndex < 0) errors.push('SEGMENT_INDEX_INVALID');
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs <= 0 || value.durationMs > 30_000) errors.push('SEGMENT_DURATION_INVALID');
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize <= 0 || value.byteSize > 8 * 1024 * 1024) errors.push('SEGMENT_SIZE_INVALID');
  if (!validHash(value.plaintextHash)) errors.push('SEGMENT_HASH_INVALID');
  if (!AUDIO_SEGMENT_STATUSES.includes(value.status)) errors.push('SEGMENT_STATUS_INVALID');
  if (value.schemaVersion !== MEETING_PHASE0_SCHEMA_VERSION) errors.push('SEGMENT_SCHEMA_VERSION_INVALID');
  return { valid: errors.length === 0, errors };
}

export function validateTranscriptRevision(value, { ownerId, meetingId } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['TRANSCRIPT_INVALID'] };
  for (const field of ['transcriptRevisionId', 'meetingId', 'ownerId', 'source', 'status', 'createdAt', 'encryptedContentRef']) if (!String(value[field] || '').trim()) errors.push(`TRANSCRIPT_${field.toUpperCase()}_REQUIRED`);
  validateOwner(value.ownerId, ownerId, errors);
  if (meetingId && value.meetingId !== meetingId) errors.push('MEETING_MISMATCH');
  if (!TRANSCRIPT_SOURCES.includes(value.source)) errors.push('TRANSCRIPT_SOURCE_INVALID');
  if (!TRANSCRIPT_STATUSES.includes(value.status)) errors.push('TRANSCRIPT_STATUS_INVALID');
  if (value.source === 'raw_asr' && !['raw_ready', 'partial', 'failed', 'blocked'].includes(value.status)) errors.push('RAW_TRANSCRIPT_MUTATION_FORBIDDEN');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) errors.push('TRANSCRIPT_REVISION_INVALID');
  if (value.schemaVersion !== MEETING_PHASE0_SCHEMA_VERSION) errors.push('TRANSCRIPT_SCHEMA_VERSION_INVALID');
  return { valid: errors.length === 0, errors };
}
