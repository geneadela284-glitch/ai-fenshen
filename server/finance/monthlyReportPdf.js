import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

import {
  assertMonthlyFinanceReportSnapshot,
  formatCnyFromMinor
} from './monthlyReportContract.js';

const DEFAULT_FONT_PATH = fileURLToPath(new URL('./assets/NotoSansCJKsc-Regular.otf', import.meta.url));
const COLORS = {
  navy: '#102a4c',
  blue: '#1f5d91',
  pale: '#eef5fb',
  text: '#1d2939',
  muted: '#667085',
  income: '#087a55',
  expense: '#b54708',
  line: '#d0d5dd'
};

export function buildMonthlyFinancePdfViewModel(snapshot) {
  assertMonthlyFinanceReportSnapshot(snapshot);
  return {
    title: snapshot.title,
    summaryPrefix:snapshot.rangeReport?'本期':'本月',
    accountingNote:snapshot.accountingNote||'',
    period: snapshot.period.label,
    timezone: snapshot.timezone,
    range: `${snapshot.period.startAt} — ${snapshot.period.endAt}`,
    generatedAt: snapshot.generatedAt,
    summary: {
      income: formatCnyFromMinor(snapshot.totals.incomeMinor),
      expense: formatCnyFromMinor(snapshot.totals.expenseMinor),
      balance: formatCnyFromMinor(snapshot.totals.balanceMinor)
    },
    categorySummaries: snapshot.categorySummaries,
    dailySummaries: snapshot.dailySummaries,
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      typeLabel: {loan_out:'借出',loan_in:'借入',repayment_in:'还入',repayment_out:'还出'}[entry.subtype] || (entry.type === 'income' ? '收入' : '支出'),
      amount: formatCnyFromMinor(entry.signedAmountMinor)
    }))
  };
}

function collectDocument(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

function drawPageHeader(doc, viewModel) {
  doc.save();
  doc.fillColor(COLORS.navy).fontSize(9).text(viewModel.title, 42, 22, { width: 511, lineBreak: false });
  doc.moveTo(42, 38).lineTo(553, 38).lineWidth(0.5).strokeColor(COLORS.line).stroke();
  doc.restore();
  doc.y = 52;
}

function ensureSpace(doc, viewModel, height) {
  if (doc.y + height <= doc.page.height - 76) return;
  doc.addPage();
  drawPageHeader(doc, viewModel);
}

function heading(doc, viewModel, label) {
  ensureSpace(doc, viewModel, 34);
  doc.moveDown(0.35).fillColor(COLORS.navy).fontSize(13).text(label);
  doc.moveDown(0.25);
}

function drawSummary(doc, viewModel) {
  const top = doc.y;
  const width = 163;
  const gap = 11;
  const cards = [
    [`${viewModel.summaryPrefix}收入`, viewModel.summary.income, COLORS.income],
    [`${viewModel.summaryPrefix}支出`, viewModel.summary.expense, COLORS.expense],
    [`${viewModel.summaryPrefix}结余`, viewModel.summary.balance, COLORS.blue]
  ];
  cards.forEach(([label, value, color], index) => {
    const x = 42 + index * (width + gap);
    doc.roundedRect(x, top, width, 58, 7).fill(COLORS.pale);
    doc.fillColor(COLORS.muted).fontSize(9).text(label, x + 10, top + 10, { width: width - 20 });
    doc.fillColor(color).fontSize(14).text(value, x + 10, top + 29, { width: width - 20, lineBreak: false });
  });
  doc.y = top + 66;
}

function drawAmountRows(doc, viewModel, rows, emptyLabel) {
  if (!rows.length) {
    doc.fillColor(COLORS.muted).fontSize(9).text(emptyLabel);
    return;
  }
  for (const row of rows) {
    ensureSpace(doc, viewModel, 22);
    const y = doc.y;
    doc.fillColor(COLORS.text).fontSize(9).text(row.label, 48, y, { width: 310, lineBreak: false });
    doc.fillColor(COLORS.text).text(row.amount, 370, y, { width: 176, align: 'right', lineBreak: false });
    doc.y = y + 18;
    doc.moveTo(48, doc.y).lineTo(546, doc.y).lineWidth(0.25).strokeColor(COLORS.line).stroke();
    doc.y += 4;
  }
}

function drawEntry(doc, viewModel, entry) {
  const description = [entry.merchantOrCounterparty, entry.note].filter(Boolean).join(' · ') || '—';
  doc.fontSize(8.5);
  const descriptionHeight = doc.heightOfString(description, { width: 292, lineGap: 1 });
  const cardHeight = Math.max(44, descriptionHeight + 29);
  ensureSpace(doc, viewModel, cardHeight + 8);
  const top = doc.y;
  doc.roundedRect(42, top, 511, cardHeight, 5).fillAndStroke('#ffffff', COLORS.line);
  doc.fillColor(COLORS.muted).fontSize(8).text(`${entry.localDate} ${entry.localTime}`, 52, top + 8, { width: 110, lineBreak: false });
  doc.fillColor(entry.type === 'income' ? COLORS.income : COLORS.expense).fontSize(9)
    .text(`${entry.typeLabel} · ${entry.category}`, 170, top + 8, { width: 170, lineBreak: false });
  doc.fillColor(entry.type === 'income' ? COLORS.income : COLORS.expense).fontSize(10)
    .text(entry.amount, 370, top + 8, { width: 171, align: 'right', lineBreak: false });
  doc.fillColor(COLORS.text).fontSize(8.5).text(description, 52, top + 24, { width: 292, lineGap: 1 });
  doc.y = top + cardHeight + 8;
}

export async function renderMonthlyFinancePdf(snapshot, { fontPath = DEFAULT_FONT_PATH } = {}) {
  const viewModel = buildMonthlyFinancePdfViewModel(snapshot);
  if (statSync(fontPath).size < 1000) throw new Error('FINANCE_REPORT_FONT_INVALID');
  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, autoFirstPage: true, info: {
    Title: viewModel.title,
    Author: 'AI分身',
    Subject: '月度收支报表',
    CreationDate: new Date(snapshot.generatedAt),
    ModDate: new Date(snapshot.generatedAt)
  } });
  const completion = collectDocument(doc);
  doc.registerFont('ReportChinese', fontPath);
  doc.font('ReportChinese');
  drawPageHeader(doc, viewModel);

  doc.fillColor(COLORS.navy).fontSize(20).text(viewModel.title, { align: 'center' });
  doc.moveDown(0.45).fillColor(COLORS.muted).fontSize(9)
    .text(`账号时区：${viewModel.timezone}`, { align: 'center' })
    .text(`统计范围：${viewModel.range}`, { align: 'center' })
    .text(`生成时间：${viewModel.generatedAt}`, { align: 'center' });
  doc.moveDown(1);
  drawSummary(doc, viewModel);
  if(viewModel.accountingNote)doc.fillColor(COLORS.muted).fontSize(9).text(viewModel.accountingNote);

  heading(doc, viewModel, '收入分类汇总');
  drawAmountRows(doc, viewModel, viewModel.categorySummaries.income.map((row) => ({
    label: row.category, amount: formatCnyFromMinor(row.amountMinor)
  })), '所选范围暂无收入记录');

  heading(doc, viewModel, '支出分类汇总');
  drawAmountRows(doc, viewModel, viewModel.categorySummaries.expense.map((row) => ({
    label: row.category, amount: formatCnyFromMinor(row.amountMinor)
  })), '所选范围暂无支出记录');

  heading(doc, viewModel, '每日收支汇总');
  drawAmountRows(doc, viewModel, viewModel.dailySummaries.map((row) => ({
    label: row.localDate,
    amount: `收入 ${formatCnyFromMinor(row.incomeMinor)}  支出 ${formatCnyFromMinor(row.expenseMinor)}  结余 ${formatCnyFromMinor(row.balanceMinor)}`
  })), '所选范围暂无每日汇总');

  heading(doc, viewModel, `全部有效账目明细（${viewModel.entries.length}笔）`);
  if (!viewModel.entries.length) doc.fillColor(COLORS.muted).fontSize(9).text('所选范围暂无有效账目。');
  for (const entry of viewModel.entries) drawEntry(doc, viewModel, entry);

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.fillColor(COLORS.muted).fontSize(8).text(
      `第 ${index - range.start + 1} / ${range.count} 页`,
      42,
      doc.page.height - 56,
      { width: 511, align: 'center', lineBreak: false }
    );
  }
  doc.end();
  const buffer = await completion;
  if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('FINANCE_REPORT_PDF_INVALID');
  return buffer;
}
