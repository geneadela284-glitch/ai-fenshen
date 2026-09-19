import {
  createMeetingPhase1Session,
  MEETING_PHASE1_SCHEMA_VERSION,
  transitionMeetingPhase1Session
} from './meetingPhase1State.js';
import {
  createAudioAsset,
  createAudioSource,
  MEETING_AUDIO_MANIFEST_VERSION,
  validateAudioAsset,
  validateAudioSource
} from './meetingAudioContracts.js';
import { StreamingSha256 } from './meetingAudioFormat.js';
import {
  CONTINUOUS_FRAGMENT_STREAM_V1,
  INDEPENDENT_MP4_SEGMENTS_V1,
  resolveRecordedContainerLayout
} from './meetingRecordingContainerLayout.js';

export const MEETING_PHASE1_STORAGE_SCHEMA_VERSION = 'meeting-phase1-storage-v1';
export const MEETING_PHASE1_DATABASE_NAME = 'ai-secretary-meeting-phase1-v1';
export const MEETING_AUDIO_IMPORT_STORAGE_SCHEMA_VERSION = 'meeting-audio-import-v1';
export const MEETING_PHASE1_DATABASE_VERSION = 6;

const AES_GCM = 'AES-GCM';
const NONCE_BYTES = 12;
const STORE_NAMES = Object.freeze([
  'meetings',
  'manifests',
  'segments',
  'pendingSegments',
  'audioSources',
  'audioManifests',
  'audioAssets',
  'transcriptDocuments',
  'transcriptRevisions',
  'transcriptionJobs',
  'transcriptionChunks',
  'diarizationDocuments',
  'diarizationRevisions',
  'diarizationJobs',
  'analysisBundles'
]);

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

export function inferRecordedAudioFormat(mimeType = '') {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (normalized.includes('webm')) return 'webm-opus';
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a';
  if (normalized.includes('aac')) return 'aac';
  return 'recorded';
}

function bytes(value, code = 'AUDIO_BYTES_INVALID') {
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

function timestamp(now) {
  return typeof now === 'function' ? now() : now || new Date().toISOString();
}

function randomId(cryptoImpl, prefix) {
  const random = cryptoImpl.getRandomValues(new Uint8Array(12));
  let binary = '';
  for (const value of random) binary += String.fromCharCode(value);
  const base64 = (globalThis.btoa || ((value) => Buffer.from(value, 'binary').toString('base64')))(binary)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${prefix}-${base64}`;
}

async function sha256Hex(cryptoImpl, value) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes(value, 'HASH_INPUT_INVALID'));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function ownerHashInput(ownerId) {
  return new TextEncoder().encode(`meeting-owner:${ownerId}`);
}

function aadFor({ ownerId, meetingId, entityType, revision, segmentId = '', sequence = -1 }) {
  const fields = [
    ['ownerId', String(ownerId)],
    ['meetingId', String(meetingId)],
    ['entityType', String(entityType)],
    ['schemaVersion', MEETING_PHASE1_STORAGE_SCHEMA_VERSION],
    ['revision', Number(revision)],
    ['segmentId', String(segmentId)],
    ['sequence', Number(sequence)]
  ];
  return new TextEncoder().encode(JSON.stringify(fields));
}

function audioAadFor({ ownerId, meetingId, sourceId, chunkId = '', sequence = -1, manifestVersion = MEETING_AUDIO_MANIFEST_VERSION, entityType, revision }) {
  const fields = [
    ['ownerId', String(ownerId)],
    ['meetingId', String(meetingId)],
    ['sourceId', String(sourceId)],
    ['chunkId', String(chunkId)],
    ['sequence', Number(sequence)],
    ['manifestVersion', Number(manifestVersion)],
    ['entityType', String(entityType)],
    ['storageSchemaVersion', MEETING_AUDIO_IMPORT_STORAGE_SCHEMA_VERSION],
    ['revision', Number(revision)]
  ];
  return new TextEncoder().encode(JSON.stringify(fields));
}

function rowKey(ownerHash, meetingId, suffix = '') {
  return [ownerHash, meetingId, suffix].filter((value) => value !== '').join('\u0000');
}

function audioRowKey(ownerHash, meetingId, sourceId, suffix = '') {
  return [ownerHash, meetingId, sourceId, suffix].filter((value) => value !== '').join('\u0000');
}

function validateCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
}

function validateOwnerContext(ownerContext) {
  if (!ownerContext || typeof ownerContext !== 'object' || ownerContext.trusted !== true) throw codedError('OWNER_CONTEXT_UNTRUSTED');
  const ownerId = required(ownerContext.ownerId, 'OWNER_REQUIRED');
  const sessionId = required(ownerContext.sessionId, 'OWNER_SESSION_REQUIRED');
  const spaceId = required(ownerContext.spaceId || 'meeting-space', 'SPACE_ID_REQUIRED');
  return Object.freeze({ trusted: true, ownerId, sessionId, spaceId });
}

function validateOwnerPayload(ownerContext, payload) {
  if (payload?.ownerId !== undefined && String(payload.ownerId) !== ownerContext.ownerId) {
    throw codedError('OWNER_ID_OVERRIDE_REJECTED');
  }
}

async function encryptValue(cryptoImpl, key, value, aad) {
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await cryptoImpl.subtle.encrypt(
    { name: AES_GCM, iv: nonce, additionalData: aad },
    key,
    plaintext
  );
  return Object.freeze({ nonce, ciphertext: new Uint8Array(ciphertext) });
}

async function decryptValue(cryptoImpl, key, envelope, aad, code = 'MEETING_CIPHERTEXT_INVALID') {
  try {
    const plaintext = await cryptoImpl.subtle.decrypt(
      { name: AES_GCM, iv: bytes(envelope.nonce, code), additionalData: aad },
      key,
      bytes(envelope.ciphertext, code)
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    throw codedError(code, error);
  }
}

async function encryptJson(cryptoImpl, key, value, aadContext) {
  return encryptValue(cryptoImpl, key, value, aadFor(aadContext));
}

async function decryptJson(cryptoImpl, key, envelope, aadContext) {
  const plaintext = await decryptValue(cryptoImpl, key, envelope, aadFor(aadContext));
  try {
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw codedError('MEETING_PAYLOAD_INVALID', error);
  }
}

function optionalNonNegativeInteger(value, code) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw codedError(code);
  return numeric;
}

function normalizeSegment(segment, bytesValue, checksum) {
  const rawSequence = segment?.sequence;
  const sequence = rawSequence === undefined || rawSequence === null ? null : Number(rawSequence);
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) throw codedError('SEGMENT_SEQUENCE_INVALID');
  const segmentId = required(segment?.segmentId, 'SEGMENT_ID_REQUIRED');
  const chunkToken = required(segment?.chunkToken || segmentId, 'SEGMENT_CHUNK_TOKEN_REQUIRED');
  const durationMs = Number(segment?.durationMs);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw codedError('SEGMENT_DURATION_INVALID');
  const mimeType = required(segment?.mimeType, 'SEGMENT_MIME_TYPE_REQUIRED');
  const startedAt = required(segment?.startedAt, 'SEGMENT_STARTED_AT_REQUIRED');
  const endedAt = required(segment?.endedAt, 'SEGMENT_ENDED_AT_REQUIRED');
  const audioBytes = bytes(bytesValue);
  if (!audioBytes.byteLength) throw codedError('AUDIO_BYTES_EMPTY');
  const captureOrdinal = optionalNonNegativeInteger(segment?.captureOrdinal, 'CAPTURE_ORDINAL_INVALID');
  const captureEpoch = optionalNonNegativeInteger(segment?.captureEpoch, 'CAPTURE_EPOCH_INVALID');
  const recorderGeneration = optionalNonNegativeInteger(segment?.recorderGeneration, 'RECORDER_GENERATION_INVALID');
  const containerLayout = resolveRecordedContainerLayout(segment?.containerLayout);
  const captureUnitId = String(segment?.captureUnitId || '').trim();
  const pageEpoch = String(segment?.pageEpoch || '').trim();
  if (captureOrdinal !== null && (!captureUnitId || captureEpoch === null || recorderGeneration === null || !pageEpoch)) {
    throw codedError('CAPTURE_IDENTITY_INVALID');
  }
  if (captureOrdinal === null && containerLayout === INDEPENDENT_MP4_SEGMENTS_V1) {
    throw codedError('CAPTURE_IDENTITY_INVALID');
  }
  return {
    segmentId,
    chunkToken,
    sequence,
    startedAt,
    endedAt,
    durationMs,
    mimeType,
    audioBytes,
    checksum,
    containerLayout,
    captureOrdinal,
    captureEpoch,
    recorderGeneration,
    captureUnitId,
    pageEpoch
  };
}

function segmentRowKey(ownerHash, meetingId, segmentId) {
  return rowKey(ownerHash, meetingId, segmentId);
}

function pendingSegmentRowKey(ownerHash, meetingId, journalId) {
  return rowKey(ownerHash, meetingId, journalId);
}

function encodePendingPayload(value) {
  const audioBytes = bytes(value.audioBytes, 'PENDING_SEGMENT_BYTES_INVALID');
  const metadata = new TextEncoder().encode(JSON.stringify({ ...value, audioBytes: undefined }));
  const output = new Uint8Array(4 + metadata.byteLength + audioBytes.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, metadata.byteLength, false);
  output.set(metadata, 4);
  output.set(audioBytes, 4 + metadata.byteLength);
  return output;
}

function decodePendingPayload(value) {
  const encoded = bytes(value, 'PENDING_SEGMENT_PAYLOAD_INVALID');
  if (encoded.byteLength < 5) throw codedError('PENDING_SEGMENT_PAYLOAD_INVALID');
  const metadataLength = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(0, false);
  if (!metadataLength || 4 + metadataLength >= encoded.byteLength) throw codedError('PENDING_SEGMENT_PAYLOAD_INVALID');
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder().decode(encoded.slice(4, 4 + metadataLength)));
  } catch (error) {
    throw codedError('PENDING_SEGMENT_PAYLOAD_INVALID', error);
  }
  return Object.freeze({
    ...metadata,
    audioBytes: encoded.slice(4 + metadataLength)
  });
}

function isSameSegment(row, normalized, plaintextHash) {
  return row?.segmentId === normalized.segmentId
    && (row?.chunkToken || row?.segmentId) === normalized.chunkToken
    && row?.sequence === normalized.sequence
    && row?.plaintextHash === plaintextHash;
}

function isSameChunk(row, normalized, plaintextHash) {
  return (row?.chunkToken || row?.segmentId) === normalized.chunkToken
    && (normalized.sequence === null || row?.sequence === normalized.sequence)
    && row?.plaintextHash === plaintextHash;
}

function backendStoreName(name) {
  if (!STORE_NAMES.includes(name)) throw codedError('MEETING_STORE_INVALID');
  return name;
}

export function createMemoryMeetingBackend() {
  let state = Object.fromEntries(STORE_NAMES.map((name) => [name, new Map()]));
  let nextFailure = null;

  return {
    async get(storeName, id) {
      backendStoreName(storeName);
      return clone(state[storeName].get(id) || null);
    },
    async list(storeName) {
      backendStoreName(storeName);
      return [...state[storeName].values()].map(clone);
    },
    async atomicPut(rows) {
      if (nextFailure) {
        const failure = nextFailure;
        nextFailure = null;
        throw failure;
      }
      return this.atomicWrite({ puts: rows });
    },
    async atomicDelete(deletions) {
      return this.atomicWrite({ deletions });
    },
    async atomicWrite({ puts = [], deletions = [] } = {}) {
      if (nextFailure) {
        const failure = nextFailure;
        nextFailure = null;
        throw failure;
      }
      const next = Object.fromEntries(STORE_NAMES.map((name) => [name, new Map(state[name])]));
      for (const deletion of deletions) {
        backendStoreName(deletion.storeName);
        next[deletion.storeName].delete(deletion.id);
      }
      for (const row of puts) {
        backendStoreName(row.storeName);
        next[row.storeName].set(row.id, clone(row.value));
      }
      state = next;
    },
    failNextAtomic(error = new Error('SIMULATED_ATOMIC_FAILURE')) {
      nextFailure = error;
    },
    mutate(storeName, id, updater) {
      backendStoreName(storeName);
      const current = state[storeName].get(id);
      if (!current) return false;
      state[storeName].set(id, clone(updater(clone(current))));
      return true;
    },
    deleteDirect(storeName, id) {
      backendStoreName(storeName);
      return state[storeName].delete(id);
    },
    dump() {
      return Object.fromEntries(STORE_NAMES.map((name) => [name, [...state[name].values()].map(clone)]));
    }
  };
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || codedError('MEETING_IDB_REQUEST_FAILED'));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || codedError('MEETING_IDB_TRANSACTION_FAILED'));
    transaction.onabort = () => reject(transaction.error || codedError('MEETING_IDB_TRANSACTION_ABORTED'));
  });
}

export function createIndexedDbMeetingBackend({ indexedDBImpl = globalThis.indexedDB, databaseName = MEETING_PHASE1_DATABASE_NAME } = {}) {
  let databasePromise = null;

  function openDatabase() {
    if (!indexedDBImpl?.open) throw codedError('INDEXEDDB_UNAVAILABLE');
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBImpl.open(databaseName, MEETING_PHASE1_DATABASE_VERSION);
        request.onupgradeneeded = () => {
          for (const name of STORE_NAMES) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || codedError('MEETING_IDB_OPEN_FAILED'));
        request.onblocked = () => reject(codedError('MEETING_IDB_BLOCKED'));
      });
    }
    return databasePromise;
  }

  return {
    async get(storeName, id) {
      backendStoreName(storeName);
      const database = await openDatabase();
      const transaction = database.transaction(storeName, 'readonly');
      const completed = transactionPromise(transaction);
      const record = await requestPromise(transaction.objectStore(storeName).get(id));
      await completed;
      return record || null;
    },
    async list(storeName) {
      backendStoreName(storeName);
      const database = await openDatabase();
      const transaction = database.transaction(storeName, 'readonly');
      const completed = transactionPromise(transaction);
      const records = await requestPromise(transaction.objectStore(storeName).getAll());
      await completed;
      return records;
    },
    async atomicPut(rows) {
      return this.atomicWrite({ puts: rows });
    },
    async atomicWrite({ puts = [], deletions = [] } = {}) {
      const names = [...new Set([
        ...puts.map((row) => backendStoreName(row.storeName)),
        ...deletions.map((deletion) => backendStoreName(deletion.storeName))
      ])];
      if (!names.length) return;
      const database = await openDatabase();
      const transaction = database.transaction(names, 'readwrite');
      const completed = transactionPromise(transaction);
      for (const deletion of deletions) transaction.objectStore(deletion.storeName).delete(deletion.id);
      for (const row of puts) transaction.objectStore(row.storeName).put(row.value);
      await completed;
    },
    async atomicDelete(deletions) {
      return this.atomicWrite({ deletions });
    }
  };
}

export function createMeetingPhase1Store({
  cryptoImpl = globalThis.crypto,
  keyProvider,
  backend = createIndexedDbMeetingBackend({}),
  now = () => new Date().toISOString()
} = {}) {
  validateCrypto(cryptoImpl);
  if (!keyProvider || typeof keyProvider.withOwnerKey !== 'function') throw codedError('KEY_PROVIDER_REQUIRED');
  if (!backend || typeof backend.get !== 'function' || typeof backend.list !== 'function' || typeof backend.atomicPut !== 'function' || typeof backend.atomicWrite !== 'function') {
    throw codedError('MEETING_BACKEND_REQUIRED');
  }

  async function context(ownerContext) {
    return validateOwnerContext(ownerContext);
  }

  async function ownerHash(contextValue) {
    return sha256Hex(cryptoImpl, ownerHashInput(contextValue.ownerId));
  }

  async function meetingRow(contextValue, meetingId) {
    const hash = await ownerHash(contextValue);
    return { hash, id: rowKey(hash, meetingId), record: await backend.get('meetings', rowKey(hash, meetingId)) };
  }

  async function decryptMeeting(contextValue, row, key) {
    const meeting = await decryptJson(cryptoImpl, key, row, {
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      entityType: 'meeting',
      revision: row.revision
    });
    if (meeting.ownerId !== contextValue.ownerId || meeting.meetingId !== row.meetingId) throw codedError('OWNER_SCOPE_MISMATCH');
    return meeting;
  }

  async function decryptManifest(contextValue, row, key) {
    const manifest = await decryptJson(cryptoImpl, key, row, {
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      entityType: 'manifest',
      revision: row.revision
    });
    if (manifest.ownerId !== contextValue.ownerId || manifest.meetingId !== row.meetingId) throw codedError('OWNER_SCOPE_MISMATCH');
    return manifest;
  }

  async function decryptSegmentMetadata(contextValue, row, key) {
    const metadata = await decryptJson(cryptoImpl, key, {
      nonce: row.metadataNonce,
      ciphertext: row.metadataCiphertext
    }, {
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      entityType: 'audioSegmentMeta',
      revision: row.metadataRevision,
      segmentId: row.segmentId,
      sequence: row.sequence
    });
    if (metadata.ownerId !== contextValue.ownerId || metadata.meetingId !== row.meetingId || metadata.segmentId !== row.segmentId || metadata.sequence !== row.sequence) {
      throw codedError('OWNER_SCOPE_MISMATCH');
    }
    return metadata;
  }

  async function verifySegmentAudio(contextValue, row, key, returnBytes = false) {
    const decrypted = await decryptValue(cryptoImpl, key, {
      nonce: row.audioNonce,
      ciphertext: row.audioCiphertext
    }, aadFor({
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      entityType: 'audioSegment',
      revision: row.audioRevision,
      segmentId: row.segmentId,
      sequence: row.sequence
    }));
    const hash = await sha256Hex(cryptoImpl, decrypted);
    if (hash !== row.plaintextHash || decrypted.byteLength !== row.byteLength) throw codedError('SEGMENT_INTEGRITY_MISMATCH');
    return returnBytes ? decrypted : null;
  }

  async function decryptPendingSegment(contextValue, row, key) {
    const plaintext = await decryptValue(cryptoImpl, key, row, aadFor({
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      entityType: 'pendingSegment',
      revision: row.revision,
      segmentId: row.journalId,
      sequence: row.captureOrdinal
    }), 'PENDING_SEGMENT_CIPHERTEXT_INVALID');
    const pending = decodePendingPayload(plaintext);
    if (
      pending.ownerId !== contextValue.ownerId
      || pending.meetingId !== row.meetingId
      || pending.journalId !== row.journalId
      || pending.captureOrdinal !== row.captureOrdinal
    ) {
      throw codedError('OWNER_SCOPE_MISMATCH');
    }
    return pending;
  }

  async function encryptAudioJson(key, value, { ownerId, meetingId, sourceId, chunkId = '', sequence = -1, manifestVersion = MEETING_AUDIO_MANIFEST_VERSION, entityType, revision }) {
    return encryptValue(cryptoImpl, key, value, audioAadFor({ ownerId, meetingId, sourceId, chunkId, sequence, manifestVersion, entityType, revision }));
  }

  async function decryptAudioJson(contextValue, key, envelope, { meetingId, sourceId, chunkId = '', sequence = -1, manifestVersion = MEETING_AUDIO_MANIFEST_VERSION, entityType, revision }) {
    const plaintext = await decryptValue(cryptoImpl, key, envelope, audioAadFor({
      ownerId: contextValue.ownerId,
      meetingId,
      sourceId,
      chunkId,
      sequence,
      manifestVersion,
      entityType,
      revision
    }));
    try {
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
      throw codedError('AUDIO_PAYLOAD_INVALID', error);
    }
  }

  async function decryptStoredAudioSource(contextValue, row, key) {
    const source = await decryptAudioJson(contextValue, key, { nonce: row.nonce, ciphertext: row.ciphertext }, {
      meetingId: row.meetingId,
      sourceId: row.sourceId,
      manifestVersion: row.manifestVersion,
      entityType: 'audioSource',
      revision: row.revision
    });
    const check = validateAudioSource(source, { ownerContext: contextValue, meetingId: row.meetingId });
    if (!check.valid || source.sourceId !== row.sourceId) throw codedError('AUDIO_SOURCE_CONTRACT_INVALID');
    return source;
  }

  async function decryptStoredAudioManifest(contextValue, row, key) {
    const manifest = await decryptAudioJson(contextValue, key, { nonce: row.nonce, ciphertext: row.ciphertext }, {
      meetingId: row.meetingId,
      sourceId: row.sourceId,
      manifestVersion: row.manifestVersion,
      entityType: 'audioManifest',
      revision: row.revision
    });
    if (manifest.ownerId !== contextValue.ownerId || manifest.meetingId !== row.meetingId || manifest.sourceId !== row.sourceId || manifest.manifestVersion !== row.manifestVersion) {
      throw codedError('AUDIO_MANIFEST_CONTRACT_INVALID');
    }
    return manifest;
  }

  async function decryptStoredAudioAsset(contextValue, row, key, returnBytes = false) {
    const metadata = await decryptAudioJson(contextValue, key, { nonce: row.metadataNonce, ciphertext: row.metadataCiphertext }, {
      meetingId: row.meetingId,
      sourceId: row.sourceId,
      chunkId: row.chunkId,
      sequence: row.sequence,
      manifestVersion: row.manifestVersion,
      entityType: 'audioAssetMeta',
      revision: row.metadataRevision
    });
    const check = validateAudioAsset(metadata, { ownerContext: contextValue, meetingId: row.meetingId, sourceId: row.sourceId });
    if (!check.valid || metadata.assetId !== row.assetId || metadata.chunkId !== row.chunkId || metadata.sequence !== row.sequence) throw codedError('AUDIO_ASSET_CONTRACT_INVALID');
    if (!returnBytes) return { metadata, bytes: null };
    const audio = await decryptValue(cryptoImpl, key, { nonce: row.audioNonce, ciphertext: row.audioCiphertext }, audioAadFor({
      ownerId: contextValue.ownerId,
      meetingId: row.meetingId,
      sourceId: row.sourceId,
      chunkId: row.chunkId,
      sequence: row.sequence,
      manifestVersion: row.manifestVersion,
      entityType: 'audioAsset',
      revision: row.audioRevision
    }));
    const hash = await sha256Hex(cryptoImpl, audio);
    if (hash !== metadata.checksum || audio.byteLength !== metadata.byteLength || audio.byteLength !== row.byteLength) throw codedError('AUDIO_ASSET_INTEGRITY_MISMATCH');
    return { metadata, bytes: audio };
  }

  async function listAudioSourceRows(contextValue, meetingId) {
    const hash = await ownerHash(contextValue);
    return (await backend.list('audioSources'))
      .filter((row) => row.ownerHash === hash && row.meetingId === meetingId)
      .sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId)));
  }

  async function loadAudioRows(contextValue, meetingId, sourceId) {
    const hash = await ownerHash(contextValue);
    const sourceKey = audioRowKey(hash, meetingId, sourceId);
    const sourceRecord = await backend.get('audioSources', sourceKey);
    if (!sourceRecord) throw codedError('AUDIO_SOURCE_NOT_FOUND');
    const manifestRecord = await backend.get('audioManifests', sourceKey);
    const assetRows = (await backend.list('audioAssets'))
      .filter((row) => row.ownerHash === hash && row.meetingId === meetingId && row.sourceId === sourceId)
      .sort((left, right) => left.sequence - right.sequence);
    return { hash, sourceKey, sourceRecord, manifestRecord, assetRows };
  }

  async function inspectImportedSource(contextValue, rows, key, { verifyBytes = true } = {}) {
    const source = await decryptStoredAudioSource(contextValue, rows.sourceRecord, key);
    if (source.importState !== 'committed') return Object.freeze({ source, manifest: null, assets: [] });
    if (!rows.manifestRecord) throw codedError('AUDIO_MANIFEST_ASSET_MISMATCH');
    const manifest = await decryptStoredAudioManifest(contextValue, rows.manifestRecord, key);
    const assets = [];
    const hasher = new StreamingSha256();
    let totalBytes = 0;
    let totalDurationMs = 0;
    const expectedIds = Array.isArray(manifest.committedAssetIds) ? manifest.committedAssetIds : [];
    if (rows.assetRows.length !== source.chunkCount || rows.assetRows.length !== manifest.expectedSequence || expectedIds.length !== rows.assetRows.length) throw codedError('AUDIO_MANIFEST_ASSET_MISMATCH');
    for (const row of rows.assetRows) {
      const asset = await decryptStoredAudioAsset(contextValue, row, key, verifyBytes);
      if (row.sequence !== assets.length || expectedIds[assets.length] !== row.assetId) throw codedError('AUDIO_MANIFEST_ASSET_MISMATCH');
      if (verifyBytes) hasher.update(asset.bytes);
      assets.push(asset.metadata);
      totalBytes += asset.metadata.byteLength;
      totalDurationMs += asset.metadata.durationMs;
    }
    if (source.committedByteLength !== totalBytes || source.committedDurationMs !== totalDurationMs || manifest.committedByteLength !== totalBytes || manifest.committedDurationMs !== totalDurationMs || source.byteLength !== totalBytes || source.durationMs !== totalDurationMs) throw codedError('AUDIO_MANIFEST_ASSET_MISMATCH');
    if (verifyBytes && hasher.digestHex() !== source.checksum) throw codedError('AUDIO_SOURCE_CHECKSUM_MISMATCH');
    return Object.freeze({ source, manifest, assets });
  }

  async function readImportedSources(contextValue, meetingId, { includeLifecycle = false, verifyBytes = true } = {}) {
    const rows = await listAudioSourceRows(contextValue, meetingId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const result = [];
      for (const row of rows) {
        const source = await decryptStoredAudioSource(contextValue, row, key);
        if (!includeLifecycle && source.importState !== 'committed') continue;
        const loaded = source.importState === 'committed'
          ? await inspectImportedSource(contextValue, await loadAudioRows(contextValue, meetingId, source.sourceId), key, { verifyBytes })
          : { source, manifest: null, assets: [] };
        result.push(loaded);
      }
      return result;
    });
  }

  async function recordedAudioSource(contextValue, meeting, manifest, segments) {
    if (!segments.length) return null;
    const checksum = await sha256Hex(cryptoImpl, new TextEncoder().encode(JSON.stringify(segments.map((segment) => segment.checksum))));
    const mimeType = segments.every((segment) => segment.mimeType === segments[0].mimeType) ? segments[0].mimeType : 'audio/webm';
    const layouts = new Set(segments.map((segment) => resolveRecordedContainerLayout(segment.containerLayout)));
    if (layouts.size !== 1) throw codedError('AUDIO_CONTAINER_LAYOUT_MISMATCH');
    return createAudioSource({
      ownerContext: contextValue,
      meetingId: meeting.meetingId,
      sourceId: `recorded-${meeting.meetingId}`,
      scope: meeting.scope,
      origin: 'recorded',
      originalFileName: '现场录音',
      mimeType,
      format: inferRecordedAudioFormat(mimeType),
      byteLength: manifest.totalBytes,
      durationMs: manifest.committedDurationMs,
      checksum,
      chunkCount: segments.length,
      manifestVersion: meeting.audioManifestVersion || MEETING_AUDIO_MANIFEST_VERSION,
      importState: 'committed',
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
      retentionExpiresAt: new Date(Date.parse(meeting.createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString(),
      revision: Math.max(meeting.revision, manifest.revision),
      containerLayout: [...layouts][0]
    });
  }

  async function loadRows(contextValue, meetingId) {
    const meeting = await meetingRow(contextValue, meetingId);
    if (!meeting.record) throw codedError('MEETING_NOT_FOUND');
    const manifestHash = meeting.hash;
    const manifestRecord = await backend.get('manifests', rowKey(manifestHash, meetingId));
    if (!manifestRecord) throw codedError('MANIFEST_NOT_FOUND');
    const segmentRows = (await backend.list('segments'))
      .filter((row) => row.ownerHash === manifestHash && row.meetingId === meetingId)
      .sort((left, right) => left.sequence - right.sequence);
    return { ...meeting, manifestRecord, segmentRows };
  }

  async function loadDurableMutationState(contextValue, rows) {
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const meeting = await decryptMeeting(contextValue, rows.record, key);
      const manifest = await decryptManifest(contextValue, rows.manifestRecord, key);
      const committedIds = Array.isArray(manifest.committedSegmentIds) ? manifest.committedSegmentIds : [];
      const rowsContiguous = rows.segmentRows.every((row, index) => row.sequence === index);
      const idsMatch = committedIds.length === rows.segmentRows.length
        && committedIds.every((id, index) => id === rows.segmentRows[index].segmentId);
      const totalBytes = rows.segmentRows.reduce((total, row) => total + Number(row.byteLength || 0), 0);
      if (!rowsContiguous
        || !idsMatch
        || manifest.expectedSegmentIndex !== rows.segmentRows.length
        || meeting.committedSegmentCount !== rows.segmentRows.length
        || meeting.committedDurationMs !== manifest.committedDurationMs
        || meeting.totalBytes !== manifest.totalBytes
        || manifest.totalBytes !== totalBytes) {
        throw codedError('MANIFEST_SEGMENT_MISMATCH');
      }
      return Object.freeze({ meeting, manifest });
    });
  }

  async function getMeeting(ownerContext, meetingId) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const rows = await loadRows(contextValue, normalizedMeetingId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const meeting = await decryptMeeting(contextValue, rows.record, key);
      const manifest = await decryptManifest(contextValue, rows.manifestRecord, key);
      const segments = [];
      for (const row of rows.segmentRows) {
        const metadata = await decryptSegmentMetadata(contextValue, row, key);
        await verifySegmentAudio(contextValue, row, key, false);
        segments.push({
          ...metadata,
          byteLength: row.byteLength,
          checksum: row.plaintextHash,
          commitState: 'committed'
        });
      }
      const expectedSequences = segments.map((item) => item.sequence);
      const contiguous = expectedSequences.every((sequence, index) => sequence === index);
      const manifestSegments = Array.isArray(manifest.committedSegmentIds) ? manifest.committedSegmentIds : [];
      const idsMatch = manifestSegments.length === segments.length && manifestSegments.every((id, index) => id === segments[index].segmentId);
      const totalDurationMs = segments.reduce((total, item) => total + item.durationMs, 0);
      const totalBytes = segments.reduce((total, item) => total + item.byteLength, 0);
      if (!contiguous || manifest.expectedSegmentIndex !== segments.length || !idsMatch || manifest.totalBytes !== totalBytes || manifest.committedDurationMs !== totalDurationMs || meeting.committedSegmentCount !== segments.length || meeting.committedDurationMs !== totalDurationMs || meeting.totalBytes !== totalBytes) {
        throw codedError('MANIFEST_SEGMENT_MISMATCH');
      }
      const importedRows = await listAudioSourceRows(contextValue, normalizedMeetingId);
      const importedSources = [];
      for (const sourceRow of importedRows) {
        const source = await decryptStoredAudioSource(contextValue, sourceRow, key);
        if (source.importState !== 'committed') continue;
        const loaded = await inspectImportedSource(contextValue, await loadAudioRows(contextValue, normalizedMeetingId, source.sourceId), key);
        importedSources.push(loaded.source);
      }
      const recordedSource = await recordedAudioSource(contextValue, meeting, manifest, segments);
      return Object.freeze({ meeting, manifest, segments, audioSources: Object.freeze([...(recordedSource ? [recordedSource] : []), ...importedSources]) });
    });
  }

  async function listMeetings(ownerContext) {
    const contextValue = await context(ownerContext);
    const hash = await ownerHash(contextValue);
    const rows = (await backend.list('meetings')).filter((row) => row.ownerHash === hash);
    const meetings = [];
    for (const row of rows) {
      meetings.push(await keyProvider.withOwnerKey(contextValue, (key) => decryptMeeting(contextValue, row, key)));
    }
    return meetings.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async function createMeeting(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    validateOwnerPayload(contextValue, input);
    const meetingId = String(input.meetingId || randomId(cryptoImpl, 'meeting')).trim();
    const title = String(input.title || '未命名会议').trim() || '未命名会议';
    const createdAt = timestamp(now);
    const meeting = createMeetingPhase1Session({
      meetingId,
      ownerId: contextValue.ownerId,
      scope: input.scope || 'meeting',
      title,
      now: createdAt
    });
    const manifest = {
      manifestId: randomId(cryptoImpl, 'manifest'),
      meetingId,
      ownerId: contextValue.ownerId,
      expectedSegmentIndex: 0,
      committedDurationMs: 0,
      totalBytes: 0,
      status: 'open',
      revision: 1,
      committedSegmentIds: [],
      containerLayout: CONTINUOUS_FRAGMENT_STREAM_V1,
      recordingAttemptId: '',
      nextCaptureOrdinal: 0,
      captureOrdinals: []
    };
    const hash = await ownerHash(contextValue);
    if (await backend.get('meetings', rowKey(hash, meetingId))) throw codedError('MEETING_ALREADY_EXISTS');
    await keyProvider.withOwnerKey(contextValue, async (key) => {
      const meetingEnvelope = await encryptJson(cryptoImpl, key, meeting, {
        ownerId: contextValue.ownerId,
        meetingId,
        entityType: 'meeting',
        revision: meeting.revision
      });
      const manifestEnvelope = await encryptJson(cryptoImpl, key, manifest, {
        ownerId: contextValue.ownerId,
        meetingId,
        entityType: 'manifest',
        revision: manifest.revision
      });
      await backend.atomicPut([
        { storeName: 'meetings', id: rowKey(hash, meetingId), value: { id: rowKey(hash, meetingId), ownerHash: hash, meetingId, entityType: 'meeting', schemaVersion: MEETING_PHASE1_STORAGE_SCHEMA_VERSION, revision: meeting.revision, nonce: meetingEnvelope.nonce, ciphertext: meetingEnvelope.ciphertext } },
        { storeName: 'manifests', id: rowKey(hash, meetingId), value: { id: rowKey(hash, meetingId), ownerHash: hash, meetingId, entityType: 'manifest', schemaVersion: MEETING_PHASE1_STORAGE_SCHEMA_VERSION, revision: manifest.revision, nonce: manifestEnvelope.nonce, ciphertext: manifestEnvelope.ciphertext } }
      ]);
    });
    return Object.freeze({ meeting, manifest, segments: [] });
  }

  async function saveSession(ownerContext, session) {
    const contextValue = await context(ownerContext);
    validateOwnerPayload(contextValue, session);
    const rows = await loadRows(contextValue, session.meetingId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const currentMeeting = await decryptMeeting(contextValue, rows.record, key);
      const currentManifest = await decryptManifest(contextValue, rows.manifestRecord, key);
      const revision = Math.max(currentMeeting.revision, currentManifest.revision) + 1;
      const nextMeeting = Object.freeze({
        ...currentMeeting,
        ...session,
        ownerId: contextValue.ownerId,
        updatedAt: timestamp(now),
        revision
      });
      const nextManifest = Object.freeze({
        ...currentManifest,
        revision,
        status: nextMeeting.recordingState === 'stopped' ? 'closed' : nextMeeting.recordingState.startsWith('failed') ? 'failed' : nextMeeting.recordingState
      });
      const meetingEnvelope = await encryptJson(cryptoImpl, key, nextMeeting, {
        ownerId: contextValue.ownerId,
        meetingId: nextMeeting.meetingId,
        entityType: 'meeting',
        revision
      });
      const manifestEnvelope = await encryptJson(cryptoImpl, key, nextManifest, {
        ownerId: contextValue.ownerId,
        meetingId: nextMeeting.meetingId,
        entityType: 'manifest',
        revision
      });
      await backend.atomicPut([
        { storeName: 'meetings', id: rows.id, value: { ...rows.record, revision, nonce: meetingEnvelope.nonce, ciphertext: meetingEnvelope.ciphertext } },
        { storeName: 'manifests', id: rows.id, value: { ...rows.manifestRecord, revision, nonce: manifestEnvelope.nonce, ciphertext: manifestEnvelope.ciphertext } }
      ]);
      return nextMeeting;
    });
  }

  async function prepareMeeting(ownerContext, meetingId) {
    const current = (await getMeeting(ownerContext, meetingId)).meeting;
    const next = transitionMeetingPhase1Session(current, { type: 'prepare' }, { now: timestamp(now) });
    if (!next.accepted && !next.idempotent) throw codedError(next.errorCode || 'SESSION_PREPARE_FAILED');
    return saveSession(ownerContext, next.state);
  }

  function normalizeCaptureScope(contextValue, input = {}) {
    validateOwnerPayload(contextValue, input);
    const meetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const sourceId = required(input.sourceId || `recorded-${meetingId}`, 'SOURCE_ID_REQUIRED');
    if (sourceId !== `recorded-${meetingId}`) throw codedError('SOURCE_SCOPE_MISMATCH');
    const recordingAttemptId = required(input.recordingAttemptId, 'RECORDING_ATTEMPT_ID_REQUIRED');
    const captureEpoch = optionalNonNegativeInteger(input.captureEpoch, 'CAPTURE_EPOCH_INVALID');
    if (captureEpoch === null) throw codedError('CAPTURE_EPOCH_INVALID');
    return Object.freeze({ meetingId, sourceId, recordingAttemptId, captureEpoch });
  }

  function currentCaptureOrdinals(manifest) {
    return Array.isArray(manifest?.captureOrdinals) ? manifest.captureOrdinals : [];
  }

  async function persistManifestOnly(contextValue, rows, current, nextManifest) {
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const envelope = await encryptJson(cryptoImpl, key, nextManifest, {
        ownerId: contextValue.ownerId,
        meetingId: nextManifest.meetingId,
        entityType: 'manifest',
        revision: nextManifest.revision
      });
      await backend.atomicPut([{
        storeName: 'manifests',
        id: rows.id,
        value: {
          ...rows.manifestRecord,
          revision: nextManifest.revision,
          nonce: envelope.nonce,
          ciphertext: envelope.ciphertext
        }
      }]);
      return nextManifest;
    });
  }

  async function reserveCaptureUnit(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const capture = normalizeCaptureScope(contextValue, input);
    const rows = await loadRows(contextValue, capture.meetingId);
    const current = await loadDurableMutationState(contextValue, rows);
    if (!['ready', 'recording', 'interrupted', 'paused'].includes(current.meeting.recordingState)) {
      throw codedError('CAPTURE_RESERVATION_STATE_INVALID');
    }
    const sessionAttemptId = String(current.meeting.recordingAttemptId || '').trim();
    const manifestAttemptId = String(current.manifest.recordingAttemptId || '').trim();
    if ((sessionAttemptId && sessionAttemptId !== capture.recordingAttemptId)
      || (manifestAttemptId && manifestAttemptId !== capture.recordingAttemptId)) {
      throw codedError('RECORDING_ATTEMPT_ID_MISMATCH');
    }
    const currentLayout = resolveRecordedContainerLayout(current.manifest.containerLayout);
    if (current.manifest.expectedSegmentIndex > 0 && currentLayout !== INDEPENDENT_MP4_SEGMENTS_V1) {
      throw codedError('RECORDING_CONTAINER_LAYOUT_MISMATCH');
    }
    const captureOrdinal = optionalNonNegativeInteger(
      current.manifest.nextCaptureOrdinal ?? 0,
      'CAPTURE_ORDINAL_INVALID'
    );
    const captureUnitId = randomId(cryptoImpl, `capture-${captureOrdinal}`);
    const chunkToken = randomId(cryptoImpl, `chunk-${captureOrdinal}`);
    const captureOrdinals = currentCaptureOrdinals(current.manifest);
    if (captureOrdinals.some((entry) => entry.captureOrdinal === captureOrdinal)) {
      throw codedError('CAPTURE_ORDINAL_CONFLICT');
    }
    const revision = Math.max(current.meeting.revision, current.manifest.revision) + 1;
    const nextManifest = Object.freeze({
      ...current.manifest,
      recordingAttemptId: manifestAttemptId || capture.recordingAttemptId,
      containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
      nextCaptureOrdinal: captureOrdinal + 1,
      captureOrdinals: [...captureOrdinals, {
        captureOrdinal,
        captureEpoch: capture.captureEpoch,
        captureUnitId,
        chunkToken,
        state: 'reserved'
      }],
      revision
    });
    try {
      await persistManifestOnly(contextValue, rows, current, nextManifest);
    } catch (error) {
      if (error?.code) throw error;
      throw codedError('CAPTURE_RESERVATION_FAILED', error);
    }
    return Object.freeze({
      captureOrdinal,
      captureUnitId,
      chunkToken,
      captureEpoch: capture.captureEpoch,
      recordingAttemptId: capture.recordingAttemptId
    });
  }

  function normalizePendingCapture(capture, unit, data, plaintextHash) {
    const identity = unit?.identity || {};
    const captureOrdinal = optionalNonNegativeInteger(identity.captureOrdinal, 'CAPTURE_ORDINAL_INVALID');
    const captureEpoch = optionalNonNegativeInteger(identity.captureEpoch, 'CAPTURE_EPOCH_INVALID');
    const recorderGeneration = optionalNonNegativeInteger(identity.recorderGeneration, 'RECORDER_GENERATION_INVALID');
    if (captureOrdinal === null || captureEpoch === null || recorderGeneration === null) {
      throw codedError('CAPTURE_IDENTITY_INVALID');
    }
    const captureUnitId = required(identity.captureUnitId, 'CAPTURE_UNIT_ID_REQUIRED');
    const chunkToken = required(identity.chunkToken, 'SEGMENT_CHUNK_TOKEN_REQUIRED');
    const pageEpoch = required(identity.pageEpoch, 'PAGE_EPOCH_REQUIRED');
    const durationMs = Number(unit?.durationMs);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw codedError('SEGMENT_DURATION_INVALID');
    const byteLength = Number(unit?.byteLength);
    if (!Number.isSafeInteger(byteLength) || byteLength !== data.byteLength || byteLength <= 0) {
      throw codedError('PENDING_SEGMENT_SIZE_MISMATCH');
    }
    const suppliedChecksum = String(unit?.checksum || '').trim().toLowerCase();
    const checksum = suppliedChecksum || plaintextHash;
    if (!/^[0-9a-f]{64}$/.test(checksum) || checksum !== plaintextHash) {
      throw codedError('PENDING_SEGMENT_CHECKSUM_MISMATCH');
    }
    const containerLayout = resolveRecordedContainerLayout(unit?.containerLayout);
    if (containerLayout !== INDEPENDENT_MP4_SEGMENTS_V1) {
      throw codedError('RECORDING_CONTAINER_LAYOUT_MISMATCH');
    }
    if (captureEpoch !== capture.captureEpoch) throw codedError('CAPTURE_EPOCH_MISMATCH');
    const journalId = `pending-${captureUnitId}`;
    return Object.freeze({
      journalId,
      meetingId: capture.meetingId,
      sourceId: capture.sourceId,
      recordingAttemptId: capture.recordingAttemptId,
      pageEpoch,
      recorderGeneration,
      captureEpoch,
      captureOrdinal,
      captureUnitId,
      chunkToken,
      startedAt: required(unit?.startedAt, 'SEGMENT_STARTED_AT_REQUIRED'),
      endedAt: required(unit?.endedAt, 'SEGMENT_ENDED_AT_REQUIRED'),
      durationMs,
      mimeType: required(unit?.mimeType, 'SEGMENT_MIME_TYPE_REQUIRED'),
      containerLayout,
      byteLength,
      checksum,
      audioBytes: data,
      retryCount: 0,
      journalState: 'pending'
    });
  }

  function samePendingCapture(existing, candidate) {
    return existing.journalId === candidate.journalId
      && existing.recordingAttemptId === candidate.recordingAttemptId
      && existing.captureEpoch === candidate.captureEpoch
      && existing.captureOrdinal === candidate.captureOrdinal
      && existing.captureUnitId === candidate.captureUnitId
      && existing.chunkToken === candidate.chunkToken
      && existing.byteLength === candidate.byteLength
      && existing.checksum === candidate.checksum;
  }

  async function stagePendingCaptureUnit(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const capture = normalizeCaptureScope(contextValue, {
      ...input,
      captureEpoch: input.captureEpoch ?? input.unit?.identity?.captureEpoch
    });
    const data = bytes(input.bytes, 'PENDING_SEGMENT_BYTES_INVALID');
    if (!data.byteLength) throw codedError('PENDING_SEGMENT_BYTES_EMPTY');
    const plaintextHash = await sha256Hex(cryptoImpl, data);
    const pending = normalizePendingCapture(capture, input.unit, data, plaintextHash);
    const rows = await loadRows(contextValue, capture.meetingId);
    const current = await loadDurableMutationState(contextValue, rows);
    const captureOrdinals = currentCaptureOrdinals(current.manifest);
    const reservation = captureOrdinals.find((entry) => entry.captureOrdinal === pending.captureOrdinal);
    if (!reservation
      || reservation.captureEpoch !== pending.captureEpoch
      || reservation.captureUnitId !== pending.captureUnitId
      || reservation.chunkToken !== pending.chunkToken
      || !['reserved', 'pending'].includes(reservation.state)) {
      throw codedError('CAPTURE_ORDINAL_CONFLICT');
    }
    const hash = rows.hash;
    const id = pendingSegmentRowKey(hash, capture.meetingId, pending.journalId);
    const existingRow = await backend.get('pendingSegments', id);
    if (existingRow) {
      const existing = await keyProvider.withOwnerKey(contextValue, (key) => decryptPendingSegment(contextValue, existingRow, key));
      if (!samePendingCapture(existing, pending)) throw codedError('PENDING_SEGMENT_TOKEN_CONFLICT');
      return Object.freeze({
        idempotent: true,
        journalId: pending.journalId,
        captureOrdinal: pending.captureOrdinal,
        byteLength: pending.byteLength,
        checksum: pending.checksum
      });
    }

    return keyProvider.withOwnerKey(contextValue, async (key) => {
      let pendingEnvelope;
      try {
        pendingEnvelope = await encryptValue(cryptoImpl, key, encodePendingPayload({
          ...pending,
          ownerId: contextValue.ownerId
        }), aadFor({
          ownerId: contextValue.ownerId,
          meetingId: capture.meetingId,
          entityType: 'pendingSegment',
          revision: 1,
          segmentId: pending.journalId,
          sequence: pending.captureOrdinal
        }));
      } catch (error) {
        throw codedError('PENDING_SEGMENT_ENCRYPTION_FAILED', error);
      }
      const revision = Math.max(current.meeting.revision, current.manifest.revision) + 1;
      const nextManifest = Object.freeze({
        ...current.manifest,
        captureOrdinals: captureOrdinals.map((entry) => entry.captureOrdinal === pending.captureOrdinal
          ? { ...entry, state: 'pending', journalId: pending.journalId, checksum: pending.checksum, byteLength: pending.byteLength }
          : entry),
        revision
      });
      const manifestEnvelope = await encryptJson(cryptoImpl, key, nextManifest, {
        ownerId: contextValue.ownerId,
        meetingId: capture.meetingId,
        entityType: 'manifest',
        revision
      });
      try {
        await backend.atomicWrite({
          puts: [
            {
              storeName: 'pendingSegments',
              id,
              value: {
                id,
                ownerHash: hash,
                meetingId: capture.meetingId,
                journalId: pending.journalId,
                captureOrdinal: pending.captureOrdinal,
                revision: 1,
                nonce: pendingEnvelope.nonce,
                ciphertext: pendingEnvelope.ciphertext
              }
            },
            {
              storeName: 'manifests',
              id: rows.id,
              value: {
                ...rows.manifestRecord,
                revision,
                nonce: manifestEnvelope.nonce,
                ciphertext: manifestEnvelope.ciphertext
              }
            }
          ]
        });
      } catch (error) {
        throw codedError('PENDING_SEGMENT_JOURNAL_FAILED', error);
      }
      return Object.freeze({
        idempotent: false,
        journalId: pending.journalId,
        captureOrdinal: pending.captureOrdinal,
        byteLength: pending.byteLength,
        checksum: pending.checksum
      });
    });
  }

  async function commitAudioSegment(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const rows = await loadRows(contextValue, normalizedMeetingId);
    const current = await loadDurableMutationState(contextValue, rows);
    if (current.meeting.recordingState === 'stopped') throw codedError('SEGMENT_AFTER_STOP');
    if (!['recording', 'interrupted'].includes(current.meeting.recordingState)) throw codedError('SEGMENT_STATE_INVALID');
    const normalizedInput = normalizeSegment(input.segment, input.bytes, input.checksum);
    const expectedSequence = current.manifest.expectedSegmentIndex;
    const sequence = normalizedInput.sequence === null ? expectedSequence : normalizedInput.sequence;
    const normalized = { ...normalizedInput, sequence };
    const plaintextHash = await sha256Hex(cryptoImpl, normalized.audioBytes);
    if (normalized.checksum && normalized.checksum !== plaintextHash) throw codedError('SEGMENT_CHECKSUM_MISMATCH');
    const currentLayout = resolveRecordedContainerLayout(current.manifest.containerLayout);
    if (expectedSequence > 0 && currentLayout !== normalized.containerLayout) {
      throw codedError('AUDIO_CONTAINER_LAYOUT_MISMATCH');
    }
    const captureOrdinals = Array.isArray(current.manifest.captureOrdinals)
      ? current.manifest.captureOrdinals
      : [];
    let captureEntry = null;
    if (normalized.captureOrdinal !== null) {
      captureEntry = captureOrdinals.find((entry) => entry.captureOrdinal === normalized.captureOrdinal) || null;
      if (!captureEntry
        || !['reserved', 'pending', 'committed'].includes(captureEntry.state)
        || captureEntry.captureUnitId !== normalized.captureUnitId
        || captureEntry.chunkToken !== normalized.chunkToken) {
        throw codedError('CAPTURE_ORDINAL_CONFLICT');
      }
      const unresolvedEarlier = captureOrdinals.some((entry) => (
        entry.captureOrdinal < normalized.captureOrdinal
        && !['committed', 'discontinuity'].includes(entry.state)
      ));
      if (unresolvedEarlier) throw codedError('PENDING_SEGMENT_OUT_OF_ORDER');
    }
    const existingByChunk = rows.segmentRows.find((row) => (row.chunkToken || row.segmentId) === normalized.chunkToken);
    if (existingByChunk) {
      if (!isSameChunk(existingByChunk, normalizedInput, plaintextHash)) throw codedError('SEGMENT_CHUNK_TOKEN_CONFLICT');
      return Object.freeze({ idempotent: true, meeting: current.meeting, manifest: current.manifest, segment: { segmentId: existingByChunk.segmentId, sequence: existingByChunk.sequence, captureOrdinal: existingByChunk.captureOrdinal ?? null, containerLayout: existingByChunk.containerLayout || currentLayout, commitState: 'committed' } });
    }
    const existing = await backend.get('segments', segmentRowKey(rows.hash, normalizedMeetingId, normalized.segmentId));
    if (existing) {
      if (!isSameSegment(existing, normalized, plaintextHash)) throw codedError('SEGMENT_ID_CONFLICT');
      return Object.freeze({ idempotent: true, meeting: current.meeting, manifest: current.manifest, segment: { segmentId: existing.segmentId, sequence: existing.sequence, commitState: 'committed' } });
    }
    if (rows.segmentRows.some((row) => row.plaintextHash === plaintextHash)) throw codedError('SEGMENT_CONTENT_DUPLICATE');
    if (sequence !== expectedSequence) throw codedError('SEGMENT_OUT_OF_ORDER');
    try {
      return await keyProvider.withOwnerKey(contextValue, async (key) => {
        const audioEnvelope = await encryptValue(cryptoImpl, key, normalized.audioBytes, aadFor({
          ownerId: contextValue.ownerId,
          meetingId: normalizedMeetingId,
          entityType: 'audioSegment',
          revision: 1,
          segmentId: normalized.segmentId,
          sequence: normalized.sequence
        }));
        const metadata = {
          meetingId: normalizedMeetingId,
          ownerId: contextValue.ownerId,
          segmentId: normalized.segmentId,
          chunkToken: normalized.chunkToken,
          sequence: normalized.sequence,
          startedAt: normalized.startedAt,
          endedAt: normalized.endedAt,
          durationMs: normalized.durationMs,
          mimeType: normalized.mimeType,
          containerLayout: normalized.containerLayout,
          pageEpoch: normalized.pageEpoch,
          recorderGeneration: normalized.recorderGeneration,
          captureEpoch: normalized.captureEpoch,
          captureOrdinal: normalized.captureOrdinal,
          captureUnitId: normalized.captureUnitId,
          byteLength: normalized.audioBytes.byteLength,
          checksum: plaintextHash,
          encryptionMetadata: { algorithm: AES_GCM, schemaVersion: MEETING_PHASE1_STORAGE_SCHEMA_VERSION },
          commitState: 'committed'
        };
        const metadataEnvelope = await encryptJson(cryptoImpl, key, metadata, {
          ownerId: contextValue.ownerId,
          meetingId: normalizedMeetingId,
          entityType: 'audioSegmentMeta',
          revision: 1,
          segmentId: normalized.segmentId,
          sequence: normalized.sequence
        });
        const revision = Math.max(current.meeting.revision, current.manifest.revision) + 1;
        const nextMeeting = Object.freeze({
          ...current.meeting,
          updatedAt: timestamp(now),
          lastSavedAt: timestamp(now),
          committedSegmentCount: current.meeting.committedSegmentCount + 1,
          committedDurationMs: current.meeting.committedDurationMs + normalized.durationMs,
          totalBytes: current.meeting.totalBytes + normalized.audioBytes.byteLength,
          lastSuccessfulPersistAt: timestamp(now),
          lastPersistedSequence: normalized.sequence,
          lastCommittedDurationMs: current.meeting.committedDurationMs + normalized.durationMs,
          recoverable: true,
          persistenceStalled: false,
          errorCode: '',
          finalizationPending: false,
          finalizationErrorCode: '',
          revision
        });
        const nextCaptureOrdinals = normalized.captureOrdinal === null
          ? captureOrdinals
          : captureOrdinals.map((entry) => entry.captureOrdinal === normalized.captureOrdinal
              ? {
                  ...entry,
                  state: 'committed',
                  segmentId: normalized.segmentId,
                  sequence: normalized.sequence,
                  durationMs: normalized.durationMs,
                  byteLength: normalized.audioBytes.byteLength,
                  checksum: plaintextHash
                }
              : entry);
        const nextManifest = Object.freeze({
          ...current.manifest,
          containerLayout: expectedSequence === 0 ? normalized.containerLayout : currentLayout,
          expectedSegmentIndex: current.manifest.expectedSegmentIndex + 1,
          committedDurationMs: current.manifest.committedDurationMs + normalized.durationMs,
          totalBytes: current.manifest.totalBytes + normalized.audioBytes.byteLength,
          committedSegmentIds: [...current.manifest.committedSegmentIds, normalized.segmentId],
          captureOrdinals: nextCaptureOrdinals,
          revision
        });
        const meetingEnvelope = await encryptJson(cryptoImpl, key, nextMeeting, {
          ownerId: contextValue.ownerId,
          meetingId: normalizedMeetingId,
          entityType: 'meeting',
          revision
        });
        const manifestEnvelope = await encryptJson(cryptoImpl, key, nextManifest, {
          ownerId: contextValue.ownerId,
          meetingId: normalizedMeetingId,
          entityType: 'manifest',
          revision
        });
        const segmentKey = segmentRowKey(rows.hash, normalizedMeetingId, normalized.segmentId);
        await backend.atomicPut([
          { storeName: 'segments', id: segmentKey, value: { id: segmentKey, ownerHash: rows.hash, meetingId: normalizedMeetingId, segmentId: normalized.segmentId, chunkToken: normalized.chunkToken, sequence: normalized.sequence, captureOrdinal: normalized.captureOrdinal, containerLayout: normalized.containerLayout, byteLength: normalized.audioBytes.byteLength, plaintextHash, metadataRevision: 1, metadataNonce: metadataEnvelope.nonce, metadataCiphertext: metadataEnvelope.ciphertext, audioRevision: 1, audioNonce: audioEnvelope.nonce, audioCiphertext: audioEnvelope.ciphertext } },
          { storeName: 'meetings', id: rows.id, value: { ...rows.record, revision, nonce: meetingEnvelope.nonce, ciphertext: meetingEnvelope.ciphertext } },
          { storeName: 'manifests', id: rows.id, value: { ...rows.manifestRecord, revision, nonce: manifestEnvelope.nonce, ciphertext: manifestEnvelope.ciphertext } }
        ]);
        return Object.freeze({ idempotent: false, meeting: nextMeeting, manifest: nextManifest, segment: metadata });
      });
    } catch (error) {
      if (error?.code === 'SEGMENT_ATOMIC_COMMIT_FAILED') throw error;
      throw codedError('SEGMENT_ATOMIC_COMMIT_FAILED', error);
    }
  }

  async function commitPendingCaptureUnit(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    validateOwnerPayload(contextValue, input);
    const meetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const journalId = required(input.journalId, 'PENDING_SEGMENT_JOURNAL_ID_REQUIRED');
    const rows = await loadRows(contextValue, meetingId);
    const id = pendingSegmentRowKey(rows.hash, meetingId, journalId);
    const row = await backend.get('pendingSegments', id);
    if (!row) throw codedError('PENDING_SEGMENT_NOT_FOUND');
    const pending = await keyProvider.withOwnerKey(contextValue, (key) => decryptPendingSegment(contextValue, row, key));
    const hash = await sha256Hex(cryptoImpl, pending.audioBytes);
    if (hash !== pending.checksum || pending.audioBytes.byteLength !== pending.byteLength) {
      throw codedError('PENDING_SEGMENT_INTEGRITY_MISMATCH');
    }
    const result = await commitAudioSegment(contextValue, {
      meetingId,
      segment: {
        segmentId: `segment-${pending.captureUnitId}`,
        chunkToken: pending.chunkToken,
        startedAt: pending.startedAt,
        endedAt: pending.endedAt,
        durationMs: pending.durationMs,
        mimeType: pending.mimeType,
        containerLayout: pending.containerLayout,
        pageEpoch: pending.pageEpoch,
        recorderGeneration: pending.recorderGeneration,
        captureEpoch: pending.captureEpoch,
        captureOrdinal: pending.captureOrdinal,
        captureUnitId: pending.captureUnitId
      },
      bytes: pending.audioBytes,
      checksum: pending.checksum
    });
    let cleanupPending = false;
    try {
      await backend.atomicDelete([{ storeName: 'pendingSegments', id }]);
    } catch {
      cleanupPending = true;
    }
    return Object.freeze({
      ...result,
      journalId,
      captureOrdinal: pending.captureOrdinal,
      cleanupPending
    });
  }

  async function replayPendingCaptureUnits(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    validateOwnerPayload(contextValue, input);
    const meetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const rows = await loadRows(contextValue, meetingId);
    const pendingRows = (await backend.list('pendingSegments'))
      .filter((row) => row.ownerHash === rows.hash && row.meetingId === meetingId)
      .sort((left, right) => left.captureOrdinal - right.captureOrdinal);
    let committedCount = 0;
    let idempotentCount = 0;
    const results = [];
    for (const row of pendingRows) {
      const result = await commitPendingCaptureUnit(contextValue, {
        meetingId,
        journalId: row.journalId
      });
      if (result.idempotent) idempotentCount += 1;
      else committedCount += 1;
      results.push(result);
    }
    const current = await getMeeting(contextValue, meetingId);
    return Object.freeze({
      committedCount,
      idempotentCount,
      replayedCount: results.length,
      results: Object.freeze(results),
      committedDurationMs: current.meeting.committedDurationMs,
      committedSegmentCount: current.meeting.committedSegmentCount,
      manifestRevision: current.manifest.revision
    });
  }

  async function recordCaptureDiscontinuity(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const capture = normalizeCaptureScope(contextValue, input);
    const captureOrdinal = optionalNonNegativeInteger(input.captureOrdinal, 'CAPTURE_ORDINAL_INVALID');
    if (captureOrdinal === null) throw codedError('CAPTURE_ORDINAL_INVALID');
    const captureUnitId = required(input.captureUnitId, 'CAPTURE_UNIT_ID_REQUIRED');
    const chunkToken = required(input.chunkToken, 'SEGMENT_CHUNK_TOKEN_REQUIRED');
    const errorCode = required(input.errorCode, 'CAPTURE_DISCONTINUITY_ERROR_REQUIRED');
    const rows = await loadRows(contextValue, capture.meetingId);
    const current = await loadDurableMutationState(contextValue, rows);
    const captureOrdinals = currentCaptureOrdinals(current.manifest);
    const existing = captureOrdinals.find((entry) => entry.captureOrdinal === captureOrdinal);
    if (!existing
      || existing.captureEpoch !== capture.captureEpoch
      || existing.captureUnitId !== captureUnitId
      || existing.chunkToken !== chunkToken) {
      throw codedError('CAPTURE_ORDINAL_CONFLICT');
    }
    if (existing.state === 'discontinuity' && existing.errorCode === errorCode) {
      return Object.freeze({ idempotent: true, captureOrdinal, errorCode });
    }
    if (existing.state !== 'reserved') throw codedError('CAPTURE_ORDINAL_ALREADY_REPRESENTED');
    const pendingId = pendingSegmentRowKey(rows.hash, capture.meetingId, `pending-${captureUnitId}`);
    if (await backend.get('pendingSegments', pendingId)) throw codedError('CAPTURE_ORDINAL_ALREADY_PENDING');
    const revision = Math.max(current.meeting.revision, current.manifest.revision) + 1;
    const nextManifest = Object.freeze({
      ...current.manifest,
      captureOrdinals: captureOrdinals.map((entry) => entry.captureOrdinal === captureOrdinal
        ? { ...entry, state: 'discontinuity', errorCode }
        : entry),
      revision
    });
    await persistManifestOnly(contextValue, rows, current, nextManifest);
    return Object.freeze({ idempotent: false, captureOrdinal, errorCode, manifest: nextManifest });
  }

  async function finalizeCaptureManifest(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    validateOwnerPayload(contextValue, input);
    const meetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const expectedRecordingAttemptId = required(input.expectedRecordingAttemptId, 'RECORDING_ATTEMPT_ID_REQUIRED');
    const replay = await replayPendingCaptureUnits(contextValue, { meetingId });
    const rows = await loadRows(contextValue, meetingId);
    const current = await getMeeting(contextValue, meetingId);
    if (String(current.manifest.recordingAttemptId || '') !== expectedRecordingAttemptId) {
      throw codedError('RECORDING_ATTEMPT_ID_MISMATCH');
    }
    const unresolved = currentCaptureOrdinals(current.manifest).filter((entry) => !['committed', 'discontinuity'].includes(entry.state));
    if (unresolved.length && input.allowSafeTailClosure !== true) {
      throw codedError('CAPTURE_MANIFEST_UNRESOLVED');
    }
    const revision = Math.max(current.meeting.revision, current.manifest.revision) + 1;
    const nextManifest = Object.freeze({
      ...current.manifest,
      captureOrdinals: currentCaptureOrdinals(current.manifest).map((entry) => unresolved.includes(entry)
        ? { ...entry, state: 'discontinuity', errorCode: 'CAPTURE_UNIT_UNSEALED_AT_FINALIZE' }
        : entry),
      status: 'closed',
      revision
    });
    await persistManifestOnly(contextValue, rows, current, nextManifest);
    return Object.freeze({
      finalized: true,
      finalizationPending: false,
      manifest: nextManifest,
      replay
    });
  }

  async function readAudioSegment(ownerContext, meetingId, segmentId) {
    const contextValue = await context(ownerContext);
    const hash = await ownerHash(contextValue);
    const row = await backend.get('segments', segmentRowKey(hash, required(meetingId, 'MEETING_ID_REQUIRED'), required(segmentId, 'SEGMENT_ID_REQUIRED')));
    if (!row) throw codedError('SEGMENT_NOT_FOUND');
    return keyProvider.withOwnerKey(contextValue, (key) => verifySegmentAudio(contextValue, row, key, true));
  }

  function sameImportIdentity(source, input) {
    const incomingIdentity = String(input.fileIdentity || '').trim();
    if (incomingIdentity && source.fileIdentity && incomingIdentity !== source.fileIdentity) return false;
    return source.byteLength === Number(input.byteLength)
      && source.durationMs === Number(input.durationMs)
      && source.format === String(input.format || '').trim()
      && source.mimeType === String(input.mimeType || '').trim();
  }

  async function beginAudioImport(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    validateOwnerPayload(contextValue, input);
    const normalizedMeetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const importId = required(input.importId, 'IMPORT_ID_REQUIRED');
    const requestedSourceId = required(input.sourceId, 'SOURCE_ID_REQUIRED');
    const rows = await loadRows(contextValue, normalizedMeetingId);
    const sourceRows = await listAudioSourceRows(contextValue, normalizedMeetingId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const decoded = [];
      for (const row of sourceRows) decoded.push({ row, source: await decryptStoredAudioSource(contextValue, row, key) });
      const existing = decoded.find(({ source }) => source.importId === importId);
      if (existing && !sameImportIdentity(existing.source, input)) throw codedError('IMPORT_ID_CONFLICT');
      if (existing?.source.importState === 'committed') return Object.freeze({ idempotent: true, source: existing.source });
      const sourceId = existing?.source.sourceId || requestedSourceId;
      const sourceKey = audioRowKey(rows.hash, normalizedMeetingId, sourceId);
      const sourceRow = await backend.get('audioSources', sourceKey);
      if (!existing && sourceRow) throw codedError('SOURCE_ID_CONFLICT');
      const createdAt = existing?.source.createdAt || timestamp(now);
      const retentionExpiresAt = existing?.source.retentionExpiresAt || new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
      const revision = (existing?.source.revision || 0) + 1;
      const source = createAudioSource({
        ownerContext: contextValue,
        meetingId: normalizedMeetingId,
        sourceId,
        scope: input.scope || existing?.source.scope || 'meeting',
        origin: 'imported',
        originalFileName: String(input.originalFileName || existing?.source.originalFileName || '').trim(),
        mimeType: String(input.mimeType || existing?.source.mimeType || '').trim(),
        format: String(input.format || existing?.source.format || '').trim(),
        byteLength: Number(input.byteLength),
        durationMs: Number(input.durationMs),
        checksum: '',
        chunkCount: 0,
        manifestVersion: MEETING_AUDIO_MANIFEST_VERSION,
        importState: 'importing',
        createdAt,
        updatedAt: timestamp(now),
        retentionExpiresAt,
        revision,
        importId,
        fileIdentity: String(input.fileIdentity || existing?.source.fileIdentity || '').trim(),
        committedByteLength: 0,
        committedDurationMs: 0
      });
      const manifest = {
        schemaVersion: 1,
        manifestVersion: MEETING_AUDIO_MANIFEST_VERSION,
        manifestId: existing?.source.manifestId || randomId(cryptoImpl, 'audio-manifest'),
        sourceId,
        meetingId: normalizedMeetingId,
        ownerId: contextValue.ownerId,
        status: 'importing',
        expectedSequence: 0,
        committedAssetIds: [],
        committedByteLength: 0,
        committedDurationMs: 0,
        revision
      };
      const sourceEnvelope = await encryptAudioJson(key, source, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId,
        manifestVersion: source.manifestVersion,
        entityType: 'audioSource',
        revision
      });
      const manifestEnvelope = await encryptAudioJson(key, manifest, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId,
        manifestVersion: manifest.manifestVersion,
        entityType: 'audioManifest',
        revision
      });
      const previousAssets = (await backend.list('audioAssets')).filter((row) => row.ownerHash === rows.hash && row.meetingId === normalizedMeetingId && row.sourceId === sourceId);
      try {
        await backend.atomicWrite({
          deletions: [
            ...previousAssets.map((row) => ({ storeName: 'audioAssets', id: row.id })),
            ...(await backend.get('audioManifests', sourceKey) ? [{ storeName: 'audioManifests', id: sourceKey }] : [])
          ],
          puts: [
            { storeName: 'audioSources', id: sourceKey, value: { id: sourceKey, ownerHash: rows.hash, meetingId: normalizedMeetingId, sourceId, manifestVersion: source.manifestVersion, revision, nonce: sourceEnvelope.nonce, ciphertext: sourceEnvelope.ciphertext } },
            { storeName: 'audioManifests', id: sourceKey, value: { id: sourceKey, ownerHash: rows.hash, meetingId: normalizedMeetingId, sourceId, manifestVersion: manifest.manifestVersion, revision, nonce: manifestEnvelope.nonce, ciphertext: manifestEnvelope.ciphertext } }
          ]
        });
      } catch (error) {
        throw codedError('AUDIO_IMPORT_ATOMIC_START_FAILED', error);
      }
      return Object.freeze({ idempotent: false, source, manifest });
    });
  }

  async function commitImportedAudioAsset(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(input.sourceId, 'SOURCE_ID_REQUIRED');
    const data = bytes(input.bytes);
    if (!data.byteLength) throw codedError('AUDIO_ASSET_EMPTY');
    const rows = await loadAudioRows(contextValue, normalizedMeetingId, normalizedSourceId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const source = await decryptStoredAudioSource(contextValue, rows.sourceRecord, key);
      if (source.importState !== 'importing') throw codedError('AUDIO_IMPORT_NOT_IMPORTING');
      if (!rows.manifestRecord) throw codedError('AUDIO_MANIFEST_NOT_FOUND');
      const manifest = await decryptStoredAudioManifest(contextValue, rows.manifestRecord, key);
      const sequence = Number(input.asset?.sequence);
      const chunkId = required(input.asset?.chunkId || input.asset?.assetId, 'AUDIO_CHUNK_ID_REQUIRED');
      const assetId = required(input.asset?.assetId || chunkId, 'AUDIO_ASSET_ID_REQUIRED');
      const plaintextHash = await sha256Hex(cryptoImpl, data);
      const existing = rows.assetRows.find((row) => row.chunkId === chunkId || row.sequence === sequence);
      if (existing) {
        const same = existing.sequence === sequence && existing.chunkId === chunkId && existing.byteLength === data.byteLength && existing.plaintextHash === plaintextHash;
        if (!same) throw codedError('AUDIO_ASSET_CONFLICT');
        return Object.freeze({ idempotent: true, source, manifest, asset: { assetId: existing.assetId, chunkId: existing.chunkId, sequence: existing.sequence, commitState: 'committed' } });
      }
      if (!Number.isSafeInteger(sequence) || sequence !== manifest.expectedSequence) throw codedError('AUDIO_ASSET_OUT_OF_ORDER');
      const revision = Math.max(source.revision, manifest.revision) + 1;
      const durationMs = Number(input.asset?.durationMs || 0);
      const asset = createAudioAsset({
        ownerContext: contextValue,
        ownerId: input.asset?.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        assetId,
        chunkId,
        scope: source.scope,
        sequence,
        byteLength: data.byteLength,
        durationMs,
        checksum: plaintextHash,
        mimeType: source.mimeType,
        manifestVersion: source.manifestVersion,
        commitState: 'committed',
        createdAt: timestamp(now)
      });
      const audioEnvelope = await encryptValue(cryptoImpl, key, data, audioAadFor({
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        chunkId,
        sequence,
        manifestVersion: source.manifestVersion,
        entityType: 'audioAsset',
        revision
      }));
      const metadataEnvelope = await encryptAudioJson(key, asset, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        chunkId,
        sequence,
        manifestVersion: source.manifestVersion,
        entityType: 'audioAssetMeta',
        revision
      });
      const nextSource = createAudioSource({
        ...source,
        ownerContext: contextValue,
        ownerId: undefined,
        importState: 'importing',
        checksum: '',
        chunkCount: source.chunkCount + 1,
        updatedAt: timestamp(now),
        revision,
        committedByteLength: source.committedByteLength + data.byteLength,
        committedDurationMs: source.committedDurationMs + durationMs
      });
      const nextManifest = {
        ...manifest,
        expectedSequence: manifest.expectedSequence + 1,
        committedAssetIds: [...manifest.committedAssetIds, asset.assetId],
        committedByteLength: manifest.committedByteLength + data.byteLength,
        committedDurationMs: manifest.committedDurationMs + durationMs,
        revision
      };
      const sourceEnvelope = await encryptAudioJson(key, nextSource, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        manifestVersion: nextSource.manifestVersion,
        entityType: 'audioSource',
        revision
      });
      const manifestEnvelope = await encryptAudioJson(key, nextManifest, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        manifestVersion: nextManifest.manifestVersion,
        entityType: 'audioManifest',
        revision
      });
      const assetKey = audioRowKey(rows.hash, normalizedMeetingId, normalizedSourceId, asset.assetId);
      try {
        await backend.atomicWrite({
          puts: [
            { storeName: 'audioAssets', id: assetKey, value: { id: assetKey, ownerHash: rows.hash, meetingId: normalizedMeetingId, sourceId: normalizedSourceId, assetId: asset.assetId, chunkId: asset.chunkId, sequence: asset.sequence, byteLength: asset.byteLength, plaintextHash, manifestVersion: asset.manifestVersion, metadataRevision: revision, metadataNonce: metadataEnvelope.nonce, metadataCiphertext: metadataEnvelope.ciphertext, audioRevision: revision, audioNonce: audioEnvelope.nonce, audioCiphertext: audioEnvelope.ciphertext } },
            { storeName: 'audioSources', id: rows.sourceKey, value: { ...rows.sourceRecord, revision, manifestVersion: nextSource.manifestVersion, nonce: sourceEnvelope.nonce, ciphertext: sourceEnvelope.ciphertext } },
            { storeName: 'audioManifests', id: rows.sourceKey, value: { ...rows.manifestRecord, revision, manifestVersion: nextManifest.manifestVersion, nonce: manifestEnvelope.nonce, ciphertext: manifestEnvelope.ciphertext } }
          ]
        });
      } catch (error) {
        throw codedError('AUDIO_ASSET_ATOMIC_COMMIT_FAILED', error);
      }
      return Object.freeze({ idempotent: false, source: nextSource, manifest: nextManifest, asset });
    });
  }

  async function completeAudioImport(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(input.sourceId, 'SOURCE_ID_REQUIRED');
    const expectedChecksum = required(input.checksum, 'AUDIO_CHECKSUM_REQUIRED').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) throw codedError('AUDIO_CHECKSUM_INVALID');
    const rows = await loadAudioRows(contextValue, normalizedMeetingId, normalizedSourceId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const source = await decryptStoredAudioSource(contextValue, rows.sourceRecord, key);
      if (source.importState === 'committed' && source.checksum === expectedChecksum) return Object.freeze({ idempotent: true, source });
      if (source.importState !== 'importing') throw codedError('AUDIO_IMPORT_NOT_IMPORTING');
      const manifest = await decryptStoredAudioManifest(contextValue, rows.manifestRecord, key);
      if (!rows.assetRows.length || rows.assetRows.length !== source.chunkCount || manifest.expectedSequence !== source.chunkCount || source.committedByteLength !== source.byteLength || source.committedDurationMs !== source.durationMs) throw codedError('AUDIO_IMPORT_INCOMPLETE');
      const hasher = new StreamingSha256();
      for (const row of rows.assetRows) {
        const checked = await decryptStoredAudioAsset(contextValue, row, key, true);
        hasher.update(checked.bytes);
      }
      if (hasher.digestHex() !== expectedChecksum) throw codedError('AUDIO_SOURCE_CHECKSUM_MISMATCH');
      const revision = Math.max(source.revision, manifest.revision) + 1;
      const committed = createAudioSource({
        ...source,
        ownerContext: contextValue,
        ownerId: undefined,
        importState: 'committed',
        checksum: expectedChecksum,
        updatedAt: timestamp(now),
        revision
      });
      const committedManifest = { ...manifest, status: 'committed', checksum: expectedChecksum, revision };
      const sourceEnvelope = await encryptAudioJson(key, committed, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        manifestVersion: committed.manifestVersion,
        entityType: 'audioSource',
        revision
      });
      const manifestEnvelope = await encryptAudioJson(key, committedManifest, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        manifestVersion: committedManifest.manifestVersion,
        entityType: 'audioManifest',
        revision
      });
      await backend.atomicWrite({
        puts: [
          { storeName: 'audioSources', id: rows.sourceKey, value: { ...rows.sourceRecord, revision, nonce: sourceEnvelope.nonce, ciphertext: sourceEnvelope.ciphertext } },
          { storeName: 'audioManifests', id: rows.sourceKey, value: { ...rows.manifestRecord, revision, nonce: manifestEnvelope.nonce, ciphertext: manifestEnvelope.ciphertext } }
        ]
      });
      return Object.freeze({ idempotent: false, source: committed, manifest: committedManifest });
    });
  }

  async function failAudioImport(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const rows = await loadAudioRows(contextValue, required(input.meetingId, 'MEETING_ID_REQUIRED'), required(input.sourceId, 'SOURCE_ID_REQUIRED'));
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const source = await decryptStoredAudioSource(contextValue, rows.sourceRecord, key);
      if (!['importing', 'validating'].includes(source.importState)) return source;
      const failed = createAudioSource({
        ...source,
        ownerContext: contextValue,
        ownerId: undefined,
        importState: 'failed_retryable',
        updatedAt: timestamp(now),
        revision: source.revision + 1,
        checksum: ''
      });
      const envelope = await encryptAudioJson(key, failed, {
        ownerId: contextValue.ownerId,
        meetingId: failed.meetingId,
        sourceId: failed.sourceId,
        manifestVersion: failed.manifestVersion,
        entityType: 'audioSource',
        revision: failed.revision
      });
      await backend.atomicWrite({ puts: [{ storeName: 'audioSources', id: rows.sourceKey, value: { ...rows.sourceRecord, revision: failed.revision, nonce: envelope.nonce, ciphertext: envelope.ciphertext } }] });
      return failed;
    });
  }

  async function cancelAudioImport(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(input.sourceId, 'SOURCE_ID_REQUIRED');
    const rows = await loadAudioRows(contextValue, normalizedMeetingId, normalizedSourceId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const source = await decryptStoredAudioSource(contextValue, rows.sourceRecord, key);
      if (source.importState === 'cancelled') return Object.freeze({ source, idempotent: true });
      if (source.importState === 'committed') throw codedError('AUDIO_IMPORT_ALREADY_COMMITTED');
      const cancelled = createAudioSource({
        ...source,
        ownerContext: contextValue,
        ownerId: undefined,
        importState: 'cancelled',
        checksum: '',
        chunkCount: 0,
        updatedAt: timestamp(now),
        revision: source.revision + 1,
        committedByteLength: 0,
        committedDurationMs: 0
      });
      const envelope = await encryptAudioJson(key, cancelled, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        manifestVersion: cancelled.manifestVersion,
        entityType: 'audioSource',
        revision: cancelled.revision
      });
      await backend.atomicWrite({
        deletions: [
          { storeName: 'audioManifests', id: rows.sourceKey },
          ...rows.assetRows.map((row) => ({ storeName: 'audioAssets', id: row.id }))
        ],
        puts: [{ storeName: 'audioSources', id: rows.sourceKey, value: { ...rows.sourceRecord, revision: cancelled.revision, nonce: envelope.nonce, ciphertext: envelope.ciphertext } }]
      });
      return Object.freeze({ source: cancelled, idempotent: false });
    });
  }

  async function deleteAudioSource(ownerContext, input = {}) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(input.sourceId, 'SOURCE_ID_REQUIRED');
    if (normalizedSourceId === `recorded-${normalizedMeetingId}`) {
      const current = await getMeeting(contextValue, normalizedMeetingId);
      const source = current.audioSources.find((item) => item.sourceId === normalizedSourceId);
      if (!source) throw codedError('AUDIO_SOURCE_NOT_FOUND');
      if (current.meeting.recordingState !== 'stopped') throw codedError('AUDIO_SOURCE_DELETE_REQUIRES_STOPPED');
      const rows = await loadRows(contextValue, normalizedMeetingId);
      const revision = Math.max(current.meeting.revision, current.manifest.revision) + 1;
      const nextMeeting = {
        ...current.meeting,
        committedSegmentCount: 0,
        committedDurationMs: 0,
        totalBytes: 0,
        updatedAt: timestamp(now),
        revision
      };
      const nextManifest = {
        ...current.manifest,
        expectedSegmentIndex: 0,
        committedDurationMs: 0,
        totalBytes: 0,
        status: 'closed',
        committedSegmentIds: [],
        revision
      };
      return keyProvider.withOwnerKey(contextValue, async (key) => {
        const meetingEnvelope = await encryptJson(cryptoImpl, key, nextMeeting, {
          ownerId: contextValue.ownerId,
          meetingId: normalizedMeetingId,
          entityType: 'meeting',
          revision
        });
        const manifestEnvelope = await encryptJson(cryptoImpl, key, nextManifest, {
          ownerId: contextValue.ownerId,
          meetingId: normalizedMeetingId,
          entityType: 'manifest',
          revision
        });
        await backend.atomicWrite({
          deletions: rows.segmentRows.map((row) => ({ storeName: 'segments', id: row.id })),
          puts: [
            { storeName: 'meetings', id: rows.id, value: { ...rows.record, revision, nonce: meetingEnvelope.nonce, ciphertext: meetingEnvelope.ciphertext } },
            { storeName: 'manifests', id: rows.manifestRecord.id, value: { ...rows.manifestRecord, revision, nonce: manifestEnvelope.nonce, ciphertext: manifestEnvelope.ciphertext } }
          ]
        });
        return true;
      });
    }
    const rows = await loadAudioRows(contextValue, normalizedMeetingId, normalizedSourceId);
    await keyProvider.withOwnerKey(contextValue, async (key) => {
      const source = await decryptStoredAudioSource(contextValue, rows.sourceRecord, key);
      if (source.importState === 'deleted') return;
      const deleting = createAudioSource({ ...source, ownerContext: contextValue, ownerId: undefined, importState: 'deleting', updatedAt: timestamp(now), revision: source.revision + 1, checksum: source.importState === 'committed' ? source.checksum : '' });
      const envelope = await encryptAudioJson(key, deleting, {
        ownerId: contextValue.ownerId,
        meetingId: normalizedMeetingId,
        sourceId: normalizedSourceId,
        manifestVersion: deleting.manifestVersion,
        entityType: 'audioSource',
        revision: deleting.revision
      });
      await backend.atomicWrite({ puts: [{ storeName: 'audioSources', id: rows.sourceKey, value: { ...rows.sourceRecord, revision: deleting.revision, nonce: envelope.nonce, ciphertext: envelope.ciphertext } }] });
    });
    await backend.atomicWrite({
      deletions: [
        { storeName: 'audioSources', id: rows.sourceKey },
        { storeName: 'audioManifests', id: rows.sourceKey },
        ...rows.assetRows.map((row) => ({ storeName: 'audioAssets', id: row.id }))
      ]
    });
    return true;
  }

  async function getAudioSource(ownerContext, meetingId, sourceId) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(sourceId, 'SOURCE_ID_REQUIRED');
    const recordedId = `recorded-${normalizedMeetingId}`;
    if (normalizedSourceId === recordedId) {
      const loaded = await getMeeting(contextValue, normalizedMeetingId);
      const source = loaded.audioSources.find((item) => item.sourceId === normalizedSourceId);
      if (!source) throw codedError('AUDIO_SOURCE_NOT_FOUND');
      return source;
    }
    const rows = await loadAudioRows(contextValue, normalizedMeetingId, normalizedSourceId);
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const source = await decryptStoredAudioSource(contextValue, rows.sourceRecord, key);
      if (source.importState !== 'committed') throw codedError('AUDIO_SOURCE_NOT_AVAILABLE');
      return (await inspectImportedSource(contextValue, rows, key)).source;
    });
  }

  async function listAudioSources(ownerContext, meetingId, { includeLifecycle = false } = {}) {
    const contextValue = await context(ownerContext);
    const loaded = await getMeeting(contextValue, meetingId);
    if (!includeLifecycle) return loaded.audioSources;
    const imported = await readImportedSources(contextValue, required(meetingId, 'MEETING_ID_REQUIRED'), { includeLifecycle: true, verifyBytes: false });
    const recorded = loaded.audioSources.filter((source) => source.origin === 'recorded');
    return Object.freeze([...recorded, ...imported.map(({ source }) => source)]);
  }

  async function* streamAudioSource(ownerContext, { meetingId, sourceId } = {}) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(sourceId, 'SOURCE_ID_REQUIRED');
    const loaded = await getMeeting(contextValue, normalizedMeetingId);
    const source = loaded.audioSources.find((item) => item.sourceId === normalizedSourceId);
    if (!source) throw codedError('AUDIO_SOURCE_NOT_AVAILABLE');
    if (source.origin === 'recorded') {
      const segments = loaded.segments.sort((left, right) => left.sequence - right.sequence);
      for (const segment of segments) yield await readAudioSegment(contextValue, normalizedMeetingId, segment.segmentId);
      return;
    }
    const rows = await loadAudioRows(contextValue, normalizedMeetingId, normalizedSourceId);
    for (const row of rows.assetRows) {
      const checked = await keyProvider.withOwnerKey(contextValue, (key) => decryptStoredAudioAsset(contextValue, row, key, true));
      yield checked.bytes;
    }
  }

  async function* streamAudioSourceDetailed(ownerContext, { meetingId, sourceId } = {}) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const normalizedSourceId = required(sourceId, 'SOURCE_ID_REQUIRED');
    const loaded = await getMeeting(contextValue, normalizedMeetingId);
    const source = loaded.audioSources.find((item) => item.sourceId === normalizedSourceId);
    if (!source || source.importState !== 'committed') throw codedError('AUDIO_SOURCE_NOT_AVAILABLE');
    if (source.origin === 'recorded') {
      const segments = [...loaded.segments].sort((left, right) => left.sequence - right.sequence);
      if (segments.length !== source.chunkCount) throw codedError('AUDIO_SOURCE_CHUNK_COUNT_MISMATCH');
      for (const segment of segments) {
        yield Object.freeze({
          sourceChunkId: segment.segmentId,
          sequence: segment.sequence,
          durationMs: segment.durationMs,
          checksum: segment.checksum,
          mimeType: segment.mimeType,
          bytes: await readAudioSegment(contextValue, normalizedMeetingId, segment.segmentId)
        });
      }
      return;
    }
    const rows = await loadAudioRows(contextValue, normalizedMeetingId, normalizedSourceId);
    if (rows.assetRows.length !== source.chunkCount) throw codedError('AUDIO_SOURCE_CHUNK_COUNT_MISMATCH');
    for (const row of rows.assetRows) {
      const checked = await keyProvider.withOwnerKey(contextValue, (key) => decryptStoredAudioAsset(contextValue, row, key, true));
      yield Object.freeze({
        sourceChunkId: checked.metadata.chunkId,
        sequence: checked.metadata.sequence,
        durationMs: checked.metadata.durationMs,
        checksum: checked.metadata.checksum,
        mimeType: checked.metadata.mimeType,
        bytes: checked.bytes
      });
    }
  }

  async function deleteMeeting(ownerContext, meetingId) {
    const contextValue = await context(ownerContext);
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const hash = await ownerHash(contextValue);
    const meetingKey = rowKey(hash, normalizedMeetingId);
    if (!(await backend.get('meetings', meetingKey))) throw codedError('MEETING_NOT_FOUND');
    const segmentRows = (await backend.list('segments')).filter((row) => row.ownerHash === hash && row.meetingId === normalizedMeetingId);
    const pendingSegmentRows = (await backend.list('pendingSegments')).filter((row) => row.ownerHash === hash && row.meetingId === normalizedMeetingId);
    const audioSourceRows = (await backend.list('audioSources')).filter((row) => row.ownerHash === hash && row.meetingId === normalizedMeetingId);
    const audioAssetRows = (await backend.list('audioAssets')).filter((row) => row.ownerHash === hash && row.meetingId === normalizedMeetingId);
    const artifactDeletions = [];
    for (const storeName of ['transcriptDocuments', 'transcriptRevisions', 'transcriptionJobs', 'transcriptionChunks', 'diarizationDocuments', 'diarizationRevisions', 'diarizationJobs', 'analysisBundles']) {
      const rows = await backend.list(storeName);
      artifactDeletions.push(...rows
        .filter((row) => row.ownerHash === hash && row.meetingId === normalizedMeetingId)
        .map((row) => ({ storeName, id: row.id })));
    }
    await backend.atomicDelete([
      { storeName: 'meetings', id: meetingKey },
      { storeName: 'manifests', id: meetingKey },
      ...segmentRows.map((row) => ({ storeName: 'segments', id: row.id })),
      ...pendingSegmentRows.map((row) => ({ storeName: 'pendingSegments', id: row.id })),
      ...audioSourceRows.map((row) => ({ storeName: 'audioSources', id: row.id })),
      ...audioSourceRows.map((row) => ({ storeName: 'audioManifests', id: row.id })),
      ...audioAssetRows.map((row) => ({ storeName: 'audioAssets', id: row.id })),
      ...artifactDeletions
    ]);
    return true;
  }

  return Object.freeze({
    createMeeting,
    prepareMeeting,
    saveSession,
    listMeetings,
    getMeeting,
    reserveCaptureUnit,
    stagePendingCaptureUnit,
    commitPendingCaptureUnit,
    replayPendingCaptureUnits,
    recordCaptureDiscontinuity,
    finalizeCaptureManifest,
    commitAudioSegment,
    readAudioSegment,
    beginAudioImport,
    commitImportedAudioAsset,
    completeAudioImport,
    failAudioImport,
    cancelAudioImport,
    deleteAudioSource,
    getAudioSource,
    listAudioSources,
    streamAudioSource,
    streamAudioSourceDetailed,
    deleteMeeting
  });
}
