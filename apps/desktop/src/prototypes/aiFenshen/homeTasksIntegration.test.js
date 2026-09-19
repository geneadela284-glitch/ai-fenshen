import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('real home loads Tasks from the authenticated API and exposes retry and completion actions', async () => {
  const app = await source('AIFenshenRealApp.jsx');
  assert.match(app, /createTasksClient/);
  assert.match(app, /getTodayTomorrow/);
  assert.match(app, /resolvedOptions\(\)\.timeZone/);
  assert.match(app, /tasksReloadKey/);
  assert.match(app, /complete\(task\.id\)/);
  assert.match(app, /restore\(task\.id\)/);
  assert.doesNotMatch(app, /ownerId|userId|accountId/);
});

test('production Tasks home path uses two task bubbles with loading empty and error states', async () => {
  const [home, bubbles, tasksClient] = await Promise.all([
    source('HomeAmbientScene.jsx'),
    source('DualTaskBubbles.jsx'),
    readFile(new URL('../../lib/tasksClient.js', import.meta.url), 'utf8')
  ]);
  const productionHome = home + bubbles + tasksClient;

  assert.match(home, /tasksState=\{tasksState\}/);
  assert.match(home, /DualTaskBubbles/);
  assert.doesNotMatch(home, /<DailyAgenda/);
  assert.match(bubbles, /正在加载事项/);
  assert.match(bubbles, /事项加载失败/);
  assert.match(bubbles, /重试/);
  assert.match(bubbles, /is-today/);
  assert.match(bubbles, /is-tomorrow/);
  assert.match(bubbles, /status === 'pending'/);
  assert.doesNotMatch(productionHome, /from ['"]\.\/fakeData\.js['"]/);
  assert.doesNotMatch(bubbles, /显示更多|暂无事项/);
});

test('task bubbles show one pending item, index dots, highlight advance and pop without changing task status', async () => {
  const bubbles = await source('DualTaskBubbles.jsx');
  assert.match(bubbles, /formatTaskTime/);
  assert.match(bubbles, /待安排/);
  assert.match(bubbles, /待完成/);
  assert.match(bubbles, /currentIndex/);
  assert.match(bubbles, /highlighted/);
  assert.match(bubbles, /poppedAt/);
  assert.match(bubbles, /transitioning/);
  assert.doesNotMatch(bubbles, /onTaskToggle|complete\(|restore\(/);
});

test('mobile task bubbles are round, separated and clear of the safe-area composer', async () => {
  const css = await source('aiFenshenPrototype.css');
  assert.match(css, /\.af-task-bubble\.is-tomorrow\s*\{[^}]*top:/s);
  assert.match(css, /\.af-task-bubble\.is-today\s*\{[^}]*bottom:\s*calc\(var\(--af-safe-bottom\)\s*\+\s*132px\)/s);
  assert.match(css, /\.af-task-bubble-card\s*\{[^}]*aspect-ratio:\s*1[^}]*border-radius:\s*50%/s);
  assert.match(css, /\.af-task-bubble-card\s*\{[^}]*backdrop-filter:/s);
  assert.match(css, /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*500px\)[\s\S]*\.af-task-bubble\.is-today/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.af-task-bubble-card/s);
});

test('real settings exposes per-user automatic day and night preference', async () => {
  const [app, settings] = await Promise.all([
    source('AIFenshenRealApp.jsx'),
    source('RealSettingsView.jsx')
  ]);
  assert.match(app, /themePreference/);
  assert.match(app, /session\.user\?\.id/);
  assert.match(settings, /自动/);
  assert.match(settings, /白天/);
  assert.match(settings, /夜晚/);
  assert.match(settings, /onThemePreferenceChange/);
});
