const SAFE_ERROR = 'AI 服务暂时不可用，请稍后重试。';

async function requestAi(request = {}) {
  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: request.input,
      messages: request.messages,
      capability: request.capability,
      metadata: request.metadata,
      options: request.options
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    return { content: '', latency: payload.latency || 0, usage: null, error: SAFE_ERROR };
  }
  return payload;
}

export const serverAIClient = {
  generate: requestAi,
  chat: requestAi
};

export default serverAIClient;
