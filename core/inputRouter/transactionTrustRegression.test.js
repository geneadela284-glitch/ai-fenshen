import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';
import { UnifiedInputRouter } from './unifiedInputRouter.js';

const currentTime = '2026-07-14T01:30:00.000Z';
const baseContext = {
  sourceType: 'conversation',
  conversationId: 'conversation-a',
  currentTime,
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  userId: 'user-a',
  workspaceId: 'workspace-a'
};

function createRouter(namespace) {
  const repository = new MemoryRepository({
    storage: createMemoryStorage(),
    namespace,
    now: () => new Date(currentTime)
  });
  const memoryService = new MemoryService({ repository, now: () => new Date(currentTime) });
  return {
    repository,
    memoryService,
    router: new UnifiedInputRouter({ memoryService, now: () => new Date(currentTime) })
  };
}

test('saves short expense statements including 花20 and 今天花20', async () => {
  const { repository, router } = createRouter('test-short-expense-statements');
  const inputs = ['今天花了20元', '花20', '今天花20'];

  for (let index = 0; index < inputs.length; index += 1) {
    const result = await router.handle(inputs[index], {
      ...baseContext,
      sourceId: `short-expense-${index + 1}`,
      submissionId: `submission-${index + 1}`
    });
    assert.equal(result.status, 'completed', inputs[index]);
  }

  assert.equal(repository.count(), 3);
  assert.deepEqual(repository.list().map((record) => record.amount), [20, 20, 20]);
  assert.ok(repository.list().every((record) => record.eventDate === '2026-07-14'));
});

test('treats 又花20 as a second real event and totals both records', async () => {
  const { repository, router } = createRouter('test-additive-expense-events');
  await router.handle('今天花了20元', { ...baseContext, sourceId: 'event-1', submissionId: 'submission-1' });
  const second = await router.handle('又花20', { ...baseContext, sourceId: 'event-2', submissionId: 'submission-2' });
  const result = await router.handle('我今天一共花了多少钱？', { ...baseContext, sourceId: 'query-1', submissionId: 'query-1' });

  assert.equal(second.status, 'completed');
  assert.equal(repository.count(), 2);
  assert.equal(result.metadata.finance.total, 40);
  assert.equal(result.metadata.finance.matchedCount, 2);
});

test('completes the 58 yuan today and 30 yuan yesterday acceptance flow without query writes', async () => {
  const { repository, router } = createRouter('test-p0-finance-acceptance-flow');
  const facts = [
    ['今天早餐18元', 'breakfast-18'],
    ['又花20元', 'expense-20-a'],
    ['又花20元', 'expense-20-b'],
    ['昨天打车30元', 'taxi-yesterday-30']
  ];
  for (const [input, sourceId] of facts) {
    const saved = await router.handle(input, { ...baseContext, sourceId, submissionId: sourceId });
    assert.equal(saved.status, 'completed', input);
  }

  const beforeQueries = repository.count();
  const today = await router.handle('我今天花了多少？', { ...baseContext, sourceId: 'query-today-58' });
  const yesterday = await router.handle('昨天花了多少？', { ...baseContext, sourceId: 'query-yesterday-30' });
  assert.equal(today.metadata.finance.totalMinor, 5800);
  assert.equal(today.metadata.finance.matchedCount, 3);
  assert.equal(yesterday.metadata.finance.totalMinor, 3000);
  assert.equal(yesterday.metadata.finance.matchedCount, 1);
  assert.equal(repository.count(), beforeQueries);

  const fourth = await router.handle('今天又花20元', {
    ...baseContext,
    sourceId: 'expense-20-c',
    submissionId: 'expense-20-c'
  });
  const updatedToday = await router.handle('我今天花了多少？', { ...baseContext, sourceId: 'query-today-78' });
  assert.equal(fourth.status, 'completed');
  assert.equal(updatedToday.metadata.finance.totalMinor, 7800);
  assert.equal(updatedToday.metadata.finance.matchedCount, 4);
});

test('uses sourceId and submissionId as replay idempotency keys', async () => {
  const { repository, router } = createRouter('test-transaction-replay-keys');
  const first = await router.handle('今天花了20元', { ...baseContext, sourceId: 'source-1', submissionId: 'submission-1' });
  const sameSource = await router.handle('今天花了20元', { ...baseContext, sourceId: 'source-1', submissionId: 'submission-2' });
  const sameSubmission = await router.handle('今天花了20元', { ...baseContext, sourceId: 'source-2', submissionId: 'submission-1' });
  const newSubmission = await router.handle('今天花了20元', { ...baseContext, sourceId: 'source-3', submissionId: 'submission-3' });

  assert.equal(first.status, 'completed');
  assert.equal(sameSource.status, 'ignored');
  assert.equal(sameSubmission.status, 'ignored');
  assert.equal(newSubmission.status, 'completed');
  assert.equal(repository.count(), 2);
});

test('does not bypass replay protection when an additive event is retried', async () => {
  const { repository, router } = createRouter('test-additive-event-replay');
  const first = await router.handle('又花20', { ...baseContext, sourceId: 'additive-source', submissionId: 'additive-submission' });
  const replay = await router.handle('又花20', { ...baseContext, sourceId: 'additive-source', submissionId: 'additive-submission' });

  assert.equal(first.status, 'completed');
  assert.equal(replay.status, 'ignored');
  assert.equal(repository.count(), 1);
});

test('keeps today and yesterday calculations separate and explains the last result without writing', async () => {
  const { repository, router } = createRouter('test-date-separated-calculations');
  const facts = [
    ['今天停车20元', 'today-1'],
    ['今天零食180元', 'today-2'],
    ['今天吃饭400元', 'today-3'],
    ['昨天早餐15元', 'yesterday-1'],
    ['昨天买菜85元', 'yesterday-2']
  ];
  for (const [input, sourceId] of facts) {
    await router.handle(input, { ...baseContext, sourceId, submissionId: sourceId });
  }

  const before = repository.count();
  const today = await router.handle('我今天一共花了多少钱？', { ...baseContext, sourceId: 'today-query' });
  const yesterday = await router.handle('我昨天花了多少钱？', { ...baseContext, sourceId: 'yesterday-query' });
  const explanation = await router.handle('昨天怎么得出的？', { ...baseContext, sourceId: 'explanation-query' });

  assert.match(today.result, /今天一共支出 600 元，共 3 笔/);
  assert.match(yesterday.result, /昨天一共支出 100 元，共 2 笔/);
  assert.equal(today.metadata.finance.total, 600);
  assert.equal(yesterday.metadata.finance.total, 100);
  assert.match(explanation.result, /15 元/);
  assert.match(explanation.result, /85 元/);
  assert.match(explanation.result, /合计 100 元/);
  assert.equal(repository.count(), before);
});

test('returns an exact no-data message and never falls back to today records', async () => {
  const { repository, router } = createRouter('test-yesterday-empty-message');
  await router.handle('今天停车20元', { ...baseContext, sourceId: 'today-only', submissionId: 'today-only' });

  const result = await router.handle('我昨天花了多少钱？', { ...baseContext, sourceId: 'yesterday-query' });

  assert.match(result.result, /^昨天没有找到支出记录。/);
  assert.match(result.result, /日期范围：2026-07-13 至 2026-07-13/);
  assert.equal(result.metadata.finance.total, 0);
  assert.equal(repository.count(), 1);
});

test('stores relative transaction event dates even when no clock time is present', async () => {
  const { repository, router } = createRouter('test-relative-transaction-date');
  await router.handle('昨天买菜花了20元', { ...baseContext, sourceId: 'yesterday-1', submissionId: 'yesterday-1' });
  await router.handle('前天收到客户货款300元', { ...baseContext, sourceId: 'before-yesterday-1', submissionId: 'before-yesterday-1' });

  const records = repository.list({ sortBy: 'eventDate', sortOrder: 'asc' });
  assert.deepEqual(records.map((record) => record.eventDate), ['2026-07-12', '2026-07-13']);
});

test('writes and queries the day before yesterday without mixing adjacent days', async () => {
  const { repository, router } = createRouter('test-day-before-yesterday-finance');
  await router.handle('今天早餐18元', { ...baseContext, sourceId: 'today', submissionId: 'today' });
  await router.handle('昨天打车30元', { ...baseContext, sourceId: 'yesterday', submissionId: 'yesterday' });
  await router.handle('前天买菜25元', { ...baseContext, sourceId: 'day-before-yesterday', submissionId: 'day-before-yesterday' });

  const result = await router.handle('我前天花了多少？', { ...baseContext, sourceId: 'day-before-yesterday-query' });

  assert.equal(result.metadata.finance.total, 25);
  assert.equal(result.metadata.finance.matchedCount, 1);
  assert.match(result.result, /前天一共支出 25 元，共 1 笔/);
  assert.equal(repository.count(), 3);
});

test('asks for one occurred date when a transaction write contains a date range', async () => {
  const { repository, router } = createRouter('test-ambiguous-transaction-date-range');
  const result = await router.handle('7月1日到7月10日买菜25元', {
    ...baseContext,
    sourceId: 'ambiguous-date-range',
    submissionId: 'ambiguous-date-range'
  });

  assert.equal(result.status, 'needs_input');
  assert.match(result.result, /日期/);
  assert.equal(repository.count(), 0);
});

test('queries, explanations, history loads and AI output never create transactions', async () => {
  const { repository, router } = createRouter('test-non-fact-inputs');
  await router.handle('今天花了20元', { ...baseContext, sourceId: 'fact-1', submissionId: 'fact-1' });
  const before = repository.count();
  const inputs = [
    ['今天花了多少钱？', { sourceId: 'query-today' }],
    ['昨天一共花了多少？', { sourceId: 'query-yesterday' }],
    ['600元怎么得出的？', { sourceId: 'query-explain' }],
    ['支出：600元，来源3条', { sourceId: 'ai-result', role: 'assistant', isAiOutput: true }],
    ['今天花了88元', { sourceId: 'history-1', historyLoad: true }]
  ];

  for (const [input, extra] of inputs) {
    await router.handle(input, { ...baseContext, ...extra });
  }

  assert.equal(repository.count(), before);
});

test('rejects invalid transaction amounts and parses yuan jiao fen exactly', async () => {
  const { repository, router } = createRouter('test-transaction-amount-boundaries');
  const invalidInputs = ['今天花了0元', '今天花了-20元', '今天花了1.234元', '今天花了999999999999999999元'];

  for (let index = 0; index < invalidInputs.length; index += 1) {
    const result = await router.handle(invalidInputs[index], {
      ...baseContext,
      sourceId: `invalid-${index}`,
      submissionId: `invalid-${index}`
    });
    assert.notEqual(result.status, 'completed', invalidInputs[index]);
  }

  const validCases = [
    ['今天早餐18元5分', 'fractional-fen', 1805],
    ['今天午餐18元5角', 'fractional-jiao', 1850],
    ['今天晚餐18元5角6分', 'fractional-yuan-jiao-fen', 1856],
    ['今天打车5角6分', 'fractional-jiao-fen', 56],
    ['今天车费5角', 'fractional-jiao-only', 50]
  ];
  for (const [input, sourceId, expectedMinor] of validCases) {
    const valid = await router.handle(input, { ...baseContext, sourceId, submissionId: sourceId });
    assert.equal(valid.status, 'completed', input);
    assert.equal(repository.list().find((record) => record.sourceId === sourceId)?.metadata.amountMinor, expectedMinor);
  }

  assert.equal(repository.count(), 5);
});

test('returns a failed finance result when persistence fails instead of passing through to AI', async () => {
  const { repository, memoryService, router } = createRouter('test-transaction-write-failure');
  memoryService.remember = () => ({ ok: false, code: 'MEMORY_STORAGE_FAILED' });

  const result = await router.handle('又花20元', {
    ...baseContext,
    sourceId: 'failed-write',
    submissionId: 'failed-write'
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'failed');
  assert.match(result.result, /未保存/);
  assert.equal(repository.count(), 0);
});

test('reads a saved transaction back before reporting success', async () => {
  const { repository, memoryService, router } = createRouter('test-transaction-readback-failure');
  memoryService.getMemory = () => ({ ok: false, code: 'MEMORY_NOT_FOUND' });

  const result = await router.handle('又花20元', {
    ...baseContext,
    sourceId: 'failed-readback',
    submissionId: 'failed-readback'
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'failed');
  assert.match(result.result, /核对失败|未保存/);
  assert.equal(repository.count(), 0);
});
