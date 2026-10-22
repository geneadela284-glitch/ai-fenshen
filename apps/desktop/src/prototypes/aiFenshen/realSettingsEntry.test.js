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

async function stateModule() {
  return import('./realSettingsState.js').catch(() => null);
}

test('real settings state sanitizes account and Provider data', async () => {
  const settings = await stateModule();
  assert.ok(settings, 'realSettingsState.js must exist');
  assert.equal(settings.maskAccountIdentifier('person@example.com'), 'p***@example.com');
  assert.equal(settings.maskAccountIdentifier('13812345678'), '138****5678');
  assert.equal(settings.maskAccountIdentifier('beta_user'), 'beta_user');
  assert.equal(settings.isAdminUser({ role: 'admin' }), true);
  assert.equal(settings.isAdminUser({ role: 'beta_user' }), false);

  const snapshot = settings.normalizeSafeAdminSettings({
    providers: [{
      id: 'deepseek',
      displayName: 'DeepSeek',
      apiKey: 'forbidden-secret',
      apiKeyConfigured: true,
      maskedApiKey: '****cret',
      baseUrl: 'https://provider.invalid',
      defaultModel: 'hidden-model',
      lastError: 'private provider failure',
      healthy: true,
      status: '可用'
    }]
  });
  assert.deepEqual(snapshot.providers, [{
    id: 'deepseek',
    label: 'DeepSeek',
    apiKeyConfigured: true,
    maskedApiKey: '****cret',
    healthy: true,
    status: '可用'
  }]);
  assert.doesNotMatch(JSON.stringify(snapshot), /forbidden-secret|provider\.invalid|hidden-model|private provider failure/);
});

test('real settings entry uses the authenticated user and existing server clients', async () => {
  const app = await source('AIFenshenRealApp.jsx');
  const view = await source('RealSettingsView.jsx');

  assert.notEqual(view, '', 'RealSettingsView.jsx must exist');
  assert.match(app, /RealSettingsView/);
  assert.match(app, /logoutAndClearNativeSession/);
  assert.match(app, /featureView === 'settings'/);
  assert.match(view, /fetchAdminAiSettings/);
  assert.match(view, /saveAdminProvider/);
  assert.match(view, /testAdminProvider/);
  assert.match(view, /currentUser\?\.role === 'admin'|isAdminUser\(currentUser\)/);
  assert.match(view, /type="password"/);
  assert.match(view, /保存成功/);
  assert.match(view, /连接成功，但状态保存失败/);
  assert.match(view, /setTimeout\(onBack, SAVE_RETURN_DELAY\)/);
  assert.match(view, /保存结果以本机回执为准/);
  assert.match(view, /你的专属AI数字分身/);
  assert.match(view, /退出登录/);
  assert.doesNotMatch(view, /dangerouslySetInnerHTML|databasePath|ownerId|entityId|confidence|baseUrl|defaultModel|router|token/i);
  assert.doesNotMatch(app, /localStorage\.clear\(\)/);
});

test('settings keeps one fixed safe-area return control and an internal scroll region', async () => {
  const view = await source('RealSettingsView.jsx');
  const css = await source('aiFenshenPrototype.css');

  assert.match(view, /data-testid="real-settings-view"/);
  assert.match(view, /aria-label="返回首页"/);
  assert.match(css, /\.af-settings-back\s*\{[^}]*position:\s*fixed[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
  assert.match(css, /\.af-settings-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.af-settings-view\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*min-width:\s*0/s);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.doesNotMatch(css, /\.af-settings[^}]*width:\s*100vw|\.af-settings[^}]*margin-(?:left|right):\s*-/s);
});

test('RED: settings keeps the only persistent entry for replaying a completed feature intro', async () => {
  const app = await source('AIFenshenRealApp.jsx');
  const view = await source('RealSettingsView.jsx');
  assert.match(view, /功能介绍/);
  assert.match(view, /onOpenFeatureIntro/);
  assert.match(app, /onOpenFeatureIntro/);
  assert.match(app, /setFeatureIntroPresentation\('manual'\)/);
});
