import { assertOwnerContext } from '../../../../core/meeting/stage3a/transcriptContracts.js';
import {
  DIARIZATION_JOB_SCHEMA_VERSION,
  DIARIZATION_JOB_STATUSES
} from '../../../../core/meeting/stage3b/diarizationJob.js';
import {
  DIARIZATION_SCHEMA_VERSION,
  validateDiarizationRevision
} from '../../../../core/meeting/stage3b/diarizationContracts.js';

const AES_GCM = 'AES-GCM';
const NONCE_BYTES = 12;
const STORAGE_SCHEMA_VERSION = 'meeting-diarization-storage-v1';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function bytes(value, code = 'DIARIZATION_CIPHERTEXT_INVALID') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError(code);
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function context(value) {
  return assertOwnerContext(value);
}

function validateBackend(backend) {
  if (!backend || typeof backend.get !== 'function' || typeof backend.list !== 'function' || typeof backend.atomicPut !== 'function' || typeof backend.atomicWrite !== 'function') {
    throw codedError('MEETING_BACKEND_REQUIRED');
  }
}

function validateCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
}

async function ownerHash(cryptoImpl, ownerId) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(`meeting-owner:${ownerId}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function rowKey(ownerHashValue, ...parts) {
  return [ownerHashValue, ...parts.map((part) => String(part))].join('\u0000');
}

function aad({ ownerId, meetingId, transcriptId = '', transcriptRevision = -1, entityType, revision, id }) {
  return new TextEncoder().encode(JSON.stringify([
    ['storageSchemaVersion', STORAGE_SCHEMA_VERSION],
    ['schemaVersion', DIARIZATION_SCHEMA_VERSION],
    ['ownerId', String(ownerId)],
    ['meetingId', String(meetingId)],
    ['transcriptId', String(transcriptId)],
    ['transcriptRevision', Number(transcriptRevision)],
    ['entityType', String(entityType)],
    ['revision', Number(revision)],
    ['id', String(id)]
  ]));
}

async function encryptJson(cryptoImpl, key, value, aadValue) {
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await cryptoImpl.subtle.encrypt({ name: AES_GCM, iv: nonce, additionalData: aadValue }, key, plaintext);
  return Object.freeze({ nonce, ciphertext: new Uint8Array(ciphertext) });
}

async function decryptJson(cryptoImpl, key, row, aadValue) {
  try {
    const plaintext = await cryptoImpl.subtle.decrypt(
      { name: AES_GCM, iv: bytes(row?.nonce), additionalData: aadValue },
      key,
      bytes(row?.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw codedError('DIARIZATION_CIPHERTEXT_INVALID', error);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateJob(job, ownerId) {
  if (!job || typeof job !== 'object') throw codedError('DIARIZATION_JOB_INVALID');
  if (job.schemaVersion !== DIARIZATION_JOB_SCHEMA_VERSION) throw codedError('DIARIZATION_JOB_SCHEMA_VERSION_INVALID');
  if (job.ownerId !== ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  for (const field of ['jobId', 'meetingId', 'sourceId', 'transcriptId', 'mode', 'status', 'createdAt', 'updatedAt']) {
    if (!String(job[field] || '').trim()) throw codedError(`DIARIZATION_JOB_${field.toUpperCase()}_REQUIRED`);
  }
  if (job.mode !== 'diarization') throw codedError('DIARIZATION_JOB_MODE_INVALID');
  if (!DIARIZATION_JOB_STATUSES.includes(job.status)) throw codedError('DIARIZATION_JOB_STATUS_INVALID');
  if (!Number.isSafeInteger(Number(job.transcriptRevision)) || Number(job.transcriptRevision) < 1) throw codedError('DIARIZATION_TRANSCRIPT_REVISION_INVALID');
  if (!(Number(job.speakerCount) === 0 || [2, 3, 4].includes(Number(job.speakerCount)))) throw codedError('DIARIZATION_SPEAKER_COUNT_INVALID');
  if (!Number.isSafeInteger(Number(job.revision)) || Number(job.revision) < 1) throw codedError('DIARIZATION_JOB_REVISION_INVALID');
  return job;
}

export function createMeetingDiarizationStore({
  cryptoImpl = globalThis.crypto,
  keyProvider,
  backend,
  now = () => new Date().toISOString()
} = {}) {
  validateCrypto(cryptoImpl);
  if (!keyProvider || typeof keyProvider.withOwnerKey !== 'function') throw codedError('KEY_PROVIDER_REQUIRED');
  validateBackend(backend);

  async function documentRow(ownerContext, meetingId, transcriptId) {
    const contextValue = context(ownerContext);
    const hash = await ownerHash(cryptoImpl, contextValue.ownerId);
    const id = rowKey(hash, required(meetingId, 'DIARIZATION_MEETING_ID_REQUIRED'), required(transcriptId, 'DIARIZATION_TRANSCRIPT_ID_REQUIRED'), 'document');
    return { contextValue, hash, id, record: await backend.get('diarizationDocuments', id) };
  }

  async function decryptDocument(contextValue, row, key) {
    const document = await decryptJson(cryptoImpl, key, row, aad({
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      transcriptId: row.transcriptId,
      transcriptRevision: row.transcriptRevision,
      entityType: 'diarizationDocument',
      revision: row.revision,
      id: row.id
    }));
    if (document.ownerId !== contextValue.ownerId || document.meetingId !== row.meetingId || document.transcriptId !== row.transcriptId) throw codedError('OWNER_SCOPE_MISMATCH');
    return document;
  }

  async function decryptRevision(contextValue, row, key) {
    const revision = await decryptJson(cryptoImpl, key, row, aad({
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      transcriptId: row.transcriptId,
      transcriptRevision: row.transcriptRevision,
      entityType: 'diarizationRevision',
      revision: row.revision,
      id: row.diarizationRevisionId
    }));
    const check = validateDiarizationRevision(revision, { ownerContext: contextValue });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    if (revision.diarizationRevisionId !== row.diarizationRevisionId || revision.meetingId !== row.meetingId || revision.transcriptId !== row.transcriptId || revision.transcriptRevision !== row.transcriptRevision) throw codedError('DIARIZATION_SCOPE_MISMATCH');
    return revision;
  }

  async function decryptJob(contextValue, row, key) {
    const job = await decryptJson(cryptoImpl, key, row, aad({
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      transcriptId: row.transcriptId,
      transcriptRevision: row.transcriptRevision,
      entityType: 'diarizationJob',
      revision: row.revision,
      id: row.jobId
    }));
    validateJob(job, contextValue.ownerId);
    if (job.jobId !== row.jobId || job.meetingId !== row.meetingId || job.transcriptId !== row.transcriptId || job.transcriptRevision !== row.transcriptRevision) throw codedError('DIARIZATION_JOB_SCOPE_MISMATCH');
    return job;
  }

  async function saveRevision(ownerContext, revision) {
    const contextValue = context(ownerContext);
    const check = validateDiarizationRevision(revision, { ownerContext: contextValue });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    const rows = await documentRow(contextValue, revision.meetingId, revision.transcriptId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const currentDocument = rows.record ? await decryptDocument(contextValue, rows.record, key) : null;
      const revisionId = required(revision.diarizationRevisionId, 'DIARIZATION_REVISION_ID_REQUIRED');
      const revisionIdRow = rowKey(rows.hash, revision.meetingId, revision.transcriptId, revisionId);
      const existingRevisionRow = await backend.get('diarizationRevisions', revisionIdRow);
      if (existingRevisionRow) {
        const existingRevision = await decryptRevision(contextValue, existingRevisionRow, key);
        if (!sameJson(existingRevision, revision)) throw codedError('DIARIZATION_REVISION_CONFLICT');
        return Object.freeze({ idempotent: true, document: currentDocument, revision: clone(existingRevision) });
      }
      if (currentDocument && Number(revision.revision) <= Number(currentDocument.currentRevision)) throw codedError('DIARIZATION_REVISION_CONFLICT');
      const document = Object.freeze({
        schemaVersion: DIARIZATION_SCHEMA_VERSION,
        documentId: rowKey(rows.hash, revision.meetingId, revision.transcriptId, 'document'),
        ownerId: contextValue.ownerId,
        meetingId: revision.meetingId,
        transcriptId: revision.transcriptId,
        transcriptRevision: revision.transcriptRevision,
        currentDiarizationRevisionId: revisionId,
        currentRevision: revision.revision,
        updatedAt: revision.updatedAt
      });
      const documentEnvelope = await encryptJson(cryptoImpl, key, document, aad({
        ownerId: contextValue.ownerId,
        meetingId: revision.meetingId,
        transcriptId: revision.transcriptId,
        transcriptRevision: revision.transcriptRevision,
        entityType: 'diarizationDocument',
        revision: revision.revision,
        id: rows.id
      }));
      const revisionEnvelope = await encryptJson(cryptoImpl, key, revision, aad({
        ownerId: contextValue.ownerId,
        meetingId: revision.meetingId,
        transcriptId: revision.transcriptId,
        transcriptRevision: revision.transcriptRevision,
        entityType: 'diarizationRevision',
        revision: revision.revision,
        id: revisionId
      }));
      try {
        await backend.atomicWrite({
          puts: [
            {
              storeName: 'diarizationDocuments',
              id: rows.id,
              value: {
                id: rows.id,
                ownerHash: rows.hash,
                meetingId: revision.meetingId,
                transcriptId: revision.transcriptId,
                transcriptRevision: revision.transcriptRevision,
                revision: revision.revision,
                nonce: documentEnvelope.nonce,
                ciphertext: documentEnvelope.ciphertext
              }
            },
            {
              storeName: 'diarizationRevisions',
              id: revisionIdRow,
              value: {
                id: revisionIdRow,
                ownerHash: rows.hash,
                meetingId: revision.meetingId,
                transcriptId: revision.transcriptId,
                transcriptRevision: revision.transcriptRevision,
                diarizationRevisionId: revisionId,
                revision: revision.revision,
                nonce: revisionEnvelope.nonce,
                ciphertext: revisionEnvelope.ciphertext
              }
            }
          ]
        });
      } catch (error) {
        throw codedError('DIARIZATION_ATOMIC_COMMIT_FAILED', error);
      }
      return Object.freeze({ idempotent: false, document, revision: clone(revision) });
    });
  }

  async function getCurrentRevision(ownerContext, { meetingId, transcriptId, transcriptRevision } = {}) {
    const rows = await documentRow(ownerContext, meetingId, transcriptId);
    if (!rows.record) throw codedError('DIARIZATION_NOT_FOUND');
    return keyProvider.withOwnerKey(rows.contextValue, async (key) => {
      const document = await decryptDocument(rows.contextValue, rows.record, key);
      if (transcriptRevision !== undefined && Number(transcriptRevision) !== Number(document.transcriptRevision)) throw codedError('DIARIZATION_TRANSCRIPT_REVISION_MISMATCH');
      const revisionRow = await backend.get('diarizationRevisions', rowKey(rows.hash, meetingId, transcriptId, document.currentDiarizationRevisionId));
      if (!revisionRow) throw codedError('DIARIZATION_REVISION_NOT_FOUND');
      const revision = await decryptRevision(rows.contextValue, revisionRow, key);
      return Object.freeze({ document: clone(document), revision: clone(revision) });
    });
  }

  async function listRevisions(ownerContext, { meetingId, transcriptId } = {}) {
    const rows = await documentRow(ownerContext, meetingId, transcriptId);
    const revisionRows = (await backend.list('diarizationRevisions'))
      .filter((row) => row.ownerHash === rows.hash && row.meetingId === meetingId && row.transcriptId === transcriptId)
      .sort((left, right) => Number(left.revision) - Number(right.revision));
    return keyProvider.withOwnerKey(rows.contextValue, async (key) => Object.freeze(await Promise.all(revisionRows.map((row) => decryptRevision(rows.contextValue, row, key)))));
  }

  async function saveJob(ownerContext, job) {
    const contextValue = context(ownerContext);
    validateJob(job, contextValue.ownerId);
    const hash = await ownerHash(cryptoImpl, contextValue.ownerId);
    const id = rowKey(hash, job.jobId);
    const existingRow = await backend.get('diarizationJobs', id);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      if (existingRow) {
        const existing = await decryptJob(contextValue, existingRow, key);
        if (sameJson(existing, job)) return Object.freeze({ idempotent: true, job: clone(existing) });
        if (Number(job.revision) <= Number(existing.revision)) throw codedError('DIARIZATION_JOB_CONFLICT');
      }
      const envelope = await encryptJson(cryptoImpl, key, job, aad({
        ownerId: contextValue.ownerId,
        meetingId: job.meetingId,
        transcriptId: job.transcriptId,
        transcriptRevision: job.transcriptRevision,
        entityType: 'diarizationJob',
        revision: job.revision,
        id: job.jobId
      }));
      try {
        await backend.atomicPut([{
          storeName: 'diarizationJobs',
          id,
          value: {
            id,
            ownerHash: hash,
            meetingId: job.meetingId,
            transcriptId: job.transcriptId,
            transcriptRevision: job.transcriptRevision,
            jobId: job.jobId,
            revision: job.revision,
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext
          }
        }]);
      } catch (error) {
        throw codedError('DIARIZATION_JOB_ATOMIC_COMMIT_FAILED', error);
      }
      return Object.freeze({ idempotent: false, job: clone(job) });
    });
  }

  async function getJob(ownerContext, jobId) {
    const contextValue = context(ownerContext);
    const hash = await ownerHash(cryptoImpl, contextValue.ownerId);
    const id = rowKey(hash, required(jobId, 'DIARIZATION_JOB_ID_REQUIRED'));
    const row = await backend.get('diarizationJobs', id);
    if (!row) throw codedError('DIARIZATION_JOB_NOT_FOUND');
    return keyProvider.withOwnerKey(contextValue, (key) => decryptJob(contextValue, row, key));
  }

  async function listJobs(ownerContext, { meetingId } = {}) {
    const contextValue = context(ownerContext);
    const hash = await ownerHash(cryptoImpl, contextValue.ownerId);
    const rows = (await backend.list('diarizationJobs')).filter((row) => row.ownerHash === hash && (!meetingId || row.meetingId === meetingId));
    return keyProvider.withOwnerKey(contextValue, async (key) => Object.freeze(await Promise.all(rows.map((row) => decryptJob(contextValue, row, key)))));
  }

  async function deleteMeeting(ownerContext, meetingId) {
    const contextValue = context(ownerContext);
    const normalizedMeetingId = required(meetingId, 'DIARIZATION_MEETING_ID_REQUIRED');
    const hash = await ownerHash(cryptoImpl, contextValue.ownerId);
    const deletions = [];
    for (const storeName of ['diarizationDocuments', 'diarizationRevisions', 'diarizationJobs']) {
      const rows = (await backend.list(storeName)).filter((row) => row.ownerHash === hash && row.meetingId === normalizedMeetingId);
      deletions.push(...rows.map((row) => ({ storeName, id: row.id })));
    }
    if (deletions.length) await backend.atomicDelete(deletions);
    return deletions.length > 0;
  }

  return Object.freeze({
    saveRevision,
    getCurrentRevision,
    listRevisions,
    saveJob,
    getJob,
    listJobs,
    deleteMeeting
  });
}
