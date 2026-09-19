import assert from 'node:assert/strict';
import test from 'node:test';

async function subject() {
  try {
    return await import('./realConversationState.js');
  } catch {
    return null;
  }
}

test('server history restores without fake messages and keeps persisted terminal states', async () => {
  const state = await subject();
  assert.equal(typeof state?.restoreConversationMessages, 'function');
  assert.deepEqual(state.restoreConversationMessages([
    { id: 'u1', role: 'user', content: '真实问题', status: 'completed', clientRequestId: 'client-1' },
    { id: 'a1', role: 'assistant', content: '真实回答', status: 'stopped', clientRequestId: 'client-1' }
  ]), [
    { id: 'u1', role: 'user', content: '真实问题', status: 'complete', clientRequestId: 'client-1' },
    { id: 'a1', role: 'assistant', content: '真实回答', status: 'stopped', clientRequestId: 'client-1' }
  ]);
});

test('optimistic exchange consumes started, deltas and completion without duplicate messages', async () => {
  const state = await subject();
  let messages = state.createOptimisticExchange([], { content: '你好', clientRequestId: 'client-1' });
  assert.deepEqual(messages.map(({ role, status }) => ({ role, status })), [
    { role: 'user', status: 'complete' },
    { role: 'assistant', status: 'streaming' }
  ]);
  messages = state.applyRealConversationEvent(messages, {
    type: 'started', data: { requestId: 'r1', conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' }
  }, 'client-1');
  messages = state.applyRealConversationEvent(messages, { type: 'delta', data: { requestId: 'r1', text: '你' } }, 'client-1');
  messages = state.applyRealConversationEvent(messages, { type: 'delta', data: { requestId: 'r1', text: '好' } }, 'client-1');
  messages = state.applyRealConversationEvent(messages, { type: 'completed', data: { requestId: 'r1', status: 'completed' } }, 'client-1');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 'u1');
  assert.deepEqual(messages[1], {
    id: 'a1', role: 'assistant', content: '你好', status: 'complete', clientRequestId: 'client-1', requestId: 'r1'
  });
});

test('stopped and error events preserve partial assistant content for retry', async () => {
  const state = await subject();
  const base = state.applyRealConversationEvent(
    state.createOptimisticExchange([], { content: '测试', clientRequestId: 'client-2' }),
    { type: 'delta', data: { requestId: 'r2', text: '部分' } },
    'client-2'
  );
  assert.equal(state.applyRealConversationEvent(base, { type: 'stopped', data: { requestId: 'r2' } }, 'client-2').at(-1).status, 'stopped');
  const failed = state.applyRealConversationEvent(base, { type: 'error', data: { requestId: 'r2', code: 'RATE_LIMITED' } }, 'client-2');
  assert.equal(failed.at(-1).content, '部分');
  assert.equal(failed.at(-1).status, 'error');
  assert.equal(state.findRetryExchange(failed, failed.at(-1).id).clientRequestId, 'client-2');
  assert.equal(state.findRetryExchange(failed, failed.at(-1).id).content, '测试');
});

test('composer-level retry resolves the latest failed exchange without a click-event id', async () => {
  const state = await subject();
  const messages = [
    { id: 'u1', role: 'user', content: 'first', status: 'complete', clientRequestId: 'r1' },
    { id: 'a1', role: 'assistant', content: 'partial', status: 'error', clientRequestId: 'r1' },
    { id: 'u2', role: 'user', content: 'second', status: 'complete', clientRequestId: 'r2' },
    { id: 'a2', role: 'assistant', content: 'later', status: 'stopped', clientRequestId: 'r2' }
  ];
  assert.deepEqual(state.findRetryExchange(messages), {
    content: 'second', clientRequestId: 'r2', assistantId: 'a2', attachmentIds: []
  });
});

test('restored and optimistic user messages retain safe attachment metadata and processing states', async () => {
  const state = await subject();
  const attachments = [{
    attachmentId: 'att_a',
    originalFilename: 'screen.png',
    mimeType: 'image/png',
    byteSize: 128,
    processingState: 'processed'
  }];
  const restored = state.restoreConversationMessages([{
    id: 'u1',
    role: 'user',
    content: '这张截图主要说了什么？',
    status: 'completed',
    clientRequestId: 'client-a',
    attachments
  }]);
  assert.deepEqual(restored[0].attachments, attachments);

  const optimistic = state.createOptimisticExchange([], {
    content: '比较图片',
    clientRequestId: 'client-b',
    attachments
  });
  assert.deepEqual(optimistic[0].attachments, attachments);
  assert.deepEqual(state.findRetryExchange([
    optimistic[0],
    { ...optimistic[1], id: 'a2', status: 'error' }
  ], 'a2'), {
    content: '比较图片',
    clientRequestId: 'client-b',
    assistantId: 'a2',
    attachmentIds: ['att_a']
  });
});

test('completed attachment event exposes only safe evidence state and marks user thumbnails terminal', async () => {
  const state = await subject();
  const base = state.createOptimisticExchange([], {
    content: '看看图片',
    clientRequestId: 'client-c',
    attachments: [{
      attachmentId: 'att_c',
      originalFilename: 'photo.jpg',
      processingState: 'processing_vision'
    }]
  });
  const completed = state.applyRealConversationEvent(base, {
    type: 'completed',
    data: {
      requestId: 'request-c',
      status: 'processed_partial',
      answerMode: 'partial',
      limitations: ['OCR_PROVIDER_UNAVAILABLE'],
      evidenceRefs: [{ type: 'vision', attachmentIds: ['att_c'] }]
    }
  }, 'client-c');
  assert.equal(completed[0].attachments[0].processingState, 'processed_partial');
  assert.deepEqual(completed[1].attachmentResult, {
    status: 'processed_partial',
    answerMode: 'partial',
    limitations: ['OCR_PROVIDER_UNAVAILABLE'],
    evidenceRefs: [{ type: 'vision', attachmentIds: ['att_c'] }]
  });
  assert.equal(JSON.stringify(completed).includes('provider'), false);
  assert.equal(JSON.stringify(completed).includes('model'), false);
});
