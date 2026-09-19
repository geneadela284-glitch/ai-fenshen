import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldDismissMeetingOverflowMenu } from './meetingOverflowMenuUi.js';

test('overflow menu dismisses when the pointer target is outside the topbar', () => {
  const menuRoot = { contains: (target) => target === 'inside' };
  assert.equal(shouldDismissMeetingOverflowMenu({ root: menuRoot, target: 'outside' }), true);
  assert.equal(shouldDismissMeetingOverflowMenu({ root: menuRoot, target: 'inside' }), false);
});

test('overflow menu dismissal fails closed while its root has not mounted', () => {
  assert.equal(shouldDismissMeetingOverflowMenu({ root: null, target: 'outside' }), false);
});
