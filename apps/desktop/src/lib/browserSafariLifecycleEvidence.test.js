import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeSafariLifecycleEvidence } from './browserSafariLifecycleEvidence.js';

test('lifecycle evidence records a reload only when a prior page marker exists', () => {
  const firstLoad = mergeSafariLifecycleEvidence({
    existing: {},
    navigationType: 'navigate',
    pageLoadMarker: 'marker-1',
    now: '2026-08-06T00:00:00.000Z'
  });
  assert.equal(firstLoad.pageRefreshVerified, false);
  assert.equal(firstLoad.pageLoadMarker, 'marker-1');

  const reload = mergeSafariLifecycleEvidence({
    existing: firstLoad,
    navigationType: 'reload',
    pageLoadMarker: 'marker-2',
    now: '2026-08-06T00:01:00.000Z'
  });
  assert.equal(reload.pageRefreshVerified, true);
  assert.equal(reload.pageLoadMarker, 'marker-2');
});
test('lifecycle evidence keeps positive results and records explicit restart confirmations', () => {
  const evidence = mergeSafariLifecycleEvidence({
    existing: { pageRefreshVerified: true, browserRestartVerified: false, deviceRestartVerified: false, pageLoadMarker: 'marker-1' },
    navigationType: 'navigate',
    browserRestartConfirmed: true,
    deviceRestartConfirmed: true,
    pageLoadMarker: 'marker-3',
    now: '2026-08-06T00:02:00.000Z'
  });
  assert.deepEqual(evidence, {
    pageRefreshVerified: true,
    browserRestartVerified: true,
    deviceRestartVerified: true,
    pageLoadMarker: 'marker-3',
    updatedAt: '2026-08-06T00:02:00.000Z'
  });
});
