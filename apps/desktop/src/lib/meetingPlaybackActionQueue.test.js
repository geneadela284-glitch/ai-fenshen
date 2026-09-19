import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingPlaybackActionQueue } from './meetingPlaybackActionQueue.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('playback controls wait for an in-flight seek before running the next action', async () => {
  const queue = createMeetingPlaybackActionQueue();
  const gate = deferred();
  const events = [];

  const first = queue.enqueue(async () => {
    events.push('seek-start');
    await gate.promise;
    events.push('seek-finished');
  });
  const second = queue.enqueue(async () => {
    events.push('skip-after-seek');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['seek-start']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['seek-start', 'seek-finished', 'skip-after-seek']);
});

test('a failed playback action does not strand later controls', async () => {
  const queue = createMeetingPlaybackActionQueue();
  const events = [];

  await assert.rejects(queue.enqueue(async () => {
    events.push('failed-seek');
    throw new Error('seek failed');
  }), /seek failed/);

  await queue.enqueue(async () => {
    events.push('playable-again');
  });
  assert.deepEqual(events, ['failed-seek', 'playable-again']);
});
