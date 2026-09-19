import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const uiSubject = await import('./financeF201Ui.js').catch(() => ({}));

test('Finance F2.0-1 groups its timeline by the entry IANA timezone without changing rows', () => {
  assert.equal(typeof uiSubject.groupFinanceEntriesByDate, 'function');
  const entries = [
    { id: 'late', occurredAt: '2026-08-01T16:30:00.000Z', timezone: 'Asia/Shanghai' },
    { id: 'early', occurredAt: '2026-08-01T15:30:00.000Z', timezone: 'Asia/Shanghai' },
    { id: 'same-day', occurredAt: '2026-08-01T07:00:00.000Z', timezone: 'Asia/Shanghai' }
  ];

  const groups = uiSubject.groupFinanceEntriesByDate(entries);
  assert.deepEqual(groups.map(({ key, entries: rows }) => [key, rows.map(({ id }) => id)]), [
    ['2026-08-02', ['late']],
    ['2026-08-01', ['early', 'same-day']]
  ]);
  assert.equal(groups[0].entries[0], entries[0]);
});

test('Finance F2.0-1 creates a half-open custom day range and rejects reversed dates', () => {
  assert.equal(typeof uiSubject.customDateRange, 'function');
  assert.deepEqual(uiSubject.customDateRange('2026-08-01', '2026-08-02', 'Asia/Shanghai'), {
    period: 'custom',
    startAt: '2026-07-31T16:00:00.000Z',
    endAt: '2026-08-02T16:00:00.000Z'
  });
  assert.equal(uiSubject.customDateRange('2026-08-03', '2026-08-02'), null);
  assert.equal(uiSubject.customDateRange('', '2026-08-02'), null);
});

test('Finance F2.0-1 Revision labels distinguish archive and unarchive from their archivedAt change', () => {
  assert.equal(typeof uiSubject.financeRevisionLabel, 'function');
  assert.equal(uiSubject.financeRevisionLabel({
    mutationType: 'archive',
    changes: { archivedAt: { before: null, after: '2026-08-02T08:00:00.000Z' } }
  }), '归档账目');
  assert.equal(uiSubject.financeRevisionLabel({
    mutationType: 'archive',
    changes: { archivedAt: { before: '2026-08-02T08:00:00.000Z', after: null } }
  }), '取消归档');
  assert.equal(uiSubject.financeRevisionLabel({ mutationType: 'archive', changes: {} }), '归档状态变更');
  assert.equal(uiSubject.financeRevisionLabel({ mutationType: 'update' }), '修改账目');
});

test('Finance F2.0-1 UI exposes the approved dashboard, timeline, filters, lifecycle and state UX only in its strict branch', async () => {
  const view = await readFile(new URL('FinanceView.jsx', import.meta.url), 'utf8');
  for (const copy of [
    '个人财务驾驶舱', '本月收入', '本月支出', '本月结余', '询问 AI分身',
    '历史账目', '加载更多', '筛选账目', '自定义日期', '全部类型', '多选分类',
    '修改记录', '恢复', '归档', '取消归档', '未保存', '账本已在其他位置更新'
  ]) assert.match(view, new RegExp(copy));
  assert.match(view, /网络异常，历史账目暂时无法读取。/);
  assert.match(view, /viewState\.mode\s*===\s*'f201'/);
  assert.match(view, /loadHistory/);
  assert.match(view, /loadNextPage/);
  assert.match(view, /loadRevisions/);
  assert.match(view, /togglePrivacyAmounts/);
  assert.doesNotMatch(view, /预算|周期账单|转账|OCR|语音录入/);
});

test('real app passes the authenticated server Finance flag into FinanceView', async () => {
  const app = await readFile(new URL('AIFenshenRealApp.jsx', import.meta.url), 'utf8');
  assert.match(app, /<FinanceView[\s\S]*?financeF201Enabled=\{session\.featureFlags\?\.financeF201Enabled === true\}[\s\S]*?\/>/);
});

test('Finance F2.0-1 visual contract supports day and night, safe areas, dynamic text and iPhone touch targets', async () => {
  const css = await readFile(new URL('aiFenshenPrototype.css', import.meta.url), 'utf8');
  assert.match(css, /\.af-finance-f201/);
  assert.match(css, /\[data-af-theme='day-sky'\]\s+\.af-finance-f201/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /env\(safe-area-inset-(?:top|right|bottom|left)/);
  assert.match(css, /font-size:\s*clamp\(/);
  assert.match(css, /@media\s*\(max-width:\s*360px\)/);
  assert.match(css, /overflow-x:\s*(?:clip|hidden)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.af-finance-f201-metrics strong\s*\{[^}]*font-size:\s*clamp\(17px,\s*5\.5vw,\s*24px\)[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(css, /\.af-finance-f201-metrics strong\s*\{[^}]*(?:text-overflow|overflow:\s*hidden)/s);
}
);
