import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { createMemoryRecord } from '../memory/memorySchema.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';
import { resolveDateRange } from './dateRangeResolver.js';
import { DataTrustService, formatTrustedFinanceReply } from './dataTrustService.js';

const now = '2026-07-14T01:30:00.000Z';
const scope = {
  now,
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  userId: 'user-a',
  workspaceId: 'workspace-a'
};

function setup(namespace) {
  const repository = new MemoryRepository({
    storage: createMemoryStorage(),
    namespace,
    now: () => new Date(now)
  });
  const memoryService = new MemoryService({ repository, now: () => new Date(now) });
  return { repository, service: new DataTrustService({ memoryService }) };
}

function seed(repository, {
  text,
  amount,
  eventDate,
  direction = 'expense',
  status = 'confirmed',
  sourceId,
  category = direction,
  memoryType = direction,
  currency = 'CNY',
  userId = 'user-a',
  workspaceId = 'workspace-a',
  sourceType = 'conversation',
  metadata = {}
}) {
  const record = createMemoryRecord({
    sourceType,
    sourceId,
    originalText: text,
    normalizedText: text,
    memoryType,
    category,
    title: text,
    summary: text.replace(/^(今天|昨天|前天)/, '').replace(/\d+(?:\.\d+)?\s*(?:元|块)?/, '').replace(/花了?|支出|收入|收到/g, '').trim() || text,
    amount,
    currency,
    direction,
    eventDate,
    status,
    needsConfirmation: false,
    metadata: { userId, workspaceId, inputRole: 'user', ...metadata }
  }, { sourceType, sourceId, now });
  const saved = repository.create(record, { confirmedByUser: true });
  assert.equal(saved.ok, true, `${text}: ${JSON.stringify(saved)}`);
  return saved.record;
}

function query(expression, extra = {}) {
  return {
    ...scope,
    dateRange: resolveDateRange(expression, scope),
    ...extra
  };
}

test('calculates the real today and yesterday regression scenario without changing record count', () => {
  const { repository, service } = setup('test-data-trust-real-regression');
  seed(repository, { text: '今天停车20元', amount: 20, eventDate: '2026-07-14', sourceId: 'today-1' });
  seed(repository, { text: '今天零食180元', amount: 180, eventDate: '2026-07-14', sourceId: 'today-2' });
  seed(repository, { text: '今天吃饭400元', amount: 400, eventDate: '2026-07-14', sourceId: 'today-3' });
  seed(repository, { text: '昨天早餐15元', amount: 15, eventDate: '2026-07-13', sourceId: 'yesterday-1' });
  seed(repository, { text: '昨天买菜85元', amount: 85, eventDate: '2026-07-13', sourceId: 'yesterday-2' });
  const before = repository.count();

  const today = service.calculateExpenses(query('今天'));
  const yesterday = service.calculateExpenses(query('昨天'));
  const explanation = service.explainCalculation(yesterday.resultId);

  assert.equal(today.total, 600);
  assert.equal(today.matchedCount, 3);
  assert.equal(yesterday.total, 100);
  assert.equal(yesterday.matchedCount, 2);
  assert.deepEqual(yesterday.calculationSteps.map((step) => step.amount).sort((left, right) => left - right), [15, 85]);
  assert.equal(explanation.total, 100);
  assert.equal(repository.count(), before);
});

test('does not use today records when yesterday has no matching data', () => {
  const { repository, service } = setup('test-data-trust-no-fallback');
  seed(repository, { text: '今天停车20元', amount: 20, eventDate: '2026-07-14', sourceId: 'today-only' });

  const result = service.calculateExpenses(query('昨天'));

  assert.equal(result.total, 0);
  assert.equal(result.matchedCount, 0);
  assert.match(formatTrustedFinanceReply(result), /^昨天没有找到支出记录。/);
  assert.match(formatTrustedFinanceReply(result), /数据来源：个人账本 0 条/);
  assert.ok(result.excludedRecords.some((record) => record.excludedReason === 'outside_date_range'));
});

test('does not guess today when the date range is missing or unresolved', () => {
  const { repository, service } = setup('test-data-trust-unresolved-range');
  seed(repository, { text: '今天停车20元', amount: 20, eventDate: '2026-07-14', sourceId: 'today-1' });

  const missing = service.calculateExpenses({ ...scope });
  const unresolved = service.calculateExpenses({ ...scope, dateRange: resolveDateRange('有空的时候', scope) });

  assert.equal(missing.total, 0);
  assert.equal(unresolved.total, 0);
  assert.equal(missing.matchedCount, 0);
  assert.equal(unresolved.matchedCount, 0);
  assert.ok(missing.warnings.includes('date_range_unresolved'));
  assert.ok(unresolved.warnings.includes('date_range_unresolved'));
});

test('filters inactive, generic, query, AI output and superseded transaction-like records', () => {
  const { repository, service } = setup('test-data-trust-exclusions');
  seed(repository, { text: '今天有效支出20元', amount: 20, eventDate: '2026-07-14', sourceId: 'valid-1' });
  for (const status of ['deleted', 'forgotten', 'superseded', 'archived', 'rejected', 'expired']) {
    seed(repository, { text: `今天${status}支出10元`, amount: 10, eventDate: '2026-07-14', sourceId: `status-${status}`, status });
  }
  seed(repository, { text: '今天普通记忆30元', amount: 30, eventDate: '2026-07-14', sourceId: 'generic-1', memoryType: 'generic_memory', category: 'generic_memory', direction: 'expense' });
  seed(repository, { text: '今天花了多少钱？', amount: 40, eventDate: '2026-07-14', sourceId: 'query-1' });
  seed(repository, { text: '支出：50元，来源3条', amount: 50, eventDate: '2026-07-14', sourceId: 'ai-1', metadata: { isAiOutput: true, inputRole: 'assistant' } });

  const result = service.calculateExpenses(query('今天'));

  assert.equal(result.total, 20);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.excludedRecords.length, 9);
  assert.ok(result.excludedRecords.every((record) => record.excludedReason));
});

test('deduplicates repeated source ids and preserves provenance for the included record', () => {
  const { repository, service } = setup('test-data-trust-source-dedupe');
  const first = seed(repository, { text: '今天停车20元', amount: 20, eventDate: '2026-07-14', sourceId: 'same-source' });
  const replay = { ...first, id: `${first.id}-replay`, originalText: '今天停车费20元', normalizedText: '今天停车费20元' };

  const result = service.calculateExpenses(query('今天', { records: [first, replay] }));

  assert.equal(result.total, 20);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.provenance.length, 1);
  assert.equal(result.provenance[0].sourceId, 'same-source');
  assert.ok(result.excludedRecords.some((record) => record.excludedReason === 'duplicate_source_id'));
});

test('isolates records by userId and workspaceId', () => {
  const { repository, service } = setup('test-data-trust-scope-isolation');
  seed(repository, { text: '用户A工作区A支出20元', amount: 20, eventDate: '2026-07-14', sourceId: 'scope-aa' });
  seed(repository, { text: '用户B工作区A支出30元', amount: 30, eventDate: '2026-07-14', sourceId: 'scope-ba', userId: 'user-b' });
  seed(repository, { text: '用户A工作区B支出40元', amount: 40, eventDate: '2026-07-14', sourceId: 'scope-ab', workspaceId: 'workspace-b' });

  const result = service.calculateExpenses(query('今天'));

  assert.equal(result.total, 20);
  assert.equal(result.matchedCount, 1);
  assert.ok(result.excludedRecords.some((record) => record.excludedReason === 'user_scope_mismatch'));
  assert.ok(result.excludedRecords.some((record) => record.excludedReason === 'workspace_scope_mismatch'));
});

test('calculates income and balance through the same deterministic service', () => {
  const { repository, service } = setup('test-data-trust-income-balance');
  seed(repository, { text: '今天收到客户货款500元', amount: 500, eventDate: '2026-07-14', sourceId: 'income-1', direction: 'income' });
  seed(repository, { text: '今天停车20元', amount: 20, eventDate: '2026-07-14', sourceId: 'expense-1' });

  const income = service.calculateIncome(query('今天'));
  const balance = service.calculateBalance(query('今天'));

  assert.equal(income.total, 500);
  assert.equal(balance.income, 500);
  assert.equal(balance.expense, 20);
  assert.equal(balance.total, 480);
  assert.equal(balance.deterministic, true);
});

test('returns the complete trusted result and auditable record fields', () => {
  const { repository, service } = setup('test-data-trust-result-contract');
  seed(repository, { text: '今天早餐20元', amount: 20, eventDate: '2026-07-14', sourceId: 'detail-1', sourceType: 'quick_note' });

  const result = service.calculateExpenses(query('今天'));
  const detail = result.includedRecords[0];

  for (const field of ['total', 'currency', 'matchedCount', 'dateRange', 'label', 'includedRecords', 'excludedRecords', 'calculationSteps', 'provenance', 'warnings', 'deterministic']) {
    assert.ok(field in result, field);
  }
  for (const field of ['recordedAt', 'eventDate', 'direction', 'amount', 'category', 'originalText', 'sourceType', 'sourceId', 'createdAt', 'status']) {
    assert.ok(field in detail, field);
  }
  assert.equal(result.deterministic, true);
  assert.match(formatTrustedFinanceReply(result), /今天一共支出 20 元，共 1 笔/);
  assert.doesNotMatch(formatTrustedFinanceReply(result), /Memory|Repository|Provider|Model|sourceId/);
});

test('aggregates money in integer minor units and returns deterministic summaries', () => {
  const { repository, service } = setup('test-data-trust-integer-money');
  seed(repository, { text: '今天早餐0.1元', amount: 0.1, eventDate: '2026-07-14', sourceId: 'decimal-1', metadata: { amountMinor: 10, financeCategory: '餐饮' } });
  seed(repository, { text: '今天早餐0.2元', amount: 0.2, eventDate: '2026-07-14', sourceId: 'decimal-2', metadata: { amountMinor: 20, financeCategory: '餐饮' } });

  const result = service.calculateExpenses(query('今天'));

  assert.equal(result.total, 0.3);
  assert.equal(result.totalMinor, 30);
  assert.equal(result.average, 0.15);
  assert.equal(result.maxTransaction.amount, 0.2);
  assert.deepEqual(result.categoryTotals, [{ category: '餐饮', amount: 0.3, amountMinor: 30, count: 2 }]);
});

test('finance reply shows date range, timezone, traceable details and data source', () => {
  const { repository, service } = setup('test-data-trust-user-reply');
  seed(repository, { text: '今天早餐18元', amount: 18, eventDate: '2026-07-14', sourceId: 'reply-1', metadata: { amountMinor: 1800, financeCategory: '餐饮' } });

  const reply = formatTrustedFinanceReply(service.calculateExpenses(query('今天')));

  assert.match(reply, /日期范围：2026-07-14 至 2026-07-14/);
  assert.match(reply, /时区：Asia\/Shanghai/);
  assert.match(reply, /数据来源：个人账本 1 条/);
  assert.match(reply, /早餐.*18 元/);
});
