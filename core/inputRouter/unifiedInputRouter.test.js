import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';
import { UnifiedInputRouter, inputIntentTypes } from './index.js';

const now = '2026-07-13T09:00:00.000Z';

function createRouter() {
  const repository = new MemoryRepository({
    storage: createMemoryStorage(),
    namespace: 'test-unified-input-router',
    now: () => new Date(now)
  });
  const memoryService = new MemoryService({ repository, now: () => new Date(now) });
  const router = new UnifiedInputRouter({ memoryService, now: () => new Date(now) });
  return { repository, memoryService, router };
}

function classify(router, input, sourceType = 'conversation') {
  return router.classify(input, {
    sourceType,
    sourceId: `${sourceType}-1`,
    conversationId: sourceType === 'conversation' ? 'c1' : '',
    currentTime: now,
    locale: 'zh-CN'
  });
}

test('classifies core record, query, task, question, chat, ambiguous, sensitive, and rejected inputs', () => {
  const { router } = createRouter();

  const cases = [
    ['今天买菜花了100元。', inputIntentTypes.EXPENSE],
    ['我今天买菜花了多少钱？', inputIntentTypes.MEMORY_QUERY],
    ['刚才收到客户货款5000元。', inputIntentTypes.INCOME],
    ['明天下午3点见张总。', inputIntentTypes.SCHEDULE],
    ['我明天有什么安排？', inputIntentTypes.MEMORY_QUERY],
    ['请处理合同审核。', inputIntentTypes.TODO],
    ['提醒我明天下午3点跟进华南客户。', inputIntentTypes.REMINDER],
    ['华南客户报价是12万元。', inputIntentTypes.QUOTE],
    ['记一下，我喜欢简洁界面。', inputIntentTypes.MEMORY_RECORD],
    ['帮我写一篇产品介绍。', inputIntentTypes.WORK_TASK],
    ['你觉得简洁界面好吗？', inputIntentTypes.QUESTION],
    ['你好。', inputIntentTypes.CASUAL_CHAT],
    ['今晚8点。', inputIntentTypes.AMBIGUOUS],
    ['我的银行卡号是6222021234567890123。', inputIntentTypes.MEMORY_RECORD],
    ['这条不要记住。', inputIntentTypes.REJECTED],
    ['   ', inputIntentTypes.REJECTED]
  ];

  for (const [input, expected] of cases) {
    const result = classify(router, input);
    assert.equal(result.intent, expected, input);
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.entities && typeof result.entities === 'object');
    assert.ok(Array.isArray(result.warnings));
    assert.equal(typeof result.normalizedInput, 'string');
  }

  assert.equal(classify(router, '我的银行卡号是6222021234567890123。').requiresConfirmation, true);
  assert.equal(classify(router, '今晚8点。').requiresConfirmation, true);
  assert.equal(classify(router, '帮我写一篇产品介绍。').shouldRemember, false);
});

test('returns the same intent for conversation and quick note sources', () => {
  const { router } = createRouter();
  const inputs = [
    '今天买菜花了100元。',
    '刚才收到客户货款5000元。',
    '明天下午3点见张总。',
    '提醒我明天下午3点跟进华南客户。',
    '华南客户报价是12万元。',
    '我今天买菜花了多少钱？',
    '帮我写一篇产品介绍。',
    '你好。'
  ];

  inputs.forEach((input) => {
    const conversation = classify(router, input, 'conversation');
    const quickNote = classify(router, input, 'quick_note');
    assert.equal(quickNote.intent, conversation.intent, input);
    assert.equal(quickNote.proposedAction, conversation.proposedAction, input);
  });
});

test('handles records and memory queries consistently across conversation and quick note sources', async () => {
  const { repository, router } = createRouter();

  const expense = await router.handle('今天买菜花了100元。', {
    sourceType: 'conversation',
    sourceId: 'c1',
    conversationId: 'c1',
    currentTime: now
  });
  const parking = await router.handle('今天停车费20元。', {
    sourceType: 'quick_note',
    sourceId: 'quick-note-1',
    currentTime: now
  });
  const duplicate = await router.handle('今天买菜花了100元。', {
    sourceType: 'conversation',
    sourceId: 'c1',
    conversationId: 'c1',
    currentTime: now
  });
  const anotherExpense = await router.handle('又花了100元。', {
    sourceType: 'conversation',
    sourceId: 'c2',
    conversationId: 'c2',
    currentTime: now
  });

  assert.equal(expense.status, 'completed');
  assert.equal(parking.status, 'completed');
  assert.equal(duplicate.status, 'ignored');
  assert.equal(anotherExpense.status, 'completed');
  assert.equal(repository.count(), 3);

  const today = await router.handle('我今天买菜花了多少钱？', {
    sourceType: 'conversation',
    sourceId: 'c3',
    conversationId: 'c3',
    currentTime: now
  });
  const parkingQuery = await router.handle('我今天停车花了多少钱？', {
    sourceType: 'conversation',
    sourceId: 'c3',
    conversationId: 'c3',
    currentTime: now
  });

  assert.equal(today.intent.intent, inputIntentTypes.MEMORY_QUERY);
  assert.match(today.result, /今天一共支出 100 元，共 1 笔/);
  assert.match(parkingQuery.result, /今天一共支出 20 元，共 1 笔/);
});

test('does not save questions, casual chat, work tasks, ambiguous, sensitive, rejected, or failed classification inputs', async () => {
  const { repository, router } = createRouter();
  const noProviderTask = await router.handle('帮我写一篇产品介绍。', { sourceType: 'conversation', sourceId: 'c1', conversationId: 'c1', currentTime: now });
  const question = await router.handle('你觉得简洁界面好吗？', { sourceType: 'conversation', sourceId: 'c1', conversationId: 'c1', currentTime: now });
  const chat = await router.handle('你好。', { sourceType: 'conversation', sourceId: 'c1', conversationId: 'c1', currentTime: now });
  const ambiguous = await router.handle('今晚8点。', { sourceType: 'quick_note', sourceId: 'q1', currentTime: now });
  const sensitive = await router.handle('我的银行卡号是6222021234567890123。', { sourceType: 'quick_note', sourceId: 'q1', currentTime: now });
  const rejected = await router.handle('这条不要记住。', { sourceType: 'quick_note', sourceId: 'q1', currentTime: now });

  assert.equal(noProviderTask.status, 'pass_through');
  assert.equal(question.status, 'pass_through');
  assert.equal(chat.status, 'pass_through');
  assert.equal(ambiguous.status, 'needs_input');
  assert.equal(sensitive.status, 'needs_input');
  assert.equal(rejected.status, 'ignored');
  assert.equal(repository.count(), 0);
});

test('does not save amount explanation and provenance queries', async () => {
  const { repository, router } = createRouter();
  await router.handle('今天买菜花了100元。', { sourceType: 'conversation', sourceId: 'expense-1', conversationId: 'c1', currentTime: now });
  const before = repository.count();

  const explanation = await router.handle('640元是怎么得出的结果？', { sourceType: 'conversation', sourceId: 'query-1', conversationId: 'c1', currentTime: now });
  const why = await router.handle('为什么是640元？', { sourceType: 'conversation', sourceId: 'query-2', conversationId: 'c1', currentTime: now });
  const provenance = await router.handle('来源是哪几条？', { sourceType: 'conversation', sourceId: 'query-3', conversationId: 'c1', currentTime: now });
  const aiResultText = await router.handle('支出：640元，来源：长期记忆4条。', { sourceType: 'conversation', sourceId: 'ai-result-1', conversationId: 'c1', currentTime: now });

  assert.equal(explanation.intent.intent, inputIntentTypes.CALCULATION_QUERY);
  assert.equal(why.intent.intent, inputIntentTypes.CALCULATION_QUERY);
  assert.equal(provenance.intent.intent, inputIntentTypes.PROVENANCE_QUERY);
  assert.equal(aiResultText.intent.intent, inputIntentTypes.PROVENANCE_QUERY);
  assert.equal(repository.count(), before);
  assert.match(explanation.result, /请确认要统计的时间范围/);
});

test('classifies explanation and correction intents without saving', async () => {
  const { repository, router } = createRouter();
  const explanation = await router.handle('解释一下这个金额。', { sourceType: 'conversation', sourceId: 'explain-1', conversationId: 'c1', currentTime: now });
  const correction = await router.handle('这条金额不对，需要更正。', { sourceType: 'conversation', sourceId: 'correction-1', conversationId: 'c1', currentTime: now });

  assert.equal(explanation.intent.intent, inputIntentTypes.EXPLANATION_QUERY);
  assert.equal(correction.intent.intent, inputIntentTypes.CORRECTION_REQUEST);
  assert.equal(repository.count(), 0);
});


test('does not report confirmation candidates as saved', async () => {
  const memoryService = {
    remember() {
      return {
        ok: true,
        action: 'prepared',
        code: 'MEMORY_CONFIRMATION_REQUIRED',
        requiresConfirmation: true,
        data: {
          id: 'candidate-1',
          originalText: '今天买菜花了100元。',
          memoryType: 'expense',
          amount: 100,
          direction: 'expense',
          status: 'pending_confirmation'
        }
      };
    },
    searchMemories() {
      return { ok: true, data: [] };
    }
  };
  const router = new UnifiedInputRouter({ memoryService, now: () => new Date(now) });
  const result = await router.handle('记一下，项目预算500元。', {
    sourceType: 'conversation',
    sourceId: 'candidate-1',
    conversationId: 'c1',
    currentTime: now
  });

  assert.equal(result.status, 'needs_input');
  assert.match(result.result, /需要确认，尚未保存/);
});

test('finance query uses strict eligible records and returns provenance', async () => {
  const { repository, router } = createRouter();
  await router.handle('今天买菜花了100元。', { sourceType: 'conversation', sourceId: 'expense-1', conversationId: 'c1', currentTime: now });
  await router.handle('今天又买菜花了100元。', { sourceType: 'conversation', sourceId: 'expense-2', conversationId: 'c1', currentTime: now });

  repository.create({
    sourceType: 'conversation',
    sourceId: 'generic-1',
    originalText: '640元是怎么得出的结果？',
    normalizedText: '640元是怎么得出的结果？',
    memoryType: 'generic_memory',
    category: 'generic_memory',
    title: '解释追问',
    summary: '640元是怎么得出的结果？',
    amount: 640,
    currency: 'CNY',
    direction: 'neutral',
    status: 'confirmed',
    needsConfirmation: false,
    eventDate: '2026-07-13'
  }, { confirmedByUser: true });
  repository.create({
    sourceType: 'conversation',
    sourceId: 'deleted-1',
    originalText: '今天买票花了50元。',
    normalizedText: '今天买票花了50元。',
    memoryType: 'expense',
    category: 'expense',
    title: '删除支出',
    summary: '今天买票花了50元',
    amount: 50,
    currency: 'CNY',
    direction: 'expense',
    status: 'deleted',
    needsConfirmation: false,
    eventDate: '2026-07-13'
  }, { confirmedByUser: true });
  repository.create({
    sourceType: 'conversation',
    sourceId: 'archived-1',
    originalText: '今天打车花了60元。',
    normalizedText: '今天打车花了60元。',
    memoryType: 'expense',
    category: 'expense',
    title: '归档支出',
    summary: '今天打车花了60元',
    amount: 60,
    currency: 'CNY',
    direction: 'expense',
    status: 'archived',
    needsConfirmation: false,
    eventDate: '2026-07-13'
  }, { confirmedByUser: true });

  const query = await router.handle('我今天花了多少钱？', {
    sourceType: 'conversation',
    sourceId: 'query-1',
    conversationId: 'c2',
    currentTime: now
  });

  assert.equal(query.intent.intent, inputIntentTypes.MEMORY_QUERY);
  assert.match(query.result, /今天一共支出 200 元，共 2 笔/);
  assert.equal(query.metadata.finance.total, 200);
  assert.equal(query.metadata.finance.matchedCount, 2);
  assert.equal(query.metadata.finance.includedRecords.length, 2);
  assert.ok(query.metadata.finance.excludedRecords.length >= 2);
  assert.match(query.result, /明细/);
});

test('duplicate sourceId does not save twice but explicit new events still save', async () => {
  const { repository, router } = createRouter();
  const first = await router.handle('今天买菜花了100元。', { sourceType: 'conversation', sourceId: 'submit-1', conversationId: 'c1', currentTime: now });
  const duplicate = await router.handle('今天买菜花了100元。', { sourceType: 'conversation', sourceId: 'submit-1', conversationId: 'c2', currentTime: now });
  const duplicateDifferentSource = await router.handle('今天买菜花了100元。', { sourceType: 'conversation', sourceId: 'submit-other', conversationId: 'c4', currentTime: now });
  const another = await router.handle('今天又买菜花了100元。', { sourceType: 'conversation', sourceId: 'submit-2', conversationId: 'c3', currentTime: now });

  assert.equal(first.status, 'completed');
  assert.equal(duplicate.status, 'ignored');
  assert.equal(duplicateDifferentSource.status, 'completed');
  assert.equal(another.status, 'completed');
  assert.equal(repository.count(), 3);
});

test('empty finance query returns no matching record message', async () => {
  const { repository, router } = createRouter();
  const query = await router.handle('我今天花了多少钱？', {
    sourceType: 'conversation',
    sourceId: 'query-empty',
    conversationId: 'c1',
    currentTime: now
  });

  assert.equal(repository.count(), 0);
  assert.match(query.result, /^今天没有找到支出记录。/);
  assert.match(query.result, /日期范围：2026-07-13 至 2026-07-13/);
  assert.match(query.result, /数据来源：个人账本 0 条/);
});

test('saves explicit transaction facts with short confirmation UX', async () => {
  const { repository, router } = createRouter();

  const meal = await router.handle('今天吃饭花了500', {
    sourceType: 'conversation',
    sourceId: 'meal-1',
    conversationId: 'c1',
    currentTime: now
  });
  const lunch = await router.handle('午饭68元', {
    sourceType: 'conversation',
    sourceId: 'lunch-1',
    conversationId: 'c1',
    currentTime: now
  });
  const payment = await router.handle('今天收到货款5000元', {
    sourceType: 'conversation',
    sourceId: 'income-1',
    conversationId: 'c1',
    currentTime: now
  });

  assert.equal(meal.status, 'completed');
  assert.match(meal.result, /^已记录：餐饮支出 500 元。\n今天 · 个人账本 · 可修改$/);
  assert.equal(meal.result.split('\n').length, 2);
  assert.deepEqual(meal.metadata.actions, ['修改', '撤销', '查看明细']);
  assert.equal(meal.metadata.action.name, 'CreateExpense');
  assert.equal(meal.metadata.action.type, 'expense');
  assert.equal(meal.metadata.action.result, 'success');
  assert.match(meal.metadata.action.proposalId, /.+/);
  assert.match(meal.metadata.action.auditId, /.+/);
  assert.equal(lunch.status, 'completed');
  assert.match(lunch.result, /餐饮支出 68 元/);
  assert.equal(payment.status, 'completed');
  assert.match(payment.result, /^已记录：收入 5000 元。\n今天 · 个人账本 · 可修改$/);
  assert.equal(repository.count(), 3);
});

test('saves explicit schedule facts with short localized confirmation UX', async () => {
  const { repository, router } = createRouter();

  const schedule = await router.handle('今天下午四点开会', {
    sourceType: 'conversation',
    sourceId: 'schedule-1',
    conversationId: 'c1',
    currentTime: now
  });

  assert.equal(schedule.status, 'completed');
  assert.equal(schedule.intent.intent, inputIntentTypes.SCHEDULE);
  assert.equal(schedule.result, '已安排：今天下午4点开会。');
  assert.doesNotMatch(schedule.result, /金额|currency|direction|收入|支出/);
  assert.doesNotMatch(schedule.result, /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/);
  assert.equal(schedule.result.split('\n').length, 1);
  assert.deepEqual(schedule.metadata.actions, ['修改', '撤销', '查看日程']);
  assert.equal(schedule.metadata.action.name, 'CreateSchedule');
  assert.equal(schedule.metadata.action.type, 'schedule');
  assert.equal(schedule.metadata.action.result, 'success');
  assert.match(schedule.metadata.action.proposalId, /.+/);
  assert.match(schedule.metadata.action.auditId, /.+/);
  assert.equal(repository.count(), 1);
});

test('records unclear transaction category as uncategorized but asks only for missing critical fields', async () => {
  const { repository, router } = createRouter();

  const uncategorized = await router.handle('今天花了500', {
    sourceType: 'conversation',
    sourceId: 'uncategorized-1',
    conversationId: 'c1',
    currentTime: now
  });
  const amountOnly = await router.handle('500元', {
    sourceType: 'conversation',
    sourceId: 'amount-only-1',
    conversationId: 'c1',
    currentTime: now
  });
  const missingAmount = await router.handle('记一笔饭钱', {
    sourceType: 'conversation',
    sourceId: 'missing-amount-1',
    conversationId: 'c1',
    currentTime: now
  });

  assert.equal(uncategorized.status, 'completed');
  assert.match(uncategorized.result, /^已记录：未分类支出 500 元。/);
  assert.equal(amountOnly.status, 'needs_input');
  assert.equal(amountOnly.result, '这是收入还是支出？');
  assert.equal(missingAmount.status, 'needs_input');
  assert.equal(missingAmount.result, '金额是多少？');
  assert.equal(repository.count(), 1);
});

test('transaction correction and explanation requests do not create duplicate memories', async () => {
  const { repository, router } = createRouter();
  await router.handle('今天吃饭花了500', {
    sourceType: 'conversation',
    sourceId: 'meal-1',
    conversationId: 'c1',
    currentTime: now
  });
  const before = repository.count();

  const correction = await router.handle('刚才不是500，是480', {
    sourceType: 'conversation',
    sourceId: 'correction-1',
    conversationId: 'c1',
    currentTime: now
  });
  const explanation = await router.handle('500元怎么得出的？', {
    sourceType: 'conversation',
    sourceId: 'why-1',
    conversationId: 'c1',
    currentTime: now
  });

  assert.equal(correction.intent.intent, inputIntentTypes.CORRECTION_REQUEST);
  assert.equal(correction.status, 'needs_input');
  assert.equal(explanation.intent.intent, inputIntentTypes.CALCULATION_QUERY);
  assert.equal(repository.count(), before);
});
