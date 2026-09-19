import { BROWSER_KEY_DATABASE_NAME } from './browserKeyStore.js';
import { MEETING_PHASE1_DATABASE_NAME } from './browserMeetingStore.js';
import { createBrowserProductionKeyProvider } from './browserProductionKeyProvider.js';

const error = code => Object.assign(new Error(code), { code });
export const abortMeetingQuery = () => new DOMException('Meeting query cancelled', 'AbortError');
export function checkMeetingQuerySignal(signal) { if (signal?.aborted) throw abortMeetingQuery(); }

// Never supplies a version, creates an object store, enrolls a key, or opens a readwrite transaction.
async function openExisting(indexedDBImpl, name, signal) {
  checkMeetingQuerySignal(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let missing = false;
    const finish = (err, db) => {
      if (settled) { db?.close(); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (err) reject(err); else resolve(db);
    };
    const cancel = () => finish(abortMeetingQuery());
    const timer = setTimeout(() => finish(error('MEETING_QUERY_STORAGE_TIMEOUT')), 5000);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const request = indexedDBImpl.open(name);
      request.onupgradeneeded = () => { missing = true; request.transaction.abort(); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); finish(null, db); };
      request.onerror = () => finish(error(missing ? 'MEETING_QUERY_DATABASE_MISSING' : 'MEETING_QUERY_STORAGE_UNAVAILABLE'));
      request.onblocked = () => finish(error('MEETING_QUERY_STORAGE_BLOCKED'));
    } catch (err) { finish(err); }
  });
}
function read(db, storeName, method, key, signal) {
  checkMeetingQuerySignal(signal);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName)[method](...(key === undefined ? [] : [key]));
      let value;
      const cancel = () => { try { tx.abort(); } catch { /* Transaction already closed. */ } };
      signal?.addEventListener('abort', cancel, { once: true });
      const done = () => signal?.removeEventListener('abort', cancel);
      request.onsuccess = () => { value = request.result; };
      request.onerror = () => { /* Transaction failure is authoritative. */ };
      tx.oncomplete = () => { done(); if (signal?.aborted) reject(abortMeetingQuery()); else resolve(value); };
      tx.onabort = tx.onerror = () => { done(); reject(signal?.aborted ? abortMeetingQuery() : error('MEETING_QUERY_READ_FAILED')); };
    } catch (err) { reject(err); }
  });
}
export async function openMeetingQueryReader({ indexedDBImpl = globalThis.indexedDB, cryptoImpl = globalThis.crypto,
  signal, meetingDatabaseName = MEETING_PHASE1_DATABASE_NAME, keyDatabaseName = BROWSER_KEY_DATABASE_NAME } = {}) {
  if (!indexedDBImpl?.open || !cryptoImpl?.subtle) throw error('MEETING_QUERY_STORAGE_UNAVAILABLE');
  let meetingDb;
  let keyDb;
  try {
    try { meetingDb = await openExisting(indexedDBImpl, meetingDatabaseName, signal); }
    catch (err) { if (err.code === 'MEETING_QUERY_DATABASE_MISSING') return { empty: true, close() {} }; throw err; }
    keyDb = await openExisting(indexedDBImpl, keyDatabaseName, signal);
    const metadata = await read(keyDb, 'metadata', 'get', 'device-binding', signal);
    if (!metadata?.deviceBindingId) throw error('DEVICE_BINDING_UNAVAILABLE');
    const storage = Object.freeze({ listKeys: () => read(keyDb, 'keys', 'getAll', undefined, signal) });
    const keyProvider = createBrowserProductionKeyProvider({ cryptoImpl, storage, deviceBindingId: metadata.deviceBindingId,
      // Same accepted browser provider contract. Reads use the already persisted key only.
      validationOnly: true, capabilities: { productionReady: false, capabilities: {
        webCryptoAesGcm: Boolean(cryptoImpl.subtle), nonExportableKeyHandle: true, indexedDb: true, persistentCryptoKey: true
      } } });
    const allowed = new Set(['meetings', 'transcriptDocuments', 'transcriptRevisions', 'analysisBundles']);
    const assertStore = name => { if (!allowed.has(name)) throw error('MEETING_QUERY_READ_SCOPE'); };
    const denyWrite = () => { throw error('MEETING_QUERY_READ_ONLY'); };
    const backend = Object.freeze({
      get(name, key) { assertStore(name); return read(meetingDb, name, 'get', key, signal); },
      list(name) { assertStore(name); return read(meetingDb, name, 'getAll', undefined, signal); },
      atomicPut: denyWrite, atomicWrite: denyWrite, atomicDelete: denyWrite
    });
    return { backend, keyProvider, cryptoImpl, close() { meetingDb.close(); keyDb.close(); } };
  } catch (err) { meetingDb?.close(); keyDb?.close(); throw err; }
}
