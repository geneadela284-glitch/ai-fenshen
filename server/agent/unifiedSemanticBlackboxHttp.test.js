import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { createProtectedMemoryRuntime } from '../memory/protectedMemoryRuntime.js';
import { UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1 } from './fixtures/unifiedAssistantSemanticEvaluationV1.js';

const ACTION_ID = 'UNIFIED_ASSISTANT_SEMANTIC_INGRESS_IMPLEMENTATION';
const NOW = new Date('2026-07-23T04:00:00.000Z');

function clone(value) {
  return structuredClone(value);
}

function entry(input) {
  return clone(UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1.find((item) => item.input === input)?.plan);
}

function memoryPlan(input, overrides = {}) {
  const base = entry('我女儿的生日是6月8号');
  return {
    ...base,
    ...overrides,
    entity: { ...base.entity, ...(overrides.entity || {}) },
    qualifiers: { ...base.qualifiers, ...(overrides.qualifiers || {}) },
    arguments: { ...base.arguments, ...(overrides.arguments || {}) }
  };
}

function ordinaryChatPlan(intent, action, value) {
  return {
    domain: 'ordinary_chat',
    intent,
    action,
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value,
    qualifiers: {},
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: [],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.95,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function calendarPlan(input, overrides = {}) {
  const base = entry('今年对应阳历哪一天');
  return {
    ...base,
    ...overrides,
    entity: { ...base.entity, ...(overrides.entity || {}) },
    arguments: { ...base.arguments, ...(overrides.arguments || {}) },
    required_evidence: overrides.required_evidence || base.required_evidence
  };
}

function plans() {
  const mapped = new Map(UNIFIED_ASSISTANT_SEMANTIC_EVALUATION_V1.map((item) => [item.input, clone(item.plan)]));
  mapped.set('我女儿出生于2012年6月8日', memoryPlan('', {
    intent: 'new_fact',
    action: 'insert_fact',
    entity: { type: 'person', reference: '女儿', relation_to_owner: 'child' },
    relation_to_owner: 'child',
    predicate: 'birth_date',
    value: '2012-06-08',
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    explicit_fields: ['entity', 'relation_to_owner', 'predicate', 'value']
  }));
  mapped.set('我妈妈是农历7月16日生日', memoryPlan('', {
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: { year: null, month: 7, day: 16 },
    qualifiers: { calendar_type: 'lunar', recurrence: 'yearly' },
    explicit_fields: ['relation_to_owner', 'predicate', 'value.month', 'value.day', 'qualifiers.calendar_type']
  }));
  mapped.set('我妈什么时候生日', memoryPlan('', {
    intent: 'fact_query',
    action: 'query',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: null,
    qualifiers: {},
    explicit_fields: ['relation_to_owner', 'predicate']
  }));
  mapped.set('请记住我妈妈是公历5月20日生日', memoryPlan('', {
    intent: 'state_fact',
    action: 'add',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: { year: null, month: 5, day: 20 },
    qualifiers: { calendar_type: 'gregorian', recurrence: 'yearly' },
    explicit_fields: [
      'relation_to_owner', 'predicate', 'value.month', 'value.day',
      'qualifiers.calendar_type'
    ]
  }));
  mapped.set('我妈妈生日是哪天？', memoryPlan('', {
    intent: 'fact_query',
    action: 'query',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: null,
    qualifiers: {},
    explicit_fields: ['relation_to_owner', 'predicate']
  }));
  mapped.set('把我妈妈生日改为农历7月16日', memoryPlan('', {
    intent: 'correction',
    action: 'supersede',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    value: { year: null, month: 7, day: 16 },
    qualifiers: { calendar_type: 'lunar', recurrence: 'yearly' },
    arguments: {
      mutation_target: {
        operation: 'correction',
        entity_relation: 'mother',
        predicate: 'birthday'
      }
    },
    explicit_fields: [
      'relation_to_owner', 'predicate', 'value.month', 'value.day',
      'qualifiers.calendar_type'
    ]
  }));
  mapped.set('妈妈的下一个生日是哪天？', calendarPlan('', {
    action: 'next_occurrence',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    arguments: {
      source_calendar: 'gregorian',
      target_calendar: 'gregorian',
      target_year_reference: 'next_occurrence',
      target_year: null,
      occurrence: 'next_occurrence'
    },
    explicit_fields: ['relation_to_owner', 'predicate', 'action'],
    inherited_fields: []
  }));
  mapped.set('距离妈妈下一个生日还有多少天？', calendarPlan('', {
    action: 'days_until',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    arguments: {
      source_calendar: 'gregorian',
      target_calendar: 'gregorian',
      target_year_reference: 'next_occurrence',
      target_year: null,
      occurrence: 'next_occurrence'
    },
    explicit_fields: ['relation_to_owner', 'predicate', 'action'],
    inherited_fields: []
  }));
  mapped.set('妈妈今年的农历生日换成公历是哪天？', calendarPlan('', {
    action: 'convert_calendar_date',
    entity: { type: 'person', reference: '妈妈', relation_to_owner: 'mother' },
    relation_to_owner: 'mother',
    predicate: 'birthday',
    arguments: {
      source_calendar: 'lunar',
      target_calendar: 'gregorian',
      target_year_reference: 'this_year',
      target_year: null,
      occurrence: 'specified_year'
    },
    explicit_fields: ['relation_to_owner', 'predicate', 'action'],
    inherited_fields: []
  }));
  mapped.set('我女儿喜欢苹果', memoryPlan('', {
    intent: 'preference_fact',
    action: 'merge',
    entity: { type: 'person', reference: '女儿', relation_to_owner: 'daughter' },
    relation_to_owner: 'daughter',
    predicate: 'likes_food',
    value: ['苹果'],
    qualifiers: { cardinality: 'multiple', degree: 'normal' },
    explicit_fields: ['relation_to_owner', 'predicate', 'value']
  }));
  mapped.set('她喜欢什么', memoryPlan('', {
    intent: 'fact_query',
    action: 'query',
    entity: { type: 'person', reference: '她', relation_to_owner: 'daughter' },
    relation_to_owner: 'daughter',
    predicate: 'likes_food',
    value: null,
    qualifiers: {},
    explicit_fields: ['predicate'],
    inherited_fields: ['entity.relation_to_owner', 'relation_to_owner']
  }));
  mapped.set('我女儿什么时候出生', memoryPlan('', {
    intent: 'fact_query',
    action: 'query',
    entity: { type: 'person', reference: '女儿', relation_to_owner: 'daughter' },
    relation_to_owner: 'daughter',
    predicate: 'birth_date',
    value: null,
    qualifiers: {},
    explicit_fields: ['relation_to_owner', 'predicate']
  }));
  mapped.set('我儿子出生于2014年2月3日', memoryPlan('', {
    intent: 'new_fact',
    action: 'insert_fact',
    entity: { type: 'person', reference: '儿子', relation_to_owner: 'child' },
    relation_to_owner: 'child',
    predicate: 'birth_date',
    value: '2014-02-03',
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    explicit_fields: ['entity', 'relation_to_owner', 'predicate', 'value']
  }));
  mapped.set('我儿子什么时候出生', memoryPlan('', {
    intent: 'fact_query',
    action: 'query',
    entity: { type: 'person', reference: '儿子', relation_to_owner: 'child' },
    relation_to_owner: 'child',
    predicate: 'birth_date',
    value: null,
    qualifiers: {},
    arguments: { query_target: { entity_relation: 'son', predicate: 'birth_date' } },
    explicit_fields: ['entity', 'relation_to_owner', 'predicate']
  }));
  mapped.set('我的孩子出生于2016年4月5日', memoryPlan('', {
    intent: 'new_fact',
    action: 'insert_fact',
    entity: { type: 'person', reference: '孩子', relation_to_owner: 'child' },
    relation_to_owner: 'child',
    predicate: 'birth_date',
    value: '2016-04-05',
    qualifiers: { calendar_type: 'unknown', recurrence: 'one_time' },
    explicit_fields: ['entity', 'relation_to_owner', 'predicate', 'value']
  }));
  mapped.set('我的孩子什么时候出生', memoryPlan('', {
    intent: 'fact_query',
    action: 'query',
    entity: { type: 'person', reference: '孩子', relation_to_owner: 'child' },
    relation_to_owner: 'child',
    predicate: 'birth_date',
    value: null,
    qualifiers: {},
    arguments: { query_target: { entity_relation: 'other', predicate: 'birth_date' } },
    explicit_fields: ['entity', 'relation_to_owner', 'predicate']
  }));
  mapped.set('你好', ordinaryChatPlan('greet', 'respond_to_greeting', '你好，我是AI秘书。'));
  mapped.set('你是谁？', ordinaryChatPlan('inquiry_identity', 'respond_to_inquiry', '我是AI秘书。'));
  mapped.set(
    '请用一句话介绍你能帮助我做什么',
    ordinaryChatPlan('inquire_capabilities', 'respond_to_inquiry', '我可以协助处理工作和生活事务。')
  );
  mapped.set(
    '北京为什么是中国的首都？',
    ordinaryChatPlan('answer_general_knowledge', 'respond_to_inquiry', '这需要普通对话模型回答。')
  );
  mapped.set(
    '为什么天空通常看起来是蓝色的？',
    ordinaryChatPlan('answer_general_knowledge', 'respond_to_inquiry', '这需要普通对话模型回答。')
  );
  mapped.set('今天打车花了18元', {
    ...entry('早餐30'),
    value: { direction: 'expense', amount_text: '18' },
    qualifiers: { relative_day_offset: 0 },
    arguments: {
      metrics: ['expense'],
      transaction_candidate: {
        direction: 'expense',
        amount_text: '18',
        occurred_expression: '今天'
      }
    }
  });
  mapped.set('帮我处理一下', {
    ...ordinaryChatPlan('ambiguous', 'ambiguous', null),
    domain: 'ambiguous',
    ambiguity_reasons: ['target_missing'],
    confidence: 0.2
  });
  return mapped;
}

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => ({
    type: block.match(/^event:\s*(.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}')
  }));
}

function visible(events) {
  return events.filter((event) => event.type === 'delta').map((event) => event.data.text).join('');
}

async function harness(now = NOW) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-semantic-http-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  const memoryPath = path.join(root, 'memory.sqlite');
  const originalPath = path.join(root, 'original.sqlite');
  fs.writeFileSync(originalPath, 'protected');
  const authorization = {
    scope: 'local-m9-2-acceptance',
    environment: 'local-m9-2-acceptance',
    database_kind: 'isolated_acceptance_memory',
    database_path: memoryPath,
    owner_source: 'authenticated_session',
    allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
    original_memory_database: { path: originalPath, access: 'read_only' },
    cross_owner_access: 'denied',
    migration_allowed: false,
    bulk_import_allowed: false,
    active_action_ids: [ACTION_ID]
  };
  let tick = 0;
  const protectedMemory = createProtectedMemoryRuntime({
    databasePath: memoryPath,
    repositoryRoot: process.cwd(),
    authorization,
    scope: authorization.scope,
    actionId: ACTION_ID,
    now: () => new Date(now.getTime() + tick++ * 1000).toISOString()
  });
  const financeRuntime = createFinanceRuntime({
    databasePath: path.join(root, 'finance.sqlite'),
    timezone: 'Asia/Shanghai',
    applyMigrations: true,
    clock: () => now
  });
  const planMap = plans();
  const plannerCalls = [];
  const streamCalls = [];
  const aiService = {
    async run(request) {
      plannerCalls.push(request.input);
      const plan = planMap.get(request.input);
      return plan
        ? { ok: true, content: JSON.stringify(plan) }
        : { ok: true, content: JSON.stringify({
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
            explicit_fields: [],
            inherited_fields: [],
            ambiguity_reasons: [],
            confidence: 0.9,
            requires_confirmation: false,
            source_spans: [],
            source_message_id: null
          }) };
    },
    async stream(request, { onDelta }) {
      streamCalls.push(request.input);
      const content = [
        '你好',
        '你是谁？',
        '请用一句话介绍你能帮助我做什么',
        '北京为什么是中国的首都？',
        '为什么天空通常看起来是蓝色的？'
      ].includes(request.input)
        ? `真实普通模型回答：${request.input}`
        : '好的。';
      await onDelta(content);
      return { ok: true, content };
    }
  };
  const instance = await createBetaServer({
    config: {
      publicDir: path.join(root, 'public'),
      authDb: path.join(root, 'auth.sqlite'),
      conversationDb: path.join(root, 'conversations.sqlite'),
      cookieSecret: 'unified-semantic-http-cookie-secret',
      secureCookie: false,
      financeTimezone: 'Asia/Shanghai'
    },
    aiService,
    memoryRuntime: {
      service: {},
      initialize: async () => ({ status: 'disabled' }),
      close: async () => {}
    },
    protectedMemoryRuntime: protectedMemory,
    financeRuntime
  });
  await instance.auth.createAccount({
    username: 'unified_owner',
    displayName: 'Unified Owner',
    password: 'PasswordA1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_admin_v1'
  });
  await instance.auth.createAccount({
    username: 'other_owner',
    displayName: 'Other Owner',
    password: 'PasswordB1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_admin_v1'
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  async function login(username, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    return { cookie: response.headers.get('set-cookie'), ownerId: body.user.id };
  }
  const primary = await login('unified_owner', 'PasswordA1!');
  const secondary = await login('other_owner', 'PasswordB1!');
  return {
    root,
    instance,
    protectedMemory,
    financeRuntime,
    plannerCalls,
    streamCalls,
    baseUrl,
    cookie: primary.cookie,
    ownerId: primary.ownerId,
    otherCookie: secondary.cookie,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      instance.conversationRuntime?.close?.();
      protectedMemory.close();
      financeRuntime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function send(h, message, clientRequestId, conversationId = null, cookie = h.cookie) {
  const response = await fetch(`${h.baseUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      clientRequestId,
      ...(conversationId ? { conversationId } : {})
    })
  });
  const events = parseSse(await response.text());
  return {
    response,
    events,
    text: visible(events),
    conversationId: events.find((event) => event.type === 'started')?.data?.conversationId
  };
}

test('real Auth HTTP/SSE uses Unified Ingress only when needed and bypasses it for clear Finance writes', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const birth = await send(h, '我女儿出生于2012年6月8日', 'birth-date');
  assert.notEqual(birth.text, '我还不能确定你的意思，请再明确一点。');
  let memories = h.protectedMemory.inspectOwner(h.ownerId).currentMemories;
  assert.equal(memories.filter((item) => item.predicate === 'birthday').length, 1);
  assert.deepEqual(
    Object.fromEntries(['year', 'month', 'day', 'calendarType'].map((key) => [key, memories[0].structuredValue[key]])),
    { year: 2012, month: 6, day: 8, calendarType: 'unknown' }
  );

  const recalledBirth = await send(h, '我女儿什么时候出生', 'query-birth');
  assert.match(recalledBirth.text, /2012年6月8日/);
  assert.doesNotMatch(recalledBirth.text, /undefined|null/);

  const sonBirth = await send(h, '我儿子出生于2014年2月3日', 'son-birth-date');
  assert.notEqual(sonBirth.text, '你指的是哪一位家人？');
  const recalledSon = await send(h, '我儿子什么时候出生', 'query-son-birth');
  assert.match(recalledSon.text, /2014年2月3日/);

  const neutralChildBirth = await send(h, '我的孩子出生于2016年4月5日', 'child-birth-date');
  assert.notEqual(neutralChildBirth.text, '你指的是哪一位家人？');
  const recalledNeutralChild = await send(h, '我的孩子什么时候出生', 'query-child-birth');
  assert.match(recalledNeutralChild.text, /2016年4月5日/);

  const birthday = await send(h, '我女儿的生日是6月8号', 'birthday');
  const enriched = await send(h, '刚才说的是农历', 'enrich-lunar', birthday.conversationId);
  assert.notEqual(enriched.text, '请补充一个最必要的明确信息。');
  memories = h.protectedMemory.inspectOwner(h.ownerId).currentMemories;
  assert.equal(
    memories.find((item) => item.predicate === 'birthday' &&
      item.structuredValue.year === 2012).structuredValue.calendarType,
    'lunar',
    `${enriched.text} ${JSON.stringify(memories.map((item) => ({
      predicate: item.predicate,
      value: item.structuredValue,
      status: item.status
    })))}`
  );

  const apple = await send(h, '我女儿喜欢苹果', 'likes-apple');
  await send(h, '她也喜欢草莓', 'likes-strawberry', apple.conversationId);
  const likes = await send(h, '她喜欢什么', 'query-likes', apple.conversationId);
  assert.match(likes.text, /苹果/);
  assert.match(likes.text, /草莓/);
  assert.doesNotMatch(likes.text, /苹果.*苹果|undefined|null/);

  const expense = await send(h, '早餐30', 'finance-expense');
  assert.equal(expense.text, '已记录');
  const income = await send(h, '收入100', 'finance-income');
  assert.match(income.text, /^已记录/);
  const month = await send(h, '这个月收入和支出分别是多少', 'finance-month');
  assert.match(month.text, /收入100元/);
  assert.match(month.text, /支出30元/);
  assert.match(month.text, /结余70元/);
  assert.equal(h.financeRuntime.repository.list({
    ownerId: h.ownerId,
    limit: 20
  }).length, 2);

  await send(h, '我妈妈是农历7月16日生日', 'mother-birthday');
  const mother = await send(h, '我妈什么时候生日', 'mother-query');
  assert.equal(mother.text, '你妈妈是农历七月十六生日。');
  const converted = await send(h, '今年对应阳历哪一天', 'calendar-current', mother.conversationId);
  assert.match(converted.text, /2026年对应的公历日期是8月28日/);
  const next = await send(h, '明年呢', 'calendar-next', mother.conversationId);
  assert.match(next.text, /2027年对应的公历日期是8月17日/);
  const distance = await send(h, '离下一次生日还有多少天', 'calendar-distance', mother.conversationId);
  assert.match(distance.text, /还有36天/);

  const unknown = await send(h, '我爸爸什么时候生日', 'unknown-father');
  assert.equal(unknown.text, '我目前还不知道。');
  const otherOwner = await send(h, '我妈什么时候生日', 'cross-owner', null, h.otherCookie);
  assert.equal(otherOwner.text, '我目前还不知道。');

  assert.equal(h.plannerCalls.length, 19, 'only non-deterministic requests invoke the Unified Planner');
  assert.equal(h.plannerCalls.includes('早餐30'), false);
  assert.equal(h.plannerCalls.includes('收入100'), false);
});

test('RED: valid generic chat reaches the real model while true ambiguity and domain routes remain protected', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const ordinaryInputs = [
    '你好',
    '你是谁？',
    '请用一句话介绍你能帮助我做什么',
    '北京为什么是中国的首都？'
  ];
  for (const [index, input] of ordinaryInputs.entries()) {
    const result = await send(h, input, `ordinary-${index}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.text, `真实普通模型回答：${input}`);
    assert.notEqual(result.text, '我还不能确定你的意思，请再明确一点。');
  }
  assert.deepEqual(h.streamCalls, ordinaryInputs);

  const ambiguous = await send(h, '帮我处理一下', 'true-ambiguity');
  assert.equal(ambiguous.response.status, 200);
  assert.equal(ambiguous.text, '请补充一个最必要的明确信息。');
  assert.deepEqual(h.streamCalls, ordinaryInputs, 'true ambiguity must not reach generic model generation');
});

test('Generation 115 production chain accepts the M12 validity-gate inputs on an isolated HTTP runtime', async (t) => {
  const h = await harness(new Date('2026-07-27T04:00:00.000Z'));
  t.after(() => h.close());

  const saved = await send(h, '请记住我妈妈是公历5月20日生日', 'gate-memory-save');
  assert.notEqual(saved.text, '我还不能确定你的意思，请再明确一点。');

  const recalled = await send(h, '我妈妈生日是哪天？', 'gate-memory-recall');
  assert.match(recalled.text, /公历五月二十|公历5月20/);

  const next = await send(h, '妈妈的下一个生日是哪天？', 'gate-calendar-next');
  assert.match(next.text, /2027年.*5月20日/);

  const days = await send(h, '距离妈妈下一个生日还有多少天？', 'gate-calendar-days');
  assert.match(days.text, /还有297天/);

  await send(h, '把我妈妈生日改为农历7月16日', 'gate-lunar-seed');
  const lunar = await send(h, '妈妈今年的农历生日换成公历是哪天？', 'gate-calendar-lunar');
  assert.match(lunar.text, /2026年.*8月28日/);

  const finance = await send(h, '今天打车花了18元', 'gate-finance');
  assert.equal(finance.text, '已记录');
  assert.equal(h.financeRuntime.repository.list({ ownerId: h.ownerId, limit: 20 }).length, 1);

  const chat = await send(h, '为什么天空通常看起来是蓝色的？', 'gate-chat');
  assert.equal(chat.text, '真实普通模型回答：为什么天空通常看起来是蓝色的？');
});
