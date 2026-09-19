const TRACE_DATABASE_NAME = 'ai-secretary-meeting-checkpoint-trace-v1';
const TRACE_STORE_NAME = 'checkpointTraces';
const TRACE_ENDPOINT = '/api/meeting/transcription/diagnostic';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function traceId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return `checkpoint-trace-${cryptoImpl.randomUUID()}`;
  return `checkpoint-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function safeEvent(event = {}) {
  const blocked = new Set([
    'blob',
    'data',
    'audioBytes',
    'bytes',
    'ciphertext',
    'key',
    'nonce',
    'samples'
  ]);
  const copy = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (blocked.has(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      copy[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const scalars = value.slice(0, 64).filter((item) => (
        item === null || ['string', 'number', 'boolean'].includes(typeof item)
      ));
      if (scalars.length === value.length) copy[key] = scalars;
    }
  }
  return Object.freeze(copy);
}

function createIndexedDbStorage({ indexedDBImpl = globalThis.indexedDB, databaseName = TRACE_DATABASE_NAME } = {}) {
  if (!indexedDBImpl?.open) return null;
  let databasePromise;
  function open() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBImpl.open(databaseName, 1);
        request.onerror = () => reject(codedError('CHECKPOINT_TRACE_IDB_OPEN_FAILED', request.error));
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(TRACE_STORE_NAME)) {
            request.result.createObjectStore(TRACE_STORE_NAME, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
      });
    }
    return databasePromise;
  }
  async function put(row) {
    const database = await open();
    await new Promise((resolve, reject) => {
      const request = database.transaction(TRACE_STORE_NAME, 'readwrite').objectStore(TRACE_STORE_NAME).put(row);
      request.onerror = () => reject(codedError('CHECKPOINT_TRACE_IDB_WRITE_FAILED', request.error));
      request.onsuccess = resolve;
    });
  }
  async function listPending() {
    const database = await open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(TRACE_STORE_NAME, 'readonly').objectStore(TRACE_STORE_NAME).getAll();
      request.onerror = () => reject(codedError('CHECKPOINT_TRACE_IDB_READ_FAILED', request.error));
      request.onsuccess = () => resolve((request.result || []).filter((row) => row.status === 'pending'));
    });
  }
  return Object.freeze({ put, listPending });
}

export function createMemoryCheckpointTraceStorage() {
  const rows = new Map();
  const clone = (value) => (typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)));
  return Object.freeze({
    rows,
    async put(row) { rows.set(row.id, clone(row)); },
    async listPending() { return [...rows.values()].filter((row) => row.status === 'pending'); }
  });
}

export function createMeetingRecordingCheckpointTraceClient({
  indexedDBImpl = globalThis.indexedDB,
  storage = createIndexedDbStorage({ indexedDBImpl }),
  fetchImpl = globalThis.fetch,
  endpoint = TRACE_ENDPOINT,
  cryptoImpl = globalThis.crypto,
  now = () => new Date().toISOString()
} = {}) {
  async function persist(row) {
    if (!storage?.put) return false;
    try {
      await storage.put(row);
      return true;
    } catch {
      return false;
    }
  }

  async function upload(row) {
    if (typeof fetchImpl !== 'function') return false;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...row.payload,
          phase: 'recording_checkpoint',
          traceId: row.id
        })
      });
      const result = await response?.json?.().catch(() => null);
      return response?.ok === true && result?.ok === true;
    } catch {
      return false;
    }
  }

  async function record(event = {}) {
    const id = traceId(cryptoImpl);
    const payload = safeEvent({ ...event, traceId: id, timestamp: event.timestamp || now() });
    const row = Object.freeze({ id, status: 'pending', payload, savedAt: now() });
    const persisted = await persist(row);
    if (!persisted) return Object.freeze({ ok: false, traceId: id, errorCode: 'CHECKPOINT_TRACE_LOCAL_PERSIST_FAILED' });
    const uploaded = await upload(row);
    if (uploaded) await persist(Object.freeze({ ...row, status: 'acknowledged', acknowledgedAt: now() }));
    return Object.freeze({ ok: uploaded, traceId: id, pending: !uploaded });
  }

  async function flushPending() {
    if (!storage?.listPending) return 0;
    let rows;
    try { rows = await storage.listPending(); } catch { return 0; }
    let count = 0;
    for (const row of rows) {
      if (await upload(row)) {
        await persist(Object.freeze({ ...row, status: 'acknowledged', acknowledgedAt: now() }));
        count += 1;
      }
    }
    return count;
  }

  return Object.freeze({ record, flushPending });
}

export { TRACE_DATABASE_NAME, TRACE_ENDPOINT, TRACE_STORE_NAME, safeEvent };
