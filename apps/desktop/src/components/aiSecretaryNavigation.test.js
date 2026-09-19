import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_SECRETARY_NAVIGATOR_ENTRIES } from './aiSecretaryNavigation.js';

test('AI secretary navigator exposes only product-approved entries', () => {
  assert.deepEqual(AI_SECRETARY_NAVIGATOR_ENTRIES.map((entry) => entry.label), [
    '会议记录',
    '历史对话',
    '长期记忆',
    '日程与待办',
    '统计与报表',
    '资料库',
    '设置中心'
  ]);
});

test('AI secretary navigator entries do not invent HTTP API targets', () => {
  for (const entry of AI_SECRETARY_NAVIGATOR_ENTRIES) {
    assert.ok(!String(entry.target || '').startsWith('/api/'), `${entry.label} should not target a fake API`);
    assert.ok(['panel', 'drawer', 'route', 'status'].includes(entry.kind), `${entry.label} should use an existing UI capability kind`);
  }
});
