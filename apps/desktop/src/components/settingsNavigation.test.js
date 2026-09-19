import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadSettingsNavigation() {
  return import('./settingsNavigation.js').catch(() => null);
}

test('settings appearance is a secondary view that returns to settings home', async () => {
  const navigation = await loadSettingsNavigation();
  assert.ok(navigation, 'settings navigation module should exist');

  const appearance = navigation.reduceSettingsView(
    navigation.SETTINGS_VIEWS.HOME,
    { type: 'open-appearance' }
  );
  assert.equal(appearance, navigation.SETTINGS_VIEWS.APPEARANCE);
  assert.equal(
    navigation.reduceSettingsView(appearance, { type: 'back' }),
    navigation.SETTINGS_VIEWS.HOME
  );
});

test('privacy and data controls stay behind a secondary settings view', async () => {
  const navigation = await loadSettingsNavigation();
  assert.ok(navigation, 'settings navigation module should exist');

  const privacy = navigation.reduceSettingsView(
    navigation.SETTINGS_VIEWS.HOME,
    { type: 'open-privacy' }
  );
  assert.equal(privacy, navigation.SETTINGS_VIEWS.PRIVACY);
  assert.equal(
    navigation.reduceSettingsView(privacy, { type: 'back' }),
    navigation.SETTINGS_VIEWS.HOME
  );
});

test('ordinary settings entries hide administrator AI configuration', async () => {
  const navigation = await loadSettingsNavigation();
  assert.ok(navigation, 'settings navigation module should exist');

  const userEntries = navigation.getSettingsHomeEntries({ isAdmin: false });
  assert.deepEqual(userEntries.map((entry) => entry.id), [
    'profile',
    'appearance',
    'notifications',
    'privacy'
  ]);
  assert.ok(userEntries.every((entry) => !/Provider|API Key|路由/.test(`${entry.title}${entry.description}`)));
});

test('administrator settings entries include the AI service entry', async () => {
  const navigation = await loadSettingsNavigation();
  assert.ok(navigation, 'settings navigation module should exist');

  const adminEntries = navigation.getSettingsHomeEntries({ isAdmin: true });
  assert.equal(adminEntries.at(-1)?.id, 'ai-service');
  assert.equal(adminEntries.at(-1)?.title, 'AI 服务');
});

test('settings keeps an explicit sticky return control even without browser history', async () => {
  const appSource = await readFile(new URL('../App.jsx', import.meta.url), 'utf8');
  const shellSource = await readFile(new URL('../layouts/AppShell.jsx', import.meta.url), 'utf8');

  assert.match(appSource, /showSettings \|\| history\.length \? handleBack : null/);
  assert.match(appSource, /backLabel=\{showSettings \? '返回首页' : '返回'\}/);
  assert.match(shellSource, /sticky top-0/);
  assert.match(shellSource, /\{backLabel\}/);
});

test('privacy view is rendered after its import and export handlers are initialized', async () => {
  const settingsSource = await readFile(new URL('./SettingsPage.jsx', import.meta.url), 'utf8');
  const exportHandlerIndex = settingsSource.indexOf('const exportLocalData =');
  const privacyViewIndex = settingsSource.indexOf('activeView === SETTINGS_VIEWS.PRIVACY');

  assert.ok(exportHandlerIndex >= 0);
  assert.ok(privacyViewIndex > exportHandlerIndex);
});

test('browser Provider secrets migrate only after explicit administrator confirmation', async () => {
  const settingsSource = await readFile(new URL('./SettingsPage.jsx', import.meta.url), 'utf8');

  assert.match(settingsSource, /window\.confirm\('将现有 Provider 配置迁移到统一后端，迁移后所有设备共用此配置。'\)/);
  assert.match(settingsSource, /if \(accepted\) \{\s*remote = await importAdminAiSettings\(local\);\s*clearBrowserProviderSecrets\(local\);/s);
});

test('returning home releases the focused settings control', async () => {
  const navigation = await loadSettingsNavigation();
  assert.ok(navigation, 'settings navigation module should exist');
  let blurCount = 0;

  const released = navigation.releasePageFocus({
    activeElement: {
      blur() {
        blurCount += 1;
      }
    }
  });

  assert.equal(released, true);
  assert.equal(blurCount, 1);
});

test('AI secretary home composer does not force mobile keyboard focus on mount', async () => {
  const homeSource = await readFile(new URL('./WorkSecretaryHome.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(homeSource, /\sautoFocus(?:\s|\n|\/>)/);
  assert.ok(!homeSource.includes("window.setTimeout(() => textareaRef.current?.focus(), 120);"));
});
