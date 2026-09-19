export function createMemoryStorage(initialData = {}) {
  const store = new Map(Object.entries(initialData));

  return {
    get(key) {
      return store.get(key) ?? null;
    },
    set(key, value) {
      store.set(key, value);
      return value;
    },
    remove(key) {
      return store.delete(key);
    },
    list() {
      return Object.fromEntries(store.entries());
    },
    clear() {
      store.clear();
    }
  };
}

export class StorageManager {
  constructor({ adapter = createMemoryStorage() } = {}) {
    this.adapter = adapter;
  }

  get(key) {
    return this.adapter.get(key);
  }

  set(key, value) {
    return this.adapter.set(key, value);
  }

  remove(key) {
    return this.adapter.remove(key);
  }

  list() {
    return this.adapter.list();
  }

  clear() {
    return this.adapter.clear();
  }

  useAdapter(adapter) {
    this.adapter = adapter;
  }
}

export const storageManager = new StorageManager();
