import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

test('M8 migration module exists', () => {
  assert.equal(existsSync(new URL('./index.js', import.meta.url)), true);
});
