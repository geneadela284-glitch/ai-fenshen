import { aiRouter } from '../router/index.js';

const defaultContext = {
  workspaceId: '',
  memory: null,
  knowledge: null,
  prompt: null,
  temperature: undefined,
  metadata: {}
};

function buildContext(request = {}) {
  return {
    workspaceId: request.workspaceId || defaultContext.workspaceId,
    memory: request.memory ?? defaultContext.memory,
    knowledge: request.knowledge ?? defaultContext.knowledge,
    prompt: request.prompt ?? defaultContext.prompt,
    temperature: request.temperature ?? request.options?.temperature ?? defaultContext.temperature,
    metadata: request.metadata && typeof request.metadata === 'object' ? request.metadata : defaultContext.metadata
  };
}

function buildProviderRequest(request = {}) {
  const context = buildContext(request);
  return {
    ...request,
    context,
    prompt: request.prompt,
    messages: request.messages,
    input: request.input,
    options: {
      ...(request.options || {}),
      ...(context.temperature !== undefined ? { temperature: context.temperature } : {})
    }
  };
}

export class AIEngine {
  constructor({ router = aiRouter } = {}) {
    this.router = router;
  }

  generate(request = {}) {
    return this.router.run({ ...buildProviderRequest(request), method: 'generate' });
  }

  summarize(request = {}) {
    return this.chat({
      ...request,
      metadata: { ...(request.metadata || {}), intent: 'summarize' }
    });
  }

  classify(request = {}) {
    return this.chat({
      ...request,
      metadata: { ...(request.metadata || {}), intent: 'classify' }
    });
  }

  extract(request = {}) {
    return this.chat({
      ...request,
      metadata: { ...(request.metadata || {}), intent: 'extract' }
    });
  }

  chat(request = {}) {
    return this.router.run({ ...buildProviderRequest(request), method: 'chat' });
  }

  analyze(request = {}) {
    return this.chat({
      ...request,
      metadata: { ...(request.metadata || {}), intent: 'analyze' }
    });
  }
}

export const aiEngine = new AIEngine();

export default aiEngine;
