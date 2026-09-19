import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { sha256 } from './sha256.js';

test('portable SHA-256 matches the canonical Node implementation', () => {
  for (const value of ['', 'hello', '报价跟进', 'x'.repeat(2_000)]) {
    const expected = createHash('sha256').update(value, 'utf8').digest('hex');
    assert.equal(sha256(value), expected);
  }
});
