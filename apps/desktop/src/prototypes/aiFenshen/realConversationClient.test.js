import assert from 'node:assert/strict';
import test from 'node:test';

async function loadSubject() {
  try {
    return await import('./realConversationClient.js');
  } catch {
    return null;
  }
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function boundJsonResponse(accountContext, body, options = {}) {
  return jsonResponse({ ...body, accountContext }, {
    ...options,
    headers: {
      'x-ai-account-context': accountContext,
      ...(options.headers || {})
    }
  });
}

test('incremental SSE parser handles arbitrary network chunk boundaries and ordered events', async () => {
  const subject = await loadSubject();
  assert.equal(typeof subject?.createSseEventParser, 'function');
  const events = [];
  const parser = subject.createSseEventParser((event) => events.push(event));
  parser.push('event: started\ndata: {"requestId":"r1","conversationId":"c1"}\n\nevent: del');
  parser.push('ta\ndata: {"requestId":"r1","text":"你');
  parser.push('好"}\n\nevent: completed\ndata: {"requestId":"r1","status":"completed"}\n\n');
  parser.finish();
  assert.deepEqual(events, [
    { type: 'started', data: { requestId: 'r1', conversationId: 'c1' } },
    { type: 'delta', data: { requestId: 'r1', text: '你好' } },
    { type: 'completed', data: { requestId: 'r1', status: 'completed' } }
  ]);
});

test('real conversation client uses Cookie Session and never sends an owner identifier', async () => {
  const subject = await loadSubject();
  assert.equal(typeof subject?.createRealConversationClient, 'function');
  const calls = [];
  const client = subject.createRealConversationClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/ai/chat/stream') {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: started\ndata: {"requestId":"r1","conversationId":"c1","userMessageId":"u1","assistantMessageId":"a1"}\n\nevent: delta\ndata: {"requestId":"r1","text":"真实"}\n\nevent: completed\ndata: {"requestId":"r1","status":"completed"}\n\n'));
            controller.close();
          }
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return jsonResponse({ ok: true });
    },
    idFactory: () => 'client-1'
  });
  const events = [];
  await client.streamMessage({
    conversationId: null,
    message: '你好',
    timezone: 'Asia/Shanghai',
    onEvent: (event) => events.push(event)
  });
  assert.deepEqual(events.map((event) => event.type), ['started', 'delta', 'completed']);
  const request = calls.find((call) => call.url === '/api/ai/chat/stream');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, {
    conversationId: null,
    message: '你好',
    clientRequestId: 'client-1',
    retry: false,
    timezone: 'Asia/Shanghai'
  });
  assert.equal(request.options.credentials, 'include');
  assert.equal('ownerId' in body || 'userId' in body || 'accountId' in body, false);
});

test('client supports owner-safe restore, new conversation and real cancel requests', async () => {
  const subject = await loadSubject();
  const calls = [];
  const client = subject.createRealConversationClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/ai/conversations' && options.method === 'POST') return jsonResponse({ ok: true, conversation: { id: 'new-1' } }, { status: 201 });
      if (url === '/api/ai/conversations') return jsonResponse({ ok: true, conversations: [{ id: 'c1' }] });
      if (url === '/api/ai/conversations/c1/messages') return jsonResponse({ ok: true, messages: [{ id: 'm1', role: 'user', content: '恢复', status: 'completed' }] });
      if (url === '/api/ai/chat/requests/r1/cancel') return jsonResponse({ ok: true, status: 'cancelled' });
      return jsonResponse({ ok: false }, { status: 404 });
    }
  });
  assert.deepEqual(await client.listConversations(), [{ id: 'c1' }]);
  assert.deepEqual(await client.loadMessages('c1'), [{ id: 'm1', role: 'user', content: '恢复', status: 'completed' }]);
  assert.deepEqual(await client.createConversation(), { id: 'new-1' });
  assert.deepEqual(await client.cancelRequest('r1'), { ok: true, status: 'cancelled' });
  for (const call of calls) assert.equal(call.options.credentials, 'include');
});

test('session expiry and sanitized stream errors are distinguishable without exposing internals', async () => {
  const subject = await loadSubject();
  const client = subject.createRealConversationClient({
    fetchImpl: async () => jsonResponse({ ok: false, message: '请先登录。', stack: '/private/secret.js' }, { status: 401 })
  });
  await assert.rejects(client.listConversations(), (error) => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.equal(error.message, '请先登录。');
    assert.doesNotMatch(error.message, /private|stack|secret/i);
    return true;
  });
});

test('stream request includes attachment ids without exposing owner or Provider controls', async () => {
  const calls = [];
  const client = (await loadSubject()).createRealConversationClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: started\ndata: {"requestId":"r-att","conversationId":"c-att","userMessageId":"u-att","assistantMessageId":"a-att"}\n\n' +
            'event: completed\ndata: {"requestId":"r-att","status":"processed","answerMode":"combined"}\n\n'
          ));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    idFactory: () => 'client-att'
  });
  await client.streamMessage({
    conversationId: 'c-att',
    message: '这张图片里有什么？',
    attachmentIds: ['att_one', 'att_two'],
    onEvent() {}
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.attachmentIds, ['att_one', 'att_two']);
  assert.equal('provider' in body || 'model' in body || 'ownerId' in body || 'userId' in body, false);
});

test('account-bound client accepts JSON only when body and response header match the current account', async () => {
  const { createRealConversationClient } = await loadSubject();
  let requestOptions;
  const client = createRealConversationClient({
    expectedAccountId: 'account-a',
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return boundJsonResponse('account-a', {
      ok: true,
      conversations: [{ id: 'conversation-a' }]
      });
    }
  });

  assert.deepEqual(await client.listConversations(), [{ id: 'conversation-a' }]);
  assert.equal(requestOptions.headers['X-AI-Expected-Account-Context'], 'account-a');
});

test('account-bound client rejects missing or mismatched JSON context before returning content', async () => {
  const { createRealConversationClient } = await loadSubject();
  const responses = [
    jsonResponse({ ok: true, accountContext: 'account-b', conversations: [{ id: 'private-b' }] }, {
      headers: { 'x-ai-account-context': 'account-a' }
    }),
    jsonResponse({ ok: true, accountContext: 'account-a', conversations: [{ id: 'private-a' }] }, {
      headers: { 'x-ai-account-context': 'account-b' }
    }),
    jsonResponse({ ok: true, conversations: [{ id: 'unbound' }] })
  ];

  for (const response of responses) {
    const client = createRealConversationClient({
      expectedAccountId: () => 'account-a',
      fetchImpl: async () => response
    });
    await assert.rejects(client.listConversations(), (error) => {
      assert.equal(error.code, 'ACCOUNT_CONTEXT_MISMATCH');
      assert.equal(error.message, '账号状态已变化，请重新登录。');
      return true;
    });
  }
});

test('account-bound client rejects an SSE context mismatch before emitting any event', async () => {
  const { createRealConversationClient } = await loadSubject();
  let emitted = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'event: started\ndata: {"requestId":"request-b","conversationId":"private-b"}\n\n'
      ));
      controller.close();
    }
  });
  const client = createRealConversationClient({
    expectedAccountId: 'account-a',
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-ai-account-context': 'account-b'
      }
    })
  });

  await assert.rejects(client.streamMessage({
    message: '你好',
    onEvent() { emitted += 1; }
  }), (error) => {
    assert.equal(error.code, 'ACCOUNT_CONTEXT_MISMATCH');
    return true;
  });
  assert.equal(emitted, 0);
});

test('account-bound client rejects an authenticated error from a different account before consuming it', async () => {
  const { createRealConversationClient } = await loadSubject();
  const client = createRealConversationClient({
    expectedAccountId: 'account-a',
    fetchImpl: async () => boundJsonResponse('account-b', {
      ok: false,
      code: 'NOT_FOUND',
      message: '对话不存在。'
    }, { status: 404 })
  });

  await assert.rejects(client.loadMessages('conversation-a'), (error) => {
    assert.equal(error.code, 'ACCOUNT_CONTEXT_MISMATCH');
    return true;
  });
});
