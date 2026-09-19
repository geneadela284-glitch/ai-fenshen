import assert from 'node:assert/strict';
import test from 'node:test';
import { QuickNoteManager } from '../quickNote/quickNoteManager.js';
import { QuickNoteRepository } from '../quickNote/quickNoteRepository.js';
import { KnowledgeFileManager } from '../knowledgeDrop/knowledgeFileManager.js';
import { KnowledgeFileRepository } from '../knowledgeDrop/knowledgeFileRepository.js';
import { KnowledgeManager } from '../knowledge/knowledgeManager.js';
import { KnowledgeRepository } from '../repositories/knowledgeRepository.js';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';
import { WorkSecretaryRepository } from '../workSecretary/workSecretaryRepository.js';
import { WorkSecretaryConversationRepository } from '../workSecretary/conversationRepository.js';
import { WorkspaceContextService } from './workspaceContextService.js';
import { WorkspaceToolRegistry } from './workspaceToolRegistry.js';

function silentEvents() {
  return { createEvent: () => null };
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function createHarness() {
  const storage = createMemoryStorage();
  const quickNotes = new QuickNoteManager({
    repository: new QuickNoteRepository({ storage }),
    events: silentEvents(),
    ai: null
  });
  const knowledgeFiles = new KnowledgeFileManager({
    repository: new KnowledgeFileRepository({ storage }),
    events: silentEvents()
  });
  const knowledge = new KnowledgeManager({
    repository: new KnowledgeRepository({ storage })
  });
  const taskRepository = new WorkSecretaryRepository({ storage });
  const conversationRepository = new WorkSecretaryConversationRepository({ storage });
  const memoryRepository = new MemoryRepository({ storage, namespace: `test-workspace-memory-${Date.now()}-${Math.random()}` });
  const memoryService = new MemoryService({ repository: memoryRepository });
  const context = new WorkspaceContextService({
    quickNotes,
    knowledgeFiles,
    knowledge,
    taskRepository,
    conversationRepository
  });
  const tools = new WorkspaceToolRegistry({ context, quickNotes, memoryService });
  return { storage, quickNotes, knowledgeFiles, knowledge, taskRepository, conversationRepository, context, memoryService, tools };
}

test('calculates only formal transaction facts and ignores numbers in generic quick notes', async () => {
  const { quickNotes, memoryService, tools } = createHarness();
  const currentTime = new Date().toISOString();
  quickNotes.save(quickNotes.classify('今天10点核对订单5000号。'));
  memoryService.remember('今天收到客户货款5000元', { context: { sourceType: 'conversation', sourceId: 'income-1', now: currentTime } });
  memoryService.remember('今天停车费20元', { context: { sourceType: 'conversation', sourceId: 'expense-1', now: currentTime } });

  const result = await tools.runForInput('我今天的收支怎么样？', { now: currentTime });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'completed');
  assert.match(result.result, /今天收入 5000 元，支出 20 元，结余 4980 元/);
  assert.equal(result.metadata.income, 5000);
  assert.equal(result.metadata.expense, 20);
  assert.equal(result.metadata.balance, 4980);
  assert.equal(result.metadata.entryCount, 2);
});

test('creates schedule from main conversation intent', async () => {
  const { quickNotes, tools } = createHarness();

  const result = await tools.runForInput('记一下，明天下午3点跟进华南客户。');
  const notes = quickNotes.listNotes();

  assert.equal(result.handled, true);
  assert.equal(result.status, 'completed');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].category, 'schedule');
  assert.equal(notes[0].content, '跟进华南客户。');
  assert.equal(notes[0].time, '15:00');
  assert.match(result.result, /已创建日程/);
});

test('syncs natural language schedule from main conversation into today agenda source and emits updates', async () => {
  const { quickNotes, context, tools } = createHarness();
  const changes = [];
  const currentTime = new Date();
  currentTime.setHours(9, 0, 0, 0);
  const unsubscribe = quickNotes.subscribeScheduleChanges((event) => changes.push(event));

  const result = await tools.runForInput('今天下午四点开会', {
    conversationId: 'c1',
    sourceId: 'schedule-submit-1',
    now: currentTime.toISOString()
  });
  const todayItems = context.getSchedules({ period: 'today', limit: 10 });
  const tomorrowItems = context.getSchedules({ period: 'tomorrow', limit: 10 });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, '已安排：今天下午4点开会。');
  assert.equal(todayItems.length, 1);
  assert.equal(todayItems[0].category, 'schedule');
  assert.equal(todayItems[0].time, '16:00');
  assert.equal(todayItems[0].content, '开会');
  assert.equal(tomorrowItems.length, 0);
  assert.equal(changes.at(-1).type, 'schedule.created');

  const updated = quickNotes.updateNote(todayItems[0].id, {
    scheduledAt: new Date(`${dateKey(currentTime)}T17:00:00`).toISOString(),
    time: '17:00',
    timeText: '今天下午5点',
    content: '开会'
  });
  assert.equal(updated.time, '17:00');
  assert.equal(context.getSchedules({ period: 'today', limit: 10 })[0].time, '17:00');
  assert.equal(changes.at(-1).type, 'schedule.updated');

  quickNotes.deleteNote(todayItems[0].id);
  assert.equal(context.getSchedules({ period: 'today', limit: 10 }).length, 0);
  assert.equal(changes.at(-1).type, 'schedule.deleted');
  unsubscribe();
});

test('updates recent schedule time from concise correction without creating duplicates', async () => {
  const { quickNotes, context, tools } = createHarness();
  const currentTime = new Date();
  currentTime.setHours(9, 0, 0, 0);
  await tools.runForInput('今天下午四点开会', {
    conversationId: 'c1',
    sourceId: 'schedule-submit-1',
    now: currentTime.toISOString()
  });

  const result = await tools.runForInput('改到下午五点', {
    conversationId: 'c1',
    sourceId: 'schedule-update-1',
    now: currentTime.toISOString()
  });
  const notes = quickNotes.listNotes();
  const todayItems = context.getSchedules({ period: 'today', limit: 10 });

  assert.equal(result.status, 'completed');
  assert.equal(result.result, '已安排：今天下午5点开会。');
  assert.equal(notes.length, 1);
  assert.equal(todayItems.length, 1);
  assert.equal(todayItems[0].time, '17:00');
  assert.equal(todayItems[0].content, '开会');
});

test('queries tomorrow schedule from real quick notes', async () => {
  const { quickNotes, tools } = createHarness();
  quickNotes.save(quickNotes.classify('明天下午3点跟进华南客户。'));

  const result = await tools.runForInput('我明天有什么安排？');

  assert.equal(result.handled, true);
  assert.match(result.result, /来源：明天安排 1 项/);
  assert.match(result.result, /跟进华南客户/);
});

test('keeps weekend planning requests in ordinary AI conversation', async () => {
  const { tools } = createHarness();
  const inputs = [
    '帮我安排一个简单的周末计划',
    '给我一个两天的休息方案',
    '周末怎么安排更充实',
    '帮我规划一次家庭活动',
    '我想周末放松一下，有什么建议'
  ];

  for (const [index, input] of inputs.entries()) {
    const result = await tools.runForInput(input, {
      conversationId: `weekend-plan-${index}`,
      sourceId: `weekend-plan-${index}`
    });
    assert.equal(result.handled, false, input);
  }
});

test('routes explicit weekend schedule questions to schedule query', async () => {
  const { tools } = createHarness();
  const inputs = [
    '我周末有什么安排',
    '我周末有什么安排？',
    '查一下周六日程',
    '周日有什么事',
    '这个周末有会议吗'
  ];

  for (const [index, input] of inputs.entries()) {
    const result = await tools.runForInput(input, {
      conversationId: `weekend-query-${index}`,
      sourceId: `weekend-query-${index}`,
      now: '2026-07-15T09:00:00+08:00'
    });
    assert.equal(result.handled, true, input);
    assert.equal(result.intent.type, 'schedule.query', input);
  }
});

test('routes explicit weekend reminder and schedule writes to persistence', async () => {
  const { quickNotes, tools } = createHarness();
  const inputs = [
    '周六下午3点提醒我健身',
    '周日晚上安排家庭聚餐',
    '周末加一个买菜待办'
  ];

  for (const [index, input] of inputs.entries()) {
    const result = await tools.runForInput(input, {
      conversationId: `weekend-write-${index}`,
      sourceId: `weekend-write-${index}`,
      now: '2026-07-15T09:00:00+08:00'
    });
    assert.equal(result.handled, true, input);
    assert.notEqual(result.intent.type || result.intent.intent, 'schedule.query', input);
    assert.equal(result.status, index === 0 ? 'completed' : 'needs_input', input);
  }

  assert.equal(quickNotes.listNotes().length, 1);
});

test('does not fabricate unparsed knowledge file content', async () => {
  const { knowledgeFiles, tools } = createHarness();
  knowledgeFiles.addFile({
    name: '华南报价表.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 128
  });

  const result = await tools.runForInput('根据最新报价单写一封客户跟进邮件。');

  assert.equal(result.handled, true);
  assert.match(result.result, /来源：资料库 1 条/);
  assert.match(result.result, /不能伪造引用内容/);
});

test('opens matching recent result', async () => {
  const { taskRepository, tools } = createHarness();
  taskRepository.create({
    id: 'task-1',
    taskId: 'task-1',
    userInput: '帮我写产品介绍',
    status: 'completed',
    result: '产品介绍正文',
    completedAt: new Date().toISOString()
  });

  const result = await tools.runForInput('打开我刚才生成的产品介绍。');

  assert.equal(result.handled, true);
  assert.match(result.result, /来源：最近成果/);
  assert.match(result.result, /产品介绍正文/);
});

test('summarizes weekly quick notes from real records', async () => {
  const { quickNotes, memoryService, tools } = createHarness();
  const currentTime = new Date().toISOString();
  quickNotes.save(quickNotes.classify('今天收到客户货款5000元，停车费支出20元。'));
  quickNotes.save(quickNotes.classify('今天完成了新品方案。'));
  memoryService.remember('今天收到客户货款5000元', { context: { sourceType: 'conversation', sourceId: 'report-income-1', now: currentTime } });
  memoryService.remember('今天停车费20元', { context: { sourceType: 'conversation', sourceId: 'report-expense-1', now: currentTime } });

  const result = await tools.runForInput('把我本周随手记整理成周报。', { now: currentTime });

  assert.equal(result.handled, true);
  assert.match(result.result, /来源：随手记 2 条/);
  assert.match(result.result, /本周随手记总结/);
  assert.match(result.result, /收入：5000元/);
  assert.match(result.result, /支出：20元/);
});
