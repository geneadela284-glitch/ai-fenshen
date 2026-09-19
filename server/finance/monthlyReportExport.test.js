import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyFinanceMigrations } from './migrations.js';
import { handleFinanceApi } from './httpApi.js';
import {
  validateMonthlyFinanceReportSnapshot
} from './monthlyReportContract.js';
import { buildMonthlyFinancePdfViewModel, renderMonthlyFinancePdf } from './monthlyReportPdf.js';
import { renderMonthlyFinanceExcel } from './monthlyReportExcel.js';
import { buildFinanceQueryPlan } from './queryPlan.js';
import { FinanceRepository } from './repository.js';
import { FinanceService } from './service.js';

const TIMEZONE = 'Asia/Shanghai';
const NOW = new Date('2026-07-22T04:00:00.000Z');
const OWNER_A = 'owner-report-a';
const OWNER_B = 'owner-report-b';

function harness() {
  const database = new DatabaseSync(':memory:');
  applyFinanceMigrations(database);
  let sequence = 0;
  const repository = new FinanceRepository({
    database,
    timezone: TIMEZONE,
    clock: () => NOW,
    id: () => `report-entry-${++sequence}`
  });
  return { database, repository };
}

function createEntry(repository, {
  ownerId = OWNER_A,
  type,
  amountMinor,
  occurredAt,
  category,
  note = null
}) {
  return repository.create({
    ownerId,
    type,
    amountMinor,
    currency: 'CNY',
    occurredAt,
    timezone: TIMEZONE,
    category,
    note,
    sourceMessageId: `source-${ownerId}-${occurredAt}-${amountMinor}`,
    clientRequestId: `request-${ownerId}-${occurredAt}-${amountMinor}-${note || ''}`
  });
}

function seedKnownMonth(repository) {
  createEntry(repository, { type: 'income', amountMinor: 500000, occurredAt: '2026-06-30T16:30:00.000Z', category: '工资', note: '七月工资' });
  createEntry(repository, { type: 'expense', amountMinor: 1800, occurredAt: '2026-06-30T16:40:00.000Z', category: '餐饮', note: '早餐' });
  createEntry(repository, { type: 'expense', amountMinor: 3250, occurredAt: '2026-07-01T04:00:00.000Z', category: '交通', note: '打车' });
  createEntry(repository, { type: 'income', amountMinor: 300000, occurredAt: '2026-07-15T04:00:00.000Z', category: '客户回款', note: '客户款' });
  createEntry(repository, { type: 'expense', amountMinor: 6800, occurredAt: '2026-07-20T04:00:00.000Z', category: '购物', note: '买菜' });
  createEntry(repository, { type: 'expense', amountMinor: 2000, occurredAt: '2026-07-31T15:59:59.000Z', category: '其他', note: '月末' });

  const deleted = createEntry(repository, { type: 'expense', amountMinor: 9900, occurredAt: '2026-07-02T04:00:00.000Z', category: '购物', note: '已删除' });
  repository.softDelete({ ownerId: OWNER_A, id: deleted.id });
  createEntry(repository, { type: 'expense', amountMinor: 1111, occurredAt: '2026-06-30T15:59:59.000Z', category: '其他', note: '六月边界外' });
  createEntry(repository, { type: 'expense', amountMinor: 2222, occurredAt: '2026-07-31T16:00:00.000Z', category: '其他', note: '八月边界外' });
  createEntry(repository, { ownerId: OWNER_B, type: 'income', amountMinor: 900000, occurredAt: '2026-07-10T04:00:00.000Z', category: '工资', note: '其他用户收入' });
  createEntry(repository, { ownerId: OWNER_B, type: 'expense', amountMinor: 8800, occurredAt: '2026-07-11T04:00:00.000Z', category: '餐饮', note: '其他用户支出' });
}

test('Monthly Finance Snapshot is owner-scoped, month-scoped and reconciled in integer minor units', () => {
  const { database, repository } = harness();
  try {
    seedKnownMonth(repository);
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.reportType, 'monthly_finance');
    assert.equal(snapshot.timezone, TIMEZONE);
    assert.deepEqual(snapshot.period, {
      year: 2026,
      month: 7,
      label: '2026年7月',
      startAt: '2026-06-30T16:00:00.000Z',
      endAt: '2026-07-31T16:00:00.000Z'
    });
    assert.deepEqual(snapshot.totals, {
      incomeMinor: 800000,
      expenseMinor: 13850,
      balanceMinor: 786150
    });
    assert.equal(snapshot.entryCount, 6);
    assert.equal(snapshot.entries.length, 6);
    assert.equal(snapshot.entries.every((entry) => Number.isSafeInteger(entry.amountMinor)), true);
    assert.equal(snapshot.entries.some((entry) => 'id' in entry || 'ownerId' in entry || 'sourceMessageId' in entry || 'clientRequestId' in entry), false);
    assert.deepEqual(snapshot.categorySummaries.income, [
      { category: '工资', amountMinor: 500000 },
      { category: '客户回款', amountMinor: 300000 }
    ]);
    assert.deepEqual(snapshot.categorySummaries.expense, [
      { category: '餐饮', amountMinor: 1800 },
      { category: '交通', amountMinor: 3250 },
      { category: '购物', amountMinor: 6800 },
      { category: '其他', amountMinor: 2000 }
    ]);
    assert.equal(snapshot.dailySummaries.reduce((sum, row) => sum + row.incomeMinor, 0), 800000);
    assert.equal(snapshot.dailySummaries.reduce((sum, row) => sum + row.expenseMinor, 0), 13850);
    assert.deepEqual(validateMonthlyFinanceReportSnapshot(snapshot), { ok: true, errors: [] });
  } finally {
    database.close();
  }
});

test('Monthly Finance Snapshot includes all 501 active rows without the ordinary query limit', () => {
  const { database, repository } = harness();
  try {
    for (let index = 0; index < 501; index += 1) {
      createEntry(repository, {
        type: 'expense',
        amountMinor: index + 1,
        occurredAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T04:00:00.000Z`,
        category: '其他',
        note: `明细-${index + 1}`
      });
    }
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    assert.equal(snapshot.entryCount, 501);
    assert.equal(snapshot.entries.length, 501);
    assert.equal(snapshot.totals.expenseMinor, (501 * 502) / 2);
    assert.deepEqual(validateMonthlyFinanceReportSnapshot(snapshot), { ok: true, errors: [] });
  } finally {
    database.close();
  }
});

test('Monthly Finance Snapshot emits a valid zero report for an empty month', () => {
  const { database, repository } = harness();
  try {
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    assert.deepEqual(snapshot.totals, { incomeMinor: 0, expenseMinor: 0, balanceMinor: 0 });
    assert.deepEqual(snapshot.categorySummaries, { income: [], expense: [] });
    assert.deepEqual(snapshot.dailySummaries, []);
    assert.deepEqual(snapshot.entries, []);
    assert.equal(snapshot.entryCount, 0);
    assert.deepEqual(validateMonthlyFinanceReportSnapshot(snapshot), { ok: true, errors: [] });
  } finally {
    database.close();
  }
});

test('Monthly Finance Snapshot contract fails closed on any monetary mismatch', () => {
  const { database, repository } = harness();
  try {
    seedKnownMonth(repository);
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    const invalid = structuredClone(snapshot);
    invalid.totals.expenseMinor += 1;
    const validation = validateMonthlyFinanceReportSnapshot(invalid);
    assert.equal(validation.ok, false);
    assert.equal(validation.errors.includes('totals_entries_mismatch'), true);
  } finally {
    database.close();
  }
});

test('Excel report reopens with numeric yuan cells and the same reconciled Snapshot', async () => {
  const { database, repository } = harness();
  try {
    seedKnownMonth(repository);
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    const { default: ExcelJS } = await import('exceljs');
    const buffer = await renderMonthlyFinanceExcel(snapshot);
    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(buffer.subarray(0, 2).toString('binary'), 'PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['概览', '分类汇总', '每日汇总', '账目明细']);
    for (const sheet of workbook.worksheets) {
      assert.equal(sheet.pageSetup.fitToWidth, 1);
      assert.equal(sheet.views[0].showGridLines, false);
    }
    const overview = workbook.getWorksheet('概览');
    const overviewValues = new Map();
    overview.eachRow((row) => overviewValues.set(row.getCell(1).value, row.getCell(2).value));
    assert.equal(overviewValues.get('本月收入'), 8000);
    assert.equal(overviewValues.get('本月支出'), 138.5);
    assert.equal(overviewValues.get('本月结余'), 7861.5);
    assert.equal(typeof overviewValues.get('本月收入'), 'number');

    const details = workbook.getWorksheet('账目明细');
    assert.equal(details.rowCount, snapshot.entryCount + 1);
    for (let rowIndex = 2; rowIndex <= details.rowCount; rowIndex += 1) {
      assert.equal(typeof details.getRow(rowIndex).getCell(8).value, 'number');
    }
    assert.equal(Math.round(details.getColumn(8).values.slice(2).reduce((total, value) => total + Number(value), 0) * 100), snapshot.totals.balanceMinor);
  } finally {
    database.close();
  }
});

test('Excel report neutralizes user-controlled formula prefixes without converting amount cells to text', async () => {
  const { database, repository } = harness();
  try {
    createEntry(repository, {
      type: 'expense', amountMinor: 3000, occurredAt: '2026-07-22T04:00:00.000Z',
      category: '餐饮', note: '=HYPERLINK("https://invalid.example")'
    });
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await renderMonthlyFinanceExcel(snapshot));
    const details = workbook.getWorksheet('账目明细');
    assert.equal(details.getRow(2).getCell(7).value, '\'=HYPERLINK("https://invalid.example")');
    assert.equal(details.getRow(2).getCell(8).value, -30);
  } finally {
    database.close();
  }
});

test('PDF report embeds a deployable Chinese font and preserves every Snapshot entry across pages', async () => {
  const { database, repository } = harness();
  try {
    for (let index = 0; index < 120; index += 1) {
      createEntry(repository, {
        type: index % 7 === 0 ? 'income' : 'expense',
        amountMinor: index + 100,
        occurredAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T04:00:00.000Z`,
        category: index % 7 === 0 ? '其他收入' : '其他',
        note: `中文明细第${index + 1}笔`
      });
    }
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    const viewModel = buildMonthlyFinancePdfViewModel(snapshot);
    assert.equal(viewModel.title, 'AI分身-2026年7月收支报表');
    assert.equal(viewModel.entries.length, snapshot.entryCount);
    assert.equal(viewModel.summary.income, '¥' + (snapshot.totals.incomeMinor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }));

    const buffer = await renderMonthlyFinancePdf(snapshot);
    const source = buffer.toString('latin1');
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.equal(buffer.length > 10000, true);
    assert.match(source, /\/ToUnicode/);
    assert.match(source, /\/FontFile(?:2|3)/);
    assert.equal((source.match(/\/Type \/Page\b/g) || []).length > 1, true);
  } finally {
    database.close();
  }
});

test('PDF footer pagination does not create blank footer-only pages', async () => {
  const { database, repository } = harness();
  try {
    seedKnownMonth(repository);
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    const buffer = await renderMonthlyFinancePdf(snapshot);
    const pageCount = (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    assert.equal(pageCount, 2);
  } finally {
    database.close();
  }
});

test('SQLite, Repository, Chat, API, Snapshot, PDF view model and Excel stay exact to the minor unit', async () => {
  const { database, repository } = harness();
  try {
    seedKnownMonth(repository);
    const plan = buildFinanceQueryPlan({
      metrics: ['income', 'expense', 'net'],
      periodExpression: '本月',
      timezone: TIMEZONE,
      now: NOW,
      text: '本月收入、支出和结余分别是多少'
    });
    const repositoryResult = repository.query(plan, { ownerId: OWNER_A });
    const service = new FinanceService({ repository, timezone: TIMEZONE, clock: () => NOW });
    const chat = await service.processUserMessage({
      ownerId: OWNER_A,
      conversationId: 'report-consistency',
      message: '本月收入、支出和结余分别是多少',
      clientRequestId: 'report-consistency-request',
      sourceMessageId: 'report-consistency-source',
      plan
    });
    let api;
    await handleFinanceApi({
      req: { method: 'GET' },
      res: {},
      url: new URL('http://localhost/api/finance/overview'),
      user: { id: OWNER_A },
      runtime: { repository, timezone: TIMEZONE, clock: () => NOW },
      readJson: async () => ({}),
      sendJson: (_res, status, body) => { api = { status, body }; }
    });
    const sql = database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END), 0) AS income_minor,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense_minor
      FROM finance_entries
      WHERE owner_id = ? AND status = 'active' AND deleted_at IS NULL
        AND occurred_at >= ? AND occurred_at < ?
    `).get(OWNER_A, plan.start_at, plan.end_at);
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    const pdf = buildMonthlyFinancePdfViewModel(snapshot);
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await renderMonthlyFinanceExcel(snapshot));
    const overviewValues = new Map();
    workbook.getWorksheet('概览').eachRow((row) => overviewValues.set(row.getCell(1).value, row.getCell(2).value));

    const expected = { incomeMinor: 800000, expenseMinor: 13850, balanceMinor: 786150 };
    assert.deepEqual(snapshot.totals, expected);
    assert.equal(repositoryResult.incomeMinor, expected.incomeMinor);
    assert.equal(repositoryResult.expenseMinor, expected.expenseMinor);
    assert.equal(repositoryResult.balanceMinor, expected.balanceMinor);
    assert.equal(chat.data.incomeMinor, expected.incomeMinor);
    assert.equal(chat.data.expenseMinor, expected.expenseMinor);
    assert.equal(chat.data.balanceMinor, expected.balanceMinor);
    assert.equal(api.status, 200);
    assert.equal(api.body.summary.incomeMinor, expected.incomeMinor);
    assert.equal(api.body.summary.expenseMinor, expected.expenseMinor);
    assert.equal(api.body.summary.balanceMinor, expected.balanceMinor);
    assert.equal(Number(sql.income_minor), expected.incomeMinor);
    assert.equal(Number(sql.expense_minor), expected.expenseMinor);
    assert.equal(pdf.summary.income, '¥8,000.00');
    assert.equal(pdf.summary.expense, '¥138.50');
    assert.equal(pdf.summary.balance, '¥7,861.50');
    assert.equal(Math.round(overviewValues.get('本月收入') * 100), expected.incomeMinor);
    assert.equal(Math.round(overviewValues.get('本月支出') * 100), expected.expenseMinor);
    assert.equal(Math.round(overviewValues.get('本月结余') * 100), expected.balanceMinor);
  } finally {
    database.close();
  }
});

test('PDF and Excel both preserve all 501 entries from the same Snapshot', async () => {
  const { database, repository } = harness();
  try {
    for (let index = 0; index < 501; index += 1) {
      createEntry(repository, {
        type: 'expense',
        amountMinor: 100,
        occurredAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T04:00:00.000Z`,
        category: '其他',
        note: `完整导出-${index + 1}`
      });
    }
    const snapshot = repository.buildMonthlyReportSnapshot({ ownerId: OWNER_A, timezone: TIMEZONE, now: NOW });
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await renderMonthlyFinanceExcel(snapshot));
    const pdfBuffer = await renderMonthlyFinancePdf(snapshot);
    assert.equal(workbook.getWorksheet('账目明细').rowCount, 502);
    assert.equal(buildMonthlyFinancePdfViewModel(snapshot).entries.length, 501);
    assert.equal((pdfBuffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length > 10, true);
  } finally {
    database.close();
  }
});
