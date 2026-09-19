import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProtectedMemoryRuntime } from './protectedMemoryRuntime.js';

const ACTION_ID = 'M9_2_REAL_CONVERSATION_MEMORY_OS_WIRING';

function authorization(databasePath, originalPath) {
  return {
    scope: 'local-m9-2-acceptance',
    environment: 'local-m9-2-acceptance',
    database_kind: 'isolated_acceptance_memory',
    database_path: databasePath,
    owner_source: 'authenticated_session',
    allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
    original_memory_database: { path: originalPath, access: 'read_only' },
    cross_owner_access: 'denied',
    migration_allowed: false,
    bulk_import_allowed: false,
    active_action_ids: [ACTION_ID]
  };
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-2-acceptance-runtime-'));
  const originalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-2-original-memory-'));
  const databasePath = path.join(root, 'memory.sqlite');
  const originalPath = path.join(originalRoot, 'memory.sqlite');
  fs.writeFileSync(originalPath, 'original-read-only-sentinel');
  const originalBefore = fs.readFileSync(originalPath);
  let clockTick = 0;
  const runtime = createProtectedMemoryRuntime({
    databasePath,
    repositoryRoot: process.cwd(),
    authorization: authorization(databasePath, originalPath),
    scope: 'local-m9-2-acceptance',
    actionId: ACTION_ID,
    now: () => new Date(Date.UTC(2026, 6, 19, 8, 0, clockTick++)).toISOString()
  });
  return {
    runtime,
    databasePath,
    originalPath,
    originalBefore,
    close() {
      runtime.close();
      assert.deepEqual(fs.readFileSync(originalPath), originalBefore);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(originalRoot, { recursive: true, force: true });
    }
  };
}

function processMessage(runtime, message, overrides = {}) {
  return runtime.processUserMessage({
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    message,
    clientRequestId: `client:${message}`,
    captureEligible: true,
    ...overrides
  });
}

test('explicit durable birthday fact is silently stored through Memory Decision and Safe Write', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await processMessage(h.runtime, '我妈妈5月6号生日。');
  assert.equal(result.kind, 'capture');
  assert.equal(result.outcome, 'memory_written');
  assert.equal(result.acknowledgement, 'none');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 1);
});

test('ordinary knowledge question is not persisted as Memory', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await processMessage(h.runtime, '太阳为什么会发光？');
  assert.equal(result.kind, 'none');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 0);
});

test('birthday is recalled in a new conversation through Query V2, Ranking and Grounding', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我妈妈5月6号生日。');
  const recalled = await processMessage(h.runtime, '我妈什么时候生日？', {
    conversationId: 'conversation-new',
    clientRequestId: 'query-new',
    captureEligible: true
  });
  assert.equal(recalled.kind, 'query');
  assert.equal(recalled.safeAnswer.type, 'fact');
  assert.equal(recalled.safeAnswer.safeUserMessage, '5月6号。');
  assert.equal(recalled.trustedContext.source, 'memory_query_v2_grounding');
  assert.deepEqual(recalled.trustedContext.fact, {
    type: 'birthday',
    displayDate: '5月6日',
    yearKnown: false,
    month: 5,
    day: 6
  });
  assert.doesNotMatch(JSON.stringify(recalled.trustedContext), /2000/);
});

test('missing relationship memory produces a sealed unknown answer instead of guessing', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await processMessage(h.runtime, '我爸爸什么时候生日？');
  assert.equal(result.kind, 'query');
  assert.equal(result.safeAnswer.type, 'not_found');
  assert.equal(result.safeAnswer.safeUserMessage, '我目前还不知道。');
});

test('explicit correction supersedes the old birthday and current recall returns only the new date', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我妈妈5月6号生日。');
  const corrected = await processMessage(h.runtime, '我刚才记错了，我妈妈是5月8号生日。', {
    clientRequestId: 'birthday-correction'
  });
  assert.equal(corrected.kind, 'capture');
  assert.equal(corrected.outcome, 'memory_corrected');
  const recalled = await processMessage(h.runtime, '我妈什么时候生日？', {
    conversationId: 'conversation-after-correction',
    clientRequestId: 'query-corrected'
  });
  assert.equal(recalled.safeAnswer.safeUserMessage, '5月8号。');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 1);
});

test('semantic duplicate and client retry do not create another active Memory', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我妈妈是5月8号生日。', { clientRequestId: 'first' });
  const duplicate = await processMessage(h.runtime, '我妈妈生日是5月8号。', { clientRequestId: 'second' });
  assert.equal(duplicate.outcome, 'duplicate_detected');
  await processMessage(h.runtime, '我妈妈是5月8号生日。', { clientRequestId: 'first' });
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 1);
});

test('ambiguous pronoun is never silently bound to a family entity', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await processMessage(h.runtime, '她下个月可能会去北京。');
  assert.equal(result.kind, 'none');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 0);
});

test('owner isolation prevents cross-owner reads and lifecycle writes', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我妈妈5月6号生日。');
  const record = h.runtime.inspectOwner('owner-a').currentMemories[0];
  const other = await processMessage(h.runtime, '我妈什么时候生日？', {
    ownerId: 'owner-b',
    conversationId: 'conversation-b',
    clientRequestId: 'query-owner-b'
  });
  assert.equal(other.safeAnswer.type, 'not_found');
  await assert.rejects(() => h.runtime.lifecycle({
    ownerId: 'owner-b', action: 'delete', memoryId: record.memoryId,
    subjectEntityId: record.subjectEntityId, predicate: record.predicate,
    expectedVersion: record.version, clientRequestId: 'cross-owner-delete'
  }), /not found|owner|scope/i);
});

test('delete, restore and purge lifecycle controls recall without affecting the original database', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我妈妈5月6号生日。');
  let record = h.runtime.inspectOwner('owner-a').currentMemories[0];
  await h.runtime.lifecycle({
    ownerId: 'owner-a', action: 'delete', memoryId: record.memoryId,
    subjectEntityId: record.subjectEntityId, predicate: record.predicate,
    expectedVersion: record.version, clientRequestId: 'delete-1'
  });
  assert.equal((await processMessage(h.runtime, '我妈什么时候生日？', { clientRequestId: 'after-delete' })).safeAnswer.type, 'not_found');
  record = h.runtime.inspectOwner('owner-a').allMemories.find((item) => item.memoryId === record.memoryId);
  await h.runtime.lifecycle({
    ownerId: 'owner-a', action: 'restore', memoryId: record.memoryId,
    subjectEntityId: record.subjectEntityId, predicate: record.predicate,
    expectedVersion: record.version, clientRequestId: 'restore-1'
  });
  assert.equal((await processMessage(h.runtime, '我妈什么时候生日？', { clientRequestId: 'after-restore' })).safeAnswer.safeUserMessage, '5月6号。');
  record = h.runtime.inspectOwner('owner-a').currentMemories[0];
  const prompt = await h.runtime.lifecycle({
    ownerId: 'owner-a', action: 'purge', memoryId: record.memoryId,
    subjectEntityId: record.subjectEntityId, predicate: record.predicate,
    expectedVersion: record.version, clientRequestId: 'purge-1', confirmed: false
  });
  assert.equal(prompt.confirmationRequired, true);
  await h.runtime.lifecycle({
    ownerId: 'owner-a', action: 'purge', memoryId: record.memoryId,
    subjectEntityId: record.subjectEntityId, predicate: record.predicate,
    expectedVersion: record.version, clientRequestId: 'purge-1', confirmed: true
  });
  assert.equal((await processMessage(h.runtime, '我妈什么时候生日？', { clientRequestId: 'after-purge' })).safeAnswer.type, 'not_found');
});

test('captureEligible false prevents refresh, retry, stopped or error paths from capturing again', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我妈妈5月6号生日。', { captureEligible: false });
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 0);
});

test('stable family food preference is stored through Memory Decision and Safe Write', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await processMessage(h.runtime, '我女儿最喜欢吃草莓。');
  assert.equal(result.kind, 'capture');
  assert.equal(result.outcome, 'memory_written');
  assert.equal(result.acknowledgement, 'none');
  const [memory] = h.runtime.inspectOwner('owner-a').currentMemories;
  assert.equal(memory.memoryType, 'preference');
  assert.equal(memory.predicate, 'favorite_preference_statement');
  assert.deepEqual(memory.structuredValue, { value: '草莓' });
});

test('new conversations recall normal and superlative preferences as separate facts', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我女儿喜欢吃苹果。', { clientRequestId: 'normal-preference' });
  await processMessage(h.runtime, '我女儿最喜欢吃草莓。');
  for (const [index, [question, answer]] of [
    ['我女儿喜欢吃什么？', '苹果。'],
    ['我女儿最喜欢吃什么？', '草莓。']
  ].entries()) {
    const recalled = await processMessage(h.runtime, question, {
      conversationId: `preference-query-${index}`,
      clientRequestId: `preference-query-${index}`
    });
    assert.equal(recalled.kind, 'query');
    assert.equal(recalled.safeAnswer.type, 'fact');
    assert.equal(recalled.safeAnswer.safeUserMessage, answer);
    assert.equal(recalled.trustedContext.grounded, true);
  }
});

test('family and preference paraphrases normalize to one active fact', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我女儿最喜欢吃草莓。', { clientRequestId: 'preference-first' });
  const duplicate = await processMessage(h.runtime, '我家孩子最爱吃草莓。', { clientRequestId: 'preference-paraphrase' });
  assert.equal(duplicate.outcome, 'duplicate_detected');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.filter((item) => item.predicate === 'favorite_preference_statement').length, 1);
  const recalled = await processMessage(h.runtime, '我家孩子最爱吃什么？', {
    conversationId: 'preference-child-alias-query', clientRequestId: 'preference-child-alias-query'
  });
  assert.equal(recalled.safeAnswer.safeUserMessage, '草莓。');
});

test('context-bound preference correction supersedes the old value', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我女儿最喜欢吃草莓。', { clientRequestId: 'preference-original' });
  await processMessage(h.runtime, '我女儿最喜欢吃什么？', { clientRequestId: 'preference-context-query' });
  const corrected = await processMessage(h.runtime, '她现在最喜欢吃芒果，不是草莓。', {
    clientRequestId: 'preference-correction'
  });
  assert.equal(corrected.outcome, 'memory_corrected');
  const recalled = await processMessage(h.runtime, '我女儿最喜欢吃什么？', {
    conversationId: 'preference-after-correction', clientRequestId: 'preference-after-correction'
  });
  assert.equal(recalled.safeAnswer.safeUserMessage, '芒果。');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.filter((item) => item.predicate === 'favorite_preference_statement').length, 1);
});

test('missing family preference produces a sealed unknown answer', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await processMessage(h.runtime, '我爸爸喜欢吃什么？');
  assert.equal(result.kind, 'query');
  assert.equal(result.safeAnswer.type, 'not_found');
  assert.equal(result.safeAnswer.safeUserMessage, '我目前还不知道。');
});

test('preference recall keeps daughter and mother entities separate', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我女儿喜欢草莓。', { clientRequestId: 'daughter-preference' });
  await processMessage(h.runtime, '我妈妈喜欢苹果。', { clientRequestId: 'mother-preference' });
  const daughter = await processMessage(h.runtime, '我女儿喜欢吃什么？', { clientRequestId: 'daughter-query' });
  const mother = await processMessage(h.runtime, '我妈妈喜欢吃什么？', { clientRequestId: 'mother-query' });
  assert.equal(daughter.safeAnswer.safeUserMessage, '草莓。');
  assert.equal(mother.safeAnswer.safeUserMessage, '苹果。');
});

test('preference records remain owner scoped', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我女儿喜欢草莓。', { clientRequestId: 'owner-a-preference' });
  const other = await processMessage(h.runtime, '我女儿喜欢吃什么？', {
    ownerId: 'owner-b', conversationId: 'owner-b-conversation', clientRequestId: 'owner-b-query'
  });
  assert.equal(other.safeAnswer.type, 'not_found');
  assert.equal(other.safeAnswer.safeUserMessage, '我目前还不知道。');
});

test('stopped or error preference messages cannot enter Memory', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const result = await processMessage(h.runtime, '我女儿最喜欢吃草莓。', { captureEligible: false });
  assert.equal(result.outcome, 'capture_skipped');
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 0);
});
