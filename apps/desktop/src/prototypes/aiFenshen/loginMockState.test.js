import assert from 'node:assert/strict';
import test from 'node:test';

test('login screen defaults to unregistered and accepts only the three mock states', async () => {
  const { LOGIN_SCREEN_STATES, normalizeLoginScreenState } = await import('./loginMockState.js');

  assert.deepEqual(LOGIN_SCREEN_STATES, ['unregistered', 'registered_no_face', 'face_ready']);
  assert.equal(normalizeLoginScreenState(), 'unregistered');
  assert.equal(normalizeLoginScreenState('unregistered'), 'unregistered');
  assert.equal(normalizeLoginScreenState('registered_no_face'), 'registered_no_face');
  assert.equal(normalizeLoginScreenState('face_ready'), 'face_ready');
  assert.equal(normalizeLoginScreenState('unknown'), 'unregistered');
});

test('credential mock starts registration for first-time users and login for registered users', async () => {
  const { getDefaultCredentialMode } = await import('./loginMockState.js');

  assert.equal(getDefaultCredentialMode('unregistered'), 'register');
  assert.equal(getDefaultCredentialMode('registered_no_face'), 'login');
});
