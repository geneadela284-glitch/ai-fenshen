import crypto from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createBetaServer } from '../../server/betaServer.js';
import { createFinanceRuntime } from '../../server/finance/runtime.js';
import { createTasksRuntime } from '../../server/tasks/runtime.js';

const timezone = 'Asia/Shanghai';
const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-mobile-task-capture-'));
const username = `mobile_task_${Date.now()}`;
const password = `Mobile${crypto.randomBytes(9).toString('hex')}7`;

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

const plans = new Map([
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
      date: new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date()),
      relative_day_offset: 0,
      local_time: '23:00'
    },
    required_evidence: ['source_message_id', 'client_request_id']
  })]
]);
const aiService = {
  async run(task) {
    return { ok: true, content: JSON.stringify(plans.get(task.input) || providerPlan()) };
  },
  async stream(_task, { onDelta }) {
    await onDelta('这是隔离验收回复。');
    return { ok: true, content: '这是隔离验收回复。' };
  },
  getStatus() {
    return { available: true };
  }
};
const disabledMemoryRuntime = {
  service: {},
  async initialize() {
    return { status: 'disabled', pathSummary: 'isolated-mobile-acceptance' };
  },
  async close() {}
};

mkdirSync(path.join(directory, 'privacy-exports'), { recursive: true });
const tasksRuntime = createTasksRuntime({
  databasePath: path.join(directory, 'tasks.sqlite'),
  applyMigrations: true
});
const financeRuntime = createFinanceRuntime({
  databasePath: path.join(directory, 'finance.sqlite'),
  applyMigrations: true,
  timezone
});
const instance = await createBetaServer({
  config: {
    publicDir: path.resolve('apps/desktop/dist'),
    authDb: path.join(directory, 'auth.sqlite'),
    accessControlDb: path.join(directory, 'access.sqlite'),
    conversationDb: path.join(directory, 'conversations.sqlite'),
    privacyDb: path.join(directory, 'privacy.sqlite'),
    privacyExportDir: path.join(directory, 'privacy-exports'),
    privacyRequired: true,
    cookieSecret: crypto.randomBytes(32).toString('hex'),
    secureCookie: false,
    financeTimezone: timezone,
    host: '127.0.0.1',
    port: 0
  },
  aiService,
  memoryRuntime: disabledMemoryRuntime,
  protectedMemoryRuntime: null,
  financeRuntime,
  tasksRuntime
});

await instance.auth.createAccount({
  username,
  displayName: 'Mobile Task Acceptance',
  password,
  role: 'beta_user',
  quotaProfileId: 'closed_beta_user_v1'
});
await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
const port = instance.server.address().port;
const credentialsPath = path.join(directory, 'credentials.json');
writeFileSync(credentialsPath, `${JSON.stringify({ username, password })}\n`, { mode: 0o600 });
chmodSync(credentialsPath, 0o600);

process.stdout.write(`${JSON.stringify({
  ready: true,
  baseUrl: `http://127.0.0.1:${port}`,
  credentialsPath,
  dataDirectory: directory
})}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => instance.server.close(resolve));
  instance.auth.close();
  rmSync(directory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
await new Promise(() => {});
