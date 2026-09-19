import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUserScopedBrowserStorage,
  exportUserLocalData,
  importUserLocalData,
  inspectLegacyLocalData,
  migrateLegacyLocalData,
  sanitizeUserScopedSecurityState
} from './userScopedStorage.js';

function installLocalStorage() {
  const store = new Map();
  global.localStorage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (index) => Array.from(store.keys())[index] || null,
    get length() {
      return store.size;
    }
  };
  global.Object.keys = Object.keys;
  return store;
}

test('scopes browser storage by stable user id in the same browser', () => {
  installLocalStorage();
  const userA = createUserScopedBrowserStorage({ userId: 'user-a' });
  const userB = createUserScopedBrowserStorage({ userId: 'user-b' });

  userA.set('memory', [{ id: 'a-memory' }]);
  userB.set('memory', [{ id: 'b-memory' }]);

  assert.deepEqual(userA.get('memory'), [{ id: 'a-memory' }]);
  assert.deepEqual(userB.get('memory'), [{ id: 'b-memory' }]);
  assert.equal(localStorage.getItem('ai-secretary:user-a:memory') !== null, true);
  assert.equal(localStorage.getItem('ai-secretary:user-b:memory') !== null, true);
});

test('ordinary accounts never inherit or retain administrator settings and raw system events', () => {
  installLocalStorage();
  localStorage.setItem('ai-work-center:ai-settings', JSON.stringify({
    appearanceTheme: 'classic',
    apiKey: 'awc-key-v1:encrypted',
    providers: { deepseek: { apiKey: 'awc-key-v1:encrypted' } }
  }));
  migrateLegacyLocalData({ userId: 'user-a', role: 'beta_user' });
  assert.equal(localStorage.getItem('ai-secretary:user-a:ai-settings'), null);

  const userA = createUserScopedBrowserStorage({ userId: 'user-a' });
  userA.set('ai-settings', { appearanceTheme: 'warm-life', apiKey: 'awc-key-v1:encrypted' });
  userA.set('events', [{ title: 'work_secretary_task', content: 'full input', metadata: { taskId: 'task-1', password: 'secret' } }]);
  sanitizeUserScopedSecurityState({ userId: 'user-a', role: 'beta_user' });
  assert.deepEqual(userA.get('ai-settings'), { appearanceTheme: 'warm-life' });
  assert.deepEqual(userA.get('events'), [{ title: 'work_secretary_task', content: '', metadata: { taskId: 'task-1' } }]);
});

test('does not auto-copy legacy data and migrates only after confirmation once', () => {
  installLocalStorage();
  localStorage.setItem('ai-work-center:quick-notes', JSON.stringify([{ id: 'legacy-note' }]));

  const legacy = inspectLegacyLocalData({ userId: 'user-a' });
  assert.equal(legacy.hasLegacyData, true);
  assert.equal(createUserScopedBrowserStorage({ userId: 'user-a' }).get('quick-notes'), null);

  const migrated = migrateLegacyLocalData({ userId: 'user-a' });
  assert.equal(migrated.migratedCount, 1);
  assert.deepEqual(createUserScopedBrowserStorage({ userId: 'user-a' }).get('quick-notes'), [{ id: 'legacy-note' }]);

  const second = migrateLegacyLocalData({ userId: 'user-a' });
  assert.equal(second.migratedCount, 0);
  assert.equal(localStorage.getItem('ai-work-center:quick-notes') !== null, true);
});

test('exports and imports only the active user namespace', () => {
  installLocalStorage();
  const userA = createUserScopedBrowserStorage({ userId: 'user-a' });
  userA.set('settings', { theme: 'classic' });
  userA.set('ai-settings', {
    appearanceTheme: 'classic',
    apiKey: 'awc-key-v1:encrypted',
    providers: { deepseek: { apiKey: 'awc-key-v1:encrypted', baseUrl: 'https://provider.example' } },
    router: { routes: { WRITE: { providerId: 'deepseek' } } }
  });
  userA.set('ai-invocation-traces', [{ providerId: 'deepseek' }]);
  userA.set('events', [{ content: 'private input' }]);
  userA.set('secretary-action-audits', [{ userId: 'user-a' }]);
  createUserScopedBrowserStorage({ userId: 'user-b' }).set('settings', { theme: 'warm-life' });

  const exported = exportUserLocalData({ userId: 'user-a' });
  assert.deepEqual(exported.data.settings, { theme: 'classic' });
  assert.deepEqual(exported.data['ai-settings'], { appearanceTheme: 'classic' });
  assert.equal(exported.data['ai-invocation-traces'], undefined);
  assert.equal(exported.data.events, undefined);
  assert.equal(exported.data['secretary-action-audits'], undefined);
  assert.doesNotMatch(JSON.stringify(exported), /apiKey|providerId|private input|encrypted/);
  assert.equal(exported.data['ai-secretary:user-b:settings'], undefined);

  importUserLocalData({
    userId: 'user-b',
    payload: { version: 1, userId: 'user-a', data: { meetings: [{ id: 'meeting-a' }] } }
  });
  assert.deepEqual(createUserScopedBrowserStorage({ userId: 'user-b' }).get('meetings'), [{ id: 'meeting-a' }]);
});
