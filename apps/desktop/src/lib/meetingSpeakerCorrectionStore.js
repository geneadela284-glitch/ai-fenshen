import { assertOwnerContext } from '../../../../core/meeting/stage3a/transcriptContracts.js';
import {
  SPEAKER_CORRECTION_SCHEMA_VERSION,
  validateSpeakerCorrectionRevision
} from '../../../../core/meeting/stage3b/speakerCorrectionContracts.js';
import { createIndexedDbMeetingSpeakerCorrectionBackend } from './meetingSpeakerCorrectionBackend.js';

const AES_GCM = 'AES-GCM';
const NONCE_BYTES = 12;
const STORAGE_SCHEMA_VERSION = 'meeting-speaker-correction-storage-v1';
const DOCUMENT_SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const APPEND_KEYS = Object.freeze([
  'ownerContext',
  'meetingId',
  'transcriptId',
  'expectedTranscriptRevision',
  'baseDiarizationRevisionId',
  'expectedCorrectionRevision',
  'mutationRequestId',
  'revision',
  'parentRevision'
]);
const READ_KEYS = Object.freeze([
  'ownerContext',
  'meetingId',
  'transcriptId',
  'expectedTranscriptRevision',
  'baseDiarizationRevisionId'
]);
const DOCUMENT_KEYS = Object.freeze([
  'schemaVersion',
  'documentId',
  'ownerId',
  'spaceId',
  'meetingId',
  'transcriptId',
  'transcriptRevision',
  'baseDiarizationRevisionId',
  'baseDiarizationRevision',
  'baseDiarizationSnapshotHash',
  'currentCorrectionRevisionId',
  'currentCorrectionRevision',
  'createdAt',
  'updatedAt'
]);
const DOCUMENT_ROW_KEYS = Object.freeze([
  'id',
  'ownerHash',
  'spaceHash',
  'documentLocator',
  'bindingFingerprint',
  'transcriptRevision',
  'baseDiarizationRevision',
  'headCorrectionRevision',
  'headRevisionLocator',
  'headCorrectionIdHash',
  'keyVersion',
  'nonce',
  'ciphertext'
]);
const REVISION_ROW_KEYS = Object.freeze([
  'id',
  'ownerHash',
  'spaceHash',
  'documentLocator',
  'bindingFingerprint',
  'transcriptRevision',
  'baseDiarizationRevision',
  'correctionRevision',
  'parentRevisionLocator',
  'correctionIdHash',
  'parentCorrectionIdHash',
  'mutationLocator',
  'requestFingerprint',
  'keyVersion',
  'nonce',
  'ciphertext'
]);

function codedError(code, cause = null, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
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

function keyVersion(value) {
  return positiveInteger(value, 'SPEAKER_CORRECTION_KEY_VERSION_INVALID');
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function onlyKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function bytes(value, code = 'SPEAKER_CORRECTION_CIPHERTEXT_INVALID') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError(code);
}

function validHash(value, code) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw codedError(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) throw codedError(code);
  return new Date(value).toISOString();
}

function validateCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
}

function validateBackend(backend) {
  for (const method of ['getDocument', 'getRevisionByNumber', 'listRevisions', 'commitRevision']) {
    if (typeof backend?.[method] !== 'function') throw codedError('SPEAKER_CORRECTION_BACKEND_REQUIRED');
  }
}

function validateKeyProvider(provider) {
  if (!provider || typeof provider.getKeyVersion !== 'function' || typeof provider.withOwnerKey !== 'function'
      || typeof provider.describe !== 'function') {
    throw codedError('KEY_PROVIDER_REQUIRED');
  }
  let description;
  try { description = provider.describe(); } catch (error) { throw codedError('KEY_PROVIDER_UNAVAILABLE', error); }
  if (!description || description.exportsKeys !== false) throw codedError('KEY_PROVIDER_INSECURE');
  if (description.available !== true) throw codedError('KEY_PROVIDER_UNAVAILABLE');
}

function assertKey(key) {
  if (!key || key.type !== 'secret' || key.extractable !== false) throw codedError('SPEAKER_CORRECTION_KEY_INVALID');
  return key;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

async function sha256Hex(cryptoImpl, value) {
  const input = typeof value === 'string' ? value : JSON.stringify(canonical(value));
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

async function domainHash(cryptoImpl, domain, ...values) {
  return sha256Hex(cryptoImpl, [domain, ...values]);
}

function scopeFromInput(ownerContext, input) {
  return Object.freeze({
    ownerContext,
    meetingId: required(input.meetingId, 'SPEAKER_CORRECTION_MEETING_ID_REQUIRED'),
    transcriptId: required(input.transcriptId, 'SPEAKER_CORRECTION_TRANSCRIPT_ID_REQUIRED'),
    transcriptRevision: positiveInteger(input.expectedTranscriptRevision, 'SPEAKER_CORRECTION_EXPECTED_TRANSCRIPT_REVISION_INVALID'),
    baseDiarizationRevisionId: required(input.baseDiarizationRevisionId, 'SPEAKER_CORRECTION_BASE_DIARIZATION_REVISION_ID_REQUIRED')
  });
}

async function locate(cryptoImpl, scope) {
  const ownerHash = await sha256Hex(cryptoImpl, `meeting-owner:${scope.ownerContext.ownerId}`);
  const spaceHash = await domainHash(cryptoImpl, 'meeting-speaker-correction-space-v1', ownerHash, scope.ownerContext.spaceId);
  const documentLocator = await domainHash(
    cryptoImpl,
    'meeting-speaker-correction-document-v1',
    ownerHash,
    spaceHash,
    scope.meetingId,
    scope.transcriptId
  );
  return Object.freeze({ ...scope, ownerHash, spaceHash, documentLocator });
}

async function bindingFingerprint(cryptoImpl, scope, revision) {
  return domainHash(
    cryptoImpl,
    'meeting-speaker-correction-binding-v1',
    scope.ownerHash,
    scope.spaceHash,
    scope.documentLocator,
    revision.transcriptRevision,
    revision.baseDiarizationRevisionId,
    revision.baseDiarizationRevision,
    revision.baseDiarizationSnapshotHash
  );
}

async function revisionLocator(cryptoImpl, scope, correctionRevision) {
  return domainHash(cryptoImpl, 'meeting-speaker-correction-revision-v1', scope.documentLocator, correctionRevision);
}

async function correctionIdHash(cryptoImpl, scope, correctionRevisionId) {
  if (correctionRevisionId === null) return '';
  return domainHash(cryptoImpl, 'meeting-speaker-correction-id-v1', scope.documentLocator, correctionRevisionId);
}

async function mutationLocator(cryptoImpl, scope, mutationRequestId) {
  return domainHash(
    cryptoImpl,
    'meeting-speaker-correction-mutation-v1',
    scope.ownerHash,
    scope.spaceHash,
    mutationRequestId
  );
}

function normalizedChange(revision) {
  const change = clone(revision.audit?.changes?.[0] ?? null);
  if (Array.isArray(change?.sourceSpeakerIds)) change.sourceSpeakerIds.sort();
  if (Array.isArray(change?.transcriptSegmentIds)) change.transcriptSegmentIds.sort();
  return canonical(change);
}

async function requestFingerprint(cryptoImpl, scope, revision) {
  const speakers = revision.speakerRefs.map(canonical).sort((left, right) => left.speakerId.localeCompare(right.speakerId));
  const assignments = revision.assignments.map(canonical).sort((left, right) => left.transcriptSegmentId.localeCompare(right.transcriptSegmentId));
  return domainHash(cryptoImpl, 'meeting-speaker-correction-request-v1', {
    ownerHash: scope.ownerHash,
    spaceHash: scope.spaceHash,
    documentLocator: scope.documentLocator,
    transcriptRevision: revision.transcriptRevision,
    baseDiarizationRevisionId: revision.baseDiarizationRevisionId,
    baseDiarizationRevision: revision.baseDiarizationRevision,
    baseDiarizationSnapshotHash: revision.baseDiarizationSnapshotHash,
    expectedCorrectionRevision: revision.correctionRevision - 1,
    operation: revision.audit.operation,
    change: normalizedChange(revision),
    speakerRefs: speakers,
    assignments,
    nextSpeakerOrdinal: revision.nextSpeakerOrdinal
  });
}

function aad(scope, row, entityType) {
  return new TextEncoder().encode(JSON.stringify([
    ['storageSchemaVersion', STORAGE_SCHEMA_VERSION],
    ['schemaVersion', SPEAKER_CORRECTION_SCHEMA_VERSION],
    ['entityType', entityType],
    ['ownerId', scope.ownerContext.ownerId],
    ['spaceId', scope.ownerContext.spaceId],
    ['ownerHash', row.ownerHash],
    ['spaceHash', row.spaceHash],
    ['meetingId', scope.meetingId],
    ['transcriptId', scope.transcriptId],
    ['transcriptRevision', row.transcriptRevision],
    ['baseDiarizationRevisionId', scope.baseDiarizationRevisionId],
    ['baseDiarizationRevision', row.baseDiarizationRevision],
    ['bindingFingerprint', row.bindingFingerprint],
    ['documentLocator', row.documentLocator],
    ['rowId', row.id],
    ['correctionRevision', row.correctionRevision ?? -1],
    ['parentRevisionLocator', row.parentRevisionLocator ?? ''],
    ['correctionIdHash', row.correctionIdHash ?? ''],
    ['parentCorrectionIdHash', row.parentCorrectionIdHash ?? ''],
    ['headCorrectionRevision', row.headCorrectionRevision ?? -1],
    ['headRevisionLocator', row.headRevisionLocator ?? ''],
    ['headCorrectionIdHash', row.headCorrectionIdHash ?? ''],
    ['mutationLocator', row.mutationLocator ?? ''],
    ['requestFingerprint', row.requestFingerprint ?? ''],
    ['keyVersion', row.keyVersion]
  ]));
}

async function encryptJson(cryptoImpl, key, value, additionalData) {
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await cryptoImpl.subtle.encrypt({ name: AES_GCM, iv: nonce, additionalData }, assertKey(key), plaintext);
  return Object.freeze({ nonce, ciphertext: new Uint8Array(ciphertext) });
}

async function decryptJson(cryptoImpl, key, row, additionalData) {
  try {
    const plaintext = await cryptoImpl.subtle.decrypt(
      { name: AES_GCM, iv: bytes(row.nonce), additionalData },
      assertKey(key),
      bytes(row.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error?.code === 'SPEAKER_CORRECTION_KEY_INVALID') throw error;
    throw codedError('SPEAKER_CORRECTION_CIPHERTEXT_INVALID', error);
  }
}

function validateRowScope(row, scope, keys, entityCode) {
  if (!exactKeys(row, keys)) throw codedError(`${entityCode}_ROW_INVALID`);
  validHash(row.ownerHash, 'SPEAKER_CORRECTION_OWNER_LOCATOR_INVALID');
  validHash(row.spaceHash, 'SPEAKER_CORRECTION_SPACE_LOCATOR_INVALID');
  validHash(row.documentLocator, 'SPEAKER_CORRECTION_DOCUMENT_LOCATOR_INVALID');
  validHash(row.bindingFingerprint, 'SPEAKER_CORRECTION_BINDING_FINGERPRINT_INVALID');
  if (row.ownerHash !== scope.ownerHash || row.spaceHash !== scope.spaceHash || row.documentLocator !== scope.documentLocator) {
    throw codedError('OWNER_SCOPE_MISMATCH');
  }
  positiveInteger(row.transcriptRevision, 'SPEAKER_CORRECTION_STORED_TRANSCRIPT_REVISION_INVALID');
  positiveInteger(row.baseDiarizationRevision, 'SPEAKER_CORRECTION_STORED_BASE_REVISION_INVALID');
  keyVersion(row.keyVersion);
  if (bytes(row.nonce).byteLength !== NONCE_BYTES || bytes(row.ciphertext).byteLength === 0) {
    throw codedError('SPEAKER_CORRECTION_CIPHERTEXT_INVALID');
  }
}

function validateDocumentPayload(document, scope, row) {
  if (!exactKeys(document, DOCUMENT_KEYS) || document.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw codedError('SPEAKER_CORRECTION_DOCUMENT_INVALID');
  }
  if (document.documentId !== scope.documentLocator
      || document.ownerId !== scope.ownerContext.ownerId
      || document.spaceId !== scope.ownerContext.spaceId
      || document.meetingId !== scope.meetingId
      || document.transcriptId !== scope.transcriptId
      || document.transcriptRevision !== scope.transcriptRevision
      || document.transcriptRevision !== row.transcriptRevision
      || document.baseDiarizationRevisionId !== scope.baseDiarizationRevisionId
      || document.baseDiarizationRevision !== row.baseDiarizationRevision
      || document.currentCorrectionRevision !== row.headCorrectionRevision) {
    throw codedError('SPEAKER_CORRECTION_DOCUMENT_SCOPE_MISMATCH');
  }
  validHash(document.baseDiarizationSnapshotHash, 'SPEAKER_CORRECTION_BASE_HASH_INVALID');
  positiveInteger(document.currentCorrectionRevision, 'SPEAKER_CORRECTION_STORED_REVISION_INVALID');
  required(document.currentCorrectionRevisionId, 'SPEAKER_CORRECTION_REVISION_ID_INVALID');
  timestamp(document.createdAt, 'SPEAKER_CORRECTION_DOCUMENT_TIME_INVALID');
  timestamp(document.updatedAt, 'SPEAKER_CORRECTION_DOCUMENT_TIME_INVALID');
}

function validateRevisionPayload(revision, scope, row) {
  const check = validateSpeakerCorrectionRevision(revision, { ownerContext: scope.ownerContext });
  if (!check.valid) throw codedError('SPEAKER_CORRECTION_STORED_REVISION_INVALID', null, check.errors);
  if (revision.ownerId !== scope.ownerContext.ownerId
      || revision.meetingId !== scope.meetingId
      || revision.transcriptId !== scope.transcriptId
      || revision.transcriptRevision !== scope.transcriptRevision
      || revision.transcriptRevision !== row.transcriptRevision
      || revision.baseDiarizationRevisionId !== scope.baseDiarizationRevisionId
      || revision.baseDiarizationRevision !== row.baseDiarizationRevision
      || revision.correctionRevision !== row.correctionRevision) {
    throw codedError('SPEAKER_CORRECTION_REVISION_SCOPE_MISMATCH');
  }
}

export function createMeetingSpeakerCorrectionStore({
  cryptoImpl = globalThis.crypto,
  keyProvider,
  backend = createIndexedDbMeetingSpeakerCorrectionBackend({})
} = {}) {
  validateCrypto(cryptoImpl);
  validateKeyProvider(keyProvider);
  validateBackend(backend);

  async function withPinnedKey(context, version, callback) {
    const normalized = keyVersion(version);
    return keyProvider.withOwnerKey({ ...context, keyVersion: normalized }, (key) => callback(assertKey(key)));
  }

  async function decryptDocument(scope, row) {
    validateRowScope(row, scope, DOCUMENT_ROW_KEYS, 'SPEAKER_CORRECTION_DOCUMENT');
    if (row.id !== scope.documentLocator || row.headCorrectionRevision < 1) throw codedError('SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID');
    const document = await withPinnedKey(scope.ownerContext, row.keyVersion, (key) => decryptJson(
      cryptoImpl,
      key,
      row,
      aad(scope, row, 'speakerCorrectionDocument')
    ));
    validateDocumentPayload(document, scope, row);
    const expectedBinding = await bindingFingerprint(cryptoImpl, scope, document);
    const expectedHeadId = await correctionIdHash(cryptoImpl, scope, document.currentCorrectionRevisionId);
    const expectedHeadLocator = await revisionLocator(cryptoImpl, scope, document.currentCorrectionRevision);
    if (expectedBinding !== row.bindingFingerprint
        || expectedHeadId !== row.headCorrectionIdHash
        || expectedHeadLocator !== row.headRevisionLocator) {
      throw codedError('SPEAKER_CORRECTION_DOCUMENT_INTEGRITY_INVALID');
    }
    return deepFreeze(clone(document));
  }

  async function decryptRevision(scope, row) {
    validateRowScope(row, scope, REVISION_ROW_KEYS, 'SPEAKER_CORRECTION_REVISION');
    const correctionRevision = positiveInteger(row.correctionRevision, 'SPEAKER_CORRECTION_STORED_REVISION_INVALID');
    validHash(row.id, 'SPEAKER_CORRECTION_REVISION_LOCATOR_INVALID');
    validHash(row.correctionIdHash, 'SPEAKER_CORRECTION_REVISION_LOCATOR_INVALID');
    validHash(row.mutationLocator, 'SPEAKER_CORRECTION_MUTATION_LOCATOR_INVALID');
    validHash(row.requestFingerprint, 'SPEAKER_CORRECTION_FINGERPRINT_INVALID');
    if (correctionRevision === 1 ? row.parentRevisionLocator !== '' || row.parentCorrectionIdHash !== ''
      : !HASH_PATTERN.test(row.parentRevisionLocator) || !HASH_PATTERN.test(row.parentCorrectionIdHash)) {
      throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');
    }
    const revision = await withPinnedKey(scope.ownerContext, row.keyVersion, (key) => decryptJson(
      cryptoImpl,
      key,
      row,
      aad(scope, row, 'speakerCorrectionRevision')
    ));
    validateRevisionPayload(revision, scope, row);
    const [expectedBinding, expectedLocator, expectedCorrectionId, expectedParentId, expectedMutation, expectedFingerprint] = await Promise.all([
      bindingFingerprint(cryptoImpl, scope, revision),
      revisionLocator(cryptoImpl, scope, revision.correctionRevision),
      correctionIdHash(cryptoImpl, scope, revision.correctionRevisionId),
      correctionIdHash(cryptoImpl, scope, revision.parentCorrectionRevisionId),
      mutationLocator(cryptoImpl, scope, revision.audit.mutationRequestId),
      requestFingerprint(cryptoImpl, scope, revision)
    ]);
    const expectedParentLocator = revision.correctionRevision === 1
      ? ''
      : await revisionLocator(cryptoImpl, scope, revision.correctionRevision - 1);
    if (row.bindingFingerprint !== expectedBinding
        || row.id !== expectedLocator
        || row.correctionIdHash !== expectedCorrectionId
        || row.parentCorrectionIdHash !== expectedParentId
        || row.parentRevisionLocator !== expectedParentLocator
        || row.mutationLocator !== expectedMutation
        || row.requestFingerprint !== expectedFingerprint) {
      throw codedError('SPEAKER_CORRECTION_REVISION_INTEGRITY_INVALID');
    }
    return deepFreeze(clone(revision));
  }

  async function resolveReadScope(input, { extraKeys = [] } = {}) {
    if (!onlyKeys(input, [...READ_KEYS, ...extraKeys])) throw codedError('SPEAKER_CORRECTION_REQUEST_SHAPE_INVALID');
    const context = assertOwnerContext(input?.ownerContext);
    return locate(cryptoImpl, scopeFromInput(context, input));
  }

  async function readStoredDocument(scope) {
    const row = await backend.getDocument(scope);
    if (!row) throw codedError('SPEAKER_CORRECTION_DOCUMENT_NOT_FOUND');
    return { row, document: await decryptDocument(scope, row) };
  }

  async function appendRevision(input = {}) {
    if (!onlyKeys(input, APPEND_KEYS)) throw codedError('SPEAKER_CORRECTION_REQUEST_SHAPE_INVALID');
    const context = assertOwnerContext(input.ownerContext);
    const scope = await locate(cryptoImpl, scopeFromInput(context, input));
    const expectedCorrectionRevision = nonNegativeInteger(input.expectedCorrectionRevision, 'SPEAKER_CORRECTION_EXPECTED_REVISION_INVALID');
    const mutationRequestId = required(input.mutationRequestId, 'SPEAKER_CORRECTION_MUTATION_REQUEST_ID_REQUIRED');
    const revision = input.revision;
    if (!revision || typeof revision !== 'object') throw codedError('SPEAKER_CORRECTION_REVISION_INVALID');
    if (revision.audit?.mutationRequestId !== mutationRequestId) throw codedError('SPEAKER_CORRECTION_MUTATION_REQUEST_MISMATCH');
    if (revision.ownerId !== context.ownerId
        || revision.meetingId !== scope.meetingId
        || revision.transcriptId !== scope.transcriptId
        || revision.transcriptRevision !== scope.transcriptRevision
        || revision.baseDiarizationRevisionId !== scope.baseDiarizationRevisionId) {
      throw codedError('SPEAKER_CORRECTION_REVISION_SCOPE_MISMATCH');
    }
    if (revision.correctionRevision !== expectedCorrectionRevision + 1) throw codedError('SPEAKER_CORRECTION_EXPECTED_REVISION_MISMATCH');

    let parent;
    if (expectedCorrectionRevision === 0) {
      parent = input.parentRevision;
      if (!parent || parent.correctionRevision !== 0) throw codedError('SPEAKER_CORRECTION_BASE_REVISION_REQUIRED');
    } else {
      if (input.parentRevision !== undefined) throw codedError('SPEAKER_CORRECTION_REQUEST_SHAPE_INVALID');
      const parentRow = await backend.getRevisionByNumber({ ...scope, correctionRevision: expectedCorrectionRevision });
      if (!parentRow) throw codedError('SPEAKER_CORRECTION_PARENT_NOT_FOUND');
      parent = await decryptRevision(scope, parentRow);
    }
    const validation = validateSpeakerCorrectionRevision(revision, { ownerContext: context, parent });
    if (!validation.valid) throw codedError(validation.errors[0], null, validation.errors);
    if (parent.ownerId !== context.ownerId
        || parent.meetingId !== scope.meetingId
        || parent.transcriptId !== scope.transcriptId
        || parent.transcriptRevision !== scope.transcriptRevision
        || parent.baseDiarizationRevisionId !== scope.baseDiarizationRevisionId) {
      throw codedError('SPEAKER_CORRECTION_PARENT_INVALID');
    }

    const binding = await bindingFingerprint(cryptoImpl, scope, revision);
    let existingDocument = null;
    const currentDocumentRow = await backend.getDocument(scope);
    if (currentDocumentRow) existingDocument = await decryptDocument(scope, currentDocumentRow);
    if (existingDocument && await bindingFingerprint(cryptoImpl, scope, existingDocument) !== binding) {
      throw codedError('SPEAKER_CORRECTION_DOCUMENT_CONFLICT');
    }
    if (expectedCorrectionRevision > 0 && !existingDocument) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');

    const [revisionId, parentLocator, revisionIdHash, parentIdHash, requestLocator, fingerprint] = await Promise.all([
      revisionLocator(cryptoImpl, scope, revision.correctionRevision),
      revision.correctionRevision === 1 ? Promise.resolve('') : revisionLocator(cryptoImpl, scope, revision.correctionRevision - 1),
      correctionIdHash(cryptoImpl, scope, revision.correctionRevisionId),
      correctionIdHash(cryptoImpl, scope, revision.parentCorrectionRevisionId),
      mutationLocator(cryptoImpl, scope, mutationRequestId),
      requestFingerprint(cryptoImpl, scope, revision)
    ]);
    const version = keyVersion(await keyProvider.getKeyVersion(context));
    const document = Object.freeze({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      documentId: scope.documentLocator,
      ownerId: context.ownerId,
      spaceId: context.spaceId,
      meetingId: scope.meetingId,
      transcriptId: scope.transcriptId,
      transcriptRevision: revision.transcriptRevision,
      baseDiarizationRevisionId: revision.baseDiarizationRevisionId,
      baseDiarizationRevision: revision.baseDiarizationRevision,
      baseDiarizationSnapshotHash: revision.baseDiarizationSnapshotHash,
      currentCorrectionRevisionId: revision.correctionRevisionId,
      currentCorrectionRevision: revision.correctionRevision,
      createdAt: existingDocument?.createdAt || revision.createdAt,
      updatedAt: revision.createdAt
    });
    const documentHeader = {
      id: scope.documentLocator,
      ownerHash: scope.ownerHash,
      spaceHash: scope.spaceHash,
      documentLocator: scope.documentLocator,
      bindingFingerprint: binding,
      transcriptRevision: revision.transcriptRevision,
      baseDiarizationRevision: revision.baseDiarizationRevision,
      headCorrectionRevision: revision.correctionRevision,
      headRevisionLocator: revisionId,
      headCorrectionIdHash: revisionIdHash,
      keyVersion: version
    };
    const revisionHeader = {
      id: revisionId,
      ownerHash: scope.ownerHash,
      spaceHash: scope.spaceHash,
      documentLocator: scope.documentLocator,
      bindingFingerprint: binding,
      transcriptRevision: revision.transcriptRevision,
      baseDiarizationRevision: revision.baseDiarizationRevision,
      correctionRevision: revision.correctionRevision,
      parentRevisionLocator: parentLocator,
      correctionIdHash: revisionIdHash,
      parentCorrectionIdHash: parentIdHash,
      mutationLocator: requestLocator,
      requestFingerprint: fingerprint,
      keyVersion: version
    };
    const encrypted = await withPinnedKey(context, version, async (key) => {
      const [documentEnvelope, revisionEnvelope] = await Promise.all([
        encryptJson(cryptoImpl, key, document, aad(scope, documentHeader, 'speakerCorrectionDocument')),
        encryptJson(cryptoImpl, key, revision, aad(scope, revisionHeader, 'speakerCorrectionRevision'))
      ]);
      return {
        documentRow: { ...documentHeader, ...documentEnvelope },
        revisionRow: { ...revisionHeader, ...revisionEnvelope }
      };
    });

    const result = await backend.commitRevision({
      ownerHash: scope.ownerHash,
      spaceHash: scope.spaceHash,
      documentLocator: scope.documentLocator,
      bindingFingerprint: binding,
      expectedCorrectionRevision,
      documentRow: encrypted.documentRow,
      revisionRow: encrypted.revisionRow
    });
    if (result.status === 'replay') {
      const stored = await decryptRevision(scope, result.revisionRow);
      if (result.revisionRow.requestFingerprint !== fingerprint
          || stored.audit.mutationRequestId !== mutationRequestId) {
        throw codedError('SPEAKER_CORRECTION_MUTATION_REQUEST_CONFLICT');
      }
      return deepFreeze({ replayed: true, revision: clone(stored) });
    }
    return deepFreeze({ replayed: false, revision: clone(revision) });
  }

  async function readDocument(input = {}) {
    const scope = await resolveReadScope(input);
    return (await readStoredDocument(scope)).document;
  }

  async function readRevision(input = {}) {
    const scope = await resolveReadScope(input, { extraKeys: ['correctionRevision'] });
    const correctionRevision = positiveInteger(input.correctionRevision, 'SPEAKER_CORRECTION_REVISION_INVALID');
    const { document } = await readStoredDocument(scope);
    if (correctionRevision > document.currentCorrectionRevision) throw codedError('SPEAKER_CORRECTION_REVISION_NOT_FOUND');
    const row = await backend.getRevisionByNumber({ ...scope, correctionRevision });
    if (!row) throw codedError('SPEAKER_CORRECTION_REVISION_NOT_FOUND');
    const revision = await decryptRevision(scope, row);
    if (correctionRevision > 1) {
      const parentRow = await backend.getRevisionByNumber({ ...scope, correctionRevision: correctionRevision - 1 });
      if (!parentRow) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');
      const parent = await decryptRevision(scope, parentRow);
      const check = validateSpeakerCorrectionRevision(revision, { ownerContext: scope.ownerContext, parent });
      if (!check.valid) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID', null, check.errors);
    }
    return revision;
  }

  async function listRevisions(input = {}) {
    const scope = await resolveReadScope(input);
    const { document } = await readStoredDocument(scope);
    const rows = await backend.listRevisions(scope);
    if (rows.length !== document.currentCorrectionRevision) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');
    const revisions = [];
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].correctionRevision !== index + 1) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');
      const revision = await decryptRevision(scope, rows[index]);
      if (revisions.length) {
        const check = validateSpeakerCorrectionRevision(revision, { ownerContext: scope.ownerContext, parent: revisions.at(-1) });
        if (!check.valid) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID', null, check.errors);
      }
      revisions.push(revision);
    }
    if (!revisions.length
        || revisions.at(-1).correctionRevisionId !== document.currentCorrectionRevisionId
        || revisions.at(-1).correctionRevision !== document.currentCorrectionRevision) {
      throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');
    }
    return deepFreeze(revisions.map(clone));
  }

  return Object.freeze({ appendRevision, readDocument, readRevision, listRevisions });
}
