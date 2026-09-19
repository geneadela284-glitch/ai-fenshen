import { isAiResultText, isQueryLikeInput } from '../inputRouter/inputSafetyGuards.js';
import { resolveDateRange } from './dateRangeResolver.js';

const FORMAL_STATUSES = new Set(['active', 'confirmed']);
const INACTIVE_STATUSES = new Set([
  'superseded',
  'deleted',
  'forgotten',
  'archived',
  'rejected',
  'expired',
  'needs_confirmation',
  'pending_confirmation',
  'candidate'
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function amountText(value) {
  const amount = Number(value || 0);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function amountMinor(record = {}) {
  const stored = Number(record.metadata?.amountMinor);
  if (Number.isSafeInteger(stored)) return stored;
  const derived = Math.round(Number(record.amount) * 100);
  return Number.isSafeInteger(derived) ? derived : NaN;
}

function moneyFromMinor(value) {
  return Number(value || 0) / 100;
}

function hash(value = '') {
  let result = 5381;
  for (const char of String(value)) result = ((result << 5) + result) ^ char.charCodeAt(0);
  return (result >>> 0).toString(36);
}

function recordTitle(record = {}) {
  return String(record.summary || record.title || record.normalizedText || record.originalText || '未命名记录').trim();
}

function recordDetail(record = {}, excludedReason = '') {
  const minor = amountMinor(record);
  return {
    recordId: record.id,
    safeRecordId: String(record.id || '').slice(-8),
    recordedAt: record.createdAt || '',
    eventDate: record.eventDate || '',
    eventTime: record.eventTime || '',
    direction: record.direction || '',
    amount: Number.isSafeInteger(minor) ? moneyFromMinor(minor) : Number(record.amount || 0),
    amountMinor: minor,
    currency: record.currency || 'CNY',
    category: record.category || '',
    memoryType: record.memoryType || '',
    originalText: record.originalText || '',
    sourceType: record.sourceType || '',
    sourceId: record.sourceId || '',
    createdAt: record.createdAt || '',
    status: record.status || '',
    summary: recordTitle(record),
    financeCategory: record.metadata?.financeCategory || (!['expense', 'income'].includes(record.category) ? record.category : '未分类'),
    excludedReason
  };
}

function sourceKey(record = {}) {
  return String(record.sourceId || record.metadata?.submissionId || record.id || '');
}

function scopeValue(record = {}, field) {
  return String(record[field] || record.metadata?.[field] || '');
}

function dateRangeFor(query = {}) {
  if (query.dateRange) return query.dateRange;
  if (query.expression) return resolveDateRange(query.expression, query);
  return resolveDateRange('', query);
}

function recordsFrom(service, query) {
  if (Array.isArray(query.records)) return query.records;
  try {
    if (service.memoryService.repository?.list) {
      return service.memoryService.repository.list({ includeDeleted: true, includeForgotten: true });
    }
    return service.memoryService.searchMemories({ includeDeleted: true, includeForgotten: true }).data || [];
  } catch {
    return [];
  }
}

function calculationStep(item, index) {
  const sign = item.direction === 'income' ? '+' : '-';
  return {
    index: index + 1,
    recordId: item.recordId,
    label: item.summary,
    amount: item.amount,
    amountMinor: item.amountMinor,
    currency: item.currency,
    direction: item.direction,
    expression: `${sign}${amountText(item.amount)}`,
    text: `${item.summary} ${amountText(item.amount)}元`
  };
}

export class DataTrustService {
  constructor({ memoryService } = {}) {
    if (!memoryService) throw new Error('DataTrustService requires MemoryService');
    this.memoryService = memoryService;
    this.results = new Map();
  }

  calculateExpenses(query = {}) {
    return this.calculate({ ...query, direction: 'expense' });
  }

  calculateIncome(query = {}) {
    return this.calculate({ ...query, direction: 'income' });
  }

  calculateBalance(query = {}) {
    return this.calculate({ ...query, direction: 'balance' });
  }

  calculate(query = {}) {
    const dateRange = dateRangeFor(query);
    const rawRecords = recordsFrom(this, query)
      .slice()
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.id || '').localeCompare(String(right.id || '')));
    const seenSources = new Set();
    const includedRecords = [];
    const excludedRecords = [];

    rawRecords.forEach((record) => {
      const excludedReason = this.exclusionReason(record, query, dateRange, seenSources);
      if (excludedReason) {
        excludedRecords.push(recordDetail(record, excludedReason));
        return;
      }
      seenSources.add(sourceKey(record));
      includedRecords.push(recordDetail(record));
    });

    const incomeMinor = includedRecords
      .filter((record) => record.direction === 'income')
      .reduce((total, record) => total + record.amountMinor, 0);
    const expenseMinor = includedRecords
      .filter((record) => record.direction === 'expense')
      .reduce((total, record) => total + record.amountMinor, 0);
    const totalMinor = query.direction === 'income' ? incomeMinor : query.direction === 'expense' ? expenseMinor : incomeMinor - expenseMinor;
    const income = moneyFromMinor(incomeMinor);
    const expense = moneyFromMinor(expenseMinor);
    const total = moneyFromMinor(totalMinor);
    const calculationSteps = includedRecords.map(calculationStep);
    const categoryMap = new Map();
    includedRecords.forEach((record) => {
      const category = record.financeCategory || '未分类';
      const current = categoryMap.get(category) || { category, amountMinor: 0, count: 0 };
      current.amountMinor += record.amountMinor;
      current.count += 1;
      categoryMap.set(category, current);
    });
    const categoryTotals = [...categoryMap.values()].map((item) => ({ ...item, amount: moneyFromMinor(item.amountMinor) }));
    const maxTransaction = includedRecords.reduce((max, record) => (!max || record.amountMinor > max.amountMinor ? record : max), null);
    const resultId = `trust-${hash([
      query.direction,
      dateRange.startDate,
      dateRange.endDateExclusive,
      ...includedRecords.map((record) => `${record.recordId}:${record.amountMinor}`)
    ].join('|'))}`;
    const warnings = [];
    if (dateRange.requiresConfirmation) warnings.push(...(dateRange.warnings || ['date_range_unresolved']));
    const result = {
      resultId,
      total,
      totalMinor,
      currency: query.currency || 'CNY',
      matchedCount: includedRecords.length,
      dateRange: clone(dateRange),
      label: dateRange.label || '',
      includedRecords,
      excludedRecords,
      calculationSteps,
      provenance: includedRecords.map((record) => clone(record)),
      warnings,
      deterministic: true,
      direction: query.direction,
      income,
      incomeMinor,
      expense,
      expenseMinor,
      balance: moneyFromMinor(incomeMinor - expenseMinor),
      balanceMinor: incomeMinor - expenseMinor,
      average: includedRecords.length ? moneyFromMinor(Math.round(totalMinor / includedRecords.length)) : 0,
      maxTransaction: clone(maxTransaction),
      categoryTotals
    };
    this.results.set(resultId, clone(result));
    return result;
  }

  exclusionReason(record = {}, query = {}, dateRange = {}, seenSources = new Set()) {
    if (dateRange.requiresConfirmation) return 'date_range_unresolved';
    const recordUserId = scopeValue(record, 'userId');
    const recordWorkspaceId = scopeValue(record, 'workspaceId');
    if (query.userId && recordUserId && recordUserId !== String(query.userId)) return 'user_scope_mismatch';
    if (query.workspaceId && recordWorkspaceId && recordWorkspaceId !== String(query.workspaceId)) return 'workspace_scope_mismatch';
    if (!FORMAL_STATUSES.has(record.status)) return INACTIVE_STATUSES.has(record.status) ? `status_${record.status}` : 'status_not_active';
    if (record.supersededBy || record.status === 'superseded') return 'superseded';
    if (!['expense', 'income'].includes(record.memoryType) || !['expense', 'income'].includes(record.category)) return 'not_transaction_fact';
    if (!['expense', 'income'].includes(record.direction)) return 'direction_not_transaction';
    if (query.direction !== 'balance' && query.direction && record.direction !== query.direction) return 'direction_mismatch';
    if (!Number.isSafeInteger(amountMinor(record)) || amountMinor(record) <= 0) return 'amount_invalid';
    if (query.currency && (record.currency || 'CNY') !== query.currency) return 'currency_mismatch';
    if (query.category && record.category !== query.category) return 'category_mismatch';
    if (query.status && record.status !== query.status) return 'status_mismatch';
    if (query.sourceType && record.sourceType !== query.sourceType) return 'source_type_mismatch';
    if (!record.eventDate) return 'event_date_missing';
    if (dateRange.startDate && record.eventDate < dateRange.startDate) return 'outside_date_range';
    if (dateRange.endDateExclusive && record.eventDate >= dateRange.endDateExclusive) return 'outside_date_range';
    if (isQueryLikeInput(record.originalText) || isQueryLikeInput(record.normalizedText)) return 'query_or_explanation_text';
    if (isAiResultText(record.originalText) || isAiResultText(record.normalizedText) || record.metadata?.isAiOutput || record.metadata?.inputRole === 'assistant') return 'ai_output_text';
    if (query.keyword) {
      const searchable = `${recordTitle(record)} ${record.originalText || ''} ${record.normalizedText || ''}`;
      if (!searchable.includes(String(query.keyword))) return 'keyword_mismatch';
    }
    const key = sourceKey(record);
    if (key && seenSources.has(key)) return 'duplicate_source_id';
    return '';
  }

  explainCalculation(resultIdOrQuery) {
    if (typeof resultIdOrQuery === 'string') return clone(this.results.get(resultIdOrQuery) || null);
    const query = resultIdOrQuery || {};
    if (query.direction === 'income') return this.calculateIncome(query);
    if (query.direction === 'balance') return this.calculateBalance(query);
    return this.calculateExpenses(query);
  }

  getProvenance(resultIdOrQuery) {
    const result = this.explainCalculation(resultIdOrQuery);
    return clone(result?.provenance || []);
  }
}

export function formatTrustedFinanceReply(result = {}, { includeSteps = true } = {}) {
  const label = result.label || '该时间范围';
  const range = result.dateRange || {};
  const contextLines = [
    range.startDate && range.endDateInclusive ? `日期范围：${range.startDate} 至 ${range.endDateInclusive}` : '',
    range.timezone ? `时区：${range.timezone}` : '',
    `数据来源：个人账本 ${result.matchedCount || 0} 条`
  ].filter(Boolean);
  if (!result.matchedCount) {
    const message = result.direction === 'income'
      ? `${label}没有找到收入记录。`
      : result.direction === 'balance'
        ? `${label}没有找到收支记录。`
        : `${label}没有找到支出记录。`;
    return [message, ...contextLines].join('\n');
  }

  const heading = result.direction === 'income'
    ? `${label}一共收入 ${amountText(result.income)} 元，共 ${result.matchedCount} 笔。`
    : result.direction === 'balance'
      ? `${label}收入 ${amountText(result.income)} 元，支出 ${amountText(result.expense)} 元，结余 ${amountText(result.balance)} 元。`
      : `${label}一共支出 ${amountText(result.expense)} 元，共 ${result.matchedCount} 笔。`;
  if (!includeSteps) return [heading, ...contextLines].join('\n');
  const detailLines = result.includedRecords.map((record) => `- ${[record.eventTime, record.summary].filter(Boolean).join(' ')} ${amountText(record.amount)} 元`);
  const totalLabel = result.direction === 'income' ? '收入合计' : result.direction === 'balance' ? '结余' : '合计';
  return [heading, ...contextLines, '', '明细：', ...detailLines, `- ${totalLabel} ${amountText(result.total)} 元`].join('\n');
}
