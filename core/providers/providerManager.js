import openai from './openai.js';
import deepseek from './deepseek.js';
import qwen from './qwen.js';
import kimi from './kimi.js';
import doubao from './doubao.js';
import zhipu from './zhipu.js';
import claude from './claude.js';
import gemini from './gemini.js';
import { assertProviderContract } from '../utils/providerContract.js';

const defaultProviders = [
  deepseek,
  qwen,
  kimi,
  doubao,
  zhipu,
  openai,
  claude,
  gemini
];

export class ProviderManager {
  constructor({
    providers = defaultProviders,
    defaultProvider = 'deepseek',
    credentialResolver = null,
    credentialMode = 'legacy_settings_v1',
    config = {}
  } = {}) {
    this.providers = new Map();
    providers.forEach((provider) => this.registerProvider(provider));
    this.defaultProvider = config.defaultProvider || defaultProvider;
    this.activeProvider = config.activeProvider || this.defaultProvider;
    this.settings = config.settings || {};
    this.providerConfigs = config.providerConfigs || {};
    this.costStrategy = config.costStrategy || 'Balanced';
    this.credentialResolver = credentialResolver;
    this.credentialMode = credentialMode;
    this.getProvider(this.activeProvider);
  }

  registerProvider(provider) {
    assertProviderContract(provider);
    this.providers.set(provider.id, provider);
    return provider;
  }

  unregisterProvider(providerId) {
    if (providerId === this.defaultProvider) {
      throw new Error('Cannot unregister the active default provider.');
    }
    return this.providers.delete(providerId);
  }

  setDefaultProvider(providerId) {
    this.getProvider(providerId);
    this.defaultProvider = providerId;
  }

  setActiveProvider(providerId) {
    this.getProvider(providerId);
    this.activeProvider = providerId;
  }

  configure(config = {}) {
    if (config.defaultProvider) {
      this.setDefaultProvider(config.defaultProvider);
    }
    if (config.activeProvider) {
      this.setActiveProvider(config.activeProvider);
    }
    if (config.settings) {
      this.settings = { ...this.settings, ...config.settings };
    }
    if (config.providerConfigs) {
      this.providerConfigs = config.providerConfigs;
    }
    if (config.costStrategy) {
      this.costStrategy = config.costStrategy;
    }
    if (config.credentialMode) {
      this.credentialMode = config.credentialMode;
    }
    if (Object.hasOwn(config, 'credentialResolver')) {
      this.credentialResolver = config.credentialResolver;
    }
    return this.getConfig();
  }

  getConfig() {
    return {
      defaultProvider: this.defaultProvider,
      activeProvider: this.activeProvider,
      settings: this.settings,
      providerConfigs: this.providerConfigs,
      costStrategy: this.costStrategy,
      credentialMode: this.credentialMode
    };
  }

  listProviders() {
    return Array.from(this.providers.values()).map(({ id, name, type, status, region, reserved }) => ({
      id,
      name,
      type,
      status,
      region,
      reserved: Boolean(reserved),
      active: id === this.activeProvider,
      default: id === this.defaultProvider
    }));
  }

  getProvider(providerId = this.activeProvider) {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`);
    }
    return provider;
  }

  resolveProviderId(request = {}) {
    return request.provider || request.providerId || this.activeProvider || this.defaultProvider;
  }

  buildRequest(request = {}, credentials = {}) {
    const providerId = this.resolveProviderId(request);
    const providerConfig = this.providerConfigs?.[providerId] || {};
    const providerSettings = {
      apiKey: credentials.api_key || (this.credentialMode === 'legacy_settings_v1' ? providerConfig.apiKey : undefined),
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.defaultModel || providerConfig.model,
      defaultModel: providerConfig.defaultModel || providerConfig.model,
      temperature: providerConfig.temperature,
      maxTokens: providerConfig.maxTokens,
      timeoutMs: providerConfig.timeout
    };
    return {
      ...request,
      provider: providerId,
      options: {
        ...(this.settings || {}),
        ...Object.fromEntries(Object.entries(providerSettings).filter(([, value]) => value !== undefined && value !== '')),
        ...(request.options || {})
      }
    };
  }

  async generate(request = {}) {
    return this.invokeWithCredentials('generate', request);
  }

  async chat(request = {}) {
    return this.invokeWithCredentials('chat', request);
  }

  getCapabilities(providerId = this.activeProvider) {
    const provider = this.getProvider(providerId);
    return {
      supportsChat: provider.supportsChat === true && typeof provider.chat === 'function',
      supportsStreaming: provider.supportsStreaming === true && typeof provider.streamChat === 'function',
      supportsVoiceStreaming: (provider.supportsStreaming === true && typeof provider.streamChat === 'function') || (provider.supportsVoiceStreaming === true && typeof provider.streamVoiceChat === 'function'),
      supportsSingleShotSseBridge:
        provider.supportsSingleShotSseBridge === true &&
        provider.supportsChat === true &&
        typeof provider.chat === 'function'
    };
  }

  supportsStreaming(providerId = this.activeProvider) {
    return this.getCapabilities(providerId).supportsStreaming;
  }

  async streamChat(request = {}, options = {}) {
    return this.invokeWithCredentials('streamChat', request, options);
  }

  async image(request = {}) {
    return this.invokeWithCredentials('image', request);
  }

  async embedding(request = {}) {
    return this.invokeWithCredentials('embedding', request);
  }

  async invokeWithCredentials(method, request = {}, invocationOptions = {}) {
    const providerId = this.resolveProviderId(request);
    const invoke = async (credentials = {}) => {
      const nextRequest = this.buildRequest({ ...request, provider: providerId }, credentials);
      const provider = this.getProvider(providerId);
      const capabilities = this.getCapabilities(providerId);
      if (method === 'streamChat' && nextRequest.metadata?.voiceRealtimeOnly === true && nextRequest.metadata?.routeDomain === 'ordinary_chat' && nextRequest.metadata?.voiceAnswerContext) {
        if (typeof provider.answerWithTools !== 'function') throw Object.assign(new Error('VOICE_ANSWER_UNSUPPORTED'), {code:'VOICE_ANSWER_UNSUPPORTED'});
        return provider.answerWithTools(nextRequest, invocationOptions);
      }
      if (method === 'streamChat' && nextRequest.metadata?.voiceRealtimeOnly === true && nextRequest.metadata?.voicePublicSearch) {
        if (typeof provider.searchPublicInformation !== 'function') throw Object.assign(new Error('PUBLIC_SEARCH_UNAVAILABLE'), {code:'PUBLIC_SEARCH_UNAVAILABLE'});
        return provider.searchPublicInformation(nextRequest, invocationOptions);
      }
      if (method === 'streamChat' && nextRequest.metadata?.voiceRealtimeOnly === true && capabilities.supportsVoiceStreaming) {
        return typeof provider.streamVoiceChat === 'function' ? provider.streamVoiceChat(nextRequest, invocationOptions) : provider.streamChat(nextRequest, invocationOptions);
      }
      if (method === 'streamChat' && capabilities.supportsStreaming) {
        return provider.streamChat(nextRequest, invocationOptions);
      }
      if (method === 'streamChat' && capabilities.supportsSingleShotSseBridge) {
        const result = await provider.chat(nextRequest);
        const content = String(result?.content || result?.text || result?.output || '');
        if (!content.trim()) {
          const error = new Error('Provider returned an empty response.');
          error.code = 'EMPTY_PROVIDER_RESPONSE';
          error.usage = result?.usage || null;
          throw error;
        }
        await invocationOptions.onDelta?.(content);
        return result;
      }
      if (method === 'streamChat') {
        const error = new Error('Provider does not support streaming.');
        error.code = 'STREAMING_NOT_SUPPORTED';
        throw error;
      }
      return provider[method](nextRequest);
    };
    if (this.credentialMode !== 'vault_v1') return invoke();
    if (!this.credentialResolver?.withCredentials) {
      const error = new Error('CREDENTIAL_RESOLVER_UNAVAILABLE');
      error.code = 'CREDENTIAL_RESOLVER_UNAVAILABLE';
      throw error;
    }
    return this.credentialResolver.withCredentials({
      providerId,
      purpose: 'invoke'
    }, invoke);
  }
}

export const providerManager = new ProviderManager();

export default providerManager;
