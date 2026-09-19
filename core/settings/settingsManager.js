import { providerManager } from '../providers/providerManager.js';
import { getProviderAdapter } from '../providers/providerAdapters.js';
import { providerRegistry } from '../providers/providerRegistry.js';
import { providerHealthRepository } from '../repositories/providerHealthRepository.js';
import { settingsRepository } from '../repositories/settingsRepository.js';
import { decryptApiKey, encryptApiKey, toSafeProviderConfig } from './apiKeySecurity.js';
import { normalizeAppearanceTheme } from './appearanceTheme.js';
import { defaultAiSettings, providerModelDefaults } from './defaultSettings.js';

const VOLATILE_HEALTH_FIELDS = new Set([
  'status',
  'healthy',
  'httpStatus',
  'lastSuccessAt',
  'lastFailureAt',
  'lastErrorCode',
  'averageLatencyMs',
  'healthSampleCount',
  'lastHealthCheck',
  'lastTestedAt',
  'lastLatency',
  'lastError',
  'responseTimeMs',
  'lastCheckedAt',
  'consecutiveFailures'
]);

function credentialProviderConfig(config = {}) {
  return Object.fromEntries(Object.entries(config).filter(([field, value]) => {
    if (!VOLATILE_HEALTH_FIELDS.has(field)) return true;
    return field === 'status' && ['未配置', '未测试', '已禁用'].includes(value);
  }));
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function safeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function safeErrorCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : 'PROVIDER_ERROR';
}

function healthSnapshot({ providerId, result, previous = {}, now }) {
  const healthy = result.ok === true;
  const responseTimeMs = nonNegativeInteger(result.latency ?? result.durationMs);
  const previousSampleCount = nonNegativeInteger(previous.sampleCount);
  const previousAverage = nonNegativeInteger(previous.averageResponseTimeMs ?? previous.responseTimeMs);
  const sampleCount = previousSampleCount + 1;
  const averageResponseTimeMs = previousSampleCount > 0
    ? Math.round(((previousAverage * previousSampleCount) + responseTimeMs) / sampleCount)
    : responseTimeMs;
  return {
    healthy,
    httpStatus: safeHttpStatus(result.httpStatus),
    errorCode: healthy ? '' : safeErrorCode(result.code),
    responseTimeMs,
    averageResponseTimeMs,
    sampleCount,
    lastCheckedAt: now,
    consecutiveFailures: healthy ? 0 : nonNegativeInteger(previous.consecutiveFailures) + 1,
    lastSuccessAt: healthy ? now : String(previous.lastSuccessAt || ''),
    providerId
  };
}

function applyHealth(config = {}, health = null) {
  if (!health || typeof health !== 'object') return config;
  const healthy = health.healthy === true ? true : health.healthy === false ? false : null;
  if (healthy === null) return config;
  const checkedAt = String(health.lastCheckedAt || '');
  const responseTimeMs = nonNegativeInteger(health.responseTimeMs);
  const averageResponseTimeMs = nonNegativeInteger(health.averageResponseTimeMs, responseTimeMs);
  const sampleCount = Math.max(1, nonNegativeInteger(health.sampleCount, 1));
  return {
    ...config,
    healthy,
    status: healthy ? '可用' : '连接失败',
    httpStatus: safeHttpStatus(health.httpStatus),
    lastSuccessAt: String(health.lastSuccessAt || ''),
    lastFailureAt: healthy ? String(config.lastFailureAt || '') : checkedAt,
    lastErrorCode: healthy ? '' : safeErrorCode(health.errorCode),
    averageLatencyMs: averageResponseTimeMs,
    healthSampleCount: sampleCount,
    lastHealthCheck: checkedAt,
    lastTestedAt: checkedAt,
    lastLatency: responseTimeMs,
    lastError: healthy ? '' : safeErrorCode(health.errorCode),
    responseTimeMs,
    lastCheckedAt: checkedAt,
    consecutiveFailures: nonNegativeInteger(health.consecutiveFailures)
  };
}

function readHealthState(repository) {
  try {
    const record = repository?.read?.();
    return record && typeof record === 'object'
      ? record
      : { schemaVersion: 1, providers: {} };
  } catch {
    return { schemaVersion: 1, providers: {} };
  }
}

export class SettingsManager {
  constructor({
    repository = settingsRepository,
    healthRepository = providerHealthRepository,
    providers = providerManager,
    defaults = defaultAiSettings,
    adapterResolver = getProviderAdapter,
    clock = () => new Date(),
    credentialBackend = 'legacy_settings_v1',
    credentialResolver = null
  } = {}) {
    this.repository = repository;
    this.healthRepository = healthRepository;
    this.providers = providers;
    this.defaults = defaults;
    this.adapterResolver = adapterResolver;
    this.clock = clock;
    this.credentialBackend = credentialBackend;
    this.credentialResolver = credentialResolver;
  }

  load() {
    const stored = this.repository.read() || {};
    const normalized = this.normalize({ ...this.defaults, ...stored });
    const persistedHealth = readHealthState(this.healthRepository).providers || {};
    const settings = {
      ...normalized,
      providers: Object.fromEntries(Object.entries(normalized.providers || {}).map(([providerId, config]) => [
        providerId,
        applyHealth(config, persistedHealth[providerId])
      ]))
    };
    this.applyToProviders(settings);
    return settings;
  }

  save(settings) {
    const current = this.load();
    const providerChanged = Boolean(settings.provider && settings.provider !== current.provider);
    const normalized = this.normalize({ ...current, ...settings }, { providerChanged });
    this.repository.update(this.serializeForStorage(normalized));
    this.applyToProviders(normalized);
    return normalized;
  }

  normalize(settings, { providerChanged = false } = {}) {
    const provider = settings.provider || this.defaults.provider;
    const providers = Object.fromEntries(providerRegistry.list().map((definition) => {
      const legacyConfig = definition.id === provider
        ? {
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            defaultModel: settings.defaultModel || settings.model,
            temperature: settings.temperature,
            maxTokens: settings.maxTokens
          }
        : {};
      const storedConfig = settings.providers?.[definition.id] || legacyConfig;
      const apiKeyConfigured = Boolean(storedConfig.apiKey || storedConfig.apiKeyConfigured);
      const normalizedConfig = providerRegistry.normalizeConfig(definition.id, {
        ...storedConfig,
        apiKey: this.credentialBackend === 'vault_v1' ? '' : decryptApiKey(storedConfig.apiKey)
      });
      if (this.credentialBackend === 'vault_v1') {
        normalizedConfig.apiKeyConfigured = apiKeyConfigured;
        normalizedConfig.configured = Boolean(
          apiKeyConfigured && normalizedConfig.baseUrl && normalizedConfig.defaultModel
        );
        normalizedConfig.healthy = storedConfig.healthy === true
          ? true
          : storedConfig.healthy === false
            ? false
            : normalizedConfig.healthy;
        if (storedConfig.status) normalizedConfig.status = storedConfig.status;
      }
      return [definition.id, normalizedConfig];
    }));
    const activeConfig = providers[provider] || providerRegistry.createDefaultConfig(provider);
    if (providerChanged) {
      activeConfig.defaultModel = providerModelDefaults[provider] ?? activeConfig.defaultModel;
      activeConfig.model = activeConfig.defaultModel;
    }
    return {
      ...this.defaults,
      ...settings,
      appearanceTheme: normalizeAppearanceTheme(settings.appearanceTheme),
      provider,
      apiKey: activeConfig.apiKey,
      baseUrl: activeConfig.baseUrl,
      defaultModel: activeConfig.defaultModel,
      model: activeConfig.defaultModel,
      costStrategy: settings.costStrategy || this.defaults.costStrategy || 'Balanced',
      router: {
        ...(this.defaults.router || { routes: {} }),
        ...(settings.router || {}),
        routes: {
          ...(this.defaults.router?.routes || {}),
          ...(settings.router?.routes || {})
        }
      },
      gateway: {
        ...(this.defaults.gateway || { runtime: { enabled: false } }),
        ...(settings.gateway || {}),
        runtime: {
          ...(this.defaults.gateway?.runtime || { enabled: false }),
          ...(settings.gateway?.runtime || {})
        }
      },
      temperature: activeConfig.temperature,
      maxTokens: activeConfig.maxTokens,
      providers
    };
  }

  serializeForStorage(settings = {}) {
    if (this.credentialBackend === 'vault_v1') {
      const { apiKey: _rootApiKey, ...safeSettings } = settings;
      const providers = Object.fromEntries(Object.entries(settings.providers || {}).map(([providerId, config]) => {
        const {
          apiKey,
          maskedApiKey: _maskedApiKey,
          ...safeConfig
        } = credentialProviderConfig(config);
        return [providerId, {
          ...safeConfig,
          apiKeyConfigured: Boolean(apiKey || safeConfig.apiKeyConfigured)
        }];
      }));
      return { ...safeSettings, providers };
    }
    const providers = Object.fromEntries(Object.entries(settings.providers || {}).map(([providerId, config]) => [
      providerId,
      {
        ...credentialProviderConfig(config),
        apiKey: encryptApiKey(config.apiKey)
      }
    ]));
    return {
      ...settings,
      apiKey: encryptApiKey(settings.apiKey),
      providers
    };
  }

  applyToProviders(settings = this.load()) {
    const activeConfig = settings.providers?.[settings.provider] || settings;
    this.providers.configure({
      activeProvider: settings.provider,
      defaultProvider: this.defaults.provider,
      providerConfigs: settings.providers,
      costStrategy: settings.costStrategy || 'Balanced',
      settings: {
        apiKey: activeConfig.apiKey,
        baseUrl: activeConfig.baseUrl,
        model: activeConfig.defaultModel,
        defaultModel: activeConfig.defaultModel,
        temperature: activeConfig.temperature,
        maxTokens: activeConfig.maxTokens,
        timeoutMs: activeConfig.timeout
      },
      credentialMode: this.credentialBackend
    });
  }

  listProviderConfigs() {
    const settings = this.load();
    return providerRegistry.list().map((definition) => ({
      ...definition,
      ...settings.providers[definition.id]
    }));
  }

  getProviderConfig(providerId) {
    return this.listProviderConfigs().find((provider) => provider.id === providerId) || null;
  }

  listProviderConfigsForAdmin() {
    return this.listProviderConfigs().map(toSafeProviderConfig);
  }

  loadClientSettings() {
    const settings = this.load();
    const providers = Object.fromEntries(Object.entries(settings.providers || {}).map(([providerId, config]) => [
      providerId,
      toSafeProviderConfig(config)
    ]));
    return { ...settings, apiKey: '', providers };
  }

  getProviderConfigForAdmin(providerId) {
    const config = this.getProviderConfig(providerId);
    return config ? toSafeProviderConfig(config) : null;
  }

  saveProviderConfigFromAdmin(providerId, config = {}) {
    const current = this.getProviderConfig(providerId) || {};
    const { apiKey, apiKeyConfigured, maskedApiKey, ...safe } = config;
    this.saveProviderConfig(providerId, {
      ...current,
      ...safe,
      apiKey: String(apiKey || '').trim() || current.apiKey || ''
    });
    return this.getProviderConfigForAdmin(providerId);
  }

  async testProviderFromAdmin(providerId, config = {}) {
    const current = this.getProviderConfig(providerId) || {};
    const { apiKey, apiKeyConfigured, maskedApiKey, ...safe } = config;
    const result = await this.testProvider(providerId, {
      ...current,
      ...safe,
      apiKey: String(apiKey || '').trim() || current.apiKey || ''
    });
    return { ...result, config: toSafeProviderConfig(result.config || current) };
  }

  saveProviderConfig(providerId, config = {}) {
    if (this.credentialBackend === 'vault_v1' && String(config.apiKey || '').trim()) {
      const error = new Error('CREDENTIAL_WRITES_REQUIRE_VAULT');
      error.code = 'CREDENTIAL_WRITES_REQUIRE_VAULT';
      throw error;
    }
    const current = this.load();
    const normalized = providerRegistry.normalizeConfig(providerId, config);
    const providers = {
      ...current.providers,
      [providerId]: normalized
    };
    const activeConfig = providers[current.provider] || normalized;
    const saved = this.normalize({
      ...current,
      providers,
      apiKey: activeConfig.apiKey,
      baseUrl: activeConfig.baseUrl,
      defaultModel: activeConfig.defaultModel,
      model: activeConfig.defaultModel,
      temperature: activeConfig.temperature,
      maxTokens: activeConfig.maxTokens
    });
    this.repository.update(this.serializeForStorage(saved));
    this.applyToProviders(saved);
    return this.getProviderConfig(providerId);
  }

  async testProvider(providerId, config = {}) {
    const definition = providerRegistry.get(providerId);
    const adapter = this.adapterResolver(definition, { manager: this.providers });
    const normalized = providerRegistry.normalizeConfig(providerId, config);
    const result = this.credentialBackend === 'vault_v1'
      ? await this.credentialResolver.withCredentials({
          providerId,
          purpose: 'health_check'
        }, (credentials) => adapter.testConnection({
          ...normalized,
          apiKey: credentials.api_key
        }))
      : await adapter.testConnection(normalized);
    const persisted = readHealthState(this.healthRepository);
    const health = healthSnapshot({
      providerId,
      result,
      previous: persisted.providers?.[providerId],
      now: this.clock().toISOString()
    });
    let healthPersistenceWarning = null;
    try {
      this.healthRepository?.update?.({
        schemaVersion: 1,
        providers: {
          ...(persisted.providers || {}),
          [providerId]: health
        }
      });
    } catch {
      healthPersistenceWarning = {
        code: 'HEALTH_STATE_PERSISTENCE_FAILED',
        message: result.ok ? '连接成功，但状态保存失败' : '状态保存失败'
      };
    }
    return {
      ...result,
      ...(healthPersistenceWarning ? { healthPersistenceWarning } : {}),
      config: applyHealth(normalized, health)
    };
  }

  recordProviderHealth(providerId, outcome = {}) {
    const current = this.getProviderConfig(providerId);
    if (!current) return null;
    const persisted = readHealthState(this.healthRepository);
    const health = healthSnapshot({
      providerId,
      result: {
        ok: outcome.success === true,
        httpStatus: outcome.httpStatus,
        code: outcome.errorCode,
        durationMs: outcome.durationMs
      },
      previous: persisted.providers?.[providerId],
      now: this.clock().toISOString()
    });
    try {
      this.healthRepository?.update?.({
        schemaVersion: 1,
        providers: {
          ...(persisted.providers || {}),
          [providerId]: health
        }
      });
    } catch {
      // Runtime Provider calls must not fail because optional health metadata cannot persist.
    }
    return applyHealth(current, health);
  }

  async testConnection(settings = this.load()) {
    const normalized = this.normalize(settings);
    return this.testProvider(normalized.provider, normalized.providers[normalized.provider]);
  }

  saveRouterConfig(router = {}) {
    const current = this.load();
    const saved = this.normalize({
      ...current,
      router: {
        ...(current.router || { routes: {} }),
        ...router,
        routes: {
          ...(current.router?.routes || {}),
          ...(router.routes || {})
        }
      }
    });
    this.repository.update(this.serializeForStorage(saved));
    this.applyToProviders(saved);
    return saved.router;
  }

  setAppearanceTheme(themeId) {
    const current = this.load();
    const saved = this.normalize({
      ...current,
      appearanceTheme: normalizeAppearanceTheme(themeId)
    });
    this.repository.update(this.serializeForStorage(saved));
    return saved.appearanceTheme;
  }
}

export const settingsManager = new SettingsManager();
