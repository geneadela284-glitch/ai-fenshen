import ExcelJS from 'exceljs';

import {
  assertMonthlyFinanceReportSnapshot,
  minorToYuanNumber
} from './monthlyReportContract.js';

const MONEY_FORMAT = '¥#,##0.00;[Red]-¥#,##0.00';
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183B68' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };

function worksheetOptions(orientation = 'landscape') {
  return {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 }
    }
  };
}

function safeText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function styleHeader(sheet, rowNumber = 1) {
  const row = sheet.getRow(rowNumber);
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle' };
  });
  row.height = 24;
}

function styleMoneyColumn(sheet, columnNumber, startRow = 2) {
  for (let row = startRow; row <= sheet.rowCount; row += 1) {
    sheet.getRow(row).getCell(columnNumber).numFmt = MONEY_FORMAT;
  }
}

function addOverview(workbook, snapshot) {
  const sheet = workbook.addWorksheet('概览', worksheetOptions('portrait'));
  sheet.columns = [{ width: 22 }, { width: 44 }];
  sheet.addRow(['项目', '内容']);
  sheet.addRows([
    [snapshot.rangeReport?'统计范围':'报表月份', snapshot.period.label],
    ['账号时区', snapshot.timezone],
    ['统计开始', snapshot.period.startAt],
    ['统计结束', snapshot.period.endAt],
    [snapshot.rangeReport?'本期收入':'本月收入', minorToYuanNumber(snapshot.totals.incomeMinor)],
    [snapshot.rangeReport?'本期支出':'本月支出', minorToYuanNumber(snapshot.totals.expenseMinor)],
    [snapshot.rangeReport?'本期结余':'本月结余', minorToYuanNumber(snapshot.totals.balanceMinor)],
    ['有效账目数', snapshot.entryCount],
    ['生成时间', snapshot.generatedAt]
  ]);
  if(snapshot.accountingNote)sheet.addRow(['统计口径',snapshot.accountingNote]);
  styleHeader(sheet);
  [6, 7, 8].forEach((row) => { sheet.getRow(row).getCell(2).numFmt = MONEY_FORMAT; });
  sheet.autoFilter = { from: 'A1', to: 'B10' };
}

function addCategories(workbook, snapshot) {
  const sheet = workbook.addWorksheet('分类汇总', worksheetOptions());
  sheet.columns = [{ width: 14 }, { width: 24 }, { width: 18 }];
  sheet.addRow(['类型', '分类', '金额（元）']);
  for (const row of snapshot.categorySummaries.income) sheet.addRow(['收入', safeText(row.category), minorToYuanNumber(row.amountMinor)]);
  for (const row of snapshot.categorySummaries.expense) sheet.addRow(['支出', safeText(row.category), minorToYuanNumber(row.amountMinor)]);
  styleHeader(sheet);
  styleMoneyColumn(sheet, 3);
  sheet.autoFilter = { from: 'A1', to: `C${Math.max(1, sheet.rowCount)}` };
}

function addDaily(workbook, snapshot) {
  const sheet = workbook.addWorksheet('每日汇总', worksheetOptions());
  sheet.columns = [{ width: 16 }, { width: 18 }, { width: 18 }, { width: 18 }];
  sheet.addRow(['日期', '收入（元）', '支出（元）', '结余（元）']);
  for (const row of snapshot.dailySummaries) {
    sheet.addRow([
      row.localDate,
      minorToYuanNumber(row.incomeMinor),
      minorToYuanNumber(row.expenseMinor),
      minorToYuanNumber(row.balanceMinor)
    ]);
  }
  styleHeader(sheet);
  [2, 3, 4].forEach((column) => styleMoneyColumn(sheet, column));
  sheet.autoFilter = { from: 'A1', to: `D${Math.max(1, sheet.rowCount)}` };
}

function addEntries(workbook, snapshot) {
  const sheet = workbook.addWorksheet('账目明细', worksheetOptions());
  sheet.columns = [
    { width: 10 }, { width: 15 }, { width: 10 }, { width: 12 },
    { width: 18 }, { width: 24 }, { width: 34 }, { width: 18 }
  ];
  sheet.addRow(['序号', '日期', '时间', '类型', '分类', '交易对象', '备注', '金额（元）']);
  for (const entry of snapshot.entries) {
    sheet.addRow([
      entry.sequence,
      entry.localDate,
      entry.localTime,
      ({loan_out:'借出',loan_in:'借入',repayment_in:'还入',repayment_out:'还出'}[entry.subtype] || (entry.type === 'income' ? '收入' : '支出')),
      safeText(entry.category),
      safeText(entry.merchantOrCounterparty),
      safeText(entry.note),
      minorToYuanNumber(entry.signedAmountMinor)
    ]);
  }
  styleHeader(sheet);
  styleMoneyColumn(sheet, 8);
  sheet.autoFilter = { from: 'A1', to: `H${Math.max(1, sheet.rowCount)}` };
}

export async function renderMonthlyFinanceExcel(snapshot) {
  assertMonthlyFinanceReportSnapshot(snapshot);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AI分身';
  workbook.created = new Date(snapshot.generatedAt);
  workbook.modified = new Date(snapshot.generatedAt);
  workbook.calcProperties.fullCalcOnLoad = false;
  addOverview(workbook, snapshot);
  addCategories(workbook, snapshot);
  addDaily(workbook, snapshot);
  addEntries(workbook, snapshot);
  const value = await workbook.xlsx.writeBuffer({ useStyles: true, useSharedStrings: true });
  const buffer = Buffer.from(value);
  if (buffer.length < 4 || buffer.subarray(0, 2).toString('binary') !== 'PK') {
    throw new Error('FINANCE_REPORT_XLSX_INVALID');
  }
  return buffer;
}
