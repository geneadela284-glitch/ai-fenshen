import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getFeature } from './featureRegistry.js';
import { createFinanceClient } from './financeClient.js';

test('finance registry entry is available and routes to the real Finance view', () => {
  const finance = getFeature('finance');
  assert.equal(finance.status, 'available');
  assert.equal(finance.view, 'finance');
  assert.equal(finance.route, 'finance');
});
test('Finance client reads overview and edits/deletes through Finance API', async () => {
  const calls = [];
  const client = createFinanceClient({ fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, summary: {}, entries: [], capabilities: { monthly_report_export: { availability: 'enabled' } }, entry: { id: 'entry-1' } }) };
  } });
  const overview = await client.getOverview();
  await client.updateEntry('entry-1', { amountMinor: 2000, category: '购物' });
  await client.deleteEntry('entry-1');
  assert.deepEqual(calls.map((item) => [item.url, item.options.method || 'GET']), [
    ['/api/finance/overview', 'GET'],
    ['/api/finance/entries/entry-1', 'PATCH'],
    ['/api/finance/entries/entry-1', 'DELETE']
  ]);
  assert.equal(overview.capabilities.monthly_report_export.availability, 'enabled');
});

test('Finance client validates complete report MIME, size and server filename before returning a download', async () => {
  const pdfBlob = new Blob(['%PDF-valid-report'], { type: 'application/pdf' });
  const client = createFinanceClient({ fetchImpl: async (url) => {
    assert.equal(url, '/api/finance/reports/current-month?format=pdf');
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => ({
        'content-type': 'application/pdf',
        'content-length': String(pdfBlob.size),
        'content-disposition': "attachment; filename=finance-report.pdf; filename*=UTF-8''AI%E5%88%86%E8%BA%AB-2026%E5%B9%B47%E6%9C%88%E6%94%B6%E6%94%AF%E6%8A%A5%E8%A1%A8.pdf"
      })[name.toLowerCase()] || null },
      blob: async () => pdfBlob
    };
  } });
  const report = await client.downloadCurrentMonthReport('pdf');
  assert.equal(report.filename, 'AI分身-2026年7月收支报表.pdf');
  assert.equal(report.contentType, 'application/pdf');
  assert.equal(report.blob.size, pdfBlob.size);
});

test('Finance PDF delivery uses one synchronous same-origin navigation without an async popup', async () => {
  const financeClient = await import('./financeClient.js');
  assert.equal(typeof financeClient.openCurrentMonthPdf, 'function');
  const navigations = [];
  const result = financeClient.openCurrentMonthPdf({
    navigate: (url) => navigations.push(url)
  });
  assert.equal(result, '/api/finance/reports/current-month?format=pdf');
  assert.deepEqual(navigations, ['/api/finance/reports/current-month?format=pdf']);
  assert.equal(financeClient.openCurrentMonthPdf.constructor.name, 'Function');
});

test('Finance PDF delivery failure has a visible, specific user message', async () => {
  const view = await readFile(new URL('FinanceView.jsx', import.meta.url), 'utf8');
  assert.match(view, /PDF暂时无法打开，请稍后再试。/);
});

test('Finance client fails closed on empty or incorrectly typed report responses', async () => {
  for (const blob of [
    new Blob([], { type: 'application/pdf' }),
    new Blob(['not a pdf'], { type: 'text/plain' })
  ]) {
    const client = createFinanceClient({ fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? blob.type : null },
      blob: async () => blob
    }) });
    await assert.rejects(client.downloadCurrentMonthReport('pdf'), /报表暂时无法生成/);
  }
});

test('real Finance view exposes monthly cards, recent ten, detail, edit, delete and refresh without owner input', async () => {
  const root = new URL('.', import.meta.url);
  const view = await readFile(new URL('FinanceView.jsx', root), 'utf8');
  const app = await readFile(new URL('AIFenshenRealApp.jsx', root), 'utf8');
  const css = await readFile(new URL('aiFenshenPrototype.css', root), 'utf8');
  for (const copy of [
    '本月收入', '本月支出', '本月结余', '最近10笔账', '修改', '删除', '重新查询',
    '导出本月报表', '导出PDF', '导出Excel', '当前仅基于收支账本，完整资产负债分析尚未启用。',
    'AI财务分析', '未启用'
  ]) assert.match(view, new RegExp(copy));
  assert.doesNotMatch(view, /owner[_A-Z]?id/i);
  assert.doesNotMatch(view, /Provider|模型路由|aiService|prompt/i);
  assert.match(view, /iPhone\|iPad/);
  assert.match(app, /FinanceView/);
  assert.match(css, /af-finance-view/);
  assert.match(css, /af-finance-export-sheet/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /safe-area-inset-left/);
  assert.match(css, /safe-area-inset-right/);
  assert.match(css, /overflow-x:\s*(?:clip|hidden)/);
});
