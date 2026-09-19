import assert from 'node:assert/strict';
import test from 'node:test';
import { createDictationCancelDispatcher } from './dictationCancel.js';

function event() {
  return {
    preventDefault() {},
    stopPropagation() {}
  };
}

test('cancel dispatches once when iPhone pointer activation is followed by synthetic click', () => {
  let now = 1_000;
  let calls = 0;
  const dispatcher = createDictationCancelDispatcher(() => { calls += 1; }, { now: () => now });

  assert.equal(dispatcher.handle(event()), true);
  assert.equal(dispatcher.handle(event()), false);
  assert.equal(calls, 1);

  now += 501;
  assert.equal(dispatcher.handle(event()), true);
  assert.equal(calls, 2);
});
