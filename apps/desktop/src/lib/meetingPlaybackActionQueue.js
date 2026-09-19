export function createMeetingPlaybackActionQueue() {
  let tail = Promise.resolve();

  function enqueue(action) {
    if (typeof action !== 'function') return Promise.reject(new TypeError('PLAYBACK_ACTION_REQUIRED'));
    const next = tail.catch(() => {}).then(action);
    tail = next.catch(() => {});
    return next;
  }

  return Object.freeze({ enqueue });
}
