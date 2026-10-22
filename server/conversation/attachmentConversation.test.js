import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationRuntime } from './runtime.js';
import {
  createMockStreamingAiService,
  createMockStreamingProvider
} from './testing/mockStreamingProvider.js';

test('RED: Conversation binds attachment processing once and saves one grounded assistant answer', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'attachment-conversation-'));
  const provider = createMockStreamingProvider({ chunks: ['普通文本回复'] });
  const runtime = createConversationRuntime({
    databasePath: path.join(directory, 'conversation.sqlite'),
    aiService: createMockStreamingAiService(provider),
    applyMigrations: true
  });
  const calls = [];
  runtime.service.setAttachmentProcessor({
    async processAttachmentsForMessage(input) {
      const { onProgress, ...serializable } = input;
      assert.equal(typeof onProgress, 'function');
      calls.push(structuredClone(serializable));
      return {
        processingId: 'proc_test',
        answer: '附件一显示红色圆形，右侧是蓝色方形。'
      };
    }
  });
  try {
    const first = runtime.service.prepare({
      ownerId: 'user-a',
      message: '这张图片里有什么？',
      clientRequestId: 'attachment-client',
      attachmentIds: ['att_a'],
      invocation: {
        subject: { accountId: 'user-a', role: 'beta_user' },
        requestLease: { requestId: 'request-a' }
      }
    });
    const result = await runtime.service.execute(first);
    assert.equal(result.status, 'completed');
    assert.equal(result.processingId, 'proc_test');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authenticatedUserId, 'user-a');
    assert.equal(calls[0].messageId, first.userMessage.id);
    assert.deepEqual(calls[0].attachmentIds, ['att_a']);
    const messages = runtime.messages.listForConversationOwner(first.conversation.id, 'user-a');
    assert.equal(messages.length, 2);
    assert.equal(messages[1].content, '附件一显示红色圆形，右侧是蓝色方形。');

    const duplicate = runtime.service.prepare({
      ownerId: 'user-a',
      conversationId: first.conversation.id,
      message: '这张图片里有什么？',
      clientRequestId: 'attachment-client',
      attachmentIds: ['att_a']
    });
    const duplicateResult = await runtime.service.execute(duplicate);
    assert.equal(duplicateResult.deduplicated, true);
    assert.equal(calls.length, 1);
    assert.equal(
      runtime.messages.listForConversationOwner(first.conversation.id, 'user-a').length,
      2
    );
  } finally {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('RED: ordinary text chat keeps the existing string contract and does not call attachment processing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'plain-conversation-'));
  const provider = createMockStreamingProvider({ chunks: ['普通文本回复'] });
  const runtime = createConversationRuntime({
    databasePath: path.join(directory, 'conversation.sqlite'),
    aiService: createMockStreamingAiService(provider),
    applyMigrations: true
  });
  let attachmentCalls = 0;
  runtime.service.setAttachmentProcessor({
    async processAttachmentsForMessage() {
      attachmentCalls += 1;
      throw new Error('must not run');
    }
  });
  try {
    const prepared = runtime.service.prepare({
      ownerId: 'user-a',
      message: '你好',
      clientRequestId: 'plain-client'
    });
    const result = await runtime.service.execute(prepared);
    assert.equal(result.status, 'completed');
    assert.equal(result.content, '普通文本回复');
    assert.equal(provider.calls, 1);
    assert.equal(attachmentCalls, 0);
  } finally {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
