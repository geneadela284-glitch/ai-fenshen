const REPORT_TYPE = 'monthly_finance';
const FORBIDDEN_ENTRY_FIELDS = new Set([
  'id', 'ownerId', 'owner_id', 'sourceMessageId', 'source_message_id',
  'clientRequestId', 'client_request_id', 'status', 'deletedAt', 'deleted_at'
]);

function safeInteger(value) {
  return Number.isSafeInteger(value);
}

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function monetaryRowsValid(rows, amountField = 'amountMinor') {
  return Array.isArray(rows) && rows.every((row) => row && typeof row === 'object' &&
    safeInteger(row[amountField]) && row[amountField] >= 0);
}

export function validateMonthlyFinanceReportSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, errors: ['snapshot_object_required'] };
  }
  if (snapshot.schemaVersion !== 1) errors.push('schema_version_invalid');
  if (snapshot.reportType !== REPORT_TYPE) errors.push('report_type_invalid');
  if (!validTimezone(snapshot.timezone)) errors.push('timezone_invalid');
  if (!snapshot.period || !Number.isInteger(snapshot.period.year) || !Number.isInteger(snapshot.period.month) ||
      snapshot.period.month < 1 || snapshot.period.month > 12 ||
      !Number.isFinite(Date.parse(snapshot.period.startAt)) || !Number.isFinite(Date.parse(snapshot.period.endAt)) ||
      Date.parse(snapshot.period.startAt) >= Date.parse(snapshot.period.endAt)) {
    errors.push('period_invalid');
  }
  if (snapshot.currency !== 'CNY') errors.push('currency_invalid');

  const totals = snapshot.totals || {};
  if (![totals.incomeMinor, totals.expenseMinor, totals.balanceMinor].every(safeInteger) ||
      totals.incomeMinor < 0 || totals.expenseMinor < 0 ||
      totals.balanceMinor !== totals.incomeMinor - totals.expenseMinor) {
    errors.push('totals_invalid');
  }

  if (!Array.isArray(snapshot.entries) || !Number.isSafeInteger(snapshot.entryCount) ||
      snapshot.entryCount < 0 || snapshot.entryCount !== snapshot.entries?.length) {
    errors.push('entries_count_invalid');
  }
  const entriesValid = Array.isArray(snapshot.entries) && snapshot.entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || !['income', 'expense'].includes(entry.type) ||
        !safeInteger(entry.amountMinor) || entry.amountMinor <= 0 ||
        !safeInteger(entry.signedAmountMinor) ||
        entry.signedAmountMinor !== (entry.type === 'income' ? entry.amountMinor : -entry.amountMinor)) return false;
    return Object.keys(entry).every((field) => !FORBIDDEN_ENTRY_FIELDS.has(field));
  });
  if (!entriesValid) errors.push('entries_invalid');

  const incomeCategories = snapshot.categorySummaries?.income;
  const expenseCategories = snapshot.categorySummaries?.expense;
  if (!monetaryRowsValid(incomeCategories) || !monetaryRowsValid(expenseCategories)) {
    errors.push('category_summaries_invalid');
  }
  const daily = snapshot.dailySummaries;
  if (!Array.isArray(daily) || !daily.every((row) => row && typeof row.localDate === 'string' &&
      [row.incomeMinor, row.expenseMinor, row.balanceMinor].every(safeInteger) &&
      row.incomeMinor >= 0 && row.expenseMinor >= 0 && row.balanceMinor === row.incomeMinor - row.expenseMinor)) {
    errors.push('daily_summaries_invalid');
  }

  if (entriesValid && [totals.incomeMinor, totals.expenseMinor].every(safeInteger)) {
    const entryIncome = sum(snapshot.entries.filter((entry) => entry.type === 'income').map((entry) => entry.amountMinor));
    const entryExpense = sum(snapshot.entries.filter((entry) => entry.type === 'expense').map((entry) => entry.amountMinor));
    if (entryIncome !== totals.incomeMinor || entryExpense !== totals.expenseMinor) errors.push('totals_entries_mismatch');
  }
  if (monetaryRowsValid(incomeCategories) && monetaryRowsValid(expenseCategories) &&
      [totals.incomeMinor, totals.expenseMinor].every(safeInteger) &&
      (sum(incomeCategories.map((row) => row.amountMinor)) !== totals.incomeMinor ||
       sum(expenseCategories.map((row) => row.amountMinor)) !== totals.expenseMinor)) {
    errors.push('totals_categories_mismatch');
  }
  if (Array.isArray(daily) && daily.every((row) => safeInteger(row.incomeMinor) && safeInteger(row.expenseMinor)) &&
      [totals.incomeMinor, totals.expenseMinor].every(safeInteger) &&
      (sum(daily.map((row) => row.incomeMinor)) !== totals.incomeMinor ||
       sum(daily.map((row) => row.expenseMinor)) !== totals.expenseMinor)) {
    errors.push('totals_daily_mismatch');
  }
  if (!Number.isFinite(Date.parse(snapshot.generatedAt))) errors.push('generated_at_invalid');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertMonthlyFinanceReportSnapshot(snapshot) {
  const validation = validateMonthlyFinanceReportSnapshot(snapshot);
  if (!validation.ok) {
    const error = new Error('FINANCE_REPORT_INCONSISTENT');
    error.code = 'FINANCE_REPORT_INCONSISTENT';
    error.details = validation.errors;
    throw error;
  }
  return snapshot;
}

export function formatCnyFromMinor(amountMinor) {
  if (!safeInteger(amountMinor)) throw new Error('FINANCE_REPORT_AMOUNT_INVALID');
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(amountMinor / 100);
}

export function minorToYuanNumber(amountMinor) {
  if (!safeInteger(amountMinor)) throw new Error('FINANCE_REPORT_AMOUNT_INVALID');
  return amountMinor / 100;
}

export function buildMonthlyReportFilename(snapshot, format) {
  if (!['pdf', 'xlsx'].includes(format)) throw new Error('FINANCE_REPORT_FORMAT_INVALID');
  return `AI分身-${snapshot.period.year}年${snapshot.period.month}月收支报表.${format}`;
}

