import { createDefaultRepositoryStorage } from './jsonStorage.js';

export class JsonCollectionRepository {
  constructor({ key, storage = createDefaultRepositoryStorage(), seed = [] } = {}) {
    if (!key) throw new Error('Repository key is required.');
    this.key = key;
    this.storage = storage;
    this.seed = seed;
  }

  readAll() {
    const stored = this.storage.get(this.key);
    return Array.isArray(stored) ? stored : [...this.seed];
  }

  replaceAll(items = []) {
    this.storage.set(this.key, items);
    return items;
  }

  create(item) {
    const next = [item, ...this.readAll()];
    this.replaceAll(next);
    return item;
  }

  read(id) {
    return this.readAll().find((item) => item.id === id) || null;
  }

  update(id, updates) {
    let updated = null;
    const next = this.readAll().map((item) => {
      if (item.id !== id) return item;
      updated = { ...item, ...updates, id };
      return updated;
    });
    this.replaceAll(next);
    return updated;
  }

  delete(id) {
    this.replaceAll(this.readAll().filter((item) => item.id !== id));
    return true;
  }

  search(predicate = () => true) {
    return this.readAll().filter(predicate);
  }
}

export class JsonRecordRepository {
  constructor({ key, storage = createDefaultRepositoryStorage(), defaults = {} } = {}) {
    if (!key) throw new Error('Repository key is required.');
    this.key = key;
    this.storage = storage;
    this.defaults = defaults;
  }

  create(record = {}) {
    const next = { ...this.defaults, ...record };
    this.storage.set(this.key, next);
    return next;
  }

  read() {
    return this.storage.get(this.key) || null;
  }

  update(record = {}) {
    const next = { ...(this.read() || this.defaults), ...record };
    this.storage.set(this.key, next);
    return next;
  }

  delete() {
    this.storage.remove(this.key);
    return true;
  }

  search() {
    const record = this.read();
    return record ? [record] : [];
  }
}
