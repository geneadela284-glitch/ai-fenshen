export function createMockStreamingProvider({
  chunks = ['你好，', '我是你的', 'AI分身。'],
  delayMs = 0,
  failAt = -1,
  errorCode = 'PROVIDER_ERROR'
} = {}) {
  const provider = {
    id: 'mock-streaming', name: 'Mock Streaming', type: 'test', status: 'ready', supportsStreaming: true,
    calls: 0, aborts: 0, deltasAfterAbort: 0, failAt,
    async generate() { return { content: chunks.join('') }; },
    async chat() { return { content: chunks.join('') }; },
    async image() { return { content: '' }; },
    async embedding() { return { content: '' }; },
    async streamChat(_request, { signal, onDelta = () => {} } = {}) {
      provider.calls += 1;
      let content = '';
      for (let index = 0; index < chunks.length; index += 1) {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (signal?.aborted) {
          provider.aborts += 1;
          const error = new Error('aborted');
          error.code = 'ABORTED';
          throw error;
        }
        if (index === provider.failAt) {
          const error = new Error('internal provider detail must stay private');
          error.code = errorCode;
          throw error;
        }
        content += chunks[index];
        await onDelta(chunks[index]);
      }
      if (signal?.aborted) provider.deltasAfterAbort += 1;
      return { content, usage: null };
    }
  };
  return provider;
}

export function createMockStreamingAiService(provider) {
  return {
    async stream(task, options) {
      try {
        const result = await provider.streamChat(task, options);
        return { ok: true, content: result.content, usage: null };
      } catch (error) {
        return { ok: false, content: '', code: error.code || 'PROVIDER_ERROR', message: 'AI 服务暂时不可用，请稍后重试。' };
      }
    }
  };
}
