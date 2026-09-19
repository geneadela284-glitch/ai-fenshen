import { resolveRecordedContainerLayout } from './meetingRecordingContainerLayout.js';

export const MEETING_AUDIO_CONTRACT_VERSION = 1;
export const MEETING_AUDIO_MANIFEST_VERSION = 1;
export const MEETING_AUDIO_RETENTION_DAYS = 30;
export const MEETING_AUDIO_MAX_BYTES = 1_073_741_824;
export const MEETING_AUDIO_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

export const MEETING_AUDIO_ORIGINS = Object.freeze(['recorded', 'imported']);
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
export const MEETING_AUDIO_FORMATS = Object.freeze(['recorded', 'm4a', 'aac', 'mp3', 'wav', 'webm-opus']);

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

function iso(value, code) {
  const normalized = required(value, code);
  if (Number.isNaN(Date.parse(normalized))) throw codedError(code);
  return new Date(normalized).toISOString();
}

function retentionExpiry(createdAt) {
  return new Date(Date.parse(createdAt) + MEETING_AUDIO_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function assertOwnerContext(ownerContext) {
  if (!ownerContext || typeof ownerContext !== 'object' || ownerContext.trusted !== true) throw codedError('OWNER_CONTEXT_UNTRUSTED');
  return Object.freeze({
    trusted: true,
    ownerId: required(ownerContext.ownerId, 'OWNER_REQUIRED'),
    sessionId: required(ownerContext.sessionId, 'OWNER_SESSION_REQUIRED'),
    spaceId: required(ownerContext.spaceId || 'meeting-space', 'SPACE_ID_REQUIRED')
  });
}

function assertOwnerOverride(ownerContext, ownerId) {
  if (ownerId !== undefined && String(ownerId) !== ownerContext.ownerId) throw codedError('OWNER_ID_OVERRIDE_REJECTED');
}

function checksum(value, code, { allowEmpty = false } = {}) {
  const normalized = String(value || '').trim().toLowerCase();
  if (allowEmpty && normalized === '') return '';
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw codedError(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw codedError(code);
  return numeric;
}

function positiveInteger(value, code) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw codedError(code);
  return numeric;
}

export function createAudioSource({ ownerContext, ownerId, meetingId, sourceId, scope = 'meeting', origin, originalFileName, mimeType, format, byteLength, durationMs, checksum: sourceChecksum, chunkCount, manifestVersion = MEETING_AUDIO_MANIFEST_VERSION, importState = 'committed', createdAt, updatedAt, retentionExpiresAt, revision = 1, importId = '', fileIdentity = '', manifestId = '', committedByteLength = byteLength, committedDurationMs = durationMs, containerLayout } = {}) {
  const context = assertOwnerContext(ownerContext);
  assertOwnerOverride(context, ownerId);
  const created = iso(createdAt || new Date().toISOString(), 'AUDIO_CREATED_AT_INVALID');
  const updated = iso(updatedAt || created, 'AUDIO_UPDATED_AT_INVALID');
  const retention = iso(retentionExpiresAt === undefined ? retentionExpiry(created) : retentionExpiresAt, 'AUDIO_RETENTION_EXPIRES_INVALID');
  const normalizedOrigin = required(origin, 'AUDIO_ORIGIN_REQUIRED');
  return Object.freeze({
    schemaVersion: MEETING_AUDIO_CONTRACT_VERSION,
    sourceId: required(sourceId, 'SOURCE_ID_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    ownerId: context.ownerId,
    scope: required(scope, 'AUDIO_SCOPE_REQUIRED'),
    origin: normalizedOrigin,
    originalFileName: String(originalFileName || '').trim(),
    mimeType: String(mimeType || '').trim(),
    format: required(format, 'AUDIO_FORMAT_REQUIRED'),
    byteLength: nonNegativeInteger(byteLength, 'AUDIO_BYTE_LENGTH_INVALID'),
    durationMs: nonNegativeInteger(durationMs, 'AUDIO_DURATION_INVALID'),
    checksum: checksum(sourceChecksum, 'AUDIO_CHECKSUM_INVALID', { allowEmpty: importState !== 'committed' }),
    chunkCount: nonNegativeInteger(chunkCount, 'AUDIO_CHUNK_COUNT_INVALID'),
    committedByteLength: nonNegativeInteger(committedByteLength, 'AUDIO_COMMITTED_BYTE_LENGTH_INVALID'),
    committedDurationMs: nonNegativeInteger(committedDurationMs, 'AUDIO_COMMITTED_DURATION_INVALID'),
    manifestVersion: positiveInteger(manifestVersion, 'AUDIO_MANIFEST_VERSION_INVALID'),
    importState: required(importState, 'AUDIO_IMPORT_STATE_REQUIRED'),
    createdAt: created,
    updatedAt: updated,
    retentionExpiresAt: retention,
    revision: positiveInteger(revision, 'AUDIO_REVISION_INVALID'),
    ...(normalizedOrigin === 'recorded'
      ? { containerLayout: resolveRecordedContainerLayout(containerLayout) }
      : {}),
    ...(String(manifestId || '').trim() ? { manifestId: String(manifestId).trim() } : {}),
    ...(String(importId || '').trim() ? { importId: String(importId).trim() } : {}),
    ...(String(fileIdentity || '').trim() ? { fileIdentity: String(fileIdentity).trim() } : {})
  });
}

export function createAudioAsset({ ownerContext, ownerId, meetingId, sourceId, assetId, chunkId, scope = 'meeting', sequence, byteLength, durationMs = 0, checksum: assetChecksum, mimeType, manifestVersion = MEETING_AUDIO_MANIFEST_VERSION, commitState = 'committed', createdAt, startedAt = '', endedAt = '' } = {}) {
  const context = assertOwnerContext(ownerContext);
  assertOwnerOverride(context, ownerId);
  return Object.freeze({
    schemaVersion: MEETING_AUDIO_CONTRACT_VERSION,
    assetId: required(assetId, 'AUDIO_ASSET_ID_REQUIRED'),
    chunkId: required(chunkId || assetId, 'AUDIO_CHUNK_ID_REQUIRED'),
    sourceId: required(sourceId, 'SOURCE_ID_REQUIRED'),
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    ownerId: context.ownerId,
    scope: required(scope, 'AUDIO_SCOPE_REQUIRED'),
    sequence: nonNegativeInteger(sequence, 'AUDIO_SEQUENCE_INVALID'),
    byteLength: positiveInteger(byteLength, 'AUDIO_ASSET_SIZE_INVALID'),
    durationMs: nonNegativeInteger(durationMs, 'AUDIO_ASSET_DURATION_INVALID'),
    checksum: checksum(assetChecksum, 'AUDIO_ASSET_CHECKSUM_INVALID'),
    mimeType: required(mimeType, 'AUDIO_ASSET_MIME_REQUIRED'),
    manifestVersion: positiveInteger(manifestVersion, 'AUDIO_MANIFEST_VERSION_INVALID'),
    commitState: required(commitState, 'AUDIO_ASSET_STATE_REQUIRED'),
    createdAt: iso(createdAt || new Date().toISOString(), 'AUDIO_ASSET_CREATED_AT_INVALID'),
    startedAt: String(startedAt || ''),
    endedAt: String(endedAt || '')
  });
}

function validation(value, errors, expected) {
  if (!value || typeof value !== 'object') return { valid: false, errors: ['AUDIO_CONTRACT_INVALID'] };
  if (value.schemaVersion !== MEETING_AUDIO_CONTRACT_VERSION) errors.push('AUDIO_SCHEMA_VERSION_INVALID');
  for (const field of ['sourceId', 'meetingId', 'ownerId', 'scope', 'format', 'mimeType', 'createdAt', 'updatedAt', 'retentionExpiresAt']) {
    if (!String(value[field] || '').trim()) errors.push(`AUDIO_${field.toUpperCase()}_REQUIRED`);
  }
  if (!MEETING_AUDIO_ORIGINS.includes(value.origin)) errors.push('AUDIO_ORIGIN_INVALID');
  if (!MEETING_AUDIO_FORMATS.includes(value.format)) errors.push('AUDIO_FORMAT_INVALID');
  if (!MEETING_AUDIO_IMPORT_STATES.includes(value.importState)) errors.push('AUDIO_IMPORT_STATE_INVALID');
  for (const field of ['createdAt', 'updatedAt', 'retentionExpiresAt']) if (Number.isNaN(Date.parse(value[field]))) errors.push(`AUDIO_${field.toUpperCase()}_INVALID`);
  if (Date.parse(value.retentionExpiresAt) < Date.parse(value.createdAt)) errors.push('AUDIO_RETENTION_EXPIRED_AT_INVALID');
  for (const [field, minimum] of [['byteLength', 0], ['durationMs', 0], ['chunkCount', 0], ['manifestVersion', 1], ['revision', 1]]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < minimum) errors.push(`AUDIO_${field.toUpperCase()}_INVALID`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.checksum || '') && !(value.importState !== 'committed' && value.checksum === '')) errors.push('AUDIO_CHECKSUM_INVALID');
  if (expected?.ownerContext && value.ownerId !== expected.ownerContext.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (expected?.meetingId && value.meetingId !== expected.meetingId) errors.push('MEETING_SCOPE_MISMATCH');
  return { valid: errors.length === 0, errors };
}

export function validateAudioSource(value, expected = {}) {
  const result = validation(value, [], expected);
  if (value?.origin === 'recorded') {
    try {
      resolveRecordedContainerLayout(value.containerLayout);
    } catch (error) {
      result.errors.push(error?.code || 'AUDIO_CONTAINER_LAYOUT_UNSUPPORTED');
      result.valid = false;
    }
  }
  return result;
}

export function validateAudioAsset(value, expected = {}) {
  const errors = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['AUDIO_ASSET_INVALID'] };
  if (value.schemaVersion !== MEETING_AUDIO_CONTRACT_VERSION) errors.push('AUDIO_SCHEMA_VERSION_INVALID');
  for (const field of ['assetId', 'chunkId', 'sourceId', 'meetingId', 'ownerId', 'scope', 'mimeType', 'createdAt']) {
    if (!String(value[field] || '').trim()) errors.push(`AUDIO_ASSET_${field.toUpperCase()}_REQUIRED`);
  }
  for (const [field, minimum] of [['sequence', 0], ['byteLength', 1], ['durationMs', 0], ['manifestVersion', 1]]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < minimum) errors.push(`AUDIO_ASSET_${field.toUpperCase()}_INVALID`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.checksum || '')) errors.push('AUDIO_ASSET_CHECKSUM_INVALID');
  if (value.commitState !== 'committed') errors.push('AUDIO_ASSET_STATE_INVALID');
  if (Number.isNaN(Date.parse(value.createdAt))) errors.push('AUDIO_ASSET_CREATED_AT_INVALID');
  if (expected.ownerContext && value.ownerId !== expected.ownerContext.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (expected.meetingId && value.meetingId !== expected.meetingId) errors.push('MEETING_SCOPE_MISMATCH');
  if (expected.sourceId && value.sourceId !== expected.sourceId) errors.push('SOURCE_SCOPE_MISMATCH');
  return { valid: errors.length === 0, errors };
}

export { assertOwnerContext };
