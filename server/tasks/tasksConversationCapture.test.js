import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { createTasksRuntime } from './runtime.js';

const NOW = new Date('2026-07-29T06:30:00.000Z');
const TIMEZONE = 'Asia/Shanghai';

function providerPlan(overrides = {}) {
  return {
    domain: 'ordinary_chat',
    intent: 'ordinary_chat',
    action: 'ordinary_chat',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: ['domain', 'intent', 'action'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.99,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null,
    ...overrides
  };
}

function taskPlan({ title, relativeDayOffset, localTime = null, ...overrides }) {
  return providerPlan({
    domain: 'tool',
    intent: 'create_task',
    action: 'tasks.create',
    predicate: 'task',
    qualifiers: { relative_day_offset: relativeDayOffset },
    tool: 'tasks.create',
    arguments: {
      title,
      description: null,
      relative_day_offset: relativeDayOffset,
      local_time: localTime
    },
    explicit_fields: [
      'domain', 'intent', 'action', 'predicate', 'tool',
      'qualifiers.relative_day_offset', 'arguments.title',
      'arguments.relative_day_offset',
      ...(localTime ? ['arguments.local_time'] : [])
    ],
    ...overrides
  });
}

function ambiguousTaskPlan() {
  return providerPlan({
    domain: 'ambiguous',
    intent: 'ambiguous',
    action: 'ambiguous',
    predicate: 'task',
    ambiguity_reasons: [{ field: 'scheduled_date', code: 'date_ambiguous' }],
    confidence: 0.55,
    requires_confirmation: true
  });
}

function createPlannerAiService() {
  const plans = new Map([
    ['今天下午3点开会', taskPlan({ title: '开会', relativeDayOffset: 0, localTime: '15:00' })],
    ['明天提醒我给客户打电话', taskPlan({ title: '给客户打电话', relativeDayOffset: 1 })],
    ['明天早上九点开会', taskPlan({
      title: '开会',
      relativeDayOffset: 1,
      localTime: '09:00',
      required_evidence: [{
        source: 'authenticated_conversation',
        required: ['source_message_id', 'client_request_id']
      }]
    })],
    ['今天晚上十一点开视频会议', taskPlan({
      title: '开视频会议',
      relativeDayOffset: 0,
      localTime: '23:00',
      arguments: {
        title: '开视频会议',
        description: null,
        date: '2026-07-29',
        relative_day_offset: 0,
        local_time: '23:00'
      },
      required_evidence: ['source_message_id', 'client_request_id']
    })],
    ['下周找时间跟客户沟通', ambiguousTaskPlan()],
    ['你好，给我讲个笑话', providerPlan()],
    ['请记住我喜欢喝茶', providerPlan({
      domain: 'memory',
      intent: 'capture',
      action: 'capture',
      entity: { type: 'person', reference: '我', relation_to_owner: 'self' },
      relation_to_owner: 'self',
      predicate: 'likes_drink',
      value: '茶',
      explicit_fields: ['domain', 'intent', 'action', 'entity', 'relation_to_owner', 'predicate', 'value']
    })],
    ['今天午饭花了30元', providerPlan({
      domain: 'finance',
      intent: 'create',
      action: 'create',
      value: { direction: 'expense', amount_text: '30元', occurred_expression: '今天' },
      qualifiers: { relative_day_offset: 0, category: '餐饮' },
      arguments: {
        transaction_candidate: {
          direction: 'expense',
          amount_text: '30元',
          occurred_expression: '今天'
        }
      },
      explicit_fields: [
        'domain', 'intent', 'action', 'value',
        'qualifiers.relative_day_offset', 'qualifiers.category',
        'arguments.transaction_candidate'
      ]
    })]
  ]);
  return {
    calls: [],
    async run(task) {
      this.calls.push(['run', task.input]);
      return { ok: true, content: JSON.stringify(plans.get(task.input) || providerPlan()) };
    },
    async stream(task, { onDelta }) {
      this.calls.push(['stream', task.input]);
      await onDelta('普通聊天回复');
      return { ok: true, content: '普通聊天回复' };
    },
    getStatus() { return { available: true }; }
  };
}

function disabledMemoryRuntime() {
  return {
    service: {},
    async initialize() { return { status: 'disabled', pathSummary: 'isolated-memory' }; },
    async close() {}
  };
}

function parseSse(text) {
  return text.trim().split('\n\n').map((block) => {
    const lines = block.split('\n');
    const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
    return { type, data: data ? JSON.parse(data) : null };
  });
}

async function request(baseUrl, pathname, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      'content-type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    body: contentType.includes('application/json') ? await response.json() : await response.text()
  };
}

async function createHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-task-capture-'));
  const publicDir = path.join(directory, 'public');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<main>isolated</main>');
  const aiService = createPlannerAiService();
  const tasksRuntime = createTasksRuntime({
    databasePath: path.join(directory, 'tasks.sqlite'),
    applyMigrations: true,
    clock: () => new Date(NOW)
  });
  const financeRuntime = createFinanceRuntime({
    databasePath: path.join(directory, 'finance.sqlite'),
    applyMigrations: true,
    timezone: TIMEZONE,
    clock: () => new Date(NOW)
  });
  const instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access.sqlite'),
      conversationDb: path.join(directory, 'conversations.sqlite'),
      privacyDb: path.join(directory, 'privacy.sqlite'),
      privacyExportDir: path.join(directory, 'exports'),
      privacyRequired: false,
      cookieSecret: 'task-capture-cookie-secret-long-enough',
      secureCookie: false,
      financeTimezone: TIMEZONE,
      host: '127.0.0.1',
      port: 0
    },
    aiService,
    memoryRuntime: disabledMemoryRuntime(),
    protectedMemoryRuntime: null,
    financeRuntime,
    tasksRuntime
  });
  const accountA = await instance.auth.createAccount({
    username: 'task_capture_a',
    displayName: 'Task Capture A',
    password: 'TaskCaptureA1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const accountB = await instance.auth.createAccount({
    username: 'task_capture_b',
    displayName: 'Task Capture B',
    password: 'TaskCaptureB1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const loginA = await instance.auth.login({ username: 'task_capture_a', password: 'TaskCaptureA1!' });
  const loginB = await instance.auth.login({ username: 'task_capture_b', password: 'TaskCaptureB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;

  async function chat({ message, clientRequestId, cookie = loginA.setCookie, conversationId = null, retry = false }) {
    const response = await request(baseUrl, '/api/ai/chat/stream', {
      method: 'POST',
      cookie,
      body: { message, clientRequestId, conversationId, retry }
    });
    return { ...response, events: parseSse(response.body) };
  }

  return {
    directory,
    instance,
    tasksRuntime,
    accountA,
    accountB,
    loginA,
    loginB,
    baseUrl,
    chat,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('RED: authenticated conversation creates today and tomorrow Tasks through the formal API', async () => {
  const h = await createHarness();
  try {
    const today = await h.chat({ message: '今天下午3点开会', clientRequestId: 'today-task-1' });
    assert.equal(today.status, 200);
    assert.match(today.body, /已加入今日事项/);

    const tomorrow = await h.chat({ message: '明天提醒我给客户打电话', clientRequestId: 'tomorrow-task-1' });
    assert.equal(tomorrow.status, 200);
    assert.match(tomorrow.body, /已加入明日事项/);

    const home = await request(
      h.baseUrl,
      '/api/tasks/today-tomorrow?timezone=Asia%2FShanghai',
      { cookie: h.loginA.setCookie }
    );
    assert.equal(home.status, 200);
    assert.deepEqual(home.body.today.map((item) => item.title), ['开会']);
    assert.deepEqual(home.body.tomorrow.map((item) => item.title), ['给客户打电话']);
    assert.equal(home.body.today[0].userId, h.accountA.id);
    assert.equal(home.body.today[0].timezone, TIMEZONE);
    assert.equal(home.body.today[0].status, 'pending');
  } finally {
    await h.close();
  }
});

test('RED: real Generation 129 Provider Task variants normalize into one today and one tomorrow row', async () => {
  const h = await createHarness();
  try {
    const tomorrow = await h.chat({
      message: '明天早上九点开会',
      clientRequestId: 'gen129-real-tomorrow'
    });
    assert.equal(tomorrow.status, 200);
    assert.match(tomorrow.body, /已加入明日事项/);

    const today = await h.chat({
      message: '今天晚上十一点开视频会议',
      clientRequestId: 'gen129-real-today'
    });
    assert.equal(today.status, 200);
    assert.match(today.body, /已加入今日事项/);

    const home = await request(
      h.baseUrl,
      '/api/tasks/today-tomorrow?timezone=Asia%2FShanghai',
      { cookie: h.loginA.setCookie }
    );
    assert.equal(home.status, 200);
    assert.deepEqual(
      home.body.today.map(({ title, scheduledAt, timezone }) => ({ title, scheduledAt, timezone })),
      [{
        title: '开视频会议',
        scheduledAt: '2026-07-29T15:00:00.000Z',
        timezone: 'Asia/Shanghai'
      }]
    );
    assert.deepEqual(
      home.body.tomorrow.map(({ title, scheduledAt, timezone }) => ({ title, scheduledAt, timezone })),
      [{
        title: '开会',
        scheduledAt: '2026-07-30T01:00:00.000Z',
        timezone: 'Asia/Shanghai'
      }]
    );

    await h.chat({
      message: '明天早上九点开会',
      clientRequestId: 'gen129-real-tomorrow'
    });
    await h.chat({
      message: '今天晚上十一点开视频会议',
      clientRequestId: 'gen129-real-today'
    });
    assert.equal(h.tasksRuntime.repository.exportForOwner(h.accountA.id).length, 2);
    assert.equal(h.tasksRuntime.repository.exportForOwner(h.accountB.id).length, 0);
  } finally {
    await h.close();
  }
});

test('RED: task capture is idempotent, durable and owner isolated', async () => {
  const h = await createHarness();
  try {
    await h.chat({ message: '今天下午3点开会', clientRequestId: 'same-task-request' });
    await h.chat({ message: '今天下午3点开会', clientRequestId: 'same-task-request' });
    assert.equal(h.tasksRuntime.repository.exportForOwner(h.accountA.id).length, 1);
    assert.equal(h.tasksRuntime.repository.exportForOwner(h.accountB.id).length, 0);

    const homeB = await request(
      h.baseUrl,
      '/api/tasks/today-tomorrow?timezone=Asia%2FShanghai',
      { cookie: h.loginB.setCookie }
    );
    assert.deepEqual(homeB.body.today, []);
    assert.deepEqual(homeB.body.tomorrow, []);
  } finally {
    await h.close();
  }
});

test('RED: ordinary chat, Memory and Finance do not create Tasks, and a truly ambiguous date asks', async () => {
  const h = await createHarness();
  try {
    const ordinary = await h.chat({ message: '你好，给我讲个笑话', clientRequestId: 'ordinary-1' });
    assert.match(ordinary.body, /普通聊天回复/);
    await h.chat({ message: '请记住我喜欢喝茶', clientRequestId: 'memory-1' });
    await h.chat({ message: '今天午饭花了30元', clientRequestId: 'finance-1' });
    const ambiguous = await h.chat({ message: '下周找时间跟客户沟通', clientRequestId: 'ambiguous-1' });
    assert.match(ambiguous.body, /补充|明确/);
    assert.equal(h.tasksRuntime.repository.exportForOwner(h.accountA.id).length, 0);
  } finally {
    await h.close();
  }
});
