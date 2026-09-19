import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderManager } from '../providers/providerManager.js';
import { providerRegistry } from '../providers/providerRegistry.js';
import { SettingsRepository } from '../repositories/settingsRepository.js';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { SettingsManager } from './settingsManager.js';

function createManager() {
  const repository = new SettingsRepository({ storage: createMemoryStorage() });
  const providers = new ProviderManager();
  return {
    repository,
    providers,
    manager: new SettingsManager({ repository, providers })
  };
}

test('provider registry includes enterprise provider persistence targets', () => {
  const providerIds = providerRegistry.list().map((provider) => provider.id);
  ['deepseek', 'qwen', 'kimi', 'openai', 'claude', 'gemini'].forEach((providerId) => {
    assert.ok(providerIds.includes(providerId), `${providerId} should be registered`);
  });
});

test('provider configs persist independently and recover after reload', () => {
  const { repository, providers, manager } = createManager();

  manager.saveProviderConfig('deepseek', {
    ...manager.getProviderConfig('deepseek'),
    enabled: true,
    apiKey: 'deepseek-key',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 1024
  });

  manager.saveProviderConfig('claude', {
    ...manager.getProviderConfig('claude'),
    enabled: true,
    apiKey: 'claude-key',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    temperature: 0.4,
    maxTokens: 2048
  });

  manager.saveProviderConfig('gemini', {
    ...manager.getProviderConfig('gemini'),
    enabled: true,
    apiKey: 'gemini-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-pro',
    temperature: 0.6,
    maxTokens: 4096
  });

  const stored = repository.read();
  assert.notEqual(stored.providers.deepseek.apiKey, 'deepseek-key');
  assert.notEqual(stored.providers.claude.apiKey, 'claude-key');
  assert.notEqual(stored.providers.gemini.apiKey, 'gemini-key');

  const reloaded = new SettingsManager({ repository, providers }).load();
  assert.equal(reloaded.providers.deepseek.apiKey, 'deepseek-key');
  assert.equal(reloaded.providers.claude.apiKey, 'claude-key');
  assert.equal(reloaded.providers.gemini.apiKey, 'gemini-key');
  assert.equal(reloaded.providers.deepseek.defaultModel, 'deepseek-chat');
  assert.equal(reloaded.providers.claude.defaultModel, 'claude-sonnet-4-20250514');
  assert.equal(reloaded.providers.gemini.defaultModel, 'gemini-2.5-pro');
  assert.equal(reloaded.providers.deepseek.temperature, 0.2);
  assert.equal(reloaded.providers.claude.temperature, 0.4);
  assert.equal(reloaded.providers.gemini.temperature, 0.6);

  const runtimeConfig = providers.getConfig();
  assert.equal(runtimeConfig.providerConfigs.claude.apiKey, 'claude-key');
  assert.equal(runtimeConfig.providerConfigs.gemini.apiKey, 'gemini-key');
});

test('missing api key test connection returns clear non-mock failure', async () => {
  const { manager } = createManager();
  const result = await manager.testProvider('claude', manager.getProviderConfig('claude'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MISSING_API_KEY');
  assert.equal(result.status, '未配置');
});

test('administrator view models mask stored keys and blank submissions preserve them', () => {
  const { manager } = createManager();
  manager.saveProviderConfig('deepseek', {
    ...manager.getProviderConfig('deepseek'),
    enabled: true,
    apiKey: 'sk-existing-secret-abcd'
  });

  const safe = manager.getProviderConfigForAdmin('deepseek');
  assert.equal(safe.apiKey, undefined);
  assert.equal(safe.maskedApiKey, 'sk-****abcd');
  manager.saveProviderConfigFromAdmin('deepseek', { ...safe, apiKey: '', priority: 3 });
  assert.equal(manager.getProviderConfig('deepseek').apiKey, 'sk-existing-secret-abcd');
  assert.equal(JSON.stringify(manager.loadClientSettings()).includes('sk-existing-secret-abcd'), false);
  assert.equal(manager.loadClientSettings().providers.deepseek.maskedApiKey, 'sk-****abcd');
});

test('appearance preference persists without changing provider configuration', () => {
  const { manager } = createManager();
  manager.saveProviderConfig('deepseek', {
    ...manager.getProviderConfig('deepseek'),
    enabled: true,
    apiKey: 'deepseek-key',
    defaultModel: 'deepseek-chat'
  });

  manager.setAppearanceTheme('professional-dark');
  const reloaded = manager.load();

  assert.equal(reloaded.appearanceTheme, 'professional-dark');
  assert.equal(reloaded.providers.deepseek.apiKey, 'deepseek-key');
  assert.equal(reloaded.providers.deepseek.defaultModel, 'deepseek-chat');
});

test('Gateway Runtime feature flag defaults off and persists only when explicitly changed', () => {
  const { manager } = createManager();
  assert.equal(manager.load().gateway.runtime.enabled, false);

  manager.save({ gateway: { runtime: { enabled: true } } });
  assert.equal(manager.load().gateway.runtime.enabled, true);
});

test('Vault-backed Settings serialization persists only non-secret compatibility fields', () => {
  const repository = new SettingsRepository({ storage: createMemoryStorage() });
  const providers = new ProviderManager();
  const manager = new SettingsManager({
    repository,
    providers,
    credentialBackend: 'vault_v1'
  });
  const serialized = manager.serializeForStorage({
    provider: 'deepseek',
    apiKey: 'must-not-persist',
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'must-not-persist',
        apiKeyConfigured: true,
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-v4-flash'
      }
    }
  });
  assert.equal('apiKey' in serialized, false);
  assert.equal('apiKey' in serialized.providers.deepseek, false);
  assert.equal(serialized.providers.deepseek.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(serialized), /must-not-persist/);
});

test('Vault-backed Settings reject direct API Key writes while legacy mode remains compatible', () => {
  const repository = new SettingsRepository({ storage: createMemoryStorage() });
  const providers = new ProviderManager();
  const manager = new SettingsManager({
    repository,
    providers,
    credentialBackend: 'vault_v1'
  });
  assert.throws(
    () => manager.saveProviderConfig('deepseek', {
      ...providerRegistry.createDefaultConfig('deepseek'),
      enabled: true,
      apiKey: 'must-use-vault'
    }),
    (error) => error.code === 'CREDENTIAL_WRITES_REQUIRE_VAULT'
  );
});

test('Vault-backed Settings load exposes configured state but no legacy credential value', () => {
  const storage = createMemoryStorage({
    'ai-settings': {
      provider: 'deepseek',
      providers: {
        deepseek: {
          enabled: true,
          apiKey: 'awc-key-v1:legacy-ciphertext',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-v4-flash',
          healthy: true,
          status: '可用'
        }
      }
    }
  });
  const repository = new SettingsRepository({ storage });
  const providers = new ProviderManager();
  const manager = new SettingsManager({
    repository,
    providers,
    credentialBackend: 'vault_v1'
  });
  const loaded = manager.load();
  assert.equal(loaded.providers.deepseek.apiKey, '');
  assert.equal(loaded.providers.deepseek.apiKeyConfigured, true);
  assert.equal(loaded.providers.deepseek.configured, true);
  assert.equal(loaded.providers.deepseek.healthy, true);
  assert.doesNotMatch(JSON.stringify(providers.getConfig()), /awc-key-v1|legacy-ciphertext/);
});
