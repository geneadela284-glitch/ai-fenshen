import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);

async function source(file) {
  try {
    return await readFile(new URL(file, root), 'utf8');
  } catch {
    return '';
  }
}

test('prototype is decomposed into focused interactive components', async () => {
  const files = [
    'AIFenshenPrototypeApp.jsx',
    'AIFenshenWordmark.jsx',
    'LoginExperience.jsx',
    'HomeAmbientScene.jsx',
    'ReminderBubbleSequence.jsx',
    'AIBrainAvatar.jsx',
    'ChatComposer.jsx',
    'ImmersiveChatView.jsx',
    'ChatMessageList.jsx',
    'MotionPreferences.js'
  ];

  for (const file of files) {
    assert.notEqual(await source(file), '', `${file} must exist`);
  }
});

test('prototype app exposes stable state and interaction test ids', async () => {
  const app = await source('AIFenshenPrototypeApp.jsx');
  const renderedSources = app
    + await source('LoginExperience.jsx')
    + await source('HomeAmbientScene.jsx')
    + await source('DailyAgenda.jsx')
    + await source('BrainFunctionRing.jsx')
    + await source('ImmersiveChatView.jsx')
    + await source('ChatComposer.jsx');

  for (const testId of ['login-view', 'home-view', 'daily-agenda', 'brain-ring', 'chat-view', 'chat-composer']) {
    assert.match(renderedSources, new RegExp(`data-testid=["']${testId}["']`));
  }
  assert.match(app, /prototypeReducer/);
  assert.match(app, /CHAT_ENTERED/);
  assert.match(app, /CHAT_EXITED/);
});

test('critical transitions use LazyMotion and real animation completion events', async () => {
  const app = await source('AIFenshenPrototypeApp.jsx');
  const animatedComponents = await Promise.all([
    source('HomeAmbientScene.jsx'),
    source('ImmersiveChatView.jsx'),
    source('ReminderBubbleSequence.jsx'),
    source('BrainFunctionRing.jsx'),
    source('AIFenshenWordmark.jsx'),
    source('ChatComposer.jsx'),
    source('FaceLoginPanel.jsx')
  ]).then((parts) => parts.join('\n'));

  assert.match(app, /LazyMotion/);
  assert.match(app, /domAnimation/);
  assert.match(app, /AnimatePresence/);
  assert.match(app + animatedComponents, /motion\/react-m/);
  assert.match(app, /useReducedMotion/);
  assert.match(app + animatedComponents, /onAnimationComplete|onExitComplete/);
  assert.doesNotMatch(app, /setTimeout\([^)]*CHAT_ENTERED/s);
  assert.doesNotMatch(app, /setTimeout\([^)]*CHAT_EXITED/s);
  assert.match(app, /reduced-motion-chat/);
});

test('Motion-owned nodes do not retain competing CSS transform, opacity, or filter animations', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.doesNotMatch(css, /\.af-home\s*\{[^}]*transition:[^}]*(?:opacity|filter|transform)/s);
  assert.doesNotMatch(css, /\.af-home\.is-(?:leaving|returning)\s*\{[^}]*(?:opacity|filter|transform|animation):/s);
  assert.doesNotMatch(css, /\.af-chat-(?:entering|exiting)\s*\{[^}]*(?:opacity|transform|animation):/s);
  assert.doesNotMatch(css, /\.af-brain-ring\s*\{[^}]*transition:[^}]*opacity/s);
  assert.doesNotMatch(css, /\.af-brain-function\s*\{[^}]*(?:transition|transform|opacity):/s);
  assert.doesNotMatch(css, /\.af-reminder-bubble\s*\{[^}]*animation:/s);
});

test('development-only query entry leaves the production app path unchanged', async () => {
  const main = await readFile(new URL('../../main.jsx', import.meta.url), 'utf8');

  assert.match(main, /uiPrototype/);
  assert.match(main, /ai-fenshen-v2/);
  assert.match(main, /import\.meta\.env\.DEV/);
});

test('approved UI is the default real mode while the screenshot prototype remains development-only', async () => {
  const main = await readFile(new URL('../../main.jsx', import.meta.url), 'utf8');
  const realApp = await source('AIFenshenRealApp.jsx');

  assert.match(main, /aiFenshen/);
  assert.match(main, /AIFenshenRealApp/);
  assert.match(main, /uiPrototype/);
  assert.match(main, /import\.meta\.env\.DEV/);
  assert.match(realApp, /fetchCurrentSession/);
  assert.match(realApp, /createRealConversationClient/);
  assert.doesNotMatch(realApp, /fakeAssistantReply|initialMessages|setInterval/);
  assert.doesNotMatch(realApp, /ownerId|userId|accountId/);
});

test('public root defaults to the real AI Fenshen and retains only the explicit development prototype override', async () => {
  const main = await readFile(new URL('../../main.jsx', import.meta.url), 'utf8');

  assert.match(main, /import\.meta\.env\.DEV\s*&&\s*prototypeId\s*===\s*['"]ai-fenshen-v2['"]/);
  assert.match(main, /const RootApp = isAIFenshenPrototype\s*\?\s*\(await import\(['"]\.\/prototypes\/aiFenshen\/AIFenshenPrototypeApp\.jsx['"]\)\)\.default\s*:\s*\(await import\(['"]\.\/prototypes\/aiFenshen\/AIFenshenRealApp\.jsx['"]\)\)\.default/s);
  assert.doesNotMatch(main, /import App from ['"]\.\/App\.jsx['"]/);
  assert.doesNotMatch(main, /:\s*App\s*;/);
});

test('prototype CSS guarantees viewport fill, safe areas, hidden home interactions, and reduced motion', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /--af-app-height/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /min-(?:width|height):\s*44px/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /overflow-y:\s*auto/);
  assert.doesNotMatch(css, /width:\s*100vw/);
  assert.doesNotMatch(css, /transition:\s*height/);
});

test('installed app reserves the system status bar and keeps viewport safe-area support', async () => {
  const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');

  assert.match(html, /<meta\s+name=["']viewport["']\s+content=["'][^"']*viewport-fit=cover[^"']*["']\s*\/?>/i);
  assert.match(html, /<meta\s+name=["']apple-mobile-web-app-status-bar-style["']\s+content=["']default["']\s*\/?>/i);
});

test('home becomes natively inert while immersive chat is entering', async () => {
  const home = await source('HomeAmbientScene.jsx');

  assert.match(home, /inert=\{leaving\}/);
  assert.doesNotMatch(home, /inert=\{leaving \? ['"]{2} : undefined\}/);
});

test('all visible product copy uses the AI分身 identity', async () => {
  const combined = await Promise.all([
    source('AIFenshenPrototypeApp.jsx'),
    source('AIFenshenWordmark.jsx'),
    source('LoginExperience.jsx'),
    source('HomeAmbientScene.jsx'),
    source('ImmersiveChatView.jsx')
  ]).then((parts) => parts.join('\n'));

  assert.match(combined, /AI分身/);
  assert.doesNotMatch(combined, /AI工作秘书|AI秘书|AI Work Secretary|Work Secretary/);
});

test('login prototype renders real credential and face-enrollment states instead of copy-only placeholders', async () => {
  const app = await source('AIFenshenPrototypeApp.jsx');
  const login = await source('LoginExperience.jsx');
  const credentials = await source('CredentialsLoginCard.jsx');
  const enrollment = await source('FaceEnrollmentPrompt.jsx');

  assert.match(app, /loginState/);
  assert.match(app, /loginScreenState/);
  const loginStateSources = login + credentials + await source('credentialFlowState.js') + await source('loginMockState.js');
  assert.match(loginStateSources, /unregistered/);
  assert.match(loginStateSources, /registered_no_face/);
  assert.match(loginStateSources, /face_ready/);
  assert.match(login, /CredentialsLoginCard/);
  assert.match(credentials, /FaceEnrollmentPrompt/);
  assert.match(credentials, /登录/);
  assert.match(credentials, /注册/);
  assert.match(credentials, /手机号/);
  assert.match(credentials, /邮箱/);
  assert.match(credentials, /验证码/);
  assert.match(credentials, /密码/);
  assert.match(enrollment, /开启人脸识别，更快登录/);
  assert.match(enrollment, /立即录入/);
  assert.match(enrollment, /暂不设置/);
});

test('entry=home and all mock login outcomes can enter prototype home', async () => {
  const app = await source('AIFenshenPrototypeApp.jsx');
  const login = await source('LoginExperience.jsx');
  const credentials = await source('CredentialsLoginCard.jsx');

  assert.match(app, /search\.get\(['"]entry['"]\)/);
  assert.match(app, /entry\s*===\s*['"]home['"]/);
  assert.match(app, /handleCredentialComplete/);
  assert.match(app + login + credentials, /onEnterHome/);
  assert.match(login, /一键登录/);
  assert.match(login, /其他登录方式/);
});

test('first credential layer is lightweight and registration is staged', async () => {
  const credentials = await source('CredentialsLoginCard.jsx');
  const state = await source('credentialFlowState.js');

  for (const label of ['手机号继续', '邮箱继续', '已有账号登录']) assert.match(credentials, new RegExp(label));
  for (const step of ['choice', 'identifier', 'code', 'password', 'success', 'enrollment']) assert.match(state, new RegExp(step));
  assert.match(credentials, /AnimatePresence/);
  assert.doesNotMatch(credentials, /确认密码/);
});

test('visual viewport is rAF throttled through CSS properties without React pixel state', async () => {
  const app = await source('AIFenshenPrototypeApp.jsx');
  const hook = await source('useStableVisualViewport.js');

  assert.match(app, /useStableVisualViewport/);
  assert.doesNotMatch(app, /setKeyboardInset/);
  assert.match(hook, /requestAnimationFrame/);
  assert.match(hook, /--af-app-height/);
  assert.doesNotMatch(hook, /--af-keyboard-offset/);
  assert.doesNotMatch(hook, /classList\.toggle\(['"]has-keyboard['"]/);
  assert.match(hook, /CSS\.supports\(['"]height:\s*100dvh['"]\)/);
  assert.match(hook, /100vh/);
  assert.match(hook, /history\.scrollRestoration\s*=\s*['"]manual['"]/);
  assert.match(hook, /addEventListener\(['"]pageshow['"]/);
  assert.match(hook, /addEventListener\(['"]focusout['"]/);
  assert.doesNotMatch(hook, /scrollIntoView/);
  assert.match(hook, /removeEventListener/);
});

test('active chat owns one fixed viewport and one scrolling message list', async () => {
  const css = await source('aiFenshenPrototype.css');
  const list = await source('ChatMessageList.jsx');
  const composer = await source('ChatComposer.jsx');

  assert.match(css, /\.af-chat\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*overflow:\s*clip/s);
  assert.match(css, /\.af-chat-message-stage\s*\{[^}]*overflow:\s*clip/s);
  assert.match(css, /\.af-message-list\s*\{[^}]*overflow-y:\s*auto[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.af-chat-top-controls\s*\{[^}]*position:\s*fixed[^}]*top:\s*0/s);
  assert.doesNotMatch(css, /\.af-chat-top-controls\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /body\.af-prototype-active\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/s);
  assert.match(css, /\.af-chat-composer\s*\{[^}]*position:\s*relative/s);
  assert.doesNotMatch(list, /scrollIntoView/);
  assert.doesNotMatch(list, /\[followLatest, messages\]/);
  assert.match(list, /requestAnimationFrame/);
  assert.match(list, /latestContentLength/);
  assert.match(list, /\[followLatest, messages\.length, latestContentLength\]/);
  assert.doesNotMatch(composer, /scale:\s*1\.003/);
});

test('chat messages, composer and back-to-bottom control share one side-padding baseline', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /\.af-prototype-canvas\s*\{[^}]*--af-chat-side-padding:\s*16px/s);
  assert.match(css, /\.af-message-list-inner\s*\{[^}]*padding:[^;]*var\(--af-chat-side-padding\)[^;]*var\(--af-chat-side-padding\)/s);
  assert.match(css, /\.af-chat-composer\s*\{[^}]*padding-right:\s*calc\(var\(--af-chat-side-padding\)\s*\+\s*env\(safe-area-inset-right[^}]*padding-left:\s*calc\(var\(--af-chat-side-padding\)\s*\+\s*env\(safe-area-inset-left/s);
  assert.match(css, /\.af-back-to-bottom\s*\{[^}]*right:\s*calc\(var\(--af-chat-side-padding\)\s*\+\s*env\(safe-area-inset-right/s);
  assert.match(css, /\.af-message\.is-assistant\s*\{[^}]*padding-inline:\s*0/s);
});

test('mobile composer uses inset padding, one glass surface, and one submit path', async () => {
  const css = await source('aiFenshenPrototype.css');
  const composer = await source('ChatComposer.jsx');

  assert.match(css, /\.af-chat-composer\s*\{[^}]*width:\s*auto[^}]*margin:\s*0[^}]*padding-right:\s*calc\(var\(--af-chat-side-padding\)\s*\+\s*env\(safe-area-inset-right[^}]*padding-left:\s*calc\(var\(--af-chat-side-padding\)\s*\+\s*env\(safe-area-inset-left/s);
  assert.match(css, /\.af-composer\s*\{[^}]*border:\s*1px solid var\(--af-glass-border\)[^}]*background:[^}]*var\(--af-glass-fill\)[^}]*box-shadow:/s);
  assert.match(css, /\.af-composer\s*\{[^}]*backdrop-filter:\s*blur\(var\(--af-surface-blur\)\)/s);
  assert.match(css, /\.af-composer:focus-within\s*\{[^}]*border-color:[^}]*var\(--af-glass-highlight\)[^}]*box-shadow:/s);
  assert.match(css, /\.af-composer textarea:focus-visible\s*\{[^}]*outline:\s*none[^}]*box-shadow:\s*none/s);
  assert.doesNotMatch(css, /\.af-chat-composer\s*\{[^}]*width:\s*calc/s);
  assert.doesNotMatch(css, /100vw/);

  assert.match(composer, /const submitMessage\s*=\s*\(\)\s*=>/);
  assert.match(composer, /event\.nativeEvent\.isComposing/);
  assert.match(composer, /event\.preventDefault\(\);\s*submitMessage\(\);/s);
  assert.match(composer, /onClick=\{submitMessage\}/);
});

test('brain menu is compact and reminder bubbles have a no-agenda fallback', async () => {
  const ring = await source('BrainFunctionRing.jsx');
  const reminder = await source('ReminderBubbleSequence.jsx');
  const fakeData = await source('fakeData.js');

  assert.match(ring, /BRAIN_FUNCTION_ORBIT_ANGLES/);
  assert.match(ring, /--brain-orbit-angle/);
  assert.match(reminder, /轻触看清/);
  assert.match(fakeData, /featureIntroItems/);
});

test('home uses only dual task bubbles while the brain control remains centered and visibly interactive', async () => {
  const home = await source('HomeAmbientScene.jsx');
  const reminder = await source('ReminderBubbleSequence.jsx');
  const brain = await source('AIBrainAvatar.jsx');
  const css = await source('aiFenshenPrototype.css');

  assert.match(home, /<DualTaskBubbles/);
  assert.doesNotMatch(home, /<DailyAgenda/);
  assert.doesNotMatch(home, /showReminderHint/);
  assert.doesNotMatch(reminder, /af-reminder-guide/);
  assert.doesNotMatch(reminder, /轻点气泡，查看提醒与功能/);
  assert.match(css, /\.af-task-bubble-card\s*\{[^}]*border-radius:\s*50%/s);
  assert.doesNotMatch(css, /\.af-reminder-guide/);

  assert.match(brain, /af-brain-core/);
  assert.match(css, /\.af-brain-hotspot\s*\{[^}]*inset:\s*0[^}]*place-items:\s*center/s);
  assert.match(css, /\.af-brain-core\s*\{[^}]*width:\s*100%[^}]*height:\s*100%[^}]*place-content:\s*center[^}]*place-items:\s*center/s);
  assert.match(css, /\.af-brain-hotspot\s*\{[^}]*box-shadow:[^}]*var\(--af-glow\)/s);
  assert.match(css, /\.af-brain-hotspot:hover[^{]*\{[^}]*box-shadow:/s);
  assert.match(css, /@keyframes af-brain-pulse/);
});

test('mobile home uses a clipped fluid viewport and safe-area anchored controls', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /body\.af-prototype-active\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.af-theme\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*min-width:\s*0[^}]*overflow-x:\s*clip/s);
  assert.match(css, /\.af-prototype-canvas\s*\{[^}]*--af-safe-left:\s*max\(16px,\s*env\(safe-area-inset-left[^}]*--af-safe-right:\s*max\(16px,\s*env\(safe-area-inset-right[^}]*--af-safe-bottom:\s*max\(12px,\s*env\(safe-area-inset-bottom/s);
  assert.match(css, /\.af-prototype-canvas\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*min-height:\s*0[^}]*height:\s*var\(--af-app-height,\s*100vh\)[^}]*overflow:\s*clip/s);
  assert.match(css, /@supports\s*\(height:\s*100dvh\)/);
  assert.match(css, /\.af-home\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*min-width:\s*0[^}]*overflow-x:\s*clip/s);
  assert.match(css, /\.af-home-header\s*\{[^}]*padding-right:\s*var\(--af-safe-right\)[^}]*padding-left:\s*var\(--af-safe-left\)/s);
  assert.match(css, /\.af-reminder-skip\s*\{[^}]*right:\s*var\(--af-safe-right\)/s);
  assert.match(css, /\.af-daily-agenda\s*\{[^}]*left:\s*var\(--af-safe-left\)/s);
  assert.match(css, /\.af-home-composer\s*\{[^}]*bottom:\s*var\(--af-safe-bottom\)/s);
  assert.doesNotMatch(css, /100vw/);
});

test('brain trigger is anchored to the source-image ear center rather than the screen edge', async () => {
  const home = await source('HomeAmbientScene.jsx');
  const brain = await source('AIBrainAvatar.jsx');
  const css = await source('aiFenshenPrototype.css');

  assert.match(home, /af-home-hero-visual/);
  assert.match(home, /<div className="af-home-avatar"[^>]*\/>\s*<AIBrainAvatar/s);
  assert.match(css, /\.af-home-hero-visual\s*\{[^}]*--brain-center-x:\s*var\(--af-brain-center-x\)[^}]*--brain-center-y:\s*var\(--af-brain-center-y\)/s);
  assert.match(css, /\.af-home-hero-visual\s*\{[^}]*min-width:\s*calc\(100% \+ 4px\)[^}]*min-height:\s*calc\(100% \+ 4px\)[^}]*aspect-ratio:\s*var\(--af-avatar-aspect-ratio\)/s);
  assert.match(css, /\.af-brain-avatar\s*\{[^}]*left:\s*var\(--brain-center-x\)[^}]*top:\s*var\(--brain-center-y\)[^}]*width:\s*76px[^}]*height:\s*76px[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
  assert.doesNotMatch(css, /\.af-brain-avatar\s*\{[^}]*(?:right:|margin-(?:top|left):)/s);
  assert.match(brain, /className="af-brain-icon"/);
  assert.match(brain, /className="af-brain-label"/);
  assert.match(css, /\.af-brain-icon\s*\{[^}]*left:\s*50%[^}]*top:\s*50%[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
  assert.match(css, /\.af-brain-label\s*\{[^}]*left:\s*50%[^}]*top:\s*calc\(50%\s*\+\s*22px\)[^}]*transform:\s*translateX\(-50%\)/s);
  assert.doesNotMatch(home + brain + css, /brain-center-debug/);
});

test('day and night backgrounds remain ungraded while preserving source ear-center alignment', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /\.af-home-ambient-glow::before\s*\{[^}]*background:\s*none[^}]*opacity:\s*0/s);
  assert.match(css, /\.af-home-ambient-glow::after\s*\{[^}]*background:\s*none[^}]*opacity:\s*0/s);
  assert.match(css, /\.af-home-vignette\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.af-home-avatar\s*\{[^}]*background-image:\s*var\(--af-avatar-asset\)[^}]*background-size:\s*cover[^}]*filter:\s*none/s);
  assert.match(css, /\.af-home-hero-visual\s*\{[^}]*--brain-center-x:\s*var\(--af-brain-center-x\)[^}]*--brain-center-y:\s*var\(--af-brain-center-y\)/s);
  assert.match(css, /\[data-af-theme='day-sky'\]\s+\.af-brain-hotspot\s*\{[^}]*rgba\(222,\s*247,\s*255,\s*0\.82\)[^}]*rgba\(31,\s*151,\s*255,\s*0\.72\)/s);
  assert.match(css, /\[data-af-theme='day-sky'\]\s+\.af-brain-pulse\s*\{[^}]*rgba\(235,\s*251,\s*255,\s*0\.62\)[^}]*rgba\(121,\s*215,\s*255,\s*0\.72\)/s);
  assert.doesNotMatch(css, /ai-fenshen-avatar-day-sky-landscape/);
});

test('keyboard and safe-area surfaces keep one continuous dark background', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /html\.af-prototype-active,[\s\S]*body\.af-prototype-active #root\s*\{[^}]*background:\s*#00040d[^}]*color-scheme:\s*dark/s);
  assert.match(css, /\.af-theme\s*\{[^}]*min-height:\s*100vh[^}]*min-height:\s*100dvh[^}]*background:\s*#00040d/s);
  assert.match(css, /\.af-chat\s*\{[^}]*background:\s*var\(--af-background\)/s);
  assert.match(css, /\.af-chat-composer\s*\{[^}]*background-color:\s*var\(--af-background\)[^}]*background-image:\s*linear-gradient/s);
  assert.doesNotMatch(css, /(?:\.af-chat|\.af-chat-composer|\.af-theme)\s*\{[^}]*(?:#fff|#ffffff|white)/i);
});

test('AI分身 wordmark uses the permanent transparent brand asset', async () => {
  const wordmark = await source('AIFenshenWordmark.jsx');
  const css = await source('aiFenshenPrototype.css');

  assert.match(wordmark, /ai-fenshen-logo-primary\.png/);
  assert.match(wordmark, /af-wordmark-asset/);
  assert.doesNotMatch(wordmark, /af-wordmark-echo|af-wordmark-orbit/);
  assert.match(css, /\.af-wordmark-asset\s*\{[^}]*object-fit:\s*contain/s);
});

test('face-ready login restores the original bottom layout and shares one card width', async () => {
  const css = await source('aiFenshenPrototype.css');
  const faceReadyRule = css.match(/\.af-login-controls\.is-face-ready\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(css, /\.af-login-controls\s*\{[^}]*right:\s*16px[^}]*bottom:\s*calc\(13px\s*\+\s*env\(safe-area-inset-bottom\)\)[^}]*left:\s*16px/s);
  assert.match(css, /\.af-login-controls\.is-face-ready\s*\{[^}]*--af-login-action-width:\s*min\(100%,\s*330px\)/s);
  assert.doesNotMatch(faceReadyRule, /^\s*(?:top|right|bottom|left|transform|width|max-width):/m);
  assert.match(css, /\.af-login-controls\.is-face-ready\s+\.af-face-login,[\s\S]*\.af-login-controls\.is-face-ready\s+\.af-face-one-tap\s*\{[^}]*width:\s*var\(--af-login-action-width\)[^}]*box-sizing:\s*border-box/s);
  assert.match(css, /\.af-face-login\s*\{[^}]*background:\s*rgba\(5,\s*25,\s*62,\s*0\.42\)[^}]*backdrop-filter:\s*blur\(14px\)[^}]*border:\s*1px solid rgba\(100,\s*160,\s*255,\s*0\.28\)/s);
  assert.match(css, /\.af-face-one-tap\s*\{[^}]*margin-top:\s*14px[^}]*background:\s*rgba\(25,\s*70,\s*145,\s*0\.38\)[^}]*backdrop-filter:\s*blur\(12px\)[^}]*border:\s*1px solid rgba\(105,\s*165,\s*255,\s*0\.32\)/s);
});

test('real chat top controls are light floating safe-area controls with a direct new-conversation action', async () => {
  const chat = await source('ImmersiveChatView.jsx');
  const css = await source('aiFenshenPrototype.css');

  assert.match(chat, /className="af-chat-top-controls"/);
  assert.match(chat, /aria-label="返回首页"/);
  assert.match(chat, /aria-label="新建对话"/);
  assert.match(chat, /Icon name="edit"/);
  assert.ok(chat.indexOf('className="af-chat-top-controls"') < chat.indexOf('className="af-chat-message-stage"'));
  assert.match(css, /\.af-chat-top-controls\s*\{[^}]*position:\s*fixed[^}]*top:\s*0[^}]*padding-top:\s*env\(safe-area-inset-top/s);
  assert.match(css, /\.af-chat-top-control\s*\{[^}]*width:\s*44px[^}]*height:\s*44px[^}]*backdrop-filter:\s*blur/s);
  assert.doesNotMatch(css, /\.af-chat-top-controls\s*\{[^}]*(?:border-bottom|background:\s*rgba\([^)]*,\s*0\.[6-9])/s);
  assert.match(css, /\.af-message-list-inner\s*\{[^}]*padding-top:\s*calc\([^}]*safe-area-inset-top/s);
});

test('real login and composer stay within mobile safe-area width under keyboard compression', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /\.is-login-real\s+\.af-login-controls\.is-credentials\s*\{[^}]*left:\s*calc\(12px\s*\+\s*env\(safe-area-inset-left[^}]*right:\s*calc\(12px\s*\+\s*env\(safe-area-inset-right[^}]*width:\s*auto[^}]*max-width:\s*480px[^}]*transform:\s*none/s);
  assert.match(css, /\.is-login-real\s+\.af-credential-card\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s);
  assert.match(css, /\.af-composer\s*>\s*textarea\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(css, /\.af-chat-composer\s*\{[^}]*padding-right:\s*calc\(var\(--af-chat-side-padding\)[^}]*padding-left:\s*calc\(var\(--af-chat-side-padding\)/s);
  assert.doesNotMatch(css, /width:\s*100vw|margin-(?:left|right):\s*-/);
});

test('real-mode mobile form controls prevent iPhone Safari focus zoom', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /@media\s*\(max-width:\s*699px\)[\s\S]*?\.is-login-real\s+\.af-auth-field-single\s+input,[\s\S]*?\.af-prototype-canvas\[data-mode=['"]real['"]\]\s+\.af-composer\s*>\s*textarea\s*\{[^}]*font-size:\s*16px/s);
});

test('real-mode page shells cannot be horizontally auto-scrolled by focused controls', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /\.af-prototype-canvas\s*\{[^}]*overflow:\s*clip/s);
  assert.match(css, /\.af-login\s*\{[^}]*overflow:\s*clip[^}]*background:\s*var\(--af-background\)/s);
  assert.match(css, /\.af-home\s*\{[^}]*overflow:\s*clip[^}]*background:\s*var\(--af-background\)/s);
  assert.doesNotMatch(css, /\.(?:af-login|af-home)\s*\{[^}]*overflow(?:-[xy])?:\s*hidden/s);
});

test('real mode new conversation is lazy-created and settings uses the shared feature route', async () => {
  const app = await source('AIFenshenRealApp.jsx');

  assert.match(app, /NEW_CONVERSATION_MARKER/);
  assert.match(app, /setConversationId\(null\)/);
  assert.match(app, /setMessages\(\[\]\)/);
  assert.doesNotMatch(app, /createNewConversation[\s\S]{0,500}client\.createConversation\(/);
  assert.match(app, /showToast\(['"]已开始新对话['"]\)/);
  assert.match(app, /getFeature\(featureKey\)/);
  assert.match(app, /FeaturePlaceholderView/);
  assert.doesNotMatch(app, /设置功能开发中/);
  assert.match(app, /setTimeout\([^,]+,\s*2000\)/);
});

test('assistant messages use restricted Markdown without raw HTML injection', async () => {
  const message = await source('ChatMessage.jsx');
  const css = await source('aiFenshenPrototype.css');

  assert.match(message, /parseSafeMarkdown/);
  assert.match(message, /codeBlock/);
  assert.match(message, /ordered/);
  assert.doesNotMatch(message, /dangerouslySetInnerHTML/);
  assert.match(css, /\.af-message-content p\s*\{[^}]*white-space:\s*pre-wrap/s);
});

test('immersive chat keeps lightweight floating return and new-conversation controls', async () => {
  const chat = await source('ImmersiveChatView.jsx');
  const css = await source('aiFenshenPrototype.css');

  assert.match(chat, /aria-label="返回首页"/);
  assert.match(chat, /aria-label="新建对话"/);
  assert.match(chat, /name="edit"/);
  assert.match(css, /\.af-chat-top-controls\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.af-chat-top-control\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px[^}]*background:\s*rgba\(3,\s*17,\s*43,\s*0\.4\)/s);
});
