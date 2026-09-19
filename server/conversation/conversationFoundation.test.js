import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyConversationMigrations } from './migrations.js';
import { ConversationRepository, MessageRepository } from './repositories.js';

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-conversation-foundation-'));
  const databasePath = path.join(directory, 'conversation.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  applyConversationMigrations(database);
  const now = () => '2026-07-18T10:00:00.000Z';
  return {
    directory,
    database,
    conversations: new ConversationRepository({ database, now }),
    messages: new MessageRepository({ database, now }),
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('pure-additive migration creates conversation tables and indexes and is idempotent', () => {
  const h = harness();
  try {
    applyConversationMigrations(h.database);
    const tables = h.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
    const indexes = h.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(tables, ['conversation_schema_migrations', 'conversations', 'messages']);
    assert.deepEqual(indexes, [
      'idx_conversations_owner_updated',
      'idx_messages_conversation_created',
      'uq_messages_user_client_request'
    ]);
    assert.equal(h.database.prepare('SELECT COUNT(*) AS count FROM conversation_schema_migrations').get().count, 1);
  } finally {
    h.close();
  }
});

test('migration does not alter an unrelated pre-existing table', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-conversation-existing-'));
  const database = new DatabaseSync(path.join(directory, 'conversation.sqlite'));
  try {
    database.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO unrelated VALUES (\'keep\', \'unchanged\');');
    const before = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'unrelated'").get().sql;
    applyConversationMigrations(database);
    assert.equal(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'unrelated'").get().sql, before);
    assert.deepEqual(database.prepare('SELECT * FROM unrelated').all().map((row) => ({ ...row })), [{ id: 'keep', value: 'unchanged' }]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('conversation repository enforces owner scope for create, read, list, touch and archive', () => {
  const h = harness();
  try {
    const created = h.conversations.createForOwner('owner-a', { title: '第一段对话' });
    assert.equal(created.ownerId, 'owner-a');
    assert.equal(h.conversations.getByIdForOwner(created.id, 'owner-a').title, '第一段对话');
    assert.equal(h.conversations.getByIdForOwner(created.id, 'owner-b'), null);
    assert.deepEqual(h.conversations.listForOwner('owner-b'), []);
    assert.equal(h.conversations.touchForOwner(created.id, 'owner-b'), false);
    assert.equal(h.conversations.archiveForOwner(created.id, 'owner-b'), false);
    assert.equal(h.conversations.archiveForOwner(created.id, 'owner-a'), true);
    assert.equal(h.conversations.getByIdForOwner(created.id, 'owner-a').status, 'archived');
  } finally {
    h.close();
  }
});

test('message repository persists states, hides cross-owner records and deduplicates clientRequestId', () => {
  const h = harness();
  try {
    const conversation = h.conversations.createForOwner('owner-a');
    const user = h.messages.createUserMessage({
      ownerId: 'owner-a', conversationId: conversation.id, content: '你好', clientRequestId: 'client-1'
    });
    const duplicate = h.messages.createUserMessage({
      ownerId: 'owner-a', conversationId: conversation.id, content: '不能覆盖', clientRequestId: 'client-1'
    });
    assert.equal(duplicate.id, user.id);
    assert.equal(duplicate.content, '你好');
    assert.throws(() => h.messages.createUserMessage({
      ownerId: 'owner-b', conversationId: conversation.id, content: '越权', clientRequestId: 'client-x'
    }), /CONVERSATION_NOT_FOUND/);

    const assistant = h.messages.createAssistantPlaceholder({
      ownerId: 'owner-a', conversationId: conversation.id, clientRequestId: 'client-1'
    });
    assert.equal(assistant.status, 'streaming');
    assert.equal(h.messages.appendAssistantDelta({ ownerId: 'owner-b', messageId: assistant.id, delta: '越权' }), false);
    assert.equal(h.messages.appendAssistantDelta({ ownerId: 'owner-a', messageId: assistant.id, delta: '你好，' }), true);
    assert.equal(h.messages.completeAssistantMessage({ ownerId: 'owner-a', messageId: assistant.id, content: '你好，我是AI分身。' }), true);
    assert.deepEqual(h.messages.listForConversationOwner(conversation.id, 'owner-b'), []);
    const messages = h.messages.listForConversationOwner(conversation.id, 'owner-a');
    assert.deepEqual(messages.map(({ role, content, status }) => ({ role, content, status })), [
      { role: 'user', content: '你好', status: 'completed' },
      { role: 'assistant', content: '你好，我是AI分身。', status: 'completed' }
    ]);
    assert.equal(h.messages.findByClientRequestId(conversation.id, 'owner-a', 'client-1').user.id, user.id);
  } finally {
    h.close();
  }
});

test('assistant stopped and error states preserve partial content', () => {
  const h = harness();
  try {
    const conversation = h.conversations.createForOwner('owner-a');
    const stopped = h.messages.createAssistantPlaceholder({ ownerId: 'owner-a', conversationId: conversation.id, clientRequestId: 'stop-1' });
    const failed = h.messages.createAssistantPlaceholder({ ownerId: 'owner-a', conversationId: conversation.id, clientRequestId: 'error-1' });
    assert.equal(h.messages.stopAssistantMessage({ ownerId: 'owner-a', messageId: stopped.id, content: '部分' }), true);
    assert.equal(h.messages.failAssistantMessage({ ownerId: 'owner-a', messageId: failed.id, content: '已生成', errorCode: 'PROVIDER_ERROR' }), true);
    const rows = h.messages.listForConversationOwner(conversation.id, 'owner-a');
    assert.deepEqual(rows.map(({ content, status, errorCode }) => ({ content, status, errorCode })), [
      { content: '部分', status: 'stopped', errorCode: null },
      { content: '已生成', status: 'error', errorCode: 'PROVIDER_ERROR' }
    ]);
  } finally {
    h.close();
  }
});
