import {
  MEETING_TRANSCRIPT_SCHEMA_VERSION,
  assertCommittedAudioSource,
  assertOwnerContext,
  validateTranscriptDocument,
  validateTranscriptSegment
} from '../../../../core/meeting/stage3a/transcriptContracts.js';
import { validateTranscriptionJob } from '../../../../core/meeting/stage3a/transcriptionJob.js';

const AES_GCM = 'AES-GCM';
const NONCE_BYTES = 12;
const STORAGE_SCHEMA_VERSION = 'meeting-transcription-storage-v1';

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

function bytes(value, code) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError(code);
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function timestamp(value) {
  const normalized = new Date(value || new Date()).toISOString();
  if (Number.isNaN(Date.parse(normalized))) throw codedError('TRANSCRIPT_TIMESTAMP_INVALID');
  return normalized;
}

function nonNegativeInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw codedError(code);
  return normalized;
}

function validateCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
}

function validateBackend(backend) {
  if (!backend || typeof backend.get !== 'function' || typeof backend.list !== 'function' || typeof backend.atomicWrite !== 'function') {
    throw codedError('MEETING_BACKEND_REQUIRED');
  }
}

function rowId(kind, ownerHash, ...parts) {
  return [kind, ownerHash, ...parts.map((part) => String(part))].join('\u0000');
}

function aad({ ownerId, meetingId, sourceId, transcriptId, transcriptRevision, entityType, sequence = -1 }) {
  return new TextEncoder().encode(JSON.stringify([
    ['storageSchemaVersion', STORAGE_SCHEMA_VERSION],
    ['schemaVersion', MEETING_TRANSCRIPT_SCHEMA_VERSION],
    ['ownerId', String(ownerId)],
    ['meetingId', String(meetingId)],
    ['sourceId', String(sourceId)],
    ['transcriptId', String(transcriptId)],
    ['transcriptRevision', Number(transcriptRevision)],
    ['entityType', String(entityType)],
    ['sequence', Number(sequence)]
  ]));
}

async function ownerHash(cryptoImpl, ownerId) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(`meeting-owner:${ownerId}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function encryptJson(cryptoImpl, key, value, aadValue) {
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await cryptoImpl.subtle.encrypt({ name: AES_GCM, iv: nonce, additionalData: aadValue }, key, plaintext);
  return { nonce, ciphertext: new Uint8Array(ciphertext) };
}

async function decryptJson(cryptoImpl, key, envelope, aadValue) {
  try {
    const plaintext = await cryptoImpl.subtle.decrypt(
      { name: AES_GCM, iv: bytes(envelope?.nonce, 'TRANSCRIPT_CIPHERTEXT_INVALID'), additionalData: aadValue },
      key,
      bytes(envelope?.ciphertext, 'TRANSCRIPT_CIPHERTEXT_INVALID')
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error?.code === 'TRANSCRIPT_CIPHERTEXT_INVALID') throw error;
    throw codedError('TRANSCRIPT_CIPHERTEXT_INVALID', error);
  }
}

function assertDocumentScope(contextValue, document, source = null) {
  const check = validateTranscriptDocument(document, { ownerContext: contextValue, source, expectedScope: 'meeting' });
  if (!check.valid) throw codedError(check.errors[0], check.errors);
  if (source) {
    if (document.sourceId !== source.sourceId || document.meetingId !== source.meetingId || document.sourceRevision !== source.revision) {
      throw codedError('TRANSCRIPT_SOURCE_SCOPE_MISMATCH');
    }
    if (document.sourceChecksum && document.sourceChecksum !== source.checksum) throw codedError('TRANSCRIPT_SOURCE_CHECKSUM_MISMATCH');
  }
  return document;
}

function assertRevisionShape(contextValue, revision, { document, source, kind } = {}) {
  if (!revision || typeof revision !== 'object') throw codedError('TRANSCRIPT_REVISION_INVALID');
  if (revision.schemaVersion !== MEETING_TRANSCRIPT_SCHEMA_VERSION) throw codedError('TRANSCRIPT_SCHEMA_VERSION_INVALID');
  if (revision.ownerId !== contextValue.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (revision.scope !== 'meeting') throw codedError('TRANSCRIPT_SCOPE_MISMATCH');
  if (document) {
    for (const field of ['transcriptId', 'meetingId', 'sourceId', 'sourceRevision']) {
      if (revision[field] !== document[field]) throw codedError(`TRANSCRIPT_${field.toUpperCase()}_MISMATCH`);
    }
  }
  if (source) {
    if (revision.sourceId !== source.sourceId || revision.meetingId !== source.meetingId || revision.sourceRevision !== source.revision) {
      throw codedError('TRANSCRIPT_SOURCE_SCOPE_MISMATCH');
    }
  }
  if (kind && revision.kind !== kind) throw codedError('TRANSCRIPT_REVISION_KIND_INVALID');
  let previousEndMs = null;
  for (const [index, segment] of (revision.segments || []).entries()) {
    const check = validateTranscriptSegment(segment, {
      transcriptId: revision.transcriptId,
      revision: revision.transcriptRevision,
      previousEndMs
    });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    if (segment.sequence !== index) throw codedError('TRANSCRIPT_SEGMENT_SEQUENCE_NOT_CONTIGUOUS');
    previousEndMs = segment.endMs;
  }
  if (!Array.isArray(revision.segments)) throw codedError('TRANSCRIPT_SEGMENTS_REQUIRED');
  if (!revision.segments.length) throw codedError('TRANSCRIPT_SEGMENTS_REQUIRED');
  return revision;
}

function assertChunkResult(result) {
  if (!result || typeof result !== 'object') throw codedError('TRANSCRIPTION_CHUNK_RESULT_INVALID');
  if (!String(result.provider || '').trim() || !String(result.model || '').trim()) throw codedError('TRANSCRIPTION_PROVIDER_METADATA_REQUIRED');
  if (!Array.isArray(result.segments)) throw codedError('TRANSCRIPTION_CHUNK_SEGMENTS_INVALID');
  let previousEndMs = 0;
  for (const segment of result.segments) {
    const startMs = Number(segment?.startMs);
    const endMs = Number(segment?.endMs);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs || startMs < previousEndMs) {
      throw codedError('TRANSCRIPTION_CHUNK_TIMELINE_INVALID');
    }
    if (typeof segment.text !== 'string') throw codedError('TRANSCRIPTION_CHUNK_TEXT_INVALID');
    if (segment.speakerRef !== undefined && segment.speakerRef !== null && segment.speakerRef !== 'unknown') throw codedError('SPEAKER_REF_FORBIDDEN');
    previousEndMs = endMs;
  }
  return clone(result);
}

function sameTranscriptScope(record, contextValue, { meetingId, sourceId, transcriptId, transcriptRevision } = {}) {
  return record?.ownerHash
    && record.ownerHash === contextValue.ownerHash
    && record.meetingId === meetingId
    && record.sourceId === sourceId
    && record.transcriptId === transcriptId
    && (transcriptRevision === undefined || record.transcriptRevision === transcriptRevision);
}

export function createMeetingTranscriptStore({
  cryptoImpl = globalThis.crypto,
  keyProvider,
  backend,
  now = () => new Date().toISOString()
} = {}) {
  validateCrypto(cryptoImpl);
  validateBackend(backend);
  if (!keyProvider || typeof keyProvider.withOwnerKey !== 'function') throw codedError('KEY_PROVIDER_REQUIRED');

  async function context(ownerContext) {
    const trusted = assertOwnerContext(ownerContext);
    return Object.freeze({ ...trusted, ownerHash: await ownerHash(cryptoImpl, trusted.ownerId) });
  }

  function documentRowId(contextValue, document) {
    return rowId('document', contextValue.ownerHash, document.meetingId, document.transcriptId);
  }

  function revisionRowId(contextValue, revision) {
    return rowId('revision', contextValue.ownerHash, revision.meetingId, revision.transcriptId, revision.transcriptRevision);
  }

  function jobRowId(contextValue, jobId) {
    return rowId('job', contextValue.ownerHash, jobId);
  }

  function chunkRowId(contextValue, jobId, sequence) {
    return rowId('chunk', contextValue.ownerHash, jobId, sequence);
  }

  async function encryptedDocument(contextValue, key, document) {
    return encryptJson(cryptoImpl, key, document, aad({
      ownerId: contextValue.ownerId,
      meetingId: document.meetingId,
      sourceId: document.sourceId,
      transcriptId: document.transcriptId,
      transcriptRevision: document.transcriptRevision,
      entityType: 'transcriptDocument'
    }));
  }

  async function encryptedRevision(contextValue, key, revision) {
    return encryptJson(cryptoImpl, key, revision, aad({
      ownerId: contextValue.ownerId,
      meetingId: revision.meetingId,
      sourceId: revision.sourceId,
      transcriptId: revision.transcriptId,
      transcriptRevision: revision.transcriptRevision,
      entityType: 'transcriptRevision'
    }));
  }

  async function decryptDocument(contextValue, key, row) {
    const document = await decryptJson(cryptoImpl, key, row, aad({
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      sourceId: row.sourceId,
      transcriptId: row.transcriptId,
      transcriptRevision: row.transcriptRevision,
      entityType: 'transcriptDocument'
    }));
    if (document.ownerId !== contextValue.ownerId || document.meetingId !== row.meetingId || document.sourceId !== row.sourceId || document.transcriptId !== row.transcriptId || document.transcriptRevision !== row.transcriptRevision) {
      throw codedError('TRANSCRIPT_SCOPE_MISMATCH');
    }
    return document;
  }

  async function decryptRevision(contextValue, key, row) {
    const revision = await decryptJson(cryptoImpl, key, row, aad({
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      sourceId: row.sourceId,
      transcriptId: row.transcriptId,
      transcriptRevision: row.transcriptRevision,
      entityType: 'transcriptRevision'
    }));
    if (revision.ownerId !== contextValue.ownerId || revision.meetingId !== row.meetingId || revision.sourceId !== row.sourceId || revision.transcriptId !== row.transcriptId || revision.transcriptRevision !== row.transcriptRevision) {
      throw codedError('TRANSCRIPT_SCOPE_MISMATCH');
    }
    return revision;
  }

  async function readTranscript(contextValue, documentRow) {
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const document = assertDocumentScope(contextValue, await decryptDocument(contextValue, key, documentRow));
      const rows = (await backend.list('transcriptRevisions'))
        .filter((row) => sameTranscriptScope(row, contextValue, {
          meetingId: document.meetingId,
          sourceId: document.sourceId,
          transcriptId: document.transcriptId
        }))
        .sort((left, right) => left.transcriptRevision - right.transcriptRevision);
      const revisions = [];
      for (const row of rows) revisions.push(assertRevisionShape(contextValue, await decryptRevision(contextValue, key, row), { document }));
      if (revisions.length !== document.transcriptRevision) throw codedError('TRANSCRIPT_REVISION_MISSING');
      for (const [index, revision] of revisions.entries()) if (revision.transcriptRevision !== index + 1) throw codedError('TRANSCRIPT_REVISION_SEQUENCE_INVALID');
      const currentRevision = revisions[revisions.length - 1];
      return Object.freeze({
        document: clone(document),
        revisions: Object.freeze(revisions.map(clone)),
        rawRevision: clone(revisions[0]),
        currentRevision: clone(currentRevision)
      });
    });
  }

  async function getTranscript(ownerContext, { meetingId, transcriptId } = {}) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const normalizedTranscriptId = required(transcriptId, 'TRANSCRIPT_ID_REQUIRED');
    const id = rowId('document', contextValue.ownerHash, normalizedMeetingId, normalizedTranscriptId);
    const row = await backend.get('transcriptDocuments', id);
    if (!row || row.ownerHash !== contextValue.ownerHash || row.meetingId !== normalizedMeetingId || row.transcriptId !== normalizedTranscriptId) throw codedError('TRANSCRIPT_NOT_FOUND');
    return readTranscript(contextValue, row);
  }

  async function createRawTranscript(ownerContext, { source, document, revision } = {}) {
    const contextValue = await context(ownerContext);
    assertCommittedAudioSource({ ownerContext: contextValue, source });
    assertDocumentScope(contextValue, document, source);
    if (document.status !== 'ready') throw codedError('TRANSCRIPT_NOT_READY');
    if (document.transcriptRevision !== 1 || revision?.transcriptRevision !== 1) throw codedError('TRANSCRIPT_RAW_REVISION_INVALID');
    assertRevisionShape(contextValue, revision, { document, source, kind: 'raw_asr' });
    const docId = documentRowId(contextValue, document);
    const revisionId = revisionRowId(contextValue, revision);
    const existing = await backend.get('transcriptDocuments', docId);
    if (existing) {
      const current = await readTranscript(contextValue, existing);
      if (canonical(current.rawRevision) === canonical(revision) && canonical(current.document) === canonical(document)) return Object.freeze({ idempotent: true, ...current });
      throw codedError('TRANSCRIPT_ID_CONFLICT');
    }
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const documentEnvelope = await encryptedDocument(contextValue, key, document);
      const revisionEnvelope = await encryptedRevision(contextValue, key, revision);
      await backend.atomicWrite({
        puts: [
          { storeName: 'transcriptDocuments', id: docId, value: { id: docId, ownerHash: contextValue.ownerHash, meetingId: document.meetingId, sourceId: document.sourceId, transcriptId: document.transcriptId, transcriptRevision: document.transcriptRevision, nonce: documentEnvelope.nonce, ciphertext: documentEnvelope.ciphertext } },
          { storeName: 'transcriptRevisions', id: revisionId, value: { id: revisionId, ownerHash: contextValue.ownerHash, meetingId: revision.meetingId, sourceId: revision.sourceId, transcriptId: revision.transcriptId, transcriptRevision: revision.transcriptRevision, nonce: revisionEnvelope.nonce, ciphertext: revisionEnvelope.ciphertext } }
        ]
      });
      return Object.freeze({ idempotent: false, document: clone(document), revisions: [clone(revision)], rawRevision: clone(revision), currentRevision: clone(revision) });
    });
  }

  async function appendRevision(ownerContext, { revision } = {}) {
    const contextValue = await context(ownerContext);
    const id = rowId('document', contextValue.ownerHash, required(revision?.meetingId, 'MEETING_ID_REQUIRED'), required(revision?.transcriptId, 'TRANSCRIPT_ID_REQUIRED'));
    const documentRow = await backend.get('transcriptDocuments', id);
    if (!documentRow) throw codedError('TRANSCRIPT_NOT_FOUND');
    const current = await readTranscript(contextValue, documentRow);
    assertRevisionShape(contextValue, revision, { document: current.document, kind: 'user_correction' });
    if (revision.transcriptRevision <= current.document.transcriptRevision) {
      const existing = current.revisions.find((item) => item.transcriptRevision === revision.transcriptRevision);
      if (existing && canonical(existing) === canonical(revision)) return Object.freeze({ idempotent: true, ...current });
      throw codedError('TRANSCRIPT_REVISION_CONFLICT');
    }
    if (revision.transcriptRevision !== current.document.transcriptRevision + 1) throw codedError('TRANSCRIPT_REVISION_GAP');
    if (revision.segments.length !== current.currentRevision.segments.length) throw codedError('TRANSCRIPT_TIMELINE_IMMUTABLE');
    for (const [index, previous] of current.currentRevision.segments.entries()) {
      const next = revision.segments[index];
      if (previous.segmentId !== next.segmentId || previous.sequence !== next.sequence || previous.startMs !== next.startMs || previous.endMs !== next.endMs || canonical(previous.sourceChunkRefs) !== canonical(next.sourceChunkRefs) || previous.speakerRef !== next.speakerRef) {
        throw codedError('TRANSCRIPT_TIMELINE_IMMUTABLE');
      }
    }
    const nextDocument = {
      ...current.document,
      transcriptRevision: revision.transcriptRevision,
      updatedAt: timestamp(typeof now === 'function' ? now() : now),
      status: 'ready'
    };
    assertDocumentScope(contextValue, nextDocument);
    const revisionId = revisionRowId(contextValue, revision);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const documentEnvelope = await encryptedDocument(contextValue, key, nextDocument);
      const revisionEnvelope = await encryptedRevision(contextValue, key, revision);
      await backend.atomicWrite({
        puts: [
          { storeName: 'transcriptDocuments', id: documentRow.id, value: { ...documentRow, transcriptRevision: nextDocument.transcriptRevision, nonce: documentEnvelope.nonce, ciphertext: documentEnvelope.ciphertext } },
          { storeName: 'transcriptRevisions', id: revisionId, value: { id: revisionId, ownerHash: contextValue.ownerHash, meetingId: revision.meetingId, sourceId: revision.sourceId, transcriptId: revision.transcriptId, transcriptRevision: revision.transcriptRevision, nonce: revisionEnvelope.nonce, ciphertext: revisionEnvelope.ciphertext } }
        ]
      });
      return Object.freeze({ idempotent: false, ...(await readTranscript(contextValue, { ...documentRow, transcriptRevision: nextDocument.transcriptRevision, nonce: documentEnvelope.nonce, ciphertext: documentEnvelope.ciphertext })) });
    });
  }

  async function getJob(ownerContext, { jobId, meetingId, sourceId, transcriptId, transcriptRevision } = {}) {
    const contextValue = await context(ownerContext);
    const normalizedJobId = required(jobId, 'TRANSCRIPTION_JOB_ID_REQUIRED');
    const row = await backend.get('transcriptionJobs', jobRowId(contextValue, normalizedJobId));
    if (!row || row.ownerHash !== contextValue.ownerHash) throw codedError('TRANSCRIPTION_JOB_NOT_FOUND');
    if (transcriptRevision !== undefined && row.transcriptRevision !== transcriptRevision) throw codedError('TRANSCRIPTION_JOB_SCOPE_MISMATCH');
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const job = await decryptJson(cryptoImpl, key, row, aad({ ownerId: contextValue.ownerId, meetingId: row.meetingId, sourceId: row.sourceId, transcriptId: row.transcriptId, transcriptRevision: row.transcriptRevision, entityType: 'transcriptionJob' }));
      if (job.ownerId !== contextValue.ownerId || job.jobId !== normalizedJobId || job.meetingId !== row.meetingId || job.sourceId !== row.sourceId || job.transcriptId !== row.transcriptId) throw codedError('TRANSCRIPTION_JOB_SCOPE_MISMATCH');
      if (meetingId !== undefined && meetingId !== job.meetingId || sourceId !== undefined && sourceId !== job.sourceId || transcriptId !== undefined && transcriptId !== job.transcriptId) throw codedError('TRANSCRIPTION_JOB_SCOPE_MISMATCH');
      const check = validateTranscriptionJob(job, { ownerId: contextValue.ownerId, sourceRevision: job.sourceRevision });
      if (!check.valid) throw codedError(check.errors[0], check.errors);
      return clone(job);
    });
  }

  async function saveJob(ownerContext, { job } = {}) {
    const contextValue = await context(ownerContext);
    if (!job || job.ownerId !== contextValue.ownerId) throw codedError(job?.ownerId ? 'OWNER_SCOPE_MISMATCH' : 'TRANSCRIPTION_JOB_INVALID');
    const check = validateTranscriptionJob(job, { ownerId: contextValue.ownerId, sourceRevision: job.sourceRevision });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    const id = jobRowId(contextValue, job.jobId);
    const existing = await backend.get('transcriptionJobs', id);
    if (existing) {
      const current = await getJob(contextValue, { jobId: job.jobId });
      if (canonical(current) === canonical(job)) return Object.freeze({ idempotent: true, job: current });
      if (current.meetingId !== job.meetingId || current.sourceId !== job.sourceId || current.transcriptId !== job.transcriptId || current.sourceRevision !== job.sourceRevision || job.revision <= current.revision) {
        throw codedError('TRANSCRIPTION_JOB_CONFLICT');
      }
      return keyProvider.withOwnerKey(contextValue, async (key) => {
        const envelope = await encryptJson(cryptoImpl, key, job, aad({ ownerId: contextValue.ownerId, meetingId: job.meetingId, sourceId: job.sourceId, transcriptId: job.transcriptId, transcriptRevision: job.transcriptRevision, entityType: 'transcriptionJob' }));
        await backend.atomicWrite({ puts: [{ storeName: 'transcriptionJobs', id, value: { ...existing, transcriptRevision: job.transcriptRevision, nonce: envelope.nonce, ciphertext: envelope.ciphertext } }] });
        return Object.freeze({ idempotent: false, job: clone(job) });
      });
    }
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const envelope = await encryptJson(cryptoImpl, key, job, aad({ ownerId: contextValue.ownerId, meetingId: job.meetingId, sourceId: job.sourceId, transcriptId: job.transcriptId, transcriptRevision: job.transcriptRevision, entityType: 'transcriptionJob' }));
      await backend.atomicWrite({ puts: [{ storeName: 'transcriptionJobs', id, value: { id, ownerHash: contextValue.ownerHash, meetingId: job.meetingId, sourceId: job.sourceId, transcriptId: job.transcriptId, transcriptRevision: job.transcriptRevision, nonce: envelope.nonce, ciphertext: envelope.ciphertext } }] });
      return Object.freeze({ idempotent: false, job: clone(job) });
    });
  }

  async function saveChunkResult(ownerContext, { job, sequence, result } = {}) {
    const contextValue = await context(ownerContext);
    if (!job || job.ownerId !== contextValue.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
    const check = validateTranscriptionJob(job, { ownerId: contextValue.ownerId, sourceRevision: job.sourceRevision });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    const normalizedSequence = nonNegativeInteger(sequence, 'TRANSCRIPTION_CHUNK_SEQUENCE_INVALID');
    const normalizedResult = assertChunkResult(result);
    const id = chunkRowId(contextValue, job.jobId, normalizedSequence);
    const existing = await backend.get('transcriptionChunks', id);
    if (existing) {
      if (existing.transcriptRevision !== job.transcriptRevision) throw codedError('TRANSCRIPTION_CHUNK_SCOPE_MISMATCH');
      const current = await keyProvider.withOwnerKey(contextValue, (key) => decryptJson(cryptoImpl, key, existing, aad({ ownerId: contextValue.ownerId, meetingId: job.meetingId, sourceId: job.sourceId, transcriptId: job.transcriptId, transcriptRevision: job.transcriptRevision, entityType: 'transcriptionChunk', sequence: normalizedSequence })));
      if (canonical(current) === canonical(normalizedResult)) return Object.freeze({ idempotent: true, sequence: normalizedSequence, result: current });
      throw codedError('TRANSCRIPTION_CHUNK_CONFLICT');
    }
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const envelope = await encryptJson(cryptoImpl, key, normalizedResult, aad({ ownerId: contextValue.ownerId, meetingId: job.meetingId, sourceId: job.sourceId, transcriptId: job.transcriptId, transcriptRevision: job.transcriptRevision, entityType: 'transcriptionChunk', sequence: normalizedSequence }));
      await backend.atomicWrite({ puts: [{ storeName: 'transcriptionChunks', id, value: { id, ownerHash: contextValue.ownerHash, jobId: job.jobId, meetingId: job.meetingId, sourceId: job.sourceId, transcriptId: job.transcriptId, transcriptRevision: job.transcriptRevision, sequence: normalizedSequence, nonce: envelope.nonce, ciphertext: envelope.ciphertext } }] });
      return Object.freeze({ idempotent: false, sequence: normalizedSequence, result: clone(normalizedResult) });
    });
  }

  async function listChunkResults(ownerContext, { jobId, meetingId, sourceId, transcriptId, transcriptRevision } = {}) {
    const contextValue = await context(ownerContext);
    const normalizedJobId = required(jobId, 'TRANSCRIPTION_JOB_ID_REQUIRED');
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(sourceId, 'SOURCE_ID_REQUIRED');
    const normalizedTranscriptId = required(transcriptId, 'TRANSCRIPT_ID_REQUIRED');
    const normalizedRevision = Number(transcriptRevision);
    if (!Number.isSafeInteger(normalizedRevision) || normalizedRevision < 1) throw codedError('TRANSCRIPT_REVISION_INVALID');
    const job = await getJob(contextValue, { jobId: normalizedJobId, meetingId: normalizedMeetingId, sourceId: normalizedSourceId, transcriptId: normalizedTranscriptId });
    if (job.transcriptRevision !== normalizedRevision) throw codedError('TRANSCRIPTION_CHUNK_SCOPE_MISMATCH');
    const rows = (await backend.list('transcriptionChunks'))
      .filter((row) => row.ownerHash === contextValue.ownerHash && row.jobId === normalizedJobId)
      .sort((left, right) => left.sequence - right.sequence);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const results = [];
      for (const row of rows) {
        if (row.meetingId !== normalizedMeetingId || row.sourceId !== normalizedSourceId || row.transcriptId !== normalizedTranscriptId || row.transcriptRevision !== normalizedRevision) throw codedError('TRANSCRIPTION_CHUNK_SCOPE_MISMATCH');
        const result = await decryptJson(cryptoImpl, key, row, aad({ ownerId: contextValue.ownerId, meetingId: normalizedMeetingId, sourceId: normalizedSourceId, transcriptId: normalizedTranscriptId, transcriptRevision: normalizedRevision, entityType: 'transcriptionChunk', sequence: row.sequence }));
        results.push({ sequence: row.sequence, result: assertChunkResult(result) });
      }
      return results;
    });
  }

  async function listJobs(ownerContext, { meetingId, sourceId } = {}) {
    const contextValue = await context(ownerContext);
    const rows = (await backend.list('transcriptionJobs'))
      .filter((row) => row.ownerHash === contextValue.ownerHash)
      .filter((row) => meetingId === undefined || row.meetingId === meetingId)
      .filter((row) => sourceId === undefined || row.sourceId === sourceId);
    const jobs = [];
    for (const row of rows) jobs.push(await getJob(contextValue, { jobId: row.id.split('\u0000').at(-1) }));
    return jobs.sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  }

  async function deleteTranscriptionArtifacts(ownerContext, { jobId } = {}) {
    const contextValue = await context(ownerContext);
    const normalizedJobId = required(jobId, 'TRANSCRIPTION_JOB_ID_REQUIRED');
    const jobIdValue = jobRowId(contextValue, normalizedJobId);
    const job = await backend.get('transcriptionJobs', jobIdValue);
    if (job && job.ownerHash !== contextValue.ownerHash) throw codedError('TRANSCRIPTION_JOB_NOT_FOUND');
    const chunks = (await backend.list('transcriptionChunks')).filter((row) => row.ownerHash === contextValue.ownerHash && row.jobId === normalizedJobId);
    await backend.atomicWrite({ deletions: [
      ...(job ? [{ storeName: 'transcriptionJobs', id: jobIdValue }] : []),
      ...chunks.map((row) => ({ storeName: 'transcriptionChunks', id: row.id }))
    ] });
    return true;
  }

  async function deleteTranscriptionChunkResults(ownerContext, { jobId } = {}) {
    const contextValue = await context(ownerContext);
    const normalizedJobId = required(jobId, 'TRANSCRIPTION_JOB_ID_REQUIRED');
    const job = await backend.get('transcriptionJobs', jobRowId(contextValue, normalizedJobId));
    if (!job || job.ownerHash !== contextValue.ownerHash) throw codedError('TRANSCRIPTION_JOB_NOT_FOUND');
    const chunks = (await backend.list('transcriptionChunks')).filter((row) => row.ownerHash === contextValue.ownerHash && row.jobId === normalizedJobId);
    await backend.atomicWrite({ deletions: chunks.map((row) => ({ storeName: 'transcriptionChunks', id: row.id })) });
    return true;
  }

  return Object.freeze({
    createRawTranscript,
    appendRevision,
    getTranscript,
    saveJob,
    getJob,
    listJobs,
    saveChunkResult,
    listChunkResults,
    deleteTranscriptionArtifacts,
    deleteTranscriptionChunkResults
  });
}

export { codedError };
