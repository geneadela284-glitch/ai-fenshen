import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseSyntheticOwnerBootstrapUsernames,
  shouldInitializeSyntheticOwnerKey
} from './meetingSyntheticOwnerBootstrap.js';

test('candidate bootstrap enables only the explicit synthetic username when the build flag is enabled', () => {
  const allowedUsernames = parseSyntheticOwnerBootstrapUsernames(' meeting-stage3b-a-review-synthetic, meeting-phase1a-synthetic ');

  assert.equal(
    shouldInitializeSyntheticOwnerKey({
      enabled: true,
      username: 'meeting-stage3b-a-review-synthetic',
      allowedUsernames
    }),
    true
  );
  assert.equal(
    shouldInitializeSyntheticOwnerKey({
      enabled: false,
      username: 'meeting-stage3b-a-review-synthetic',
      allowedUsernames
    }),
    false
  );
  assert.equal(
    shouldInitializeSyntheticOwnerKey({
      enabled: true,
      username: 'real-user',
      allowedUsernames
    }),
    false
  );
});

test('candidate bootstrap ignores empty and duplicate username entries', () => {
  assert.deepEqual(
    parseSyntheticOwnerBootstrapUsernames(',, meeting-stage3b-a-review-synthetic,meeting-stage3b-a-review-synthetic,'),
    ['meeting-stage3b-a-review-synthetic']
  );
});
