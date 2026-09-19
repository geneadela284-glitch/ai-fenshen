import { createBrowserStorage } from '../storage/browserStorage.js';
import { storageManager } from '../storage/memoryStorage.js';

export function createDefaultRepositoryStorage() {
  return storageManager;
}
