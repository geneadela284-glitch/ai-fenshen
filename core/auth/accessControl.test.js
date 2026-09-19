import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeRole,
  filterAuthorizedMenu,
  isAdminUser,
  resolveAuthorizedPage
} from './accessControl.js';

test('treats beta_user as the legacy user role and lets admin inherit user access', () => {
  assert.equal(authorizeRole({ role: 'beta_user' }, 'user').allowed, true);
  assert.equal(authorizeRole({ role: 'user' }, 'user').allowed, true);
  assert.equal(authorizeRole({ role: 'admin' }, 'user').allowed, true);
  assert.equal(authorizeRole({ role: 'beta_user' }, 'admin').status, 403);
  assert.equal(authorizeRole(null, 'admin').status, 401);
  assert.equal(isAdminUser({ role: 'admin' }), true);
});

test('removes administrator navigation and rejects direct administrator hashes for users', () => {
  const menu = ['工作秘书', '设置', '管理员中心'];
  assert.deepEqual(filterAuthorizedMenu(menu, { role: 'beta_user' }), ['工作秘书', '设置']);
  assert.deepEqual(filterAuthorizedMenu(menu, { role: 'admin' }), menu);
  assert.equal(resolveAuthorizedPage('管理员中心', { role: 'beta_user' }), '工作秘书');
  assert.equal(resolveAuthorizedPage('管理员中心', { role: 'admin' }), '管理员中心');
});
