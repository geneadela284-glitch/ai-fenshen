import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchCurrentSession, loginSession, logout } from './authClient.js';

test('voice entry is enabled only by a boolean server authorization flag', async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const flag of [true, false, 'true', undefined]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ user: { id: 'voice-owner' }, featureFlags: { voiceChatEnabled: flag } }) });
      assert.equal((await fetchCurrentSession()).featureFlags.voiceChatEnabled === true, flag === true);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('authenticated session keeps the strict server Finance F2.0-1 flag', async () => {
  const previousFetch = globalThis.fetch;
  const responses = [
    { ok: true, json: async () => ({ user: { id: 'user-1' }, featureFlags: { financeF201Enabled: true } }) },
    { ok: true, json: async () => ({ ok: true, user: { id: 'user-1' }, featureFlags: { financeF201Enabled: true } }) }
  ];
  globalThis.fetch = async () => responses.shift();
  try {
    assert.deepEqual(await fetchCurrentSession(), {
      user: { id: 'user-1' },
      featureFlags: { financeF201Enabled: true }
    });
    assert.deepEqual(await loginSession('beta_user', 'Password1!'), {
      user: { id: 'user-1' },
      featureFlags: { financeF201Enabled: true }
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('authenticated session fails closed for missing or non-boolean Finance flags', async () => {
  const previousFetch = globalThis.fetch;
  const responses = [
    { ok: true, json: async () => ({ user: { id: 'user-1' } }) },
    { ok: true, json: async () => ({ ok: true, user: { id: 'user-1' }, featureFlags: { financeF201Enabled: 'true' } }) }
  ];
  globalThis.fetch = async () => responses.shift();
  try {
    assert.equal((await fetchCurrentSession()).featureFlags.financeF201Enabled, false);
    assert.equal((await loginSession('beta_user', 'Password1!')).featureFlags.financeF201Enabled, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('logout uses the real cookie session endpoint', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true };
  };
  try {
    await logout();
    assert.deepEqual(calls, [{
      url: '/api/auth/logout',
      options: { method: 'POST', credentials: 'include' }
    }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('logout does not report success when the server session was not invalidated', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    await assert.rejects(logout(), /退出失败/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
