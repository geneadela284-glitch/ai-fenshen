import { createBrowserStorage } from '../../../../core/storage/browserStorage.js';
import { storageManager } from '../../../../core/storage/memoryStorage.js';
import { createUserScopedBrowserStorage } from '../../../../core/storage/userScopedStorage.js';

let initialized = false;
let activeUserId = '';

export function initializeAppStorage() {
  if (initialized || typeof window === 'undefined') return;
  storageManager.useAdapter(createBrowserStorage({ prefix: 'ai-secretary:locked' }));
  initialized = true;
}

export function activateUserStorage(userId) {
  if (typeof window === 'undefined') return;
  activeUserId = userId;
  storageManager.useAdapter(createUserScopedBrowserStorage({ userId }));
}

export function resetUserStorage() {
  if (typeof window === 'undefined') return;
  activeUserId = '';
  storageManager.useAdapter(createBrowserStorage({ prefix: 'ai-secretary:locked' }));
}

export function getActiveUserId() {
  return activeUserId;
}
