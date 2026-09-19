import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_JSON_BYTES = 48 * 1024;
const VERIFIED_AAC_MIME_TYPES = new Set(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']);

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

function boundedString(value, maximum = 240) {
  return String(value ?? '').trim().slice(0, maximum);
}

function bool(value) {
  return value === true;
}

function safeJson(value) {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) throw codedError('RECORDING_ATTEMPT_PAYLOAD_TOO_LARGE');
  return serialized;
}

function hashUserAgent(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function classifyUserAgent(userAgent) {
  const value = String(userAgent || '');
  const isIOS = /iPhone|iPad|iPod/i.test(value);
  const isChrome = isIOS
    && /AppleWebKit/i.test(value)
    && /CriOS\//i.test(value);
  const isSafari = isIOS
    && /AppleWebKit/i.test(value)
    && /Version\//i.test(value)
    && /Safari\//i.test(value)
    && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(value);
  return Object.freeze({
    normalizedDeviceClassification: isChrome
      ? 'iphone-chrome'
      : isSafari
        ? 'iphone-safari'
        : isIOS
          ? 'ios-other'
          : 'non-ios',
    isIOS,
    isSafari,
    isIphoneProfile: isSafari || isChrome
  });
}

function rowToAttempt(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
  return Object.freeze({
    recordingAttemptId: row.recording_attempt_id,
    authenticatedUserId: row.authenticated_user_id,
    ownerId: row.owner_id,
    scope: row.scope,
    generation: row.generation,
    implementationCommit: row.implementation_commit,
    clientBuildId: row.client_build_id,
    assetVersionId: row.asset_version_id,
    uaHash: row.ua_hash,
    normalizedDeviceClassification: row.device_classification,
    isIOS: row.is_ios === 1,
    isSafari: row.is_safari === 1,
    isIphoneProfile: row.is_iphone_profile === 1,
    supportedAacCodecMime: row.supported_aac_codec === 1,
    supportedAacPlainMime: row.supported_aac_plain === 1,
    selectedProfile: row.selected_profile,
    selectionReason: row.selection_reason,
    requestedMimeType: row.requested_mime_type,
    constructorOptions: payload.constructorOptions || {},
    capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
    actualMimeType: row.actual_mime_type,
    fallbackReason: row.fallback_reason,
    mismatchCode: row.mismatch_code,
    constructorErrorCode: payload.constructorErrorCode || '',
    gateResult: row.gate_result,
    errorCode: row.error_code,
    meetingId: row.meeting_id,
    sourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export function evaluateRecordingAttemptGate({
  attempt,
  expectedGeneration = '',
  expectedImplementationCommit = '',
  expectedClientBuildId = '',
  expectedAssetVersionId = ''
} = {}) {
  const identityMismatch = (expected, actual) => expected && String(expected) !== String(actual || '');
  if (identityMismatch(expectedGeneration, attempt.generation)
      || identityMismatch(expectedImplementationCommit, attempt.implementationCommit)
      || identityMismatch(expectedClientBuildId, attempt.clientBuildId)
      || identityMismatch(expectedAssetVersionId, attempt.assetVersionId)) {
    return Object.freeze({ ok: false, serverGate: 'AAC_PRIMARY_NOT_ACTIVE', errorCode: 'CLIENT_ASSET_VERSION_MISMATCH' });
  }
  if (!attempt.isIphoneProfile) {
    return Object.freeze({ ok: false, serverGate: 'AAC_PRIMARY_NOT_ACTIVE', errorCode: 'IPHONE_PROFILE_NOT_MATCHED' });
  }
  if (attempt.selectedProfile !== 'AAC_MP4_PRIMARY') {
    if (attempt.supportedAacCodecMime !== true && attempt.supportedAacPlainMime !== true) {
      return Object.freeze({ ok: false, serverGate: 'AAC_PRIMARY_NOT_ACTIVE', errorCode: 'AAC_UNSUPPORTED' });
    }
    return Object.freeze({ ok: false, serverGate: 'AAC_PRIMARY_NOT_ACTIVE', errorCode: 'WEBM_FALLBACK_SELECTED' });
  }
  if (!VERIFIED_AAC_MIME_TYPES.has(String(attempt.actualMimeType || '').trim().toLowerCase())) {
    return Object.freeze({ ok: false, serverGate: 'AAC_PRIMARY_NOT_ACTIVE', errorCode: 'AAC_CONSTRUCTOR_MIME_MISMATCH' });
  }
  return Object.freeze({ ok: true, serverGate: 'AAC_PRIMARY_ACTIVE', errorCode: null });
}

export class MeetingRecordingAttemptStore {
  constructor({ dbPath, clock = () => new Date() } = {}) {
    if (!dbPath || !path.isAbsolute(dbPath)) throw new TypeError('MeetingRecordingAttemptStore requires an absolute dbPath.');
    this.dbPath = path.normalize(dbPath);
    this.clock = clock;
    this.database = null;
  }

  nowIso() {
    const value = new Date(this.clock());
    if (!Number.isFinite(value.getTime())) throw new Error('RECORDING_ATTEMPT_CLOCK_INVALID');
    return value.toISOString();
  }

  secureFiles() {
    for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`, `${this.dbPath}-journal`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  initialize() {
    mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(this.dbPath), 0o700);
    this.database = new DatabaseSync(this.dbPath);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meeting_recording_attempts (
        recording_attempt_id TEXT PRIMARY KEY,
        authenticated_user_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        generation TEXT NOT NULL,
        implementation_commit TEXT NOT NULL,
        client_build_id TEXT NOT NULL,
        asset_version_id TEXT NOT NULL,
        ua_hash TEXT NOT NULL,
        device_classification TEXT NOT NULL,
        is_ios INTEGER NOT NULL,
        is_safari INTEGER NOT NULL,
        is_iphone_profile INTEGER NOT NULL,
        supported_aac_codec INTEGER NOT NULL,
        supported_aac_plain INTEGER NOT NULL,
        selected_profile TEXT NOT NULL,
        selection_reason TEXT NOT NULL,
        requested_mime_type TEXT NOT NULL,
        actual_mime_type TEXT NOT NULL,
        fallback_reason TEXT NOT NULL,
        mismatch_code TEXT NOT NULL,
        gate_result TEXT NOT NULL,
        error_code TEXT NOT NULL,
        meeting_id TEXT,
        source_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.database.exec('CREATE INDEX IF NOT EXISTS idx_meeting_recording_attempts_owner ON meeting_recording_attempts(owner_id, created_at)');
    this.secureFiles();
    return this;
  }

  close() {
    if (!this.database) return;
    this.secureFiles();
    this.database.close();
    this.database = null;
    this.secureFiles();
  }

  save({ authenticatedUserId, scope, userAgent, payload, gate } = {}) {
    if (!this.database) throw codedError('RECORDING_ATTEMPT_STORE_CLOSED');
    const ownerId = required(authenticatedUserId, 'AUTH_REQUIRED');
    const normalizedScope = required(scope, 'RECORDING_ATTEMPT_SCOPE_REQUIRED');
    const input = payload && typeof payload === 'object' ? payload : {};
    const recordingAttemptId = boundedString(input.recordingAttemptId || `recording-attempt-${Date.now()}`, 160);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(recordingAttemptId)) throw codedError('RECORDING_ATTEMPT_ID_INVALID');
    const existing = this.database.prepare('SELECT * FROM meeting_recording_attempts WHERE recording_attempt_id = ?').get(recordingAttemptId);
    if (existing) {
      if (existing.owner_id !== ownerId) throw codedError('RECORDING_ATTEMPT_OWNER_MISMATCH');
      return Object.freeze({ idempotent: true, attempt: rowToAttempt(existing) });
    }
    const timestamp = this.nowIso();
    const ua = classifyUserAgent(userAgent);
    const attempt = {
      recordingAttemptId,
      authenticatedUserId: ownerId,
      ownerId,
      scope: normalizedScope,
      generation: boundedString(input.generation, 32),
      implementationCommit: boundedString(input.implementationCommit, 80),
      clientBuildId: boundedString(input.clientBuildId, 160),
      assetVersionId: boundedString(input.assetVersionId, 240),
      uaHash: hashUserAgent(userAgent),
      ...ua,
      supportedAacCodecMime: bool(input.supportedAacCodecMime),
      supportedAacPlainMime: bool(input.supportedAacPlainMime),
      selectedProfile: boundedString(input.selectedProfile, 64),
      selectionReason: boundedString(input.selectionReason, 160),
      requestedMimeType: boundedString(input.requestedMimeType, 120),
      constructorOptions: input.constructorOptions && typeof input.constructorOptions === 'object'
        ? { mimeType: boundedString(input.constructorOptions.mimeType, 120) }
        : {},
      capabilities: Array.isArray(input.capabilities)
        ? input.capabilities.slice(0, 8).map((item) => Object.freeze({
          requestedMimeType: boundedString(item?.requestedMimeType, 120),
          supported: item?.supported === true
        }))
        : [],
      actualMimeType: boundedString(input.actualMimeType, 120),
      fallbackReason: boundedString(input.fallbackReason, 160),
      mismatchCode: boundedString(input.mismatchCode, 96),
      constructorErrorCode: boundedString(input.constructorErrorCode, 96),
      gateResult: gate.serverGate,
      errorCode: gate.errorCode || '',
      meetingId: boundedString(input.meetingId, 160) || null,
      sourceId: boundedString(input.sourceId, 160) || null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const payloadJson = safeJson(attempt);
    this.database.prepare(`
      INSERT INTO meeting_recording_attempts (
        recording_attempt_id, authenticated_user_id, owner_id, scope,
        generation, implementation_commit, client_build_id, asset_version_id,
        ua_hash, device_classification, is_ios, is_safari, is_iphone_profile,
        supported_aac_codec, supported_aac_plain, selected_profile, selection_reason,
        requested_mime_type, actual_mime_type, fallback_reason, mismatch_code,
        gate_result, error_code, meeting_id, source_id, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.recordingAttemptId, attempt.authenticatedUserId, attempt.ownerId, attempt.scope,
      attempt.generation, attempt.implementationCommit, attempt.clientBuildId, attempt.assetVersionId,
      attempt.uaHash, attempt.normalizedDeviceClassification, attempt.isIOS ? 1 : 0, attempt.isSafari ? 1 : 0,
      attempt.isIphoneProfile ? 1 : 0, attempt.supportedAacCodecMime ? 1 : 0, attempt.supportedAacPlainMime ? 1 : 0,
      attempt.selectedProfile, attempt.selectionReason, attempt.requestedMimeType, attempt.actualMimeType,
      attempt.fallbackReason, attempt.mismatchCode, attempt.gateResult, attempt.errorCode,
      attempt.meetingId, attempt.sourceId, payloadJson, attempt.createdAt, attempt.updatedAt
    );
    return Object.freeze({ idempotent: false, attempt: Object.freeze(attempt) });
  }

  bind({ authenticatedUserId, recordingAttemptId, meetingId, sourceId } = {}) {
    if (!this.database) throw codedError('RECORDING_ATTEMPT_STORE_CLOSED');
    const ownerId = required(authenticatedUserId, 'AUTH_REQUIRED');
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(sourceId, 'SOURCE_ID_REQUIRED');
    const row = this.database.prepare('SELECT * FROM meeting_recording_attempts WHERE recording_attempt_id = ?').get(String(recordingAttemptId || '').trim());
    if (!row) throw codedError('RECORDING_ATTEMPT_NOT_FOUND');
    if (row.owner_id !== ownerId) throw codedError('RECORDING_ATTEMPT_OWNER_MISMATCH');
    const existingMeetingId = String(row.meeting_id || '').trim();
    const existingSourceId = String(row.source_id || '').trim();
    if (existingMeetingId || existingSourceId) {
      if (existingMeetingId !== normalizedMeetingId || existingSourceId !== normalizedSourceId) {
        throw codedError('RECORDING_ATTEMPT_BIND_CONFLICT');
      }
      return Object.freeze({ ...rowToAttempt(row), idempotent: true });
    }
    const updatedAt = this.nowIso();
    this.database.prepare('UPDATE meeting_recording_attempts SET meeting_id = ?, source_id = ?, updated_at = ? WHERE recording_attempt_id = ?')
      .run(normalizedMeetingId, normalizedSourceId, updatedAt, row.recording_attempt_id);
    return Object.freeze({
      ...rowToAttempt(this.database.prepare('SELECT * FROM meeting_recording_attempts WHERE recording_attempt_id = ?').get(row.recording_attempt_id)),
      idempotent: false
    });
  }

  findBySource({ authenticatedUserId, meetingId, sourceId } = {}) {
    if (!this.database) throw codedError('RECORDING_ATTEMPT_STORE_CLOSED');
    const ownerId = required(authenticatedUserId, 'AUTH_REQUIRED');
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(sourceId, 'SOURCE_ID_REQUIRED');
    const row = this.database.prepare(`
      SELECT * FROM meeting_recording_attempts
      WHERE authenticated_user_id = ? AND owner_id = ? AND meeting_id = ? AND source_id = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(ownerId, ownerId, normalizedMeetingId, normalizedSourceId);
    return row ? rowToAttempt(row) : null;
  }

  findByAttempt({ authenticatedUserId, recordingAttemptId } = {}) {
    if (!this.database) throw codedError('RECORDING_ATTEMPT_STORE_CLOSED');
    const ownerId = required(authenticatedUserId, 'AUTH_REQUIRED');
    const normalizedAttemptId = required(recordingAttemptId, 'RECORDING_ATTEMPT_ID_REQUIRED');
    const row = this.database.prepare(`
      SELECT * FROM meeting_recording_attempts
      WHERE authenticated_user_id = ? AND owner_id = ? AND recording_attempt_id = ?
      LIMIT 1
    `).get(ownerId, ownerId, normalizedAttemptId);
    return row ? rowToAttempt(row) : null;
  }
}

export { classifyUserAgent, hashUserAgent };
