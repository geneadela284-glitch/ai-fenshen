import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

import {
  decryptBytes,
  encryptBytes,
  withProviderDataKey,
  validateKeyProvider
} from '../../localDataSpace/index.js';
import {
  assertTrustedOwnerContext,
  ownerHash,
  safeRelativePath
} from '../../localDataSpace/ownerContext.js';
import {
  createManifest,
  ensureDataSpaceLayout,
  resolveOwnerSpacePath,
  validateManifest
} from '../../localDataSpace/manifest.js';
import { EncryptedRecordStore } from '../../localDataSpace/encryptedRecordStore.js';
import { exportEncryptedArchive, restoreEncryptedArchive } from '../../localDataSpace/archive.js';
import { buildMeetingAad } from './meetingCrypto.js';
import {
  MEETING_PHASE0_SCHEMA_VERSION,
  createAudioManifest,
  createAudioSegment,
  createMeeting,
  createTranscriptRevision,
  validateAudioManifest,
  validateAudioSegment,
  validateMeeting,
  validateTranscriptRevision
} from './meetingDataContracts.js';

const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_DURATION_MS = 30_000;
const MEETING_RECORD_KIND = 'meeting';
const MANIFEST_RECORD_KIND = 'audio-manifest';
const SEGMENT_RECORD_KIND = 'audio-segment';
const TRANSCRIPT_RECORD_KIND = 'transcript-revision';
const EXPORT_RECORD_KIND = 'export-manifest';
const MEETING_ENCRYPTED_PAYLOAD_VERSION = 'meeting-encrypted-payload-v1';

function error(code, details = undefined) {
  const value = new Error(code);
  value.code = code;
  if (details !== undefined) value.details = details;
  return value;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw error(code);
  return normalized;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashedId(prefix, value) {
  return `${prefix}-${sha256(String(value)).slice(0, 48)}`;
}

function meetingGroupId(meetingId) {
  return `meeting-${sha256(String(meetingId)).slice(0, 48)}`;
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function jsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    throw error('MANIFEST_INVALID');
  }
}

function atomicWrite(filePath, bytes) {
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    const handle = openSync(temporary, 'r');
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, filePath);
  } catch (caught) {
    try { rmSync(temporary, { force: true }); } catch { /* cleanup is best effort */ }
    throw caught;
  }
}

function normalizeBytes(value) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!bytes || bytes.length === 0 || bytes.length > MAX_SEGMENT_BYTES) throw error('SEGMENT_SIZE_INVALID');
  return bytes;
}

function readInitialManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  const value = jsonFile(manifestPath);
  return value?.state === 'initializing' ? null : value;
}

function assertNoInterruptedSpace(spacePath) {
  const manifestPath = path.join(spacePath, 'manifest.json');
  if (!existsSync(manifestPath)) return;
  let marker;
  try { marker = jsonFile(manifestPath); } catch { return; }
  if (marker?.state !== 'initializing') return;
  for (const entry of readdirSync(spacePath, { withFileTypes: true })) {
    if (entry.name === 'manifest.json') continue;
    if (entry.isFile() || entry.isSymbolicLink()) throw error('DATA_SPACE_INCOMPLETE');
    if (entry.isDirectory() && readdirSync(path.join(spacePath, entry.name)).length > 0) throw error('DATA_SPACE_INCOMPLETE');
  }
}

function cleanupTemporaryFiles(rootDirectory) {
  if (!existsSync(rootDirectory)) return;
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
    const target = path.join(rootDirectory, entry.name);
    if (entry.name.startsWith('.local-data-space-')) {
      removeIfExists(target);
      continue;
    }
    if (entry.isDirectory()) {
      cleanupTemporaryFiles(target);
      continue;
    }
    if (entry.isFile() && entry.name.includes('.tmp-')) removeIfExists(target);
  }
}

function segmentAad(ownerId, segment) {
  return buildMeetingAad({
    ownerId,
    meetingId: segment.meetingId,
    entityType: 'audio-segment',
    schemaVersion: segment.schemaVersion,
    revision: segment.revision,
    segmentIndex: segment.segmentIndex
  });
}

function segmentEnvelopePath(spacePath, segmentId) {
  return path.join(spacePath, 'meetings', 'blobs', `${sha256(String(segmentId))}.enc`);
}

function removeIfExists(target) {
  try { rmSync(target, { recursive: true, force: true }); } catch { /* cleanup is best effort */ }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sealMeetingPayload(payload, dataKey, ownerId, { meetingId, entityType, revision = 1, segmentIndex = '' } = {}) {
  const context = Object.freeze({
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    entityType: required(entityType, 'ENTITY_TYPE_REQUIRED'),
    schemaVersion: MEETING_PHASE0_SCHEMA_VERSION,
    revision,
    segmentIndex
  });
  const aad = buildMeetingAad({ ownerId, ...context });
  return Object.freeze({
    version: MEETING_ENCRYPTED_PAYLOAD_VERSION,
    context,
    envelope: encryptBytes(Buffer.from(JSON.stringify(payload), 'utf8'), dataKey, { aad })
  });
}

function openMeetingPayload(wrapper, dataKey, ownerId, expectedEntityType = null) {
  try {
    if (!wrapper || wrapper.version !== MEETING_ENCRYPTED_PAYLOAD_VERSION || !wrapper.context || !wrapper.envelope) throw new Error('invalid');
    if (expectedEntityType && wrapper.context.entityType !== expectedEntityType) throw new Error('entity');
    const context = wrapper.context;
    const aad = buildMeetingAad({ ownerId, ...context });
    return JSON.parse(decryptBytes(wrapper.envelope, dataKey, { aad }).toString('utf8'));
  } catch {
    throw error('AUTHENTICATION_FAILED');
  }
}

export class MeetingFoundationStore {
  constructor({ rootDirectory, spacePath, ownerContext, keyProvider, dataKey, manifest, records, clock, faultInjector = null } = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.spacePath = spacePath;
    this.ownerContext = ownerContext;
    this.ownerId = ownerContext.ownerId;
    this.ownerHash = ownerHash(this.ownerId);
    this.keyProvider = keyProvider;
    this.dataKey = Buffer.from(dataKey);
    this.manifest = manifest;
    this.records = records;
    this.clock = clock;
    this.faultInjector = typeof faultInjector === 'function' ? faultInjector : null;
    this.closed = false;
    this.segmentLookup = new Map();
    this.restoreIdempotent = false;
  }

  static async open({ rootDirectory, ownerContext, keyProvider, clock = () => new Date(), faultInjector = null } = {}) {
    const trusted = assertTrustedOwnerContext(ownerContext);
    const providerValidation = validateKeyProvider(keyProvider);
    if (!providerValidation.valid) throw Object.assign(error('KEY_PROVIDER_INVALID'), { details: providerValidation.errors });
    const root = path.resolve(required(rootDirectory, 'DATA_ROOT_INVALID'));
    if (root === path.parse(root).root) throw error('DATA_ROOT_INVALID');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const spacePath = ensureDataSpaceLayout(root, trusted);
    assertNoInterruptedSpace(spacePath);
    cleanupTemporaryFiles(spacePath);
    const manifestPath = path.join(spacePath, 'manifest.json');
    const existingManifest = readInitialManifest(manifestPath);
    const spaceId = existingManifest?.spaceId || randomUUID();
    const keyRequest = { ownerId: trusted.ownerId, spaceId };
    const keyReference = existingManifest
      ? await keyProvider.getDataKey(keyRequest)
      : await keyProvider.createDataKey(keyRequest);
    let result;
    try {
      result = await withProviderDataKey(
        keyProvider,
        { ...keyRequest, keyHandle: keyReference },
        async (providerDataKey) => {
          const dataKey = Buffer.from(providerDataKey);
          let manifest = existingManifest;
          if (manifest) {
            const manifestCheck = validateManifest(manifest, { ownerId: trusted.ownerId, dataKey });
            if (!manifestCheck.valid) throw error('MANIFEST_INVALID', manifestCheck.errors);
            if (!existsSync(path.join(spacePath, 'meetings', 'meetings.sqlite'))) throw error('DATA_SPACE_INCOMPLETE');
          } else {
            manifest = createManifest({ ownerContext: trusted, spaceId, dataKey, createdAt: nowIso(clock) });
          }
          const records = await EncryptedRecordStore.open({
            databasePath: path.join(spacePath, 'meetings', 'meetings.sqlite'),
            ownerId: trusted.ownerId,
            spaceId: `${spaceId}:meetings`,
            dataKey,
            clock
          });
          try {
            if (!existingManifest) atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            const store = new MeetingFoundationStore({ rootDirectory: root, spacePath, ownerContext: trusted, keyProvider, dataKey, manifest, records, clock, faultInjector });
            await store.verifyConsistency();
            return store;
          } catch (caught) {
            await records.close();
            throw caught;
          }
        }
      );
      return result;
    } catch (caught) {
      if (caught?.code) throw caught;
      throw error('MEETING_FOUNDATION_OPEN_FAILED');
    }
  }

  _requireOpen() {
    if (this.closed) throw error('MEETING_FOUNDATION_CLOSED');
  }

  _recordId(kind, id) {
    return hashedId(kind, id);
  }

  _sourceId(kind, id) {
    return hashedId(`source-${kind}`, id);
  }

  _groupId(meetingId) {
    return meetingGroupId(meetingId);
  }

  _seal(payload, context) {
    return sealMeetingPayload(payload, this.dataKey, this.ownerId, context);
  }

  _openRow(row, expectedEntityType = null) {
    return row ? openMeetingPayload(row.payload, this.dataKey, this.ownerId, expectedEntityType) : null;
  }

  _fault(point, context = {}) {
    if (this.faultInjector) this.faultInjector(point, context);
  }

  _writeManifestFile(manifest) {
    atomicWrite(path.join(this.spacePath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  _blobPath(segmentId) {
    return segmentEnvelopePath(this.spacePath, segmentId);
  }

  _blobRelativePath(segmentId) {
    return safeRelativePath(path.relative(this.spacePath, this._blobPath(segmentId)).split(path.sep).join('/'));
  }

  async _getRecord(kind, id) {
    const row = await this.records.get(this._recordId(kind, id));
    return this._openRow(row, kind);
  }

  async createMeeting(input = {}) {
    this._requireOpen();
    const meetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const existing = await this._getRecord(MEETING_RECORD_KIND, meetingId);
    if (existing) {
      const requestedTitle = input.title === undefined ? existing.title : String(input.title || '未命名会议').trim() || '未命名会议';
      const requestedSourceType = input.sourceType === undefined ? existing.sourceType : String(input.sourceType).trim();
      if (existing.title !== requestedTitle || existing.sourceType !== requestedSourceType) throw error('MEETING_CONFLICT');
      return existing;
    }
    const meeting = createMeeting({ ...input, meetingId, trustedOwnerId: this.ownerId });
    const audioManifest = createAudioManifest({ meetingId, ownerId: this.ownerId });
    await this.records.transaction(({ insert }) => {
      insert({
        recordId: this._recordId(MEETING_RECORD_KIND, meetingId),
        kind: MEETING_RECORD_KIND,
        sourceId: this._sourceId(MEETING_RECORD_KIND, meetingId),
        payload: this._seal(meeting, { meetingId, entityType: MEETING_RECORD_KIND, revision: meeting.revision })
      });
      insert({
        recordId: this._recordId(MANIFEST_RECORD_KIND, meetingId),
        kind: MANIFEST_RECORD_KIND,
        sourceId: this._sourceId(MANIFEST_RECORD_KIND, meetingId),
        groupId: this._groupId(meetingId),
        payload: this._seal(audioManifest, { meetingId, entityType: MANIFEST_RECORD_KIND, revision: audioManifest.revision })
      });
    });
    return meeting;
  }

  async getMeeting(meetingId) {
    this._requireOpen();
    return this._getRecord(MEETING_RECORD_KIND, required(meetingId, 'MEETING_ID_REQUIRED'));
  }

  async listMeetings() {
    this._requireOpen();
    return (await this.records.list({ kind: MEETING_RECORD_KIND })).map((row) => this._openRow(row, MEETING_RECORD_KIND));
  }

  async getAudioManifest(meetingId) {
    this._requireOpen();
    return this._getRecord(MANIFEST_RECORD_KIND, required(meetingId, 'MEETING_ID_REQUIRED'));
  }

  async listAudioSegments(meetingId) {
    this._requireOpen();
    const rows = await this.records.list({ kind: SEGMENT_RECORD_KIND, groupId: this._groupId(required(meetingId, 'MEETING_ID_REQUIRED')) });
    const segments = rows.map((row) => this._openRow(row, SEGMENT_RECORD_KIND)).sort((left, right) => left.segmentIndex - right.segmentIndex);
    segments.forEach((segment) => this.segmentLookup.set(segment.segmentId, segment));
    return segments;
  }

  async getAudioSegment(segmentId) {
    this._requireOpen();
    const row = await this.records.get(this._recordId(SEGMENT_RECORD_KIND, required(segmentId, 'SEGMENT_ID_REQUIRED')));
    if (!row) return null;
    const segment = this._openRow(row, SEGMENT_RECORD_KIND);
    this.segmentLookup.set(segment.segmentId, segment);
    return segment;
  }

  _writeEncryptedSegment(segment, bytes) {
    const envelope = encryptBytes(bytes, this.dataKey, { aad: segmentAad(this.ownerId, segment) });
    const finalPath = this._blobPath(segment.segmentId);
    mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    const temporary = `${finalPath}.tmp-${randomUUID()}`;
    let committed = false;
    try {
      writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      const handle = openSync(temporary, 'r');
      try { fsyncSync(handle); } finally { closeSync(handle); }
      this._fault('after-stage', { segment });
      const staged = JSON.parse(readFileSync(temporary, 'utf8'));
      const checked = decryptBytes(staged, this.dataKey, { aad: segmentAad(this.ownerId, segment) });
      if (sha256(checked) !== segment.plaintextHash || checked.length !== segment.byteSize) throw error('SEGMENT_INTEGRITY_FAILED');
      this._fault('after-validation', { segment });
      renameSync(temporary, finalPath);
      committed = true;
      this._fault('after-blob-commit', { segment, path: finalPath });
      return { envelope, finalPath };
    } catch (caught) {
      try { rmSync(temporary, { force: true }); } catch { /* cleanup is best effort */ }
      if (committed) removeIfExists(finalPath);
      throw caught;
    }
  }

  async putAudioSegment({ meetingId, segmentId, segmentIndex, durationMs, bytes, format = 'application/octet-stream' } = {}) {
    this._requireOpen();
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const meeting = await this.getMeeting(normalizedMeetingId);
    if (!meeting) throw error('MEETING_NOT_FOUND');
    const manifest = await this.getAudioManifest(normalizedMeetingId);
    if (!manifest) throw error('MANIFEST_NOT_FOUND');
    const data = normalizeBytes(bytes);
    const contentHash = sha256(data);
    const normalizedSegmentId = required(segmentId, 'SEGMENT_ID_REQUIRED');
    const existingById = await this.getAudioSegment(normalizedSegmentId);
    if (existingById) {
      if (existingById.meetingId !== normalizedMeetingId || existingById.plaintextHash !== contentHash || existingById.segmentIndex !== segmentIndex) throw error('SEGMENT_ID_CONFLICT');
      return Object.freeze({ segment: existingById, idempotent: true });
    }
    const existingSegments = await this.listAudioSegments(normalizedMeetingId);
    const existingByHash = existingSegments.find((segment) => segment.plaintextHash === contentHash);
    if (existingByHash) return Object.freeze({ segment: existingByHash, idempotent: true, duplicateOf: existingByHash.segmentId });
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex !== manifest.expectedSegmentIndex) throw error('SEGMENT_ORDER_INVALID');
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_SEGMENT_DURATION_MS) throw error('SEGMENT_DURATION_INVALID');
    const segment = createAudioSegment({
      segmentId: normalizedSegmentId,
      meetingId: normalizedMeetingId,
      ownerId: this.ownerId,
      segmentIndex,
      durationMs,
      byteSize: data.length,
      plaintextHash: contentHash,
      encryptedBlobRef: this._blobRelativePath(normalizedSegmentId),
      nonceRef: `nonce-${sha256(normalizedSegmentId).slice(0, 32)}`,
      format,
      status: 'committed'
    });
    const nextManifest = createAudioManifest({
      ...manifest,
      expectedSegmentIndex: manifest.expectedSegmentIndex + 1,
      committedDurationMs: manifest.committedDurationMs + durationMs,
      totalBytes: manifest.totalBytes + data.length,
      revision: manifest.revision + 1,
      committedSegmentIndexes: [...manifest.committedSegmentIndexes, segmentIndex]
    });
    const mutableNextManifest = structuredClone(nextManifest);
    this._fault('before-manifest-commit', { segment, manifest, nextManifest: mutableNextManifest });
    const { finalPath } = this._writeEncryptedSegment(segment, data);
    let metadataCommitted = false;
    try {
      await this.records.transaction(({ insert, update }) => {
        insert({
          recordId: this._recordId(SEGMENT_RECORD_KIND, segment.segmentId),
          kind: SEGMENT_RECORD_KIND,
          sourceId: this._sourceId(SEGMENT_RECORD_KIND, segment.segmentId),
          groupId: this._groupId(normalizedMeetingId),
          relativePath: segment.encryptedBlobRef,
          payload: this._seal(segment, {
            meetingId: normalizedMeetingId,
            entityType: SEGMENT_RECORD_KIND,
            revision: segment.revision,
            segmentIndex: segment.segmentIndex
          })
        });
        update(
          this._recordId(MANIFEST_RECORD_KIND, normalizedMeetingId),
          this._seal(mutableNextManifest, {
            meetingId: normalizedMeetingId,
            entityType: MANIFEST_RECORD_KIND,
            revision: mutableNextManifest.revision
          })
        );
      });
      metadataCommitted = true;
      this._fault('after-manifest-commit', { segment, manifest: mutableNextManifest, path: finalPath });
      this.segmentLookup.set(segment.segmentId, segment);
      return Object.freeze({ segment, idempotent: false });
    } catch (caught) {
      if (!metadataCommitted) {
        try {
          await this.records.delete(this._recordId(SEGMENT_RECORD_KIND, segment.segmentId));
        } catch { /* transaction rollback normally leaves no record */ }
        removeIfExists(finalPath);
      }
      throw caught;
    }
  }

  async appendTranscriptRevision({ meetingId, transcriptRevisionId, parentRevisionId = null, source = 'raw_asr', status = 'raw_ready', content } = {}) {
    this._requireOpen();
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    if (!(await this.getMeeting(normalizedMeetingId))) throw error('MEETING_NOT_FOUND');
    const revisionId = required(transcriptRevisionId, 'TRANSCRIPT_REVISION_ID_REQUIRED');
    const existingRevision = await this._getRecord(TRANSCRIPT_RECORD_KIND, revisionId);
    if (existingRevision) {
      const requested = createTranscriptRevision({
        meetingId: normalizedMeetingId,
        ownerId: this.ownerId,
        transcriptRevisionId: revisionId,
        parentRevisionId,
        source,
        status,
        createdAt: existingRevision.createdAt,
        revision: existingRevision.revision,
        encryptedContentRef: existingRevision.encryptedContentRef,
        content
      });
      if (!sameJson(existingRevision, requested)) throw error('TRANSCRIPT_REVISION_EXISTS');
      return existingRevision;
    }
    const existing = (await this.records.list({ kind: TRANSCRIPT_RECORD_KIND, groupId: this._groupId(normalizedMeetingId) })).map((row) => this._openRow(row, TRANSCRIPT_RECORD_KIND)).sort((left, right) => left.revision - right.revision);
    const latest = existing.at(-1) || null;
    if (latest && parentRevisionId !== latest.transcriptRevisionId) throw error('TRANSCRIPT_PARENT_NOT_LATEST');
    if (!latest && parentRevisionId) throw error('TRANSCRIPT_PARENT_NOT_FOUND');
    const revision = createTranscriptRevision({
      meetingId: normalizedMeetingId,
      ownerId: this.ownerId,
      transcriptRevisionId: revisionId,
      parentRevisionId,
      source,
      status,
      revision: existing.length + 1,
      encryptedContentRef: `meetings/transcripts/${sha256(revisionId)}.enc`,
      content
    });
    await this.records.transaction(({ insert }) => {
      insert({
        recordId: this._recordId(TRANSCRIPT_RECORD_KIND, revisionId),
        kind: TRANSCRIPT_RECORD_KIND,
        sourceId: this._sourceId(TRANSCRIPT_RECORD_KIND, revisionId),
        groupId: this._groupId(normalizedMeetingId),
        relativePath: revision.encryptedContentRef,
        payload: this._seal(revision, {
          meetingId: normalizedMeetingId,
          entityType: TRANSCRIPT_RECORD_KIND,
          revision: revision.revision
        })
      });
    });
    return revision;
  }

  async getTranscriptRevision(transcriptRevisionId) {
    this._requireOpen();
    return this._getRecord(TRANSCRIPT_RECORD_KIND, required(transcriptRevisionId, 'TRANSCRIPT_REVISION_ID_REQUIRED'));
  }

  async listTranscriptRevisions(meetingId) {
    this._requireOpen();
    return (await this.records.list({ kind: TRANSCRIPT_RECORD_KIND, groupId: this._groupId(required(meetingId, 'MEETING_ID_REQUIRED')) })).map((row) => this._openRow(row, TRANSCRIPT_RECORD_KIND)).sort((left, right) => left.revision - right.revision);
  }

  readStoredSegmentEnvelope(segmentId, { ownerId = this.ownerId } = {}) {
    this._requireOpen();
    if (ownerId !== this.ownerId) throw error('OWNER_MISMATCH');
    const filePath = this._blobPath(required(segmentId, 'SEGMENT_ID_REQUIRED'));
    if (!existsSync(filePath)) throw error('SEGMENT_BLOB_NOT_FOUND');
    return jsonFile(filePath);
  }

  readAudioSegmentBytes(segmentId, { ownerId = this.ownerId } = {}) {
    this._requireOpen();
    if (ownerId !== this.ownerId) throw error('OWNER_MISMATCH');
    const segment = this.segmentLookup.get(required(segmentId, 'SEGMENT_ID_REQUIRED'));
    if (!segment) throw error('SEGMENT_NOT_LOADED');
    const plaintext = decryptBytes(this.readStoredSegmentEnvelope(segment.segmentId), this.dataKey, { aad: segmentAad(this.ownerId, segment) });
    if (sha256(plaintext) !== segment.plaintextHash) throw error('SEGMENT_INTEGRITY_FAILED');
    return plaintext;
  }

  async verifyConsistency() {
    this._requireOpen();
    await this.records.integrityCheck();
    const meetings = await this.listMeetings();
    const referencedBlobs = new Set();
    for (const meeting of meetings) {
      const meetingCheck = validateMeeting(meeting, { ownerId: this.ownerId });
      if (!meetingCheck.valid) throw error('MEETING_CONTRACT_INVALID', meetingCheck.errors);
      const manifest = await this.getAudioManifest(meeting.meetingId);
      const manifestCheck = validateAudioManifest(manifest, { ownerId: this.ownerId, meetingId: meeting.meetingId });
      if (!manifestCheck.valid) throw error('MANIFEST_SEGMENT_MISMATCH', manifestCheck.errors);
      const segments = await this.listAudioSegments(meeting.meetingId);
      if (segments.length !== manifest.expectedSegmentIndex || segments.some((segment, index) => segment.segmentIndex !== index)) throw error('MANIFEST_SEGMENT_MISMATCH');
      let durationTotal = 0;
      let byteTotal = 0;
      for (const segment of segments) {
        const segmentCheck = validateAudioSegment(segment, { ownerId: this.ownerId, meetingId: meeting.meetingId });
        if (!segmentCheck.valid) throw error('SEGMENT_CONTRACT_INVALID', segmentCheck.errors);
        const blobPath = this._blobPath(segment.segmentId);
        if (!existsSync(blobPath)) throw error('MANIFEST_SEGMENT_MISMATCH');
        const plaintext = decryptBytes(jsonFile(blobPath), this.dataKey, { aad: segmentAad(this.ownerId, segment) });
        if (plaintext.length !== segment.byteSize || sha256(plaintext) !== segment.plaintextHash) throw error('SEGMENT_INTEGRITY_FAILED');
        durationTotal += segment.durationMs;
        byteTotal += segment.byteSize;
        referencedBlobs.add(path.resolve(blobPath));
      }
      if (durationTotal !== manifest.committedDurationMs || byteTotal !== manifest.totalBytes) throw error('MANIFEST_SEGMENT_MISMATCH');
      for (const revision of await this.listTranscriptRevisions(meeting.meetingId)) {
        const revisionCheck = validateTranscriptRevision(revision, { ownerId: this.ownerId, meetingId: meeting.meetingId });
        if (!revisionCheck.valid) throw error('TRANSCRIPT_CONTRACT_INVALID', revisionCheck.errors);
      }
    }
    const blobDirectory = path.join(this.spacePath, 'meetings', 'blobs');
    if (existsSync(blobDirectory)) {
      for (const entry of readdirSync(blobDirectory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!referencedBlobs.has(path.resolve(path.join(blobDirectory, entry.name)))) throw error('MANIFEST_SEGMENT_MISMATCH');
      }
    }
    return Object.freeze({ status: 'ok', meetingCount: meetings.length });
  }

  async exportEncrypted({ destinationPath, recoveryKey } = {}) {
    this._requireOpen();
    if (recoveryKey === undefined) throw error('RECOVERY_KEY_REQUIRED');
    if (typeof this.keyProvider?.wrapForRecovery !== 'function') throw error('KEY_RECOVERY_UNAVAILABLE');
    const keyWrapping = await this.keyProvider.wrapForRecovery({ ownerId: this.ownerId, spaceId: this.manifest.spaceId, recoveryKey });
    const exported = await exportEncryptedArchive({ sourceRoot: this.spacePath, ownerId: this.ownerId, manifest: this.manifest, dataKey: this.dataKey, destinationPath, keyWrapping, createdAt: nowIso(this.clock) });
    const meetingIds = (await this.listMeetings()).map((meeting) => meeting.meetingId);
    const exportId = `export-${sha256(exported.path)}`;
    const payload = { exportId, path: exported.path, meetingIds, createdAt: nowIso(this.clock), schemaVersion: MEETING_PHASE0_SCHEMA_VERSION };
    await this.records.transaction(({ insert }) => {
      insert({
        recordId: this._recordId(EXPORT_RECORD_KIND, exportId),
        kind: EXPORT_RECORD_KIND,
        sourceId: this._sourceId(EXPORT_RECORD_KIND, exportId),
        payload: this._seal(payload, { meetingId: `export:${exportId}`, entityType: EXPORT_RECORD_KIND, revision: 1 })
      });
    });
    return exported;
  }

  async deleteMeeting(meetingId) {
    this._requireOpen();
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const meeting = await this.getMeeting(normalizedMeetingId);
    if (!meeting) throw error('MEETING_NOT_FOUND');
    const segments = await this.listAudioSegments(normalizedMeetingId);
    const transcriptRows = await this.records.list({ kind: TRANSCRIPT_RECORD_KIND, groupId: this._groupId(normalizedMeetingId) });
    const manifestRecordId = this._recordId(MANIFEST_RECORD_KIND, normalizedMeetingId);
    const meetingRecordId = this._recordId(MEETING_RECORD_KIND, normalizedMeetingId);
    const managedExports = (await this.records.list({ kind: EXPORT_RECORD_KIND }))
      .map((row) => ({ ...row, payload: this._openRow(row, EXPORT_RECORD_KIND) }))
      .filter((row) => row.payload.meetingIds?.includes(normalizedMeetingId));
    await this.records.transaction(({ delete: deleteRecord }) => {
      deleteRecord(meetingRecordId);
      deleteRecord(manifestRecordId);
      for (const segment of segments) deleteRecord(this._recordId(SEGMENT_RECORD_KIND, segment.segmentId));
      for (const row of transcriptRows) deleteRecord(row.recordId);
      for (const row of managedExports) deleteRecord(row.recordId);
    });
    for (const segment of segments) removeIfExists(this._blobPath(segment.segmentId));
    removeIfExists(path.join(this.spacePath, 'index', sha256(normalizedMeetingId)));
    removeIfExists(path.join(this.spacePath, 'queue', sha256(normalizedMeetingId)));
    for (const row of managedExports) removeIfExists(row.payload.path);
    for (const segment of segments) this.segmentLookup.delete(segment.segmentId);
    await this.records.vacuum();
    await this.verifyConsistency();
    return true;
  }

  async deleteOwner() {
    this._requireOpen();
    const spaceId = this.manifest.spaceId;
    const staged = path.join(path.dirname(this.spacePath), `.local-data-space-delete-${randomUUID()}`);
    await this.close();
    renameSync(this.spacePath, staged);
    try {
      await this.keyProvider.deleteDataKey({ ownerId: this.ownerId, spaceId });
      removeIfExists(staged);
      return true;
    } catch (caught) {
      try {
        if (existsSync(staged) && !existsSync(this.spacePath)) renameSync(staged, this.spacePath);
      } catch { /* original key-store failure remains authoritative */ }
      throw caught;
    }
  }

  async close() {
    if (this.closed) return;
    await this.records.close();
    this.closed = true;
    this.dataKey.fill(0);
    this.segmentLookup.clear();
  }

  static async restoreEncrypted({ archivePath, destinationRoot, ownerContext, keyProvider, recoveryKey } = {}) {
    const restored = await restoreEncryptedArchive({ archivePath, destinationRoot, ownerContext, keyProvider, recoveryKey });
    const store = await MeetingFoundationStore.open({ rootDirectory: destinationRoot, ownerContext, keyProvider });
    store.restoreIdempotent = restored.restoreIdempotent === true;
    return store;
  }

  static async deleteOwner({ rootDirectory, ownerContext, keyProvider } = {}) {
    const trusted = assertTrustedOwnerContext(ownerContext);
    const target = resolveOwnerSpacePath(rootDirectory, trusted);
    if (!existsSync(target)) return true;
    const store = await MeetingFoundationStore.open({ rootDirectory, ownerContext: trusted, keyProvider });
    return store.deleteOwner();
  }
}
