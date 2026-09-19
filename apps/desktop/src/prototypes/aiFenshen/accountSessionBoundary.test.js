import assert from 'node:assert/strict';
import test from 'node:test';

async function loadSubject() {
  try {
    return await import('./accountSessionBoundary.js');
  } catch {
    return null;
  }
}

test('switching accounts invalidates every token captured by the previous account', async () => {
  const subject = await loadSubject();
  assert.equal(typeof subject?.createAccountSessionBoundary, 'function');

  const boundary = subject.createAccountSessionBoundary();
  const enteredA = boundary.transitionTo('account-a');
  const tokenA = boundary.capture();
  const enteredB = boundary.transitionTo('account-b');

  assert.equal(enteredA.changed, true);
  assert.equal(enteredB.changed, true);
  assert.equal(boundary.isCurrent(tokenA), false);
  assert.equal(boundary.isOwner('account-a'), false);
  assert.equal(boundary.isOwner('account-b'), true);
  assert.equal(boundary.currentOwnerId(), 'account-b');
});

test('refreshing the same account keeps its generation while logout invalidates it', async () => {
  const { createAccountSessionBoundary } = await import('./accountSessionBoundary.js');
  const boundary = createAccountSessionBoundary({ initialOwnerId: 'account-a' });
  const tokenA = boundary.capture();

  const refreshed = boundary.transitionTo('account-a');
  assert.equal(refreshed.changed, false);
  assert.equal(boundary.isCurrent(tokenA), true);

  const loggedOut = boundary.transitionTo(null);
  assert.equal(loggedOut.changed, true);
  assert.equal(boundary.isCurrent(tokenA), false);
  assert.equal(boundary.currentOwnerId(), null);
});

test('captured account tokens are immutable snapshots', async () => {
  const { createAccountSessionBoundary } = await import('./accountSessionBoundary.js');
  const boundary = createAccountSessionBoundary({ initialOwnerId: 'account-a' });
  const token = boundary.capture();

  assert.equal(Object.isFrozen(token), true);
  assert.throws(() => { token.ownerId = 'account-b'; }, TypeError);
  assert.equal(boundary.isCurrent(token), true);
});
