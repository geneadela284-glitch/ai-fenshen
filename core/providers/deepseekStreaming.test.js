import assert from 'node:assert/strict';
import test from 'node:test';
import deepseek from './deepseek.js';

function streamResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

test('DeepSeek streaming sends stream:true and parses SSE split across chunk boundaries', async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  let sentBody;
  try {
    globalThis.fetch = async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"你好，"}}]}\n\nda',
        'ta: {"choices":[{"delta":{"content":"我是你的"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"AI分身。"}}]}\n\ndata: [DO',
        'NE]\n\n'
      ]);
    };
    const result = await deepseek.streamChat({ input: '你好', options: { apiKey: 'secret-key', timeoutMs: 1000 } }, {
      onDelta: (text) => deltas.push(text)
    });
    assert.equal(sentBody.stream, true);
    assert.equal(sentBody.model, 'deepseek-v4-flash');
    assert.deepEqual(sentBody.thinking, { type: 'disabled' });
    assert.deepEqual(deltas, ['你好，', '我是你的', 'AI分身。']);
    assert.equal(result.content, '你好，我是你的AI分身。');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DeepSeek streaming propagates caller AbortSignal to upstream fetch', async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let upstreamSignal;
  try {
    globalThis.fetch = async (_url, options) => {
      upstreamSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    };
    const pending = deepseek.streamChat({ input: '停止', options: { apiKey: 'secret-key', timeoutMs: 5000 } }, { signal: caller.signal });
    caller.abort('user_cancelled');
    await assert.rejects(pending, (error) => ['ABORTED', 'TIMEOUT'].includes(error.code));
    assert.equal(upstreamSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DeepSeek streaming error does not expose API key', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => streamResponse(['{"error":"secret-key"}'], { status: 500 });
    await assert.rejects(
      deepseek.streamChat({ input: '失败', options: { apiKey: 'secret-key' } }, {}),
      (error) => !JSON.stringify({ message: error.message, code: error.code }).includes('secret-key')
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
