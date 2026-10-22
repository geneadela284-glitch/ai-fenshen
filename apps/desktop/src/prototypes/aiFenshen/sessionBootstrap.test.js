import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountWorkspaceTransition } from './accountSessionBoundary.js';

async function loadSubject() {
  try {
    return await import('./sessionBootstrap.js');
  } catch {
    return {};
  }
}

test('a temporary bootstrap failure preserves the current account workspace while access remains unavailable', async () => {
  const { restoreBootstrapSession } = await loadSubject();
  assert.equal(typeof restoreBootstrapSession, 'function');
  const resets = [];
  const workspace = createAccountWorkspaceTransition({ onReset: (change) => resets.push(change) });
  workspace.transitionTo('account-a');
  resets.length = 0;
  let unavailable = false;

  const result = await restoreBootstrapSession({
    fetchSession: async () => { throw Object.assign(new Error('offline'), { code: 'AUTH_SESSION_UNAVAILABLE' }); },
    fetchPrivacyConsent: async () => ({ consent: { current: true } }),
    accountWorkspace: workspace,
    isCurrent: () => true,
    onAuthenticated: () => assert.fail('temporary bootstrap failure must not authenticate'),
    onUnauthenticated: () => assert.fail('temporary bootstrap failure must not log out'),
    onUnavailable: () => { unavailable = true; }
  });

  assert.deepEqual(result, { state: 'unavailable' });
  assert.equal(unavailable, true);
  assert.equal(workspace.currentOwnerId(), 'account-a');
  assert.deepEqual(resets, []);
});

test('an explicit unauthenticated result waits for protected cleanup before presenting login', async () => {
  const { restoreBootstrapSession } = await loadSubject();
  assert.equal(typeof restoreBootstrapSession, 'function');
  const workspace = createAccountWorkspaceTransition({ initialOwnerId: 'account-a' });
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  let restoringFinished = false;
  const restoring = restoreBootstrapSession({
    fetchSession: async () => ({ user: null, featureFlags: { financeF201Enabled: false } }),
    fetchPrivacyConsent: async () => assert.fail('401 must not read private consent'),
    accountWorkspace: workspace,
    isCurrent: () => true,
    onAuthenticated: () => assert.fail('401 must not authenticate'),
    onUnauthenticated: async () => { await cleanup; },
    onUnavailable: () => assert.fail('401 must not look temporary')
  }).then(() => { restoringFinished = true; });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(restoringFinished, false);
  releaseCleanup();
  await restoring;
  assert.equal(workspace.currentOwnerId(), null);
});

test('an expired current session waits for native cleanup before presenting login', async () => {
  const { expireBootstrapSession } = await loadSubject();
  assert.equal(typeof expireBootstrapSession, 'function');
  const workspace = createAccountWorkspaceTransition({ initialOwnerId: 'account-a' });
  const token = workspace.capture();
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  let published = false;
  const expiring = expireBootstrapSession({
    accountWorkspace: workspace,
    expectedToken: token,
    isCurrent: () => true,
    clearNativeSessionCookie: async () => { await cleanup; },
    onExpired: () => { published = true; }
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(published, false);
  releaseCleanup();
  assert.deepEqual(await expiring, { state: 'expired', nativeClearFailed: false });
  assert.equal(published, true);
  assert.equal(workspace.currentOwnerId(), null);
});
