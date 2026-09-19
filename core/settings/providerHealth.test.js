import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderManager } from '../providers/providerManager.js';
import { SettingsRepository } from '../repositories/settingsRepository.js';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { SettingsManager } from './settingsManager.js';

function createManager() {
  return new SettingsManager({
    repository: new SettingsRepository({ storage: createMemoryStorage() }),
    providers: new ProviderManager()
  });
}

function createReadOnlyCredentialRepository() {
  const error = Object.assign(new Error('Read-only file system'), { code: 'EROFS' });
  return {
    read() {
      return null;
    },
    update() {
      throw error;
    }
  };
}

function createHealthRepository(initialProviders = {}, { failWrites = false } = {}) {
  let record = {
    schemaVersion: 1,
    providers: structuredClone(initialProviders)
  };
  return {
    read() {
      return structuredClone(record);
    },
    update(next) {
      if (failWrites) {
        throw Object.assign(new Error('Health store unavailable'), { code: 'EACCES' });
      }
      record = { ...record, ...structuredClone(next) };
      return structuredClone(record);
    }
  };
}

function providerConfig(providerId, overrides = {}) {
  return {
    id: providerId,
    enabled: true,
    apiKey: `secret-${providerId}`,
    baseUrl: 'http://127.0.0.1:9',
    defaultModel: `${providerId}-model`,
    timeout: 10,
    ...overrides
  };
}

function managerForHealthTest({
  result,
  healthRepository = createHealthRepository(),
  credentialRepository = createReadOnlyCredentialRepository()
} = {}) {
  return {
    healthRepository,
    manager: new SettingsManager({
      repository: credentialRepository,
      healthRepository,
      providers: { configure() {} },
      adapterResolver() {
        return {
          async testConnection() {
            return structuredClone(result);
          }
        };
      }
    })
  };
}

test('configured provider remains unverified until a real success is recorded', () => {
  const manager = createManager();
  const saved = manager.saveProviderConfig('deepseek', {
    ...manager.getProviderConfig('deepseek'),
    enabled: true,
    apiKey: 'local-key',
    status: '未测试'
  });

  assert.equal(saved.configured, true);
  assert.equal(saved.healthy, null);
  assert.equal(saved.status, '未测试');
});

test('records provider success and failure health without exposing or replacing its key', () => {
  const manager = createManager();
  manager.saveProviderConfig('deepseek', {
    ...manager.getProviderConfig('deepseek'),
    enabled: true,
    apiKey: 'local-key',
    status: '未测试'
  });

  const success = manager.recordProviderHealth('deepseek', { success: true, durationMs: 120 });
  assert.equal(success.healthy, true);
  assert.equal(success.status, '可用');
  assert.equal(success.averageLatencyMs, 120);
  assert.ok(success.lastSuccessAt);
  assert.equal(success.apiKey, 'local-key');

  const failure = manager.recordProviderHealth('deepseek', { success: false, durationMs: 180, errorCode: 'TIMEOUT' });
  assert.equal(failure.healthy, false);
  assert.equal(failure.status, '连接失败');
  assert.equal(failure.lastErrorCode, 'TIMEOUT');
  assert.ok(failure.lastFailureAt);
  assert.equal(failure.averageLatencyMs, 150);
  assert.equal(failure.apiKey, 'local-key');
});

test('HTTP 200 remains successful when the credential repository is read-only', async () => {
  const { manager, healthRepository } = managerForHealthTest({
    result: { ok: true, status: '可用', httpStatus: 200, latency: 82, message: 'Connected' }
  });

  const result = await manager.testProvider('qwen', providerConfig('qwen'));

  assert.equal(result.ok, true);
  assert.equal(result.config.healthy, true);
  assert.equal(healthRepository.read().providers.qwen.httpStatus, 200);
});

test('HTTP 200 returns a persistence warning instead of a connection failure when Health Store write fails', async () => {
  const { manager } = managerForHealthTest({
    result: { ok: true, status: '可用', httpStatus: 200, latency: 91, message: 'Connected' },
    healthRepository: createHealthRepository({}, { failWrites: true })
  });

  const result = await manager.testProvider('kimi', providerConfig('kimi'));

  assert.equal(result.ok, true);
  assert.equal(result.healthPersistenceWarning?.code, 'HEALTH_STATE_PERSISTENCE_FAILED');
  assert.equal(result.config.healthy, true);
});

test('HTTP 200 remains successful when Health Store cannot be read', async () => {
  const healthRepository = {
    read() {
      throw Object.assign(new Error('Health store unreadable'), { code: 'EACCES' });
    },
    update() {
      throw Object.assign(new Error('Health store unavailable'), { code: 'EACCES' });
    }
  };
  const { manager } = managerForHealthTest({
    result: { ok: true, status: '可用', httpStatus: 200, latency: 73, message: 'Connected' },
    healthRepository
  });

  const result = await manager.testProvider('qwen', providerConfig('qwen'));

  assert.equal(result.ok, true);
  assert.equal(result.config.healthy, true);
  assert.equal(result.healthPersistenceWarning?.code, 'HEALTH_STATE_PERSISTENCE_FAILED');
});

test('HTTP 400 remains the current failure even when stored health was successful', async () => {
  const healthRepository = createHealthRepository({
    deepseek: {
      healthy: true,
      httpStatus: 200,
      errorCode: '',
      responseTimeMs: 50,
      lastCheckedAt: '2026-07-20T00:00:00.000Z',
      consecutiveFailures: 0,
      lastSuccessAt: '2026-07-20T00:00:00.000Z'
    }
  });
  const { manager } = managerForHealthTest({
    result: { ok: false, status: '连接失败', httpStatus: 400, code: 'HTTP_ERROR', latency: 44, message: '网络错误' },
    healthRepository
  });

  const result = await manager.testProvider('deepseek', providerConfig('deepseek'));

  assert.equal(result.ok, false);
  assert.equal(result.config.healthy, false);
  assert.equal(result.config.httpStatus, 400);
  assert.equal(healthRepository.read().providers.deepseek.consecutiveFailures, 1);
});

test('current HTTP 200 overrides a stored unhealthy state', async () => {
  const healthRepository = createHealthRepository({
    zhipu: {
      healthy: false,
      httpStatus: 500,
      errorCode: 'HTTP_ERROR',
      responseTimeMs: 30,
      lastCheckedAt: '2026-07-20T00:00:00.000Z',
      consecutiveFailures: 2,
      lastSuccessAt: ''
    }
  });
  const { manager } = managerForHealthTest({
    result: { ok: true, status: '可用', httpStatus: 200, latency: 101, message: 'Connected' },
    healthRepository
  });

  const result = await manager.testProvider('zhipu', providerConfig('zhipu'));

  assert.equal(result.ok, true);
  assert.equal(result.config.healthy, true);
  assert.equal(result.config.consecutiveFailures, 0);
});

test('provider health records stay isolated across Qwen, Kimi, and Zhipu', () => {
  const healthRepository = createHealthRepository();
  const manager = new SettingsManager({
    repository: createReadOnlyCredentialRepository(),
    healthRepository,
    providers: { configure() {} }
  });

  manager.recordProviderHealth('qwen', { success: true, httpStatus: 200, durationMs: 10 });
  manager.recordProviderHealth('kimi', { success: false, httpStatus: 429, durationMs: 20, errorCode: 'RATE_LIMITED' });
  manager.recordProviderHealth('zhipu', { success: true, httpStatus: 200, durationMs: 30 });

  const providers = healthRepository.read().providers;
  assert.equal(providers.qwen.healthy, true);
  assert.equal(providers.kimi.healthy, false);
  assert.equal(providers.kimi.httpStatus, 429);
  assert.equal(providers.zhipu.responseTimeMs, 30);
});

test('Provider Health Store never persists API keys or credential bodies', async () => {
  const { manager, healthRepository } = managerForHealthTest({
    result: { ok: true, status: '可用', httpStatus: 200, latency: 12, message: 'Connected' }
  });

  await manager.testProvider('qwen', providerConfig('qwen', { apiKey: 'must-never-enter-health-store' }));

  assert.doesNotMatch(JSON.stringify(healthRepository.read()), /must-never-enter-health-store|apiKey|credential/i);
});

test('Credential Store serialization excludes volatile Provider health metadata', () => {
  const repository = new SettingsRepository({ storage: createMemoryStorage() });
  const manager = new SettingsManager({
    repository,
    healthRepository: createHealthRepository(),
    providers: new ProviderManager()
  });

  manager.saveProviderConfig('deepseek', {
    ...manager.getProviderConfig('deepseek'),
    apiKey: 'credential-only-secret',
    enabled: true,
    status: '可用',
    healthy: true,
    httpStatus: 200,
    lastCheckedAt: '2026-07-26T00:00:00.000Z',
    consecutiveFailures: 0
  });

  const storedProvider = repository.read().providers.deepseek;
  assert.equal(storedProvider.status, undefined);
  assert.equal(storedProvider.healthy, undefined);
  assert.equal(storedProvider.httpStatus, undefined);
  assert.equal(storedProvider.lastCheckedAt, undefined);
  assert.equal(storedProvider.consecutiveFailures, undefined);
  assert.ok(storedProvider.apiKey);
});
