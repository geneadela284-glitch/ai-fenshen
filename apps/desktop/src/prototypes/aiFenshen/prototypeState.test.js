import assert from 'node:assert/strict';
import test from 'node:test';

async function loadPrototypeState() {
  try {
    return await import('./prototypeState.js');
  } catch {
    return null;
  }
}

test('prototype state module exposes the approved state-machine API', async () => {
  const subject = await loadPrototypeState();

  assert.equal(typeof subject?.createInitialPrototypeState, 'function');
  assert.equal(typeof subject?.prototypeReducer, 'function');
  assert.equal(typeof subject?.advanceReminder, 'function');
  assert.equal(typeof subject?.calculateComposerHeight, 'function');
  assert.equal(typeof subject?.calculateKeyboardInset, 'function');
  assert.equal(typeof subject?.isNearBottom, 'function');
});

test('initial state keeps login, home, chat, and composer modes mutually exclusive', async () => {
  const { createInitialPrototypeState } = await import('./prototypeState.js');
  const state = createInitialPrototypeState();

  assert.equal(state.appView, 'login');
  assert.equal(state.loginState, 'idle');
  assert.equal(state.homeState, 'reminderSequence');
  assert.equal(state.chatTransitionState, 'inactive');
  assert.equal(state.composerState, 'idle');
  assert.equal(state.themeId, 'deep-blue');
});

test('login simulation enters the home without touching real authentication', async () => {
  const { createInitialPrototypeState, prototypeReducer } = await import('./prototypeState.js');
  let state = createInitialPrototypeState();

  state = prototypeReducer(state, { type: 'LOGIN_SCAN' });
  assert.equal(state.loginState, 'scanning');
  state = prototypeReducer(state, { type: 'LOGIN_SUCCESS' });
  assert.equal(state.loginState, 'success');
  state = prototypeReducer(state, { type: 'ENTER_HOME' });
  assert.equal(state.appView, 'home');
  assert.equal(state.homeState, 'reminderSequence');
});

test('entering immersive chat closes the brain and reminder interactions', async () => {
  const { createInitialPrototypeState, prototypeReducer } = await import('./prototypeState.js');
  let state = { ...createInitialPrototypeState(), appView: 'home', homeState: 'brainOpen' };

  state = prototypeReducer(state, { type: 'ENTER_CHAT' });
  assert.equal(state.appView, 'immersiveChat');
  assert.equal(state.homeState, 'idle');
  assert.equal(state.chatTransitionState, 'entering');
  state = prototypeReducer(state, { type: 'CHAT_ENTERED' });
  assert.equal(state.chatTransitionState, 'active');
  state = prototypeReducer(state, { type: 'EXIT_CHAT' });
  assert.equal(state.chatTransitionState, 'exiting');
  state = prototypeReducer(state, { type: 'CHAT_EXITED' });
  assert.equal(state.appView, 'home');
  assert.equal(state.chatTransitionState, 'inactive');
  assert.equal(state.homeState, 'idle');
});

test('account context reset returns owner-scoped UI to a clean home state', async () => {
  const { prototypeReducer } = await import('./prototypeState.js');
  const active = {
    appView: 'immersiveChat',
    loginState: 'success',
    homeState: 'brainOpen',
    chatTransitionState: 'active',
    composerState: 'streaming',
    themeId: 'violet'
  };

  assert.deepEqual(prototypeReducer(active, { type: 'RESET_ACCOUNT_CONTEXT' }), {
    appView: 'home',
    loginState: 'success',
    homeState: 'idle',
    chatTransitionState: 'inactive',
    composerState: 'idle',
    themeId: 'violet'
  });
});

test('stale animation completion events cannot override an interrupted transition', async () => {
  const { createInitialPrototypeState, prototypeReducer } = await import('./prototypeState.js');
  const initial = { ...createInitialPrototypeState(), appView: 'home', homeState: 'idle' };

  const entering = prototypeReducer(initial, { type: 'ENTER_CHAT' });
  const exitingBeforeEnterCompletes = prototypeReducer(entering, { type: 'EXIT_CHAT' });
  const staleEnterCompletion = prototypeReducer(exitingBeforeEnterCompletes, { type: 'CHAT_ENTERED' });
  assert.equal(staleEnterCompletion.chatTransitionState, 'exiting');

  const reenteringBeforeExitCompletes = prototypeReducer(exitingBeforeEnterCompletes, { type: 'ENTER_CHAT' });
  const staleExitCompletion = prototypeReducer(reenteringBeforeExitCompletes, { type: 'CHAT_EXITED' });
  assert.equal(staleExitCompletion.appView, 'immersiveChat');
  assert.equal(staleExitCompletion.chatTransitionState, 'entering');
});

test('reminder bubbles reveal first, then shatter and advance', async () => {
  const { advanceReminder } = await import('./prototypeState.js');
  const initial = { index: 0, phase: 'blurred', complete: false };
  const revealed = advanceReminder(initial, 2);
  const shattered = advanceReminder(revealed, 2);
  const next = advanceReminder(shattered, 2);
  const finalReveal = advanceReminder(next, 2);
  const finalShatter = advanceReminder(finalReveal, 2);
  const complete = advanceReminder(finalShatter, 2);

  assert.deepEqual(revealed, { index: 0, phase: 'clear', complete: false });
  assert.deepEqual(shattered, { index: 0, phase: 'shattering', complete: false });
  assert.deepEqual(next, { index: 1, phase: 'blurred', complete: false });
  assert.equal(complete.complete, true);
});

test('composer grows from 56px and caps at thirty percent of the viewport', async () => {
  const { calculateComposerHeight } = await import('./prototypeState.js');

  assert.equal(calculateComposerHeight({ scrollHeight: 30, viewportHeight: 812 }), 56);
  assert.equal(calculateComposerHeight({ scrollHeight: 180, viewportHeight: 812 }), 180);
  assert.equal(calculateComposerHeight({ scrollHeight: 420, viewportHeight: 812 }), 244);
});

test('visual viewport delta becomes a non-negative keyboard inset', async () => {
  const { calculateKeyboardInset } = await import('./prototypeState.js');

  assert.equal(calculateKeyboardInset({ innerHeight: 844, visualViewportHeight: 510, offsetTop: 0 }), 334);
  assert.equal(calculateKeyboardInset({ innerHeight: 844, visualViewportHeight: 844, offsetTop: 0 }), 0);
  assert.equal(calculateKeyboardInset({ innerHeight: 600, visualViewportHeight: 640, offsetTop: 0 }), 0);
});

test('day and night themes expose one complete token contract', async () => {
  const {
    THEME_IDS,
    THEME_TOKEN_KEYS,
    getThemeTokens,
    resolveThemeMode,
    themeIdForMode
  } = await import('./prototypeState.js');

  assert.ok(THEME_IDS.includes('day-sky'));
  assert.ok(THEME_IDS.includes('deep-blue'));
  for (const themeId of THEME_IDS) {
    assert.deepEqual(Object.keys(getThemeTokens(themeId)).sort(), [...THEME_TOKEN_KEYS].sort());
  }
  assert.equal(resolveThemeMode({
    preference: 'auto',
    now: new Date('2026-07-30T02:00:00.000Z'),
    timeZone: 'Asia/Shanghai'
  }), 'day');
  assert.equal(resolveThemeMode({
    preference: 'auto',
    now: new Date('2026-07-30T12:00:00.000Z'),
    timeZone: 'Asia/Shanghai'
  }), 'night');
  assert.equal(resolveThemeMode({ preference: 'day' }), 'day');
  assert.equal(resolveThemeMode({ preference: 'night' }), 'night');
  assert.equal(resolveThemeMode({
    preference: 'auto',
    timeZone: 'Invalid/Timezone',
    systemPrefersDark: true
  }), 'night');
  assert.equal(themeIdForMode('day'), 'day-sky');
  assert.equal(themeIdForMode('night'), 'deep-blue');
});

test('reduced motion uses the short transition and scroll policy respects readers', async () => {
  const { getMotionDuration, isNearBottom } = await import('./prototypeState.js');

  assert.equal(getMotionDuration(true), 140);
  assert.equal(getMotionDuration(false), 380);
  assert.equal(isNearBottom({ scrollTop: 601, clientHeight: 300, scrollHeight: 980 }), true);
  assert.equal(isNearBottom({ scrollTop: 120, clientHeight: 300, scrollHeight: 980 }), false);
});
