import assert from 'node:assert/strict';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { WorkSecretaryRepository } from './workSecretaryRepository.js';
import { WorkSecretaryManager } from './workSecretaryManager.js';
import { EventRepository } from '../events/eventRepository.js';
import { EventManager } from '../events/eventManager.js';

const storage = createMemoryStorage();
const repository = new WorkSecretaryRepository({ storage });
const eventRepository = new EventRepository({ storage });
const events = new EventManager({ repository: eventRepository });

const capturedRequests = [];
const ai = {
  async generate(request) {
    capturedRequests.push(request);
    return {
      taskType: request.metadata?.taskType || 'writing',
      selectedProvider: 'deepseek',
      selectedModel: 'deepseek-chat',
      fallbackUsed: false,
      content: `真实结果：${request.input}`,
      result: { content: `真实结果：${request.input}` },
      usage: { total_tokens: 18 },
      latency: 42,
      error: null
    };
  }
};

const settings = {
  load() {
    return {
      provider: 'deepseek',
      apiKey: 'local-test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat'
    };
  }
};

const manager = new WorkSecretaryManager({ repository, events, ai, settings });

const task = manager.createTask('帮我写一篇家具新品介绍');
assert.equal(task.userInput, '帮我写一篇家具新品介绍');
assert.equal(task.status, 'processing');
assert.equal(task.taskType, 'writing');
assert.ok(task.taskId);

const completed = await manager.executeTask(task.taskId);
assert.equal(completed.status, 'completed');
assert.match(completed.result, /家具新品介绍/);
assert.ok(completed.completedAt);
assert.equal(capturedRequests[0].input, '帮我写一篇家具新品介绍');
assert.equal(capturedRequests[0].metadata.taskType, 'writing');
assert.equal(capturedRequests[0].metadata.promptTemplateName, 'work-secretary-writing');
assert.equal(capturedRequests[0].metadata.taskConfirmation.userGoal, '帮我写一篇家具新品介绍');
assert.ok(Array.isArray(capturedRequests[0].messages));
assert.equal(capturedRequests[0].messages.at(-1).role, 'user');
assert.equal(capturedRequests[0].messages.at(-1).content, '帮我写一篇家具新品介绍');
assert.match(capturedRequests[0].messages[0].content, /不得偏离用户主题/);
assert.match(capturedRequests[0].messages[0].content, /写作主题/);

const reloaded = manager.listTasks();
assert.equal(reloaded.length, 1);
assert.equal(reloaded[0].taskId, task.taskId);
assert.equal(reloaded[0].status, 'completed');

const eventTypes = events.listEvents().map((event) => event.metadata?.workSecretaryStatus);
assert.ok(eventTypes.includes('task_created'));
assert.ok(eventTypes.includes('task_processing'));
assert.ok(eventTypes.includes('task_completed'));

const serverConfiguredManager = new WorkSecretaryManager({
  repository: new WorkSecretaryRepository({ storage: createMemoryStorage() }),
  events: new EventManager({ repository: new EventRepository({ storage: createMemoryStorage() }) }),
  ai: {
    async generate(request) {
      return { content: `服务端结果：${request.input}`, error: null };
    }
  },
  settings: {
    load() {
      return { provider: 'deepseek', apiKey: '', model: 'deepseek-chat' };
    }
  }
});

const serverConfiguredTask = serverConfiguredManager.createTask('帮我写一篇家具新品介绍');
const serverConfiguredResult = await serverConfiguredManager.executeTask(serverConfiguredTask.taskId);
assert.equal(serverConfiguredResult.status, 'completed');
assert.match(serverConfiguredResult.result, /服务端结果/);

const gatedStorage = createMemoryStorage();
const gatedRepository = new WorkSecretaryRepository({ storage: gatedStorage });
let gatedAiCalls = 0;
const gatedManager = new WorkSecretaryManager({
  repository: gatedRepository,
  events: new EventManager({ repository: new EventRepository({ storage: gatedStorage }) }),
  ai: {
    async generate() {
      gatedAiCalls += 1;
      return { content: '不应该调用 AI', error: null };
    }
  },
  settings
});

const reasoningTask = gatedManager.createTask('分析这份方案可能存在的风险。');
const reasoningResult = await gatedManager.executeTask(reasoningTask.taskId);
assert.equal(reasoningResult.status, 'needs_input');
assert.match(reasoningResult.error, /请提供需要分析的方案内容/);

const analysisTask = gatedManager.createTask('统计所有门店销售额、单品排行和成交率。');
const analysisResult = await gatedManager.executeTask(analysisTask.taskId);
assert.equal(analysisResult.status, 'needs_input');
assert.match(analysisResult.error, /请上传销售报表/);
assert.equal(gatedAiCalls, 0);

capturedRequests.length = 0;
const regressionTask = manager.createTask('帮我写一篇实木餐桌新品介绍，面向准备装修新房的家庭用户，约800字，风格专业但亲切，突出环保、耐用和售后服务。');
await manager.executeTask(regressionTask.taskId);
const writingRequest = capturedRequests.at(-1);
assert.equal(writingRequest.metadata.taskType, 'writing');
assert.equal(writingRequest.metadata.taskConfirmation.audience, '准备装修新房的家庭用户');
assert.equal(writingRequest.metadata.taskConfirmation.outputFormat, '约800字');
assert.match(writingRequest.messages[0].content, /环保、耐用和售后服务/);
assert.equal(writingRequest.messages.at(-1).content, regressionTask.userInput);

capturedRequests.length = 0;
const presentationTask = manager.createTask('生成一份家具门店季度经营汇报PPT大纲。');
await manager.executeTask(presentationTask.taskId);
const presentationRequest = capturedRequests.at(-1);
assert.equal(presentationRequest.metadata.taskType, 'presentation');
assert.equal(presentationRequest.metadata.promptTemplateName, 'work-secretary-presentation');
assert.match(presentationRequest.messages[0].content, /逐页大纲/);
assert.match(presentationRequest.messages[0].content, /不得输出普通长文章/);

capturedRequests.length = 0;
const followupTask = manager.createTask('把上面的内容写得更正式一些。');
await manager.executeTask(followupTask.taskId);
const followupRequest = capturedRequests.at(-1);
assert.equal(followupRequest.metadata.taskConfirmation.isFollowUp, true);
assert.equal(followupRequest.metadata.taskType, 'presentation');
assert.match(followupRequest.messages[0].content, /上一份结果/);
assert.match(followupRequest.messages[0].content, /只修改风格，不改变主题/);

capturedRequests.length = 0;
const attachmentTask = manager.createTask('总结附件里的主要内容。', {
  attachments: [
    {
      id: 'attachment-txt-1',
      name: '客户偏好.txt',
      mimeType: 'text/plain',
      size: 48,
      extension: 'txt',
      status: 'attached',
      parseable: true,
      content: '客户喜欢浅色实木家具，关注交付时间和售后服务。'
    },
    {
      id: 'attachment-pdf-1',
      name: '报价单.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      extension: 'pdf',
      status: 'attached',
      parseable: false,
      content: '这段内容不应进入 Prompt'
    },
    {
      id: 'attachment-xlsx-1',
      name: '销售表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 2048,
      extension: 'xlsx',
      status: 'readable',
      contentType: 'spreadsheet',
      parseable: true,
      tables: [
        {
          title: '销售',
          headers: ['门店', '销售额'],
          rows: [{ 门店: '上海店', 销售额: '18000' }]
        }
      ],
      metadata: { sheetNames: ['销售'] }
    }
  ]
});
assert.equal(attachmentTask.attachments.length, 3);
assert.equal(attachmentTask.attachments[0].taskId, attachmentTask.taskId);
const attachmentResult = await manager.executeTask(attachmentTask.taskId);
assert.equal(attachmentResult.status, 'completed');
assert.equal(attachmentResult.attachments.length, 3);
const attachmentRequest = capturedRequests.at(-1);
assert.equal(attachmentRequest.metadata.injectedAttachmentCount, 2);
assert.match(attachmentRequest.messages[0].content, /客户喜欢浅色实木家具/);
assert.match(attachmentRequest.messages[0].content, /上海店/);
assert.doesNotMatch(attachmentRequest.messages[0].content, /这段内容不应进入 Prompt/);

const failedFinanceStorage = createMemoryStorage();
const failedFinanceEvents = new EventManager({ repository: new EventRepository({ storage: failedFinanceStorage }) });
let failedFinanceAiCalls = 0;
const failedFinanceManager = new WorkSecretaryManager({
  repository: new WorkSecretaryRepository({ storage: failedFinanceStorage }),
  events: failedFinanceEvents,
  workspaceTools: {
    async runForInput() {
      return { handled: true, status: 'failed', result: '这笔记录未保存，请稍后重试。', error: '这笔记录未保存，请稍后重试。' };
    }
  },
  ai: {
    async generate() {
      failedFinanceAiCalls += 1;
      return { content: '已记录', error: null };
    }
  },
  settings
});
const failedFinanceTask = failedFinanceManager.createTask('又花20元');
const failedFinanceResult = await failedFinanceManager.executeTask(failedFinanceTask.taskId);
assert.equal(failedFinanceResult.status, 'failed');
assert.match(failedFinanceResult.error, /未保存/);
assert.equal(failedFinanceAiCalls, 0);
assert.doesNotMatch(failedFinanceEvents.listEvents().map((event) => event.metadata?.workSecretaryStatus).join(','), /task_completed/);

const eventFailureManager = new WorkSecretaryManager({
  repository: new WorkSecretaryRepository({ storage: createMemoryStorage() }),
  events: {
    createEvent() {
      throw new Error('event unavailable');
    }
  },
  workspaceTools: {
    async runForInput() {
      return { handled: true, status: 'completed', result: '已记录：支出 20 元。', metadata: { memoryId: 'finance-event-failure' } };
    }
  },
  ai: {
    async generate() {
      throw new Error('handled finance input must not call AI');
    }
  },
  settings
});
const eventFailureTask = eventFailureManager.createTask('今天早餐20元');
const eventFailureResult = await eventFailureManager.executeTask(eventFailureTask.taskId);
assert.equal(eventFailureResult.status, 'completed');
assert.match(eventFailureResult.result, /已记录/);

console.log('Work Secretary manager tests PASS');
