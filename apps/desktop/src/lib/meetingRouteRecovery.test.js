import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consumeMeetingRouteRecovery,
  persistMeetingRouteRecovery
} from './meetingRouteRecovery.js';
import { handleMeetingTopBack } from './meetingRouteRecoveryUi.js';

function storageHarness() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    has(key) { return values.has(key); }
  };
}

test('meeting route recovery is scoped to the owner and consumed once after the recorder safety reload', () => {
  const storage = storageHarness();
  assert.equal(persistMeetingRouteRecovery({ storage, ownerId: 'owner-a', meetingId: 'meeting-a' }), true);
  assert.equal(storage.has('ai-fenshen:meeting-route-recovery:v1'), true);
  assert.deepEqual(consumeMeetingRouteRecovery({ storage, ownerId: 'owner-b' }), null);
  assert.deepEqual(consumeMeetingRouteRecovery({ storage, ownerId: 'owner-a' }), { meetingId: 'meeting-a' });
  assert.deepEqual(consumeMeetingRouteRecovery({ storage, ownerId: 'owner-a' }), null);
});

test('meeting list top back navigates home even when a meeting remains selected', () => {
  const calls = [];
  handleMeetingTopBack({
    mobilePanel: 'list',
    setMobilePanel: (value) => calls.push(['panel', value]),
    onNavigate: (value) => calls.push(['navigate', value])
  });
  assert.deepEqual(calls, [['navigate', '工作秘书']]);
});

test('meeting detail and import top back return to the meeting list', () => {
  for (const mobilePanel of ['detail', 'import']) {
    const calls = [];
    handleMeetingTopBack({
      mobilePanel,
      setMobilePanel: (value) => calls.push(value),
      onNavigate: () => calls.push('home')
    });
    assert.deepEqual(calls, ['list']);
  }
});
