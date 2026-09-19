import { SAFARI_VALIDATION_EVIDENCE_FIELDS } from './browserSafariValidationEvidence.js';

export const BROWSER_KEY_STORAGE_SCHEMA_VERSION = 'browser-key-storage-v1';
export const BROWSER_KEY_DATABASE_NAME = 'ai-secretary-production-key-provider-v1';
const DEVICE_METADATA_ID = 'device-binding';
const VALIDATION_FIXTURE_ID = 'validation-fixture';
const VALIDATION_LIFECYCLE_ID = 'validation-lifecycle';
const VALIDATION_EVIDENCE_ID = 'validation-evidence';
const RECOVERY_USE_PREFIX = 'recovery-use:';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || codedError('INDEXEDDB_REQUEST_FAILED'));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || codedError('INDEXEDDB_TRANSACTION_FAILED'));
    transaction.onabort = () => reject(transaction.error || codedError('INDEXEDDB_TRANSACTION_ABORTED'));
  });
}

function recordId(ownerHash, spaceId, keyVersion) {
  return `${ownerHash}\u0000${spaceId}\u0000${keyVersion}`;
}

function safeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw codedError('KEY_RECORD_INVALID');
  if (record.kind === 'capability-probe') {
    if (!record.recordId || !record.cryptoKey || record.cryptoKey.extractable !== false) throw codedError('KEY_RECORD_INVALID');
    return Object.freeze({ ...record, schemaVersion: BROWSER_KEY_STORAGE_SCHEMA_VERSION });
  }
  if (!record.recordId || !record.ownerHash || !record.spaceId || !record.keyId || !record.deviceKey ||
      !record.deviceWrappedOwnerDek || !record.deviceNonce || !record.deviceAad) throw codedError('KEY_RECORD_INVALID');
  if (record.deviceKey.extractable !== false) throw codedError('DEVICE_KEK_EXPORTABLE');
  if (record.cryptoKey || record.ownerDek || record.ownerDekBytes || record.recoverySecret) throw codedError('KEY_RECORD_CLEAR_KEY_MATERIAL');
  return Object.freeze({ ...record, schemaVersion: BROWSER_KEY_STORAGE_SCHEMA_VERSION });
}

function safeDeviceMetadata(record) {
  if (!record || typeof record !== 'object' || record.metadataId !== DEVICE_METADATA_ID || !record.deviceBindingId) {
    throw codedError('DEVICE_METADATA_INVALID');
  }
  return Object.freeze({ metadataId: DEVICE_METADATA_ID, deviceBindingId: String(record.deviceBindingId) });
}

function safeValidationFixture(record) {
  if (!record || typeof record !== 'object' || record.metadataId !== VALIDATION_FIXTURE_ID ||
      !record.nonce || !record.ciphertext || !record.aad || record.plaintext || record.rawKeyIncluded === true) {
    throw codedError('VALIDATION_FIXTURE_INVALID');
  }
  return Object.freeze({
    metadataId: VALIDATION_FIXTURE_ID,
    schemaVersion: String(record.schemaVersion || BROWSER_KEY_STORAGE_SCHEMA_VERSION),
    nonce: new Uint8Array(record.nonce),
    ciphertext: new Uint8Array(record.ciphertext),
    aad: String(record.aad),
    rawKeyIncluded: false
  });
}

function safeLifecycleEvidence(record) {
  if (!record || typeof record !== 'object' || record.metadataId !== VALIDATION_LIFECYCLE_ID) throw codedError('VALIDATION_LIFECYCLE_INVALID');
  return Object.freeze({
    metadataId: VALIDATION_LIFECYCLE_ID,
    pageRefreshVerified: record.pageRefreshVerified === true,
    browserRestartVerified: record.browserRestartVerified === true,
    deviceRestartVerified: record.deviceRestartVerified === true,
    pageLoadMarker: String(record.pageLoadMarker || ''),
    updatedAt: String(record.updatedAt || '')
  });
}

function safeValidationEvidence(record) {
  if (!record || typeof record !== 'object' || record.metadataId !== VALIDATION_EVIDENCE_ID) throw codedError('VALIDATION_EVIDENCE_INVALID');
  return Object.freeze({
    metadataId: VALIDATION_EVIDENCE_ID,
    ...Object.fromEntries(SAFARI_VALIDATION_EVIDENCE_FIELDS.map((field) => [field, record[field] === true])),
    updatedAt: String(record.updatedAt || '')
  });
}

function recoveryUseMetadataId(credentialId) {
  return `${RECOVERY_USE_PREFIX}${String(credentialId || '').trim()}`;
}

function safeRecoveryCredentialUse(record) {
  if (!record || typeof record !== 'object' || !record.credentialId || !record.ownerHash || !record.usedAt ||
      record.metadataId !== recoveryUseMetadataId(record.credentialId)) {
    throw codedError('RECOVERY_CREDENTIAL_USE_INVALID');
  }
  return Object.freeze({
    metadataId: record.metadataId,
    credentialId: String(record.credentialId),
    ownerHash: String(record.ownerHash),
    usedAt: String(record.usedAt)
  });
}

export function createIndexedDbKeyStorage({
  indexedDBImpl = globalThis.indexedDB,
  databaseName = BROWSER_KEY_DATABASE_NAME,
  navigatorImpl = globalThis.navigator,
  now = () => new Date().toISOString()
} = {}) {
  let databasePromise = null;

  function openDatabase() {
    if (!indexedDBImpl?.open) throw codedError('INDEXEDDB_UNAVAILABLE');
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBImpl.open(databaseName, 2);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('keys')) request.result.createObjectStore('keys', { keyPath: 'recordId' });
          if (!request.result.objectStoreNames.contains('metadata')) request.result.createObjectStore('metadata', { keyPath: 'metadataId' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || codedError('INDEXEDDB_OPEN_FAILED'));
        request.onblocked = () => reject(codedError('INDEXEDDB_BLOCKED'));
      });
    }
    return databasePromise;
  }

  async function allRecords() {
    const database = await openDatabase();
    const transaction = database.transaction('keys', 'readonly');
    const completed = transactionPromise(transaction);
    const records = await requestPromise(transaction.objectStore('keys').getAll());
    await completed;
    return records;
  }

  return {
    schemaVersion: BROWSER_KEY_STORAGE_SCHEMA_VERSION,
    available: Boolean(indexedDBImpl?.open),
    async putKey(record) {
      const database = await openDatabase();
      const transaction = database.transaction('keys', 'readwrite');
      const completed = transactionPromise(transaction);
      transaction.objectStore('keys').put(safeRecord({ ...record, updatedAt: record.updatedAt || now() }));
      await completed;
    },
    async updateKey(record) {
      return this.putKey(record);
    },
    async listKeys() {
      return allRecords();
    },
    async deleteRecord(recordIdValue) {
      const database = await openDatabase();
      const transaction = database.transaction('keys', 'readwrite');
      const completed = transactionPromise(transaction);
      transaction.objectStore('keys').delete(recordIdValue);
      await completed;
    },
    async deleteOwner(ownerHash, spaceId) {
      const records = await allRecords();
      for (const record of records) {
        if (record.ownerHash === ownerHash && record.spaceId === spaceId) await this.deleteRecord(record.recordId);
      }
    },
    async getOrCreateDeviceBindingId({ createId = () => `device-${Date.now()}-${Math.random().toString(16).slice(2)}` } = {}) {
      const database = await openDatabase();
      const readTransaction = database.transaction('metadata', 'readonly');
      const readCompleted = transactionPromise(readTransaction);
      const existing = await requestPromise(readTransaction.objectStore('metadata').get(DEVICE_METADATA_ID));
      await readCompleted;
      if (existing?.deviceBindingId) return String(existing.deviceBindingId);
      const deviceBindingId = String(createId()).trim();
      if (!deviceBindingId) throw codedError('DEVICE_BINDING_UNAVAILABLE');
      const writeTransaction = database.transaction('metadata', 'readwrite');
      const completed = transactionPromise(writeTransaction);
      writeTransaction.objectStore('metadata').put(safeDeviceMetadata({ metadataId: DEVICE_METADATA_ID, deviceBindingId }));
      await completed;
      return deviceBindingId;
    },
    async putValidationFixture(fixture) {
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readwrite');
      const completed = transactionPromise(transaction);
      transaction.objectStore('metadata').put(safeValidationFixture({ ...fixture, metadataId: VALIDATION_FIXTURE_ID }));
      await completed;
    },
    async getValidationFixture() {
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readonly');
      const completed = transactionPromise(transaction);
      const record = await requestPromise(transaction.objectStore('metadata').get(VALIDATION_FIXTURE_ID));
      await completed;
      return record ? safeValidationFixture(record) : null;
    },
    async deleteValidationFixture() {
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readwrite');
      const completed = transactionPromise(transaction);
      transaction.objectStore('metadata').delete(VALIDATION_FIXTURE_ID);
      await completed;
    },
    async getLifecycleEvidence() {
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readonly');
      const completed = transactionPromise(transaction);
      const record = await requestPromise(transaction.objectStore('metadata').get(VALIDATION_LIFECYCLE_ID));
      await completed;
      return record ? safeLifecycleEvidence(record) : {
        metadataId: VALIDATION_LIFECYCLE_ID,
        pageRefreshVerified: false,
        browserRestartVerified: false,
        deviceRestartVerified: false,
        pageLoadMarker: '',
        updatedAt: ''
      };
    },
    async setLifecycleEvidence(evidence) {
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readwrite');
      const completed = transactionPromise(transaction);
      transaction.objectStore('metadata').put(safeLifecycleEvidence({
        ...evidence,
        metadataId: VALIDATION_LIFECYCLE_ID,
        updatedAt: now()
      }));
      await completed;
    },
    async getSafariValidationEvidence() {
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readonly');
      const completed = transactionPromise(transaction);
      const record = await requestPromise(transaction.objectStore('metadata').get(VALIDATION_EVIDENCE_ID));
      await completed;
      if (record) return safeValidationEvidence(record);
      return Object.freeze({
        metadataId: VALIDATION_EVIDENCE_ID,
        ...Object.fromEntries(SAFARI_VALIDATION_EVIDENCE_FIELDS.map((field) => [field, false])),
        updatedAt: ''
      });
    },
    async setSafariValidationEvidence(evidence) {
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readwrite');
      const completed = transactionPromise(transaction);
      transaction.objectStore('metadata').put(safeValidationEvidence({
        ...evidence,
        metadataId: VALIDATION_EVIDENCE_ID,
        updatedAt: now()
      }));
      await completed;
    },
    async getRecoveryCredentialUse(credentialId) {
      const metadataId = recoveryUseMetadataId(credentialId);
      if (metadataId === RECOVERY_USE_PREFIX) throw codedError('RECOVERY_CREDENTIAL_ID_REQUIRED');
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readonly');
      const completed = transactionPromise(transaction);
      const record = await requestPromise(transaction.objectStore('metadata').get(metadataId));
      await completed;
      return record ? safeRecoveryCredentialUse(record) : null;
    },
    async claimRecoveryCredentialUse({ credentialId, ownerHash, usedAt = now() } = {}) {
      const metadataId = recoveryUseMetadataId(credentialId);
      const safe = safeRecoveryCredentialUse({ metadataId, credentialId, ownerHash, usedAt });
      const database = await openDatabase();
      const transaction = database.transaction('metadata', 'readwrite');
      const completed = transactionPromise(transaction);
      const request = transaction.objectStore('metadata').add(safe);
      try {
        await requestPromise(request);
        await completed;
      } catch (error) {
        if (error?.name === 'ConstraintError') throw codedError('RECOVERY_CREDENTIAL_ALREADY_USED');
        throw error;
      }
    },
    async probeStoragePersistence() {
      const storage = navigatorImpl?.storage;
      if (typeof storage?.estimate !== 'function') {
        return { quotaBytes: 0, persisted: false, privateModeSafe: false, errorCode: 'STORAGE_QUOTA_UNAVAILABLE' };
      }
      try {
        const estimate = await storage.estimate();
        const quotaBytes = Number(estimate?.quota || 0);
        const persisted = typeof storage.persisted === 'function' ? await storage.persisted() : false;
        return {
          quotaBytes,
          persisted: persisted === true,
          privateModeSafe: quotaBytes > 0 && persisted === true
        };
      } catch (error) {
        return { quotaBytes: 0, persisted: false, privateModeSafe: false, errorCode: error?.code || 'STORAGE_PERSISTENCE_PROBE_FAILED' };
      }
    },
    async probeCryptoKeyPersistence(cryptoKey) {
      try {
        const probeId = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const database = await openDatabase();
        const transaction = database.transaction('keys', 'readwrite');
        const completed = transactionPromise(transaction);
        transaction.objectStore('keys').put(safeRecord({
          kind: 'capability-probe',
          recordId: probeId,
          cryptoKey,
          createdAt: now()
        }));
        await completed;
        const reopened = (await this.listKeys()).find((record) => record.recordId === probeId);
        await this.deleteRecord(probeId);
        return { available: true, reopened: reopened?.cryptoKey?.extractable === false };
      } catch (error) {
        return { available: false, reopened: false, errorCode: error?.code || 'CRYPTO_KEY_PERSISTENCE_FAILED' };
      }
    }
  };
}

export { recordId };
