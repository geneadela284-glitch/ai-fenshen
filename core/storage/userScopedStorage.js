import { createBrowserStorage } from './browserStorage.js';
import { sanitizeSensitiveData } from '../security/sensitiveData.js';

const LEGACY_PREFIX = 'ai-work-center';
const USER_PREFIX = 'ai-secretary';
const MIGRATION_MARKER = '__legacyMigration.v1';
const SYSTEM_EXPORT_KEYS = new Set(['ai-invocation-traces', 'events', 'secretary-action-audits']);

function sanitizeExportValue(key, value) {
  if (SYSTEM_EXPORT_KEYS.has(key)) return undefined;
  if (key === 'ai-settings') {
    return value?.appearanceTheme ? { appearanceTheme: value.appearanceTheme } : {};
  }
  return value;
}

function storageKeys() {
  if (typeof localStorage === 'undefined') return [];
  const keys = new Set();
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) keys.add(key);
  }
  Object.keys(localStorage).forEach((key) => keys.add(key));
  return Array.from(keys);
}

function safeUserId(userId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('userId is required for scoped storage.');
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function getUserStoragePrefix(userId) {
  return `${USER_PREFIX}:${safeUserId(userId)}`;
}

export function createUserScopedBrowserStorage({ userId } = {}) {
  return createBrowserStorage({ prefix: getUserStoragePrefix(userId) });
}

export function inspectLegacyLocalData({ userId } = {}) {
  const markerKey = `${getUserStoragePrefix(userId)}:${MIGRATION_MARKER}`;
  const legacyKeys = storageKeys().filter((key) => key.startsWith(`${LEGACY_PREFIX}:`));
  return {
    hasLegacyData: legacyKeys.length > 0,
    alreadyMigrated: ['accepted', 'declined'].includes(localStorage.getItem(markerKey)),
    legacyKeys: legacyKeys.map((key) => key.replace(`${LEGACY_PREFIX}:`, ''))
  };
}

export function migrateLegacyLocalData({ userId, role = 'user' } = {}) {
  const prefix = getUserStoragePrefix(userId);
  const markerKey = `${prefix}:${MIGRATION_MARKER}`;
  if (localStorage.getItem(markerKey) === 'accepted') {
    return { migratedCount: 0, skipped: true };
  }
  let migratedCount = 0;
  storageKeys()
    .filter((key) => key.startsWith(`${LEGACY_PREFIX}:`))
    .forEach((legacyKey) => {
      const dataKey = legacyKey.replace(`${LEGACY_PREFIX}:`, '');
      if (role !== 'admin' && (dataKey === 'ai-settings' || SYSTEM_EXPORT_KEYS.has(dataKey))) return;
      const scopedKey = `${prefix}:${dataKey}`;
      if (localStorage.getItem(scopedKey) === null) {
        localStorage.setItem(scopedKey, localStorage.getItem(legacyKey));
        migratedCount += 1;
      }
    });
  localStorage.setItem(markerKey, 'accepted');
  return { migratedCount, skipped: false };
}

export function sanitizeUserScopedSecurityState({ userId, role = 'user' } = {}) {
  const storage = createUserScopedBrowserStorage({ userId });
  if (role !== 'admin') {
    const settings = storage.get('ai-settings');
    if (settings) storage.set('ai-settings', sanitizeExportValue('ai-settings', settings));
    storage.remove('ai-invocation-traces');
    storage.remove('secretary-action-audits');
  }
  const events = storage.get('events');
  if (Array.isArray(events)) {
    storage.set('events', events.map((event) => ({
      ...event,
      content: '',
      metadata: sanitizeSensitiveData(event?.metadata || {})
    })));
  }
}

export function declineLegacyLocalData({ userId } = {}) {
  localStorage.setItem(`${getUserStoragePrefix(userId)}:${MIGRATION_MARKER}`, 'declined');
  return true;
}

export function exportUserLocalData({ userId } = {}) {
  const prefix = `${getUserStoragePrefix(userId)}:`;
  const data = {};
  storageKeys()
    .filter((key) => key.startsWith(prefix))
    .filter((key) => !key.endsWith(`:${MIGRATION_MARKER}`))
    .forEach((key) => {
      const scopedKey = key.slice(prefix.length);
      if (SYSTEM_EXPORT_KEYS.has(scopedKey)) return;
      try {
        data[scopedKey] = sanitizeExportValue(scopedKey, JSON.parse(localStorage.getItem(key)));
      } catch {
        data[scopedKey] = sanitizeExportValue(scopedKey, localStorage.getItem(key));
      }
    });
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    userId: safeUserId(userId),
    data
  };
}

export function importUserLocalData({ userId, payload } = {}) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') {
    throw new Error('Invalid local data backup.');
  }
  const prefix = `${getUserStoragePrefix(userId)}:`;
  Object.entries(parsed.data).forEach(([key, value]) => {
    if (SYSTEM_EXPORT_KEYS.has(String(key)) || String(key) === 'ai-settings') return;
    if (/apiKey|password|session|authorization|cookie|secret/i.test(String(key))) return;
    localStorage.setItem(`${prefix}${key}`, JSON.stringify(value));
  });
  return { importedCount: Object.keys(parsed.data).length };
}
