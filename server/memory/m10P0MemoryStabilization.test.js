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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-p0-memory-'));
  const databasePath = path.join(root, 'memory.sqlite');
  const originalPath = path.join(root, 'original.sqlite');
  fs.writeFileSync(originalPath, 'protected-original');
  let tick = 0;
  const open = () => createProtectedMemoryRuntime({
    databasePath,
    repositoryRoot: process.cwd(),
    authorization: authorization(databasePath, originalPath),
    scope: 'local-m9-2-acceptance',
    actionId: ACTION_ID,
    now: () => new Date(Date.UTC(2026, 6, 19, 10, 0, tick++)).toISOString()
  });
  let runtime = open();
  return {
    root,
    databasePath,
    get runtime() { return runtime; },
    restart() {
      runtime.close();
      runtime = open();
      return runtime;
    },
    close() {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function processMessage(runtime, message, overrides = {}) {
  return runtime.processUserMessage({
    ownerId: 'owner-a',
    conversationId: 'conversation-a',
    message,
    clientRequestId: `request:${message}:${overrides.sequence || 0}`,
    captureEligible: true,
    ...overrides
  });
}

test('出生于 birthday is committed and recalled in the same conversation, a new conversation and after restart', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const captured = await processMessage(h.runtime, '我女儿出生于2012年6月8日');
  assert.equal(captured.kind, 'capture');
  assert.equal(captured.outcome, 'memory_written');
  let recalled = await processMessage(h.runtime, '我女儿是什么时候出生的？', { clientRequestId: 'same-conversation' });
  assert.equal(recalled.safeAnswer.safeUserMessage, '2012年6月8日。');
  recalled = await processMessage(h.runtime, '我女儿什么时候生日？', {
    conversationId: 'new-conversation', clientRequestId: 'new-conversation-query'
  });
  assert.equal(recalled.safeAnswer.safeUserMessage, '2012年6月8日。');
  h.restart();
  recalled = await processMessage(h.runtime, '我女儿什么时候生日？', {
    conversationId: 'after-restart', clientRequestId: 'after-restart-query'
  });
  assert.equal(recalled.safeAnswer.safeUserMessage, '2012年6月8日。');
});

test('normal likes are a multi-value set while 最喜欢 is an independent versioned predicate', async (t) => {
  const h = harness();
  t.after(() => h.close());
  assert.equal((await processMessage(h.runtime, '我女儿喜欢苹果。', { clientRequestId: 'like-apple' })).outcome, 'memory_written');
  assert.equal((await processMessage(h.runtime, '我女儿喜欢草莓。', { clientRequestId: 'like-strawberry' })).outcome, 'memory_corrected');
  assert.equal((await processMessage(h.runtime, '我女儿最喜欢吃草莓。', { clientRequestId: 'favorite-strawberry' })).outcome, 'memory_written');
  assert.equal((await processMessage(h.runtime, '我女儿现在最喜欢吃芒果。', { clientRequestId: 'favorite-mango' })).outcome, 'memory_corrected');

  const likes = await processMessage(h.runtime, '我女儿喜欢吃什么？', { clientRequestId: 'likes-query' });
  assert.equal(likes.safeAnswer.safeUserMessage, '苹果、草莓。');
  const favorite = await processMessage(h.runtime, '我女儿最喜欢吃什么？', { clientRequestId: 'favorite-query' });
  assert.equal(favorite.safeAnswer.safeUserMessage, '芒果。');

  const current = h.runtime.inspectOwner('owner-a').currentMemories;
  assert.equal(current.filter((item) => item.predicate === 'preference_statement').length, 1);
  assert.equal(current.filter((item) => item.predicate === 'favorite_preference_statement').length, 1);
  assert.deepEqual(current.find((item) => item.predicate === 'preference_statement').structuredValue.values, ['苹果', '草莓']);
});

test('grounded preference follow-ups never invent values and ten exhausted 还有呢 replies stay sealed', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我女儿喜欢苹果。', { clientRequestId: 'known-apple' });
  await processMessage(h.runtime, '我女儿喜欢草莓。', { clientRequestId: 'known-strawberry' });
  const first = await processMessage(h.runtime, '我女儿喜欢吃什么？', { clientRequestId: 'known-query' });
  assert.equal(first.safeAnswer.safeUserMessage, '苹果、草莓。');
  const second = await processMessage(h.runtime, '还喜欢吃什么？', { clientRequestId: 'follow-up-query' });
  assert.equal(second.safeAnswer.safeUserMessage, '我目前只记录到这些，没有更多已确认的信息。');
  for (let index = 0; index < 10; index += 1) {
    const more = await processMessage(h.runtime, '还有呢', {
      clientRequestId: `more-${index}`,
      sequence: index
    });
    assert.equal(more.kind, 'query');
    assert.equal(more.safeAnswer.safeUserMessage, '我目前只记录到这些，没有更多已确认的信息。');
    assert.doesNotMatch(JSON.stringify(more), /蓝莓|橙子|西瓜/);
  }
  assert.equal(h.runtime.inspectOwner('owner-a').currentMemories.length, 1);
});

test('unknown family preference stays sealed and other owner facts never cross scope', async (t) => {
  const h = harness();
  t.after(() => h.close());
  await processMessage(h.runtime, '我女儿喜欢苹果。', { clientRequestId: 'owner-a-like' });
  const unknown = await processMessage(h.runtime, '我爸爸喜欢吃什么？', { clientRequestId: 'unknown-family' });
  assert.equal(unknown.safeAnswer.safeUserMessage, '我目前还不知道。');
  const other = await processMessage(h.runtime, '我女儿喜欢吃什么？', {
    ownerId: 'owner-b', conversationId: 'owner-b-conversation', clientRequestId: 'owner-b-query'
  });
  assert.equal(other.safeAnswer.safeUserMessage, '我目前还不知道。');
});
