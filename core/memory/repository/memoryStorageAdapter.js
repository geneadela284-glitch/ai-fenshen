import { migrateMemoryRecords } from './memoryMigration.js';

export const DEFAULT_MEMORY_STORAGE_NAMESPACE = 'aiworkcenter.memory.records.v1';

export class MemoryStorageAdapter {
  constructor({ storage, namespace = DEFAULT_MEMORY_STORAGE_NAMESPACE } = {}) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new Error('MemoryStorageAdapter requires a storage adapter with get/set methods');
    }
    this.storage = storage;
    this.namespace = namespace;
  }

  readAll() {
    const payload = this.storage.get(this.namespace);
    if (!payload) return [];
    if (Array.isArray(payload)) return migrateMemoryRecords(payload);
    if (Array.isArray(payload.records)) return migrateMemoryRecords(payload.records);
    return [];
  }

  writeAll(records) {
    const safeRecords = migrateMemoryRecords(records);
    this.storage.set(this.namespace, {
      version: 1,
      records: safeRecords
    });
    return safeRecords;
  }

  replaceAll(records) {
    return this.writeAll(records);
  }

  clearNamespace() {
    if (typeof this.storage.remove === 'function') {
      this.storage.remove(this.namespace);
      return true;
    }
    this.writeAll([]);
    return true;
  }
}
