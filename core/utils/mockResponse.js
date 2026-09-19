function normalizeInput(input) {
  if (Array.isArray(input)) {
    return input.map((item) => item.content || item.text || JSON.stringify(item)).join('\n');
  }
  return input || '';
}

export function createMockText({ provider, mode, prompt = '', input = '', options = {} }) {
  const normalized = normalizeInput(input);
  const content = [
    `[Mock ${provider.name}]`,
    `mode: ${mode}`,
    prompt ? `prompt: ${prompt}` : null,
    normalized ? `input: ${normalized}` : null,
    `result: 这里是 ${provider.name} 的模拟返回。真实 API 接入后会替换为模型结果。`
  ]
    .filter(Boolean)
    .join('\n');

  return {
    provider: provider.id,
    mode,
    content,
    usage: {
      inputTokens: String(prompt + normalized).length,
      outputTokens: content.length
    },
    options,
    mocked: true,
    createdAt: new Date().toISOString()
  };
}

export function createMockImage({ provider, prompt = '', options = {} }) {
  return {
    provider: provider.id,
    mode: 'image',
    prompt,
    url: null,
    description: `这里是 ${provider.name} 的模拟图片结果。`,
    options,
    mocked: true,
    createdAt: new Date().toISOString()
  };
}

export function createMockEmbedding({ provider, input = '', options = {} }) {
  const text = normalizeInput(input);
  const seed = Array.from(text).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const vector = Array.from({ length: 8 }, (_, index) => Number(((seed + index * 17) % 100 / 100).toFixed(2)));

  return {
    provider: provider.id,
    mode: 'embedding',
    input: text,
    vector,
    dimensions: vector.length,
    options,
    mocked: true,
    createdAt: new Date().toISOString()
  };
}
