import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderManager } from './providerManager.js';
import qwen from './qwen.js';

function streamResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

test('Qwen exposes native voice streaming and parses split OpenAI-compatible SSE', async () => {
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
    assert.equal(qwen.supportsStreaming, false);
    assert.equal(qwen.supportsVoiceStreaming, true);
    assert.equal(qwen.supportsSingleShotSseBridge, true);
    assert.equal(typeof qwen.streamChat, 'undefined');
    const result = await qwen.streamVoiceChat({ input: '你好', options: { apiKey: 'secret-key', timeoutMs: 1000 } }, {
      onDelta: (text) => deltas.push(text)
    });
    assert.equal(sentBody.stream, true);
    assert.equal(sentBody.model, 'qwen-plus');
    assert.deepEqual(deltas, ['你好，', '我是你的', 'AI分身。']);
    assert.equal(result.content, '你好，我是你的AI分身。');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qwen native voice streaming propagates caller AbortSignal', async () => {
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
    const pending = qwen.streamVoiceChat({ input: '停止', options: { apiKey: 'secret-key', timeoutMs: 5000 } }, { signal: caller.signal });
    caller.abort('user_cancelled');
    await assert.rejects(pending, (error) => ['ABORTED', 'TIMEOUT'].includes(error.code));
    assert.equal(upstreamSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qwen keeps ordinary text streaming on the single-shot bridge while voice uses native SSE', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requestBodies.push(body);
      if (body.stream) return streamResponse(['data: {"choices":[{"delta":{"content":"语音原生"}}]}\n\ndata: [DONE]\n\n']);
      return new Response(JSON.stringify({ choices: [{ message: { content: '普通桥接' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const manager = new ProviderManager({
      config: {
        providerConfigs: {
          qwen: {
            apiKey: 'secret-key',
            baseUrl: 'https://qwen.test/v1',
            defaultModel: 'qwen-max'
          }
        }
      }
    });
    const ordinaryDeltas = [];
    const ordinary = await manager.streamChat({ provider: 'qwen', input: '普通建议' }, {
      onDelta: (text) => ordinaryDeltas.push(text)
    });
    const voiceDeltas = [];
    const voice = await manager.streamChat({
      provider: 'qwen',
      input: '问候',
      metadata: { voiceRealtimeOnly: true }
    }, {
      onDelta: (text) => voiceDeltas.push(text)
    });

    assert.equal(manager.getCapabilities('qwen').supportsStreaming, false);
    assert.equal(manager.getCapabilities('qwen').supportsVoiceStreaming, true);
    assert.equal(ordinary.content, '普通桥接');
    assert.deepEqual(ordinaryDeltas, ['普通桥接']);
    assert.equal(voice.content, '语音原生');
    assert.deepEqual(voiceDeltas, ['语音原生']);
    assert.deepEqual(requestBodies.map(({ stream }) => stream), [false, true]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
