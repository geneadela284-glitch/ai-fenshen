import assert from 'node:assert/strict';
import test from 'node:test';

async function subject() {
  return import('./homeBubbleExperience.js').catch(() => ({}));
}

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test('RED: feature intro is shown once per authenticated user and local date', async () => {
  const bubble = await subject();
  assert.equal(typeof bubble.shouldShowDailyFeatureIntro, 'function');
  assert.equal(typeof bubble.markDailyFeatureIntroHandled, 'function');
  const store = storage();

  assert.equal(bubble.shouldShowDailyFeatureIntro({
    storage: store, identity: 'user-a', dateKey: '2026-07-29', introVersion: 'capabilities-v1'
  }), true);
  bubble.markDailyFeatureIntroHandled({
    storage: store, identity: 'user-a', dateKey: '2026-07-29', introVersion: 'capabilities-v1'
  });
  assert.equal(bubble.shouldShowDailyFeatureIntro({
    storage: store, identity: 'user-a', dateKey: '2026-07-29', introVersion: 'capabilities-v1'
  }), false);
  assert.equal(bubble.shouldShowDailyFeatureIntro({
    storage: store, identity: 'user-a', dateKey: '2026-07-30', introVersion: 'capabilities-v1'
  }), true);
  assert.equal(bubble.shouldShowDailyFeatureIntro({
    storage: store, identity: 'user-b', dateKey: '2026-07-29', introVersion: 'capabilities-v1'
  }), true);
});

test('RED: invalid or global bubble scopes fail closed instead of sharing state', async () => {
  const bubble = await subject();
  assert.equal(typeof bubble.homeBubbleExperienceKey, 'function');
  assert.throws(() => bubble.homeBubbleExperienceKey('', '2026-07-29', 'capabilities-v1'), /user/i);
  assert.throws(() => bubble.homeBubbleExperienceKey('user-a', '', 'capabilities-v1'), /date/i);
  assert.throws(() => bubble.homeBubbleExperienceKey('user-a', '2026-07-29', ''), /intro version/i);
  assert.notEqual(
    bubble.homeBubbleExperienceKey('user-a', '2026-07-29', 'capabilities-v1'),
    bubble.homeBubbleExperienceKey('user-b', '2026-07-29', 'capabilities-v1')
  );
});

test('RED: skipped intro version stays compact across dates and users remain isolated', async () => {
  const bubble = await subject();
  assert.equal(typeof bubble.markFeatureIntroVersionSkipped, 'function');
  assert.equal(typeof bubble.resolveFeatureIntroPresentation, 'function');
  const store = storage();
  const base = {
    storage: store,
    identity: 'user-a',
    dateKey: '2026-07-29',
    introVersion: 'capabilities-v1'
  };

  assert.equal(bubble.resolveFeatureIntroPresentation(base), 'expanded');
  bubble.markFeatureIntroVersionSkipped(base);
  assert.equal(bubble.resolveFeatureIntroPresentation(base), 'compact');
  assert.equal(bubble.resolveFeatureIntroPresentation({
    ...base, dateKey: '2026-07-30'
  }), 'compact');
  assert.equal(bubble.resolveFeatureIntroPresentation({
    ...base, identity: 'user-b'
  }), 'expanded');
  assert.equal(bubble.resolveFeatureIntroPresentation({
    ...base, introVersion: 'capabilities-v2'
  }), 'expanded');
});

test('RED: completing the current intro version hides every home replay marker until a new version', async () => {
  const bubble = await subject();
  assert.equal(typeof bubble.markFeatureIntroVersionCompleted, 'function');
  const store = storage();
  const base = {
    storage: store,
    identity: 'user-a',
    dateKey: '2026-07-29',
    introVersion: 'capabilities-v1'
  };
  bubble.markFeatureIntroVersionCompleted(base);
  assert.equal(bubble.resolveFeatureIntroPresentation(base), 'hidden');
  assert.equal(bubble.resolveFeatureIntroPresentation({
    ...base, dateKey: '2026-07-30'
  }), 'hidden');
  assert.equal(bubble.resolveFeatureIntroPresentation({
    ...base, identity: 'user-b'
  }), 'expanded');
  assert.equal(bubble.resolveFeatureIntroPresentation({
    ...base, introVersion: 'capabilities-v2'
  }), 'expanded');
});
