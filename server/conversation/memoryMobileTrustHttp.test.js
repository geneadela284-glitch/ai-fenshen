import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createConversationRuntime } from './runtime.js';
import { createProtectedMemoryRuntime } from '../memory/protectedMemoryRuntime.js';
import { computeMemoryRecordV2Checksum } from '../../memory/entity/validation.js';

const ACTION_ID = 'MEMORY_MOBILE_TRUST_STABILIZATION_IMPLEMENTATION';

function qualifiers(overrides = {}) {
  return {
    calendar_type: 'unknown', year: null, month: null, day: null,
    lunar_leap_month: 'unknown', temporal_scope: 'stable', recurrence: 'unknown',
    degree: 'normal', cardinality: 'single', negation: false, uncertainty: false,
    ...overrides
  };
}

function memoryPlan(message, {
  intent = 'memory_candidate', relation = 'mother', predicate = 'birthday',
  value = null, qualifierOverrides = {}, inherited = {},
  ambiguityReasons = [], requiresConfirmation = false
} = {}) {
  return {
    intent,
    subject: {
      entity_type: 'person', relation_to_owner: relation,
      normalized_reference: relation, resolved_entity_hint: null
    },
    predicate,
    value,
    qualifiers: qualifiers(qualifierOverrides),
    confidence: 0.98,
    source_spans: [{ text: message, start: 0, end: message.length }],
    ambiguity_reasons: ambiguityReasons,
    requires_confirmation: requiresConfirmation,
    inherited_context: {
      previous_entity: inherited.previous_entity || null,
      previous_predicate: inherited.previous_predicate || null,
      previously_returned_values: inherited.previously_returned_values || []
    }
  };
}

function plans() {
  const values = new Map();
  const put = (message, options) => values.set(message, memoryPlan(message, options));
  put('我妈妈7月16日生日', {
    value: { year: null, month: 7, day: 16 },
    qualifierOverrides: { month: 7, day: 16, recurrence: 'yearly' }
  });
  put('我妈什么时候生日？', { intent: 'memory_query' });
  put('她是农历7月16生日', {
    value: { year: null, month: 7, day: 16 },
    qualifierOverrides: { calendar_type: 'lunar', month: 7, day: 16, recurrence: 'yearly' },
    inherited: { previous_entity: 'mother', previous_predicate: 'birthday' }
  });
  put('我女儿喜欢苹果', {
    relation: 'daughter', predicate: 'likes_food', value: ['苹果'],
    qualifierOverrides: { cardinality: 'multiple' }
  });
  put('她喜欢吃什么？', {
    intent: 'memory_query', relation: 'daughter', predicate: 'likes_food',
    inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food' }
  });
  put('她最喜欢吃我煮的沸腾鱼', {
    relation: 'daughter', predicate: 'favorite_food', value: '我煮的沸腾鱼',
    qualifierOverrides: { degree: 'favorite', cardinality: 'single' }
  });
  put('还有她最喜欢吃我煮的沸腾鱼。', {
    relation: 'daughter', predicate: 'favorite_food', value: '我煮的沸腾鱼',
    qualifierOverrides: { degree: 'favorite', cardinality: 'single' },
    inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food' }
  });
  put('还有呢？', {
    intent: 'memory_query', relation: 'daughter', predicate: 'likes_food',
    inherited: { previous_entity: 'daughter', previous_predicate: 'likes_food' }
  });
  put('我爸爸喜欢喝茶', {
    relation: 'father', predicate: 'likes_food', value: ['茶'],
    qualifierOverrides: { cardinality: 'multiple' }
  });
  put('我爸爸什么时候生日？', {
    intent: 'memory_query', relation: 'father', predicate: 'birthday'
  });
  put('一个不存在的家庭成员生日是什么时候？', {
    intent: 'ambiguous', relation: 'other', predicate: 'birthday',
    qualifierOverrides: { uncertainty: true },
    ambiguityReasons: ['无法确定具体家庭成员'], requiresConfirmation: true
  });
  return values;
}

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => ({
    type: block.match(/^event:\s*(.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}')
  }));
}

function visibleText(result) {
  return result.events.filter((event) => event.type === 'delta').map((event) => event.data.text).join('');
}

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mobile-trust-http-'));
  const memoryPath = path.join(root, 'memory.sqlite');
  const originalPath = path.join(root, 'original.sqlite');
  fs.writeFileSync(originalPath, 'protected');
  const authorization = {
    scope: 'local-m9-2-acceptance', environment: 'local-m9-2-acceptance',
    database_kind: 'isolated_acceptance_memory', database_path: memoryPath,
    owner_source: 'authenticated_session',
    allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
    original_memory_database: { path: originalPath, access: 'read_only' },
    cross_owner_access: 'denied', migration_allowed: false, bulk_import_allowed: false,
    active_action_ids: [ACTION_ID]
  };
  const planMap = plans();
  let tick = 0;
  const protectedMemory = createProtectedMemoryRuntime({
    databasePath: memoryPath,
    repositoryRoot: process.cwd(),
    authorization,
    scope: authorization.scope,
    actionId: ACTION_ID,
    now: () => new Date(Date.UTC(2026, 6, 23, 2, 0, tick++)).toISOString(),
    semanticPlanner: {
      async plan({ message }) {
        const value = planMap.get(message);
        return value
          ? { ok: true, plan: structuredClone(value), attempts: 1, source: 'model' }
          : { ok: false, code: 'SEMANTIC_PLAN_INVALID', attempts: 2 };
      }
    }
  });
  const aiService = {
    async stream(request, { onDelta }) {
      await onDelta('好的。');
      return { ok: true, content: '好的。' };
    }
  };
  const conversationRuntime = createConversationRuntime({
    databasePath: path.join(root, 'conversations.sqlite'),
    aiService,
    applyMigrations: true,
    memoryPolicy: 'protected_acceptance',
    memoryIntegration: protectedMemory
  });
  const instance = await createBetaServer({
    config: {
      publicDir: path.join(root, 'public'), authDb: path.join(root, 'auth.sqlite'),
      cookieSecret: 'memory-mobile-trust-http-cookie-secret', secureCookie: false
    },
    aiService,
    memoryRuntime: { service: {}, initialize: async () => ({ status: 'disabled' }), close: async () => {} },
    conversationRuntime,
    protectedMemoryRuntime: protectedMemory
  });
  await instance.auth.createAccount({
    username: 'memory_owner', displayName: 'Memory Owner', password: 'PasswordA1!', role: 'beta_user',
    quotaProfileId: 'closed_beta_admin_v1'
  });
  const login = await instance.auth.login({ username: 'memory_owner', password: 'PasswordA1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    root, memoryPath, protectedMemory, conversationRuntime, instance,
    ownerId: login.user.id, cookie: login.setCookie,
    baseUrl: `http://127.0.0.1:${instance.server.address().port}`,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function stream(h, body, cookie = h.cookie) {
  const response = await fetch(`${h.baseUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, events: parseSse(await response.text()) };
}

function replaceStructuredValue(memoryPath, ownerId, memoryId, structuredValue) {
  const database = new DatabaseSync(memoryPath);
  try {
    const row = database.prepare(`
      SELECT payload_json AS payload
      FROM memory_records_v2
      WHERE owner_user_id = ? AND memory_id = ?
    `).get(ownerId, memoryId);
    const payload = JSON.parse(row.payload);
    payload.structuredValue = structuredValue;
    payload.checksum = computeMemoryRecordV2Checksum(payload);
    database.prepare(`
      UPDATE memory_records_v2 SET payload_json = ?
      WHERE owner_user_id = ? AND memory_id = ?
    `).run(JSON.stringify(payload), ownerId, memoryId);
  } finally {
    database.close();
  }
}

test('real Auth HTTP/SSE uses canonical memory for online legacy records and final visible text', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  await stream(h, { message: '我妈妈7月16日生日', clientRequestId: 'seed-birthday' });
  let current = h.protectedMemory.inspectOwner(h.ownerId).currentMemories;
  const birthday = current.find((item) => item.predicate === 'birthday');
  replaceStructuredValue(h.memoryPath, h.ownerId, birthday.memoryId, { date: '2000-07-16' });

  const birthdayQuery = await stream(h, { message: '我妈什么时候生日？', clientRequestId: 'query-birthday' });
  assert.equal(visibleText(birthdayQuery), '你妈妈是7月16日生日。');
  assert.doesNotMatch(visibleText(birthdayQuery), /undefined|null/);
  const conversationId = birthdayQuery.events.find((event) => event.type === 'started').data.conversationId;

  const enriched = await stream(h, {
    conversationId, message: '她是农历7月16生日', clientRequestId: 'enrich-lunar'
  });
  assert.notEqual(visibleText(enriched), '请再明确一点。');
  current = h.protectedMemory.inspectOwner(h.ownerId).currentMemories;
  assert.equal(current.find((item) => item.predicate === 'birthday').structuredValue.calendarType, 'lunar');
  const lunarQuery = await stream(h, { message: '我妈什么时候生日？', clientRequestId: 'query-lunar' });
  assert.equal(visibleText(lunarQuery), '你妈妈是农历七月十六生日。');

  await stream(h, { message: '我女儿喜欢苹果', clientRequestId: 'seed-likes' });
  current = h.protectedMemory.inspectOwner(h.ownerId).currentMemories;
  const likes = current.find((item) => item.predicate === 'preference_statement');
  replaceStructuredValue(h.memoryPath, h.ownerId, likes.memoryId, {
    value: '水果是苹果、苹果和草莓', values: ['水果是苹果', '苹果和草莓']
  });
  await stream(h, { message: '她最喜欢吃我煮的沸腾鱼', clientRequestId: 'seed-favorite' });
  const countBeforeDuplicate = h.protectedMemory.inspectOwner(h.ownerId).allMemories.length;
  const duplicate = await stream(h, {
    message: '还有她最喜欢吃我煮的沸腾鱼。', clientRequestId: 'favorite-duplicate'
  });
  assert.notEqual(visibleText(duplicate), '请再明确一点。');
  assert.equal(h.protectedMemory.inspectOwner(h.ownerId).allMemories.length, countBeforeDuplicate);

  const likesQuery = await stream(h, { message: '她喜欢吃什么？', clientRequestId: 'query-likes' });
  assert.equal(visibleText(likesQuery), '你女儿喜欢苹果和草莓。');
  assert.doesNotMatch(visibleText(likesQuery), /苹果和苹果|undefined|null/);
  const likesConversationId = likesQuery.events.find((event) => event.type === 'started').data.conversationId;
  const exhausted = await stream(h, {
    conversationId: likesConversationId, message: '还有呢？', clientRequestId: 'likes-exhausted'
  });
  assert.equal(visibleText(exhausted), '我目前只记录到这些，没有更多已确认的信息。');

  await stream(h, { message: '我爸爸喜欢喝茶', clientRequestId: 'seed-father-entity' });
  const prepared = h.protectedMemory.inspectOwner(h.ownerId);
  const father = prepared.entities.find((entity) => entity.metadata?.familyRole === 'father');
  assert.ok(father);
  assert.equal(prepared.currentMemories.some((item) =>
    item.subjectEntityId === father.entityId && item.predicate === 'birthday'), false);

  const explicitUnknown = await stream(h, {
    message: '我爸爸什么时候生日？', clientRequestId: 'unknown-father-birthday'
  });
  assert.equal(visibleText(explicitUnknown), '我目前还不知道。');

  const countBeforeAmbiguous = h.protectedMemory.inspectOwner(h.ownerId).allMemories.length;
  const ambiguousEntity = await stream(h, {
    message: '一个不存在的家庭成员生日是什么时候？', clientRequestId: 'ambiguous-family'
  });
  assert.equal(visibleText(ambiguousEntity), '请补充一个最必要的明确信息。');
  assert.equal(h.protectedMemory.inspectOwner(h.ownerId).allMemories.length, countBeforeAmbiguous);

  const logout = await fetch(`${h.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: h.cookie } });
  assert.equal(logout.status, 200);
  const login = await fetch(`${h.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'memory_owner', password: 'PasswordA1!' })
  });
  const afterRelogin = await stream(h, {
    message: '我妈什么时候生日？', clientRequestId: 'query-after-relogin'
  }, login.headers.get('set-cookie'));
  assert.equal(visibleText(afterRelogin), '你妈妈是农历七月十六生日。');
});
