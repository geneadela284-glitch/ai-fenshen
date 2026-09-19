export const MEETING_SPEAKER_CORRECTION_DATABASE_NAME = 'ai-fenshen-meeting-speaker-management-v1';
export const MEETING_SPEAKER_CORRECTION_DATABASE_VERSION = 1;
export const MEETING_SPEAKER_CORRECTION_STORES = Object.freeze([
  'speakerCorrectionDocuments',
  'speakerCorrectionRevisions'
]);

export const MEETING_SPEAKER_CORRECTION_INDEXES = Object.freeze({
  speakerCorrectionDocuments: Object.freeze({
    byOwnerDocument: Object.freeze({
      keyPath: Object.freeze(['ownerHash', 'spaceHash', 'documentLocator']),
      unique: true
    })
  }),
  speakerCorrectionRevisions: Object.freeze({
    byOwnerDocument: Object.freeze({
      keyPath: Object.freeze(['ownerHash', 'spaceHash', 'documentLocator']),
      unique: false
    }),
    byOwnerDocumentRevision: Object.freeze({
      keyPath: Object.freeze(['ownerHash', 'spaceHash', 'documentLocator', 'correctionRevision']),
      unique: true
    }),
    byOwnerMutation: Object.freeze({
      keyPath: Object.freeze(['ownerHash', 'spaceHash', 'mutationLocator']),
      unique: true
    }),
    byOwnerDocumentFingerprint: Object.freeze({
      keyPath: Object.freeze(['ownerHash', 'spaceHash', 'documentLocator', 'requestFingerprint']),
      unique: true
    })
  })
});

const DOCUMENT_ROW_KEYS = Object.freeze([
  'id', 'ownerHash', 'spaceHash', 'documentLocator', 'bindingFingerprint',
  'transcriptRevision', 'baseDiarizationRevision', 'headCorrectionRevision',
  'headRevisionLocator', 'headCorrectionIdHash', 'keyVersion', 'nonce', 'ciphertext'
]);
const REVISION_ROW_KEYS = Object.freeze([
  'id', 'ownerHash', 'spaceHash', 'documentLocator', 'bindingFingerprint',
  'transcriptRevision', 'baseDiarizationRevision', 'correctionRevision',
  'parentRevisionLocator', 'correctionIdHash', 'parentCorrectionIdHash',
  'mutationLocator', 'requestFingerprint', 'keyVersion', 'nonce', 'ciphertext'
]);
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
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

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw codedError(code);
  return number;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw codedError(code);
  return number;
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hash(value, code) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw codedError(code);
  return value;
}

function byteLength(value) {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return -1;
}

function validateDocumentRow(row) {
  if (!exactKeys(row, DOCUMENT_ROW_KEYS)) throw codedError('SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID');
  for (const field of ['id', 'ownerHash', 'spaceHash', 'documentLocator', 'bindingFingerprint', 'headRevisionLocator', 'headCorrectionIdHash']) {
    hash(row[field], 'SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID');
  }
  positiveInteger(row.transcriptRevision, 'SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID');
  positiveInteger(row.baseDiarizationRevision, 'SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID');
  positiveInteger(row.headCorrectionRevision, 'SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID');
  positiveInteger(row.keyVersion, 'SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID');
  if (byteLength(row.nonce) !== 12 || byteLength(row.ciphertext) < 1) throw codedError('SPEAKER_CORRECTION_DOCUMENT_ROW_INVALID');
}

function validateRevisionRow(row) {
  if (!exactKeys(row, REVISION_ROW_KEYS)) throw codedError('SPEAKER_CORRECTION_REVISION_ROW_INVALID');
  for (const field of ['id', 'ownerHash', 'spaceHash', 'documentLocator', 'bindingFingerprint', 'correctionIdHash', 'mutationLocator', 'requestFingerprint']) {
    hash(row[field], 'SPEAKER_CORRECTION_REVISION_ROW_INVALID');
  }
  positiveInteger(row.transcriptRevision, 'SPEAKER_CORRECTION_REVISION_ROW_INVALID');
  positiveInteger(row.baseDiarizationRevision, 'SPEAKER_CORRECTION_REVISION_ROW_INVALID');
  const correctionRevision = positiveInteger(row.correctionRevision, 'SPEAKER_CORRECTION_REVISION_ROW_INVALID');
  positiveInteger(row.keyVersion, 'SPEAKER_CORRECTION_REVISION_ROW_INVALID');
  if (correctionRevision === 1) {
    if (row.parentRevisionLocator !== '' || row.parentCorrectionIdHash !== '') throw codedError('SPEAKER_CORRECTION_REVISION_ROW_INVALID');
  } else {
    hash(row.parentRevisionLocator, 'SPEAKER_CORRECTION_REVISION_ROW_INVALID');
    hash(row.parentCorrectionIdHash, 'SPEAKER_CORRECTION_REVISION_ROW_INVALID');
  }
  if (byteLength(row.nonce) !== 12 || byteLength(row.ciphertext) < 1) throw codedError('SPEAKER_CORRECTION_REVISION_ROW_INVALID');
}

function storeName(value) {
  if (!MEETING_SPEAKER_CORRECTION_STORES.includes(value)) throw codedError('SPEAKER_CORRECTION_STORE_INVALID');
  return value;
}

function schema() {
  return Object.freeze({
    name: MEETING_SPEAKER_CORRECTION_DATABASE_NAME,
    version: MEETING_SPEAKER_CORRECTION_DATABASE_VERSION,
    stores: MEETING_SPEAKER_CORRECTION_STORES,
    indexes: MEETING_SPEAKER_CORRECTION_INDEXES
  });
}

function normalizeCommit(input = {}) {
  const ownerHash = required(input.ownerHash, 'SPEAKER_CORRECTION_OWNER_LOCATOR_REQUIRED');
  const spaceHash = required(input.spaceHash, 'SPEAKER_CORRECTION_SPACE_LOCATOR_REQUIRED');
  const documentLocator = required(input.documentLocator, 'SPEAKER_CORRECTION_DOCUMENT_LOCATOR_REQUIRED');
  const bindingFingerprint = required(input.bindingFingerprint, 'SPEAKER_CORRECTION_BINDING_FINGERPRINT_REQUIRED');
  const expectedCorrectionRevision = nonNegativeInteger(input.expectedCorrectionRevision, 'SPEAKER_CORRECTION_EXPECTED_REVISION_INVALID');
  const documentRow = clone(input.documentRow);
  const revisionRow = clone(input.revisionRow);
  if (!documentRow || !revisionRow) throw codedError('SPEAKER_CORRECTION_COMMIT_INVALID');
  validateDocumentRow(documentRow);
  validateRevisionRow(revisionRow);
  const nextRevision = expectedCorrectionRevision + 1;
  const commonMatches = (row) => row.ownerHash === ownerHash
    && row.spaceHash === spaceHash
    && row.documentLocator === documentLocator
    && row.bindingFingerprint === bindingFingerprint;
  if (!commonMatches(documentRow) || !commonMatches(revisionRow)
      || documentRow.id !== documentLocator
      || documentRow.headCorrectionRevision !== nextRevision
      || revisionRow.correctionRevision !== nextRevision
      || documentRow.headRevisionLocator !== revisionRow.id
      || documentRow.headCorrectionIdHash !== revisionRow.correctionIdHash
      || !revisionRow.mutationLocator || !revisionRow.requestFingerprint) {
    throw codedError('SPEAKER_CORRECTION_COMMIT_INVALID');
  }
  return Object.freeze({
    ownerHash,
    spaceHash,
    documentLocator,
    bindingFingerprint,
    expectedCorrectionRevision,
    documentRow,
    revisionRow
  });
}

function sameScope(row, input) {
  return row?.ownerHash === input.ownerHash
    && row?.spaceHash === input.spaceHash
    && row?.documentLocator === input.documentLocator;
}

function inspectCommit({ currentDocument, existingMutation, existingFingerprint, existingRevision, input }) {
  if (existingMutation) {
    if (sameScope(existingMutation, input)
        && existingMutation.requestFingerprint === input.revisionRow.requestFingerprint
        && existingMutation.bindingFingerprint === input.bindingFingerprint) {
      return Object.freeze({ status: 'replay', revisionRow: clone(existingMutation) });
    }
    throw codedError('SPEAKER_CORRECTION_MUTATION_REQUEST_CONFLICT');
  }
  if (existingFingerprint) throw codedError('SPEAKER_CORRECTION_FINGERPRINT_CONFLICT');
  if (input.expectedCorrectionRevision === 0) {
    if (currentDocument) throw codedError('SPEAKER_CORRECTION_CAS_CONFLICT');
  } else if (!currentDocument
      || !sameScope(currentDocument, input)
      || currentDocument.bindingFingerprint !== input.bindingFingerprint
      || currentDocument.headCorrectionRevision !== input.expectedCorrectionRevision
      || currentDocument.headRevisionLocator !== input.revisionRow.parentRevisionLocator
      || currentDocument.headCorrectionIdHash !== input.revisionRow.parentCorrectionIdHash) {
    throw codedError('SPEAKER_CORRECTION_CAS_CONFLICT');
  }
  if (existingRevision) throw codedError('SPEAKER_CORRECTION_REVISION_EXISTS');
  return null;
}

function createMemoryState() {
  return {
    stores: Object.fromEntries(MEETING_SPEAKER_CORRECTION_STORES.map((name) => [name, new Map()])),
    queue: Promise.resolve(),
    nextFailure: null
  };
}

export function createMemoryMeetingSpeakerCorrectionBackend({ sharedState = createMemoryState() } = {}) {
  function rows(name) {
    return sharedState.stores[storeName(name)];
  }

  async function get(name, id) {
    return clone(rows(name).get(id) ?? null);
  }

  async function list(name) {
    return [...rows(name).values()].map(clone);
  }

  async function getDocument(scope) {
    return get('speakerCorrectionDocuments', required(scope?.documentLocator, 'SPEAKER_CORRECTION_DOCUMENT_LOCATOR_REQUIRED'));
  }

  async function getRevisionByNumber(scope) {
    const revision = nonNegativeInteger(scope?.correctionRevision, 'SPEAKER_CORRECTION_REVISION_INVALID');
    return clone([...rows('speakerCorrectionRevisions').values()].find((row) => sameScope(row, scope) && row.correctionRevision === revision) ?? null);
  }

  async function listRevisions(scope) {
    return [...rows('speakerCorrectionRevisions').values()]
      .filter((row) => sameScope(row, scope))
      .sort((left, right) => left.correctionRevision - right.correctionRevision)
      .map(clone);
  }

  function commitRevision(rawInput) {
    const task = sharedState.queue.then(() => {
      const input = normalizeCommit(rawInput);
      const documents = rows('speakerCorrectionDocuments');
      const revisions = rows('speakerCorrectionRevisions');
      const currentDocument = documents.get(input.documentLocator) ?? null;
      const existingMutation = [...revisions.values()].find((row) => row.ownerHash === input.ownerHash
        && row.spaceHash === input.spaceHash
        && row.mutationLocator === input.revisionRow.mutationLocator) ?? null;
      const existingFingerprint = [...revisions.values()].find((row) => sameScope(row, input)
        && row.requestFingerprint === input.revisionRow.requestFingerprint) ?? null;
      const existingRevision = revisions.get(input.revisionRow.id)
        ?? [...revisions.values()].find((row) => sameScope(row, input)
          && row.correctionRevision === input.revisionRow.correctionRevision)
        ?? null;
      const replay = inspectCommit({ currentDocument, existingMutation, existingFingerprint, existingRevision, input });
      if (replay) return replay;

      const nextDocuments = new Map(documents);
      const nextRevisions = new Map(revisions);
      nextRevisions.set(input.revisionRow.id, clone(input.revisionRow));
      if (sharedState.nextFailure?.at === 'afterRevisionAdd') {
        const failure = sharedState.nextFailure.error;
        sharedState.nextFailure = null;
        throw failure;
      }
      nextDocuments.set(input.documentLocator, clone(input.documentRow));
      if (sharedState.nextFailure) {
        const failure = sharedState.nextFailure.error;
        sharedState.nextFailure = null;
        throw failure;
      }
      sharedState.stores = {
        ...sharedState.stores,
        speakerCorrectionDocuments: nextDocuments,
        speakerCorrectionRevisions: nextRevisions
      };
      return Object.freeze({ status: 'committed', revisionRow: clone(input.revisionRow) });
    });
    sharedState.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  return Object.freeze({
    schema,
    get,
    list,
    getDocument,
    getRevisionByNumber,
    listRevisions,
    commitRevision,
    failNextCommit(error = codedError('SIMULATED_ATOMIC_FAILURE'), { at = 'beforeCommit' } = {}) {
      sharedState.nextFailure = { error, at };
    },
    replace(name, id, value) {
      rows(name).set(id, clone(value));
    },
    deleteDirect(name, id) {
      return rows(name).delete(id);
    },
    dump() {
      return Object.fromEntries(MEETING_SPEAKER_CORRECTION_STORES.map((name) => [name, [...rows(name).values()].map(clone)]));
    },
    reopen() {
      return createMemoryMeetingSpeakerCorrectionBackend({ sharedState });
    },
    close() {}
  });
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error || codedError('SPEAKER_CORRECTION_IDB_REQUEST_FAILED'));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || codedError('SPEAKER_CORRECTION_IDB_TRANSACTION_FAILED'));
    transaction.onabort = () => reject(transaction.error || codedError('SPEAKER_CORRECTION_IDB_TRANSACTION_ABORTED'));
  });
}

function abort(transaction) {
  try { transaction.abort(); } catch {}
}

function indexKey(scope, suffix = []) {
  return [scope.ownerHash, scope.spaceHash, ...suffix];
}

function sameStringArray(left, right) {
  return JSON.stringify(Array.from(left || [])) === JSON.stringify(Array.from(right || []));
}

function assertDatabaseSchema(database) {
  const actualStores = Array.from(database.objectStoreNames || []).sort();
  const expectedStores = [...MEETING_SPEAKER_CORRECTION_STORES].sort();
  if (!sameStringArray(actualStores, expectedStores)) throw codedError('SPEAKER_CORRECTION_IDB_SCHEMA_INVALID');
  let transaction;
  try {
    transaction = database.transaction(MEETING_SPEAKER_CORRECTION_STORES, 'readonly');
    for (const name of MEETING_SPEAKER_CORRECTION_STORES) {
      const objectStore = transaction.objectStore(name);
      if (objectStore.keyPath !== 'id' || objectStore.autoIncrement === true) {
        throw codedError('SPEAKER_CORRECTION_IDB_SCHEMA_INVALID');
      }
      const expectedIndexes = MEETING_SPEAKER_CORRECTION_INDEXES[name];
      const actualIndexNames = Array.from(objectStore.indexNames || []).sort();
      if (!sameStringArray(actualIndexNames, Object.keys(expectedIndexes).sort())) {
        throw codedError('SPEAKER_CORRECTION_IDB_SCHEMA_INVALID');
      }
      for (const [indexName, definition] of Object.entries(expectedIndexes)) {
        const index = objectStore.index(indexName);
        if (!sameStringArray(index.keyPath, definition.keyPath) || index.unique !== definition.unique) {
          throw codedError('SPEAKER_CORRECTION_IDB_SCHEMA_INVALID');
        }
      }
    }
  } catch (error) {
    try { transaction?.abort(); } catch {}
    if (error?.code === 'SPEAKER_CORRECTION_IDB_SCHEMA_INVALID') throw error;
    throw codedError('SPEAKER_CORRECTION_IDB_SCHEMA_INVALID', error);
  }
}

async function readTransaction(transaction, operation) {
  const completed = transactionPromise(transaction);
  try {
    const value = await operation();
    await completed;
    return value;
  } catch (error) {
    abort(transaction);
    await completed.catch(() => {});
    if (String(error?.code || '').startsWith('SPEAKER_CORRECTION_')) throw error;
    throw codedError('SPEAKER_CORRECTION_IDB_READ_FAILED', error);
  }
}

async function databaseRead(database, stores, operation) {
  let transaction;
  try {
    transaction = database.transaction(stores, 'readonly');
  } catch (error) {
    throw codedError('SPEAKER_CORRECTION_IDB_READ_FAILED', error);
  }
  return readTransaction(transaction, () => operation(transaction));
}

export function createIndexedDbMeetingSpeakerCorrectionBackend({
  indexedDBImpl = globalThis.indexedDB,
  databaseName = MEETING_SPEAKER_CORRECTION_DATABASE_NAME,
  faultInjector = null
} = {}) {
  let databasePromise = null;
  let openedDatabase = null;

  function open() {
    if (!indexedDBImpl?.open) return Promise.reject(codedError('INDEXEDDB_UNAVAILABLE'));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBImpl.open(databaseName, MEETING_SPEAKER_CORRECTION_DATABASE_VERSION);
        let blocked = false;
        request.onupgradeneeded = () => {
          const database = request.result;
          for (const name of MEETING_SPEAKER_CORRECTION_STORES) {
            const objectStore = database.objectStoreNames.contains(name)
              ? request.transaction.objectStore(name)
              : database.createObjectStore(name, { keyPath: 'id' });
            for (const [indexName, definition] of Object.entries(MEETING_SPEAKER_CORRECTION_INDEXES[name])) {
              if (!objectStore.indexNames.contains(indexName)) {
                objectStore.createIndex(indexName, [...definition.keyPath], { unique: definition.unique });
              }
            }
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          if (blocked) {
            database.close();
            return;
          }
          try {
            assertDatabaseSchema(database);
          } catch (error) {
            database.close();
            reject(error);
            return;
          }
          openedDatabase = database;
          openedDatabase.onversionchange = () => {
            openedDatabase?.close();
            openedDatabase = null;
            databasePromise = null;
          };
          resolve(request.result);
        };
        request.onerror = () => reject(codedError('SPEAKER_CORRECTION_IDB_OPEN_FAILED', request.error));
        request.onblocked = () => {
          blocked = true;
          reject(codedError('SPEAKER_CORRECTION_IDB_BLOCKED'));
        };
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  }

  async function get(name, id) {
    const database = await open();
    const normalizedName = storeName(name);
    const value = await databaseRead(database, normalizedName, (transaction) => (
      requestPromise(transaction.objectStore(normalizedName).get(id))
    ));
    return value ? clone(value) : null;
  }

  async function list(name) {
    const database = await open();
    const normalizedName = storeName(name);
    const values = await databaseRead(database, normalizedName, (transaction) => (
      requestPromise(transaction.objectStore(normalizedName).getAll())
    ));
    return (values || []).map(clone);
  }

  async function getDocument(scope) {
    return get('speakerCorrectionDocuments', required(scope?.documentLocator, 'SPEAKER_CORRECTION_DOCUMENT_LOCATOR_REQUIRED'));
  }

  async function getRevisionByNumber(scope) {
    const database = await open();
    const value = await databaseRead(database, 'speakerCorrectionRevisions', (transaction) => {
      const index = transaction.objectStore('speakerCorrectionRevisions').index('byOwnerDocumentRevision');
      return requestPromise(index.get(indexKey(scope, [scope.documentLocator, Number(scope.correctionRevision)])));
    });
    return value ? clone(value) : null;
  }

  async function listRevisions(scope) {
    const values = await list('speakerCorrectionRevisions');
    return values.filter((row) => sameScope(row, scope)).sort((left, right) => left.correctionRevision - right.correctionRevision);
  }

  async function commitRevision(rawInput) {
    const input = normalizeCommit(rawInput);
    const database = await open();
    let transaction = null;
    let completed = null;
    try {
      transaction = database.transaction(MEETING_SPEAKER_CORRECTION_STORES, 'readwrite');
      completed = transactionPromise(transaction);
      const documents = transaction.objectStore('speakerCorrectionDocuments');
      const revisions = transaction.objectStore('speakerCorrectionRevisions');
      const [currentDocument, existingMutation, existingFingerprint, existingRevision] = await Promise.all([
        requestPromise(documents.get(input.documentLocator)),
        requestPromise(revisions.index('byOwnerMutation').get(indexKey(input, [input.revisionRow.mutationLocator]))),
        requestPromise(revisions.index('byOwnerDocumentFingerprint').get(indexKey(input, [input.documentLocator, input.revisionRow.requestFingerprint]))),
        requestPromise(revisions.index('byOwnerDocumentRevision').get(indexKey(input, [input.documentLocator, input.revisionRow.correctionRevision])))
      ]);
      const replay = inspectCommit({ currentDocument, existingMutation, existingFingerprint, existingRevision, input });
      if (replay) {
        await completed;
        return replay;
      }
      revisions.add(clone(input.revisionRow));
      if (typeof faultInjector === 'function') faultInjector({ at: 'afterRevisionAdd', input: clone(input) });
      documents.put(clone(input.documentRow));
      await completed;
      return Object.freeze({ status: 'committed', revisionRow: clone(input.revisionRow) });
    } catch (error) {
      if (transaction) abort(transaction);
      await completed?.catch(() => {});
      if (String(error?.code || '').startsWith('SPEAKER_CORRECTION_')) throw error;
      if (error?.name === 'ConstraintError') throw codedError('SPEAKER_CORRECTION_APPEND_CONFLICT', error);
      throw codedError('SPEAKER_CORRECTION_COMMIT_FAILED', error);
    }
  }

  function close() {
    openedDatabase?.close();
    openedDatabase = null;
    databasePromise = null;
  }

  return Object.freeze({
    schema,
    open,
    get,
    list,
    getDocument,
    getRevisionByNumber,
    listRevisions,
    commitRevision,
    close,
    reopen() {
      close();
      return createIndexedDbMeetingSpeakerCorrectionBackend({ indexedDBImpl, databaseName, faultInjector });
    }
  });
}
