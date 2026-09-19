function todo(providerId, method) {
  const error = new Error(`TODO: ${providerId}.${method} Gateway integration is not implemented.`);
  error.code = 'CAPABILITY_NOT_SUPPORTED';
  throw error;
}

class InternationalAdapterPlaceholder {
  constructor(providerId) {
    this.providerId = providerId;
  }

  validateConfig() { return todo(this.providerId, 'validateConfig'); }
  async healthCheck() { return todo(this.providerId, 'healthCheck'); }
  async listModels() { return todo(this.providerId, 'listModels'); }
  supportsCapability() { return todo(this.providerId, 'supportsCapability'); }
  async invoke() { return todo(this.providerId, 'invoke'); }
  async invokeVision() { return todo(this.providerId, 'invokeVision'); }
  async invokeStructured() { return todo(this.providerId, 'invokeStructured'); }
  normalizeResponse() { return todo(this.providerId, 'normalizeResponse'); }
  normalizeError() { return todo(this.providerId, 'normalizeError'); }
  normalizeUsage() { return todo(this.providerId, 'normalizeUsage'); }
  estimateCost() { return todo(this.providerId, 'estimateCost'); }
}

export class OpenAIAdapter extends InternationalAdapterPlaceholder {
  constructor() { super('openai'); }
}

export class ClaudeAdapter extends InternationalAdapterPlaceholder {
  constructor() { super('claude'); }
}

export class GeminiAdapter extends InternationalAdapterPlaceholder {
  constructor() { super('gemini'); }
}

export class GrokAdapter extends InternationalAdapterPlaceholder {
  constructor() { super('grok'); }
}
