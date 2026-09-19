import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAssistantAgentOrchestrator } from '../agent/assistantAgentOrchestrator.js';
import { createBetaServer } from '../betaServer.js';
import { createProtectedMemoryRuntime } from '../memory/protectedMemoryRuntime.js';
import { createAssistantToolRegistry } from '../tools/assistantToolRegistry.js';
import { createCalendarTool } from '../tools/calendar/calendarTool.js';
import { createConversationRuntime } from './runtime.js';

const ACTION_ID = 'ASSISTANT_AGENT_CALENDAR_TOOL_IMPLEMENTATION';
const NOW = new Date('2026-07-23T04:00:00.000Z');

function memoryPlan(message, { intent = 'memory_candidate', relation = 'mother', value = null, calendarType = 'unknown' } = {}) {
  return {
    intent,
    subject: { entity_type: 'person', relation_to_owner: relation, normalized_reference: relation, resolved_entity_hint: null },
    predicate: 'birthday', value,
    qualifiers: {
      calendar_type: calendarType, year: null, month: value?.month ?? null, day: value?.day ?? null,
      lunar_leap_month: 'unknown', temporal_scope: 'stable', recurrence: 'yearly', degree: 'normal',
      cardinality: 'single', negation: false, uncertainty: false
    },
    confidence: 0.99,
    source_spans: [{ text: message, start: 0, end: message.length }],
    ambiguity_reasons: [], requires_confirmation: false,
    inherited_context: { previous_entity: null, previous_predicate: null, previously_returned_values: [] }
  };
}

function toolPlan(message, reference, action = 'convert_calendar_date', sourceCalendar = 'lunar') {
  return {
    domain: 'tool', action, tool: 'calendar.convert',
    arguments: {
      source_calendar: sourceCalendar, target_calendar: 'gregorian',
      target_year_reference: reference,
      occurrence: reference === 'next_occurrence' ? 'next_occurrence' : 'specified_year'
    },
    required_evidence: [{ entity_relation: 'mother', predicate: 'birthday', required_qualifiers: ['calendar_type', 'month', 'day', 'lunar_leap_month'] }],
    inherited_context: { previous_entity: 'mother', previous_predicate: 'birthday', previous_tool: 'calendar.convert' },
    confidence: 0.99, ambiguity: [], requires_confirmation: false, source_message_id: message
  };
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

async function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-tool-http-'));
  const memoryPath = path.join(root, 'memory.sqlite');
  const originalPath = path.join(root, 'original.sqlite');
  fs.writeFileSync(originalPath, 'protected');
  const authorization = {
    scope: 'local-m9-2-acceptance', environment: 'local-m9-2-acceptance', database_kind: 'isolated_acceptance_memory',
    database_path: memoryPath, owner_source: 'authenticated_session',
    allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
    original_memory_database: { path: originalPath, access: 'read_only' }, cross_owner_access: 'denied',
    migration_allowed: false, bulk_import_allowed: false, active_action_ids: [ACTION_ID]
  };
  const plans = new Map([
    ['我妈妈是农历7月16日生日。', memoryPlan('我妈妈是农历7月16日生日。', { value: { year: null, month: 7, day: 16 }, calendarType: 'lunar' })],
    ['我妈妈是公历1979年5月12日生日。', memoryPlan('我妈妈是公历1979年5月12日生日。', { value: { year: 1979, month: 5, day: 12 }, calendarType: 'gregorian' })],
    ['我妈什么时候生日？', memoryPlan('我妈什么时候生日？', { intent: 'memory_query' })],
    ['今年对应阳历哪一天？', memoryPlan('今年对应阳历哪一天？', { intent: 'memory_query', calendarType: 'gregorian' })],
    ['明年呢？', memoryPlan('明年呢？', { intent: 'memory_query', calendarType: 'gregorian' })],
    ['离下一次生日还有多少天？', memoryPlan('离下一次生日还有多少天？', { intent: 'memory_query', calendarType: 'gregorian' })],
    ['那下一次生日还有多少天？', memoryPlan('那下一次生日还有多少天？', { intent: 'memory_query', calendarType: 'gregorian' })]
  ]);
  const protectedMemory = createProtectedMemoryRuntime({
    databasePath: memoryPath, repositoryRoot: process.cwd(), authorization, scope: authorization.scope,
    actionId: ACTION_ID, now: () => NOW.toISOString(),
    semanticPlanner: { async plan({ message }) {
      const plan = plans.get(message);
      return plan ? { ok: true, plan: structuredClone(plan), attempts: 1, source: 'model' }
        : { ok: false, code: 'SEMANTIC_PLAN_INVALID', attempts: 2 };
    } }
  });
  const registry = createAssistantToolRegistry();
  registry.register(createCalendarTool());
  const assistantToolPlanner = { async plan({ message }) {
    if (message === '今年对应阳历哪一天？') return { ok: true, plan: toolPlan(message, 'this_year') };
    if (message === '明年呢？') return { ok: true, plan: toolPlan(message, 'next_year') };
    if (message === '离下一次生日还有多少天？') return { ok: true, plan: toolPlan(message, 'next_occurrence', 'days_until') };
    if (message === '那下一次生日还有多少天？') {
      return { ok: true, plan: toolPlan(message, 'next_occurrence', 'days_until', 'gregorian') };
    }
    return { ok: true, plan: {
      domain: 'ordinary_chat', action: 'ordinary_chat', tool: null, arguments: {}, required_evidence: [],
      inherited_context: { previous_entity: null, previous_predicate: null, previous_tool: null },
      confidence: 0.99, ambiguity: [], requires_confirmation: false, source_message_id: null
    } };
  } };
  const aiService = { async stream(request, { onDelta }) { await onDelta('好的。'); return { ok: true, content: '好的。' }; } };
  const agent = createAssistantAgentOrchestrator({
    assistantToolPlanner, toolRegistry: registry, memoryIntegration: protectedMemory,
    timezone: 'Asia/Shanghai', clock: () => NOW
  });
  const conversationRuntime = createConversationRuntime({
    databasePath: path.join(root, 'conversations.sqlite'), aiService, applyMigrations: true,
    memoryPolicy: 'protected_acceptance', assistantAgent: agent
  });
  const instance = await createBetaServer({
    config: { publicDir: path.join(root, 'public'), authDb: path.join(root, 'auth.sqlite'), cookieSecret: 'calendar-http-test-cookie-secret', secureCookie: false },
    aiService,
    memoryRuntime: { service: {}, initialize: async () => ({ status: 'disabled' }), close: async () => {} },
    conversationRuntime, protectedMemoryRuntime: protectedMemory
  });
  await instance.auth.createAccount({ username: 'calendar_owner', displayName: 'Calendar Owner', password: 'PasswordA1!', role: 'beta_user', quotaProfileId: 'closed_beta_user_v1' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'calendar_owner', password: 'PasswordA1!' })
  });
  return {
    root, instance, protectedMemory, conversationRuntime, baseUrl,
    cookie: login.headers.get('set-cookie'),
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      conversationRuntime.close();
      protectedMemory.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function send(h, message, clientRequestId, conversationId = null, cookie = h.cookie) {
  const response = await fetch(`${h.baseUrl}/api/ai/chat/stream`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ message, clientRequestId, ...(conversationId ? { conversationId } : {}) })
  });
  const events = parseSse(await response.text());
  return { response, events, text: visible(events), conversationId: events.find((event) => event.type === 'started')?.data?.conversationId };
}

test('authenticated HTTP Agent binds Memory Evidence, executes Calendar Tool and preserves owner-scoped continuation', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  await send(h, '我妈妈是农历7月16日生日。', 'seed-birthday');
  const recalled = await send(h, '我妈什么时候生日？', 'recall-birthday');
  assert.equal(recalled.text, '你妈妈是农历七月十六生日。');

  const current = await send(h, '今年对应阳历哪一天？', 'convert-current', recalled.conversationId);
  assert.equal(current.text, '你妈妈是农历七月十六生日，2026年对应的公历日期是8月28日。');
  assert.doesNotMatch(current.text, /undefined|null/);

  const next = await send(h, '明年呢？', 'convert-next', recalled.conversationId);
  assert.match(next.text, /2027年对应的公历日期是8月17日/);
  const distance = await send(h, '离下一次生日还有多少天？', 'next-occurrence', recalled.conversationId);
  assert.match(distance.text, /还有36天/);

  const logout = await fetch(`${h.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: h.cookie } });
  assert.equal(logout.status, 200);
  const login = await fetch(`${h.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'calendar_owner', password: 'PasswordA1!' })
  });
  const afterRelogin = await send(h, '今年对应阳历哪一天？', 'convert-relogin', null, login.headers.get('set-cookie'));
  assert.match(afterRelogin.text, /2026年对应的公历日期是8月28日/);
});

test('RED: authenticated HTTP continuation calculates a confirmed Gregorian birthday', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const saved = await send(h, '我妈妈是公历1979年5月12日生日。', 'seed-gregorian-birthday');
  assert.equal(saved.response.status, 200);
  const recalled = await send(h, '我妈什么时候生日？', 'recall-gregorian-birthday');
  assert.equal(recalled.text, '你妈妈是公历1979年5月12日生日。');

  const distance = await send(
    h,
    '那下一次生日还有多少天？',
    'gregorian-next-occurrence',
    recalled.conversationId
  );
  assert.equal(distance.response.status, 200);
  assert.equal(
    distance.text,
    '你妈妈是公历5月12日生日，下一次生日是2027年5月12日，还有293天。'
  );
  assert.doesNotMatch(distance.text, /暂时无法完成日期换算|undefined|null/);
});
