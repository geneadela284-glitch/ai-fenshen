import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('RED: login cannot claim silent agreement and first authenticated use is gated by explicit privacy consent', async () => {
  const [login, app] = await Promise.all([
    source('RealAccountLogin.jsx'),
    source('AIFenshenRealApp.jsx')
  ]);
  assert.doesNotMatch(login, /登录即代表同意/);
  assert.match(login, /登录后.*明确同意/);
  assert.match(app, /PrivacyConsentView/);
  assert.match(app, /privacyConsent/);
});

test('RED: privacy notice requires an unchecked explicit control and exposes closed-beta data processing facts', async () => {
  const view = await source('PrivacyConsentView.jsx');
  assert.match(view, /useState\(false\)/);
  assert.match(view, /封闭测试/);
  assert.match(view, /VPS/);
  assert.match(view, /大模型 Provider/);
  assert.match(view, /密码、API Key、身份证件、银行卡/);
});

test('RED: settings has only the minimum self-service export and two-stage deletion controls', async () => {
  const settings = await source('RealSettingsView.jsx');
  assert.match(settings, /导出我的数据/);
  assert.match(settings, /删除我的账号/);
  assert.match(settings, /DELETE_MY_ACCOUNT/);
  assert.match(settings, /确认永久删除/);
  assert.doesNotMatch(settings, /账号管理后台|用户管理中心/);
});
