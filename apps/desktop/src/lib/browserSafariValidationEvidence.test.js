import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSafariValidationComplete,
  mergeSafariValidationEvidence
} from './browserSafariValidationEvidence.js';

const COMPLETE = {
  syntheticFixtureVerified: true,
  recoveryVerified: true,
  secondDeviceRecovery: true,
  oldDeviceRevoked: true,
  deviceUnlockVerified: true,
  logoutLoginVerified: true,
  wrongAccountRejected: true,
  siteDataCleared: true,
  privateModeBlocked: true
};

test('validation evidence is allowlisted and merges only positive confirmations', () => {
  const evidence = mergeSafariValidationEvidence({
    existing: { syntheticFixtureVerified: true, secret: 'must-not-pass-through' },
    updates: { recoveryVerified: true, wrongAccountRejected: false, unknown: true },
    now: '2026-08-06T00:00:00.000Z'
  });
  assert.deepEqual(evidence, {
    syntheticFixtureVerified: true,
    recoveryVerified: true,
    secondDeviceRecovery: false,
    oldDeviceRevoked: false,
    deviceUnlockVerified: false,
    logoutLoginVerified: false,
    wrongAccountRejected: false,
    siteDataCleared: false,
    privateModeBlocked: false,
    updatedAt: '2026-08-06T00:00:00.000Z'
  });
  assert.equal(Object.hasOwn(evidence, 'secret'), false);
  assert.equal(Object.hasOwn(evidence, 'unknown'), false);
});

test('validation completion requires every synthetic and manual step', () => {
  assert.equal(isSafariValidationComplete(COMPLETE), true);
  assert.equal(isSafariValidationComplete({ ...COMPLETE, siteDataCleared: false }), false);
});
