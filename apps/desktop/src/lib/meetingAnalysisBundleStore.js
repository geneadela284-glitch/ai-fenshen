import { assertOwnerContext } from '../../../../core/meeting/stage3a/transcriptContracts.js';
import {
  MEETING_ANALYSIS_BUNDLE_SCHEMA_VERSION,
  revalidateMeetingAnalysisBundle
} from '../../../../core/meeting/stage4/meetingAnalysisBundleContracts.js';
import { resolveMeetingAnalysisSource } from '../components/meeting/meetingAnalysisSource.js';

export const MEETING_ANALYSIS_BUNDLE_STORE_NAME = 'analysisBundles';
export const MEETING_ANALYSIS_BUNDLE_STORAGE_SCHEMA_VERSION = 'meeting-analysis-bundle-storage-v1';

const AES_GCM = 'AES-GCM';
const NONCE_BYTES = 12;

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

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function bytes(value, code = 'ANALYSIS_CIPHERTEXT_INVALID') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw codedError(code);
}

function validateCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') throw codedError('WEB_CRYPTO_UNAVAILABLE');
}

function validateBackend(backend) {
  if (!backend || typeof backend.get !== 'function' || typeof backend.list !== 'function' || typeof backend.atomicWrite !== 'function' || typeof backend.atomicDelete !== 'function') {
    throw codedError('MEETING_BACKEND_REQUIRED');
  }
}

async function ownerHash(cryptoImpl, ownerId) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(`meeting-owner:${ownerId}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function rowId(hash, bundle) {
  return [hash, bundle.meetingId, bundle.analysisId, bundle.analysisRevision].join('\u0000');
}

function aad({ ownerId, meetingId, analysisId, analysisRevision, transcriptRevision }) {
  return new TextEncoder().encode(JSON.stringify([
    ['storageSchemaVersion', MEETING_ANALYSIS_BUNDLE_STORAGE_SCHEMA_VERSION],
    ['schemaVersion', MEETING_ANALYSIS_BUNDLE_SCHEMA_VERSION],
    ['ownerId', String(ownerId)],
    ['meetingId', String(meetingId)],
    ['analysisId', String(analysisId)],
    ['analysisRevision', Number(analysisRevision)],
    ['transcriptRevision', Number(transcriptRevision)]
  ]));
}

async function encryptJson(cryptoImpl, key, bundle) {
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await cryptoImpl.subtle.encrypt(
    { name: AES_GCM, iv: nonce, additionalData: aad(bundle) },
    key,
    new TextEncoder().encode(JSON.stringify(bundle))
  );
  return { nonce, ciphertext: new Uint8Array(ciphertext) };
}

async function decryptJson(cryptoImpl, key, row, contextValue) {
  try {
    const plaintext = await cryptoImpl.subtle.decrypt(
      { name: AES_GCM, iv: bytes(row.nonce), additionalData: aad({ ...row, ownerId: contextValue.ownerId }) },
      key,
      bytes(row.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error?.code === 'ANALYSIS_CIPHERTEXT_INVALID') throw error;
    throw codedError('ANALYSIS_CIPHERTEXT_INVALID', error);
  }
}

function assertNestedBinding(value, expected, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertNestedBinding(child, expected, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (Object.hasOwn(expected, key)) {
      const matches = ['sourceRevision', 'transcriptRevision'].includes(key)
        ? Number(child) === Number(expected[key])
        : child === expected[key];
      if (!matches) throw codedError(key === 'ownerId' ? 'OWNER_SCOPE_MISMATCH' : 'ANALYSIS_BINDING_MISMATCH');
    }
    assertNestedBinding(child, expected, seen);
  }
}

function assertPersistedBundle(bundle, contextValue, row = null) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw codedError('ANALYSIS_PAYLOAD_INVALID');
  if (bundle.schemaVersion !== MEETING_ANALYSIS_BUNDLE_SCHEMA_VERSION) throw codedError('ANALYSIS_SCHEMA_MISMATCH');
  if (bundle.ownerId !== contextValue.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (bundle.scope !== 'meeting') throw codedError('ANALYSIS_SCOPE_MISMATCH');
  if (bundle.status !== 'CURRENT' || bundle.groundingStatus !== 'GROUNDING_SUPPORTED') throw codedError('ANALYSIS_BUNDLE_NOT_PERSISTABLE');
  for (const field of ['analysisId', 'meetingId', 'sourceId', 'transcriptId', 'idempotencyKey', 'createdAt', 'updatedAt']) required(bundle[field], 'ANALYSIS_PAYLOAD_INVALID');
  for (const field of ['analysisRevision', 'sourceRevision', 'transcriptRevision', 'sourceTranscriptRevision']) {
    if (!Number.isSafeInteger(Number(bundle[field])) || Number(bundle[field]) < 1) throw codedError('ANALYSIS_PAYLOAD_INVALID');
  }
  if (bundle.sourceTranscriptRevision !== bundle.transcriptRevision) throw codedError('ANALYSIS_PAYLOAD_INVALID');
  if (!Array.isArray(bundle.decisions) || !Array.isArray(bundle.actionItems) || !Array.isArray(bundle.evidenceRefs)) throw codedError('ANALYSIS_PAYLOAD_INVALID');
  assertNestedBinding({ summary: bundle.summary, decisions: bundle.decisions, actionItems: bundle.actionItems, evidenceRefs: bundle.evidenceRefs }, {
    ownerId: contextValue.ownerId,
    scope: 'meeting',
    meetingId: bundle.meetingId,
    sourceId: bundle.sourceId,
    sourceRevision: bundle.sourceRevision,
    transcriptId: bundle.transcriptId,
    transcriptRevision: bundle.transcriptRevision
  });
  if (row) {
    if (row.schemaVersion !== MEETING_ANALYSIS_BUNDLE_STORAGE_SCHEMA_VERSION) throw codedError('ANALYSIS_SCHEMA_MISMATCH');
    if (row.ownerHash !== contextValue.ownerHash || row.meetingId !== bundle.meetingId || row.analysisId !== bundle.analysisId || Number(row.analysisRevision) !== Number(bundle.analysisRevision)) {
      throw codedError('ANALYSIS_ROW_SCOPE_MISMATCH');
    }
  }
  return bundle;
}

function normalizeCurrentContext(ownerContext, currentContext, bundle) {
  if (!currentContext) return null;
  // Revalidate the dependencies the saved evidence actually used. A later
  // speaker backfill must not invalidate quotes with no speaker attribution.
  const binds = (field) => Boolean(bundle[field] || bundle.evidenceRefs.some((ref) => ref[field]));
  return {
    ownerContext,
    source: resolveMeetingAnalysisSource(currentContext.source, currentContext.currentTranscriptRevision),
    currentTranscriptRevision: currentContext.currentTranscriptRevision,
    currentDiarizationRevision: binds('diarizationRevisionId') ? currentContext.currentDiarizationRevision : undefined,
    currentSpeakerCorrectionRevision: binds('speakerCorrectionRevisionId') ? currentContext.currentSpeakerCorrectionRevision : undefined
  };
}

function supersedeHistorical(values) {
  const current = values
    .filter((value) => value.status === 'CURRENT')
    .sort((left, right) => Number(right.analysisRevision) - Number(left.analysisRevision))[0];
  if (!current) return values;
  return values.map((value) => {
    if (value.status !== 'CURRENT') return value;
    if (Number(value.analysisRevision) >= Number(current.analysisRevision)) return value;
    if (value.sourceId !== current.sourceId || value.sourceRevision !== current.sourceRevision || value.transcriptRevision !== current.transcriptRevision) return value;
    return { ...value, status: 'SUPERSEDED' };
  });
}

export function createMeetingAnalysisBundleStore({
  cryptoImpl = globalThis.crypto,
  keyProvider,
  backend,
  now = () => new Date().toISOString()
} = {}) {
  validateCrypto(cryptoImpl);
  validateBackend(backend);
  if (!keyProvider || typeof keyProvider.withOwnerKey !== 'function') throw codedError('KEY_PROVIDER_REQUIRED');

  let writeQueue = Promise.resolve();

  function enqueueWrite(task) {
    const next = writeQueue.then(task);
    writeQueue = next.catch(() => {});
    return next;
  }

  async function context(ownerContext) {
    const trusted = assertOwnerContext(ownerContext);
    return Object.freeze({ ...trusted, ownerHash: await ownerHash(cryptoImpl, trusted.ownerId) });
  }

  async function readRow(contextValue, row) {
    if (!row || row.ownerHash !== contextValue.ownerHash) throw codedError('ANALYSIS_NOT_FOUND');
    return keyProvider.withOwnerKey(contextValue, async (key) => {
      const bundle = await decryptJson(cryptoImpl, key, row, contextValue);
      return clone(assertPersistedBundle(bundle, contextValue, row));
    });
  }

  async function rowsFor(contextValue, { meetingId, analysisId } = {}) {
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    return (await backend.list(MEETING_ANALYSIS_BUNDLE_STORE_NAME))
      .filter((row) => row.ownerHash === contextValue.ownerHash && row.meetingId === normalizedMeetingId && (!analysisId || row.analysisId === analysisId))
      .sort((left, right) => Number(right.analysisRevision) - Number(left.analysisRevision));
  }

  function projection(ownerContext, bundle, currentContext) {
    return revalidateMeetingAnalysisBundle(
      bundle,
      normalizeCurrentContext(ownerContext, currentContext, bundle) || { ownerContext }
    );
  }

  async function save(ownerContext, { bundle } = {}) {
    return enqueueWrite(async () => {
      const contextValue = await context(ownerContext);
      if (!bundle || bundle.ownerId !== contextValue.ownerId) throw codedError(bundle?.ownerId ? 'OWNER_SCOPE_MISMATCH' : 'ANALYSIS_BUNDLE_REQUIRED');
      assertPersistedBundle(bundle, contextValue);
      const id = rowId(contextValue.ownerHash, bundle);
      const matchingRows = await rowsFor(contextValue, { meetingId: bundle.meetingId });
      for (const row of matchingRows) {
        const existing = await readRow(contextValue, row);
        if (existing.idempotencyKey === bundle.idempotencyKey) {
          if (canonical(existing) === canonical(bundle)) return Object.freeze({ idempotent: true, bundle: clone(existing) });
          throw codedError('ANALYSIS_IDEMPOTENCY_CONFLICT');
        }
        if (existing.analysisId === bundle.analysisId && Number(existing.analysisRevision) === Number(bundle.analysisRevision)) {
          if (canonical(existing) === canonical(bundle)) return Object.freeze({ idempotent: true, bundle: clone(existing) });
          throw codedError('ANALYSIS_IDEMPOTENCY_CONFLICT');
        }
      }
      const existingRow = await backend.get(MEETING_ANALYSIS_BUNDLE_STORE_NAME, id);
      if (existingRow) throw codedError('ANALYSIS_IDEMPOTENCY_CONFLICT');
      const encrypted = await keyProvider.withOwnerKey(contextValue, (key) => encryptJson(cryptoImpl, key, bundle));
      const row = {
        id,
        ownerHash: contextValue.ownerHash,
        meetingId: bundle.meetingId,
        sourceId: bundle.sourceId,
        transcriptId: bundle.transcriptId,
        analysisId: bundle.analysisId,
        analysisRevision: bundle.analysisRevision,
        transcriptRevision: bundle.transcriptRevision,
        schemaVersion: MEETING_ANALYSIS_BUNDLE_STORAGE_SCHEMA_VERSION,
        entityType: 'meetingAnalysisBundle',
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        updatedAt: bundle.updatedAt
      };
      try {
        await backend.atomicWrite({ puts: [{ storeName: MEETING_ANALYSIS_BUNDLE_STORE_NAME, id, value: row }] });
      } catch (error) {
        throw codedError('ANALYSIS_ATOMIC_COMMIT_FAILED', error);
      }
      return Object.freeze({ idempotent: false, bundle: clone(bundle) });
    });
  }

  async function get(ownerContext, { meetingId, analysisId, analysisRevision, currentContext } = {}) {
    const contextValue = await context(ownerContext);
    const requestedAnalysisId = required(analysisId, 'ANALYSIS_ID_REQUIRED');
    const rows = await rowsFor(contextValue, { meetingId });
    const matchingRows = rows.filter((candidate) => candidate.analysisId === requestedAnalysisId);
    const row = analysisRevision === undefined
      ? matchingRows[0]
      : matchingRows.find((candidate) => Number(candidate.analysisRevision) === Number(analysisRevision));
    if (!row) throw codedError('ANALYSIS_NOT_FOUND');
    const values = await projectRows(contextValue, rows, currentContext);
    return values.find((value) => value.analysisId === requestedAnalysisId && (analysisRevision === undefined || Number(value.analysisRevision) === Number(analysisRevision)));
  }

  async function list(ownerContext, { meetingId, currentContext } = {}) {
    const contextValue = await context(ownerContext);
    const rows = await rowsFor(contextValue, { meetingId });
    return projectRows(contextValue, rows, currentContext);
  }

  async function projectRows(contextValue, rows, currentContext) {
    const bundles = [];
    for (const row of rows) bundles.push(projection(contextValue, await readRow(contextValue, row), currentContext));
    return supersedeHistorical(bundles);
  }

  async function getCurrent(ownerContext, { meetingId, currentContext } = {}) {
    const values = await list(ownerContext, { meetingId, currentContext });
    return values.find((value) => value.status === 'CURRENT') || null;
  }

  async function exportBundles(ownerContext, { meetingId, currentContext } = {}) {
    return list(ownerContext, { meetingId, currentContext });
  }

  async function remove(ownerContext, { meetingId, analysisId } = {}) {
    return enqueueWrite(async () => {
      const contextValue = await context(ownerContext);
      const rows = await rowsFor(contextValue, { meetingId, analysisId: required(analysisId, 'ANALYSIS_ID_REQUIRED') });
      if (!rows.length) return 0;
      try {
        await backend.atomicDelete(rows.map((row) => ({ storeName: MEETING_ANALYSIS_BUNDLE_STORE_NAME, id: row.id })));
      } catch (error) {
        throw codedError('ANALYSIS_ATOMIC_DELETE_FAILED', error);
      }
      return rows.length;
    });
  }

  return Object.freeze({
    save,
    get,
    list,
    getCurrent,
    exportBundles,
    delete: remove
  });
}
