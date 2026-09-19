import assert from 'node:assert/strict';
import test from 'node:test';

async function loadSubject() {
  try {
    return await import('./accountSessionBoundary.js');
  } catch {
    return null;
  }
}

test('account workspace resets once per owner change and ignores same-owner refreshes', async () => {
  const subject = await loadSubject();
  assert.equal(typeof subject?.createAccountWorkspaceTransition, 'function');

  const resets = [];
  const workspace = subject.createAccountWorkspaceTransition({
    onReset: (change) => resets.push(change)
  });

  workspace.transitionTo('account-a');
  workspace.transitionTo('account-a');
  workspace.transitionTo('account-b');

  assert.deepEqual(resets.map(({ previousOwnerId, nextOwnerId }) => ({ previousOwnerId, nextOwnerId })), [
    { previousOwnerId: null, nextOwnerId: 'account-a' },
    { previousOwnerId: 'account-a', nextOwnerId: 'account-b' }
  ]);
  assert.equal(workspace.isOwner('account-b'), true);
});

test('a delayed result cannot commit after the workspace switches from account A to B', async () => {
  const { createAccountWorkspaceTransition } = await import('./accountSessionBoundary.js');
  const workspace = createAccountWorkspaceTransition();
  const tokenA = workspace.transitionTo('account-a');
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const writes = [];

  const pendingA = (async () => {
    const value = await delayed;
    return workspace.commit(tokenA, () => writes.push(value));
  })();

  workspace.transitionTo('account-b');
  release('private-account-a-result');

  assert.equal(await pendingA, false);
  assert.deepEqual(writes, []);
});

test('the current account can commit while logout invalidates its token synchronously', async () => {
  const { createAccountWorkspaceTransition } = await import('./accountSessionBoundary.js');
  const workspace = createAccountWorkspaceTransition();
  const tokenA = workspace.transitionTo('account-a');
  const writes = [];

  assert.equal(workspace.commit(tokenA, () => writes.push('visible-a')), true);
  workspace.transitionTo(null);
  assert.equal(workspace.commit(tokenA, () => writes.push('stale-a')), false);
  assert.deepEqual(writes, ['visible-a']);
  assert.equal(workspace.currentOwnerId(), null);
});
