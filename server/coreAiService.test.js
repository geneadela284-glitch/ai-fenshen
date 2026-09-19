import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCoreAiService as createProductionCoreAiService,
  CoreAiService as ProductionCoreAiService
} from './coreAiService.js';
import { encryptApiKey } from '../core/settings/apiKeySecurity.js';
import { allowingAccessControl } from '../core/router/testing/allowingAccessControl.js';

function createCoreAiService(options = {}) {
  return createProductionCoreAiService({ ...options, accessControl: allowingAccessControl });
}

class CoreAiService extends ProductionCoreAiService {
  constructor(options = {}) {
    super({ ...options, accessControl: allowingAccessControl });
  }
}

test('stores admin AI configuration on the backend without plaintext keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-core-ai-'));
  const configPath = path.join(dir, 'settings.json');
  try {
    const service = createCoreAiService({ configPath });
    const safe = service.saveProvider('deepseek', {
      enabled: true,
      apiKey: 'test-secret-value-abcd',
      baseUrl: 'https://example.invalid/v1',
      defaultModel: 'deepseek-chat'
    });
    assert.equal(safe.apiKeyConfigured, true);
    assert.equal('apiKey' in safe, false);
    assert.doesNotMatch(await readFile(configPath, 'utf8'), /test-secret-value-abcd/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps read-only credentials unchanged while atomically persisting secret-free Provider health', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-health-store-'));
  const configPath = path.join(dir, 'credential.json');
  const healthStorePath = path.join(dir, 'runtime', 'provider-health.json');
  try {
    const service = createCoreAiService({
      configPath,
      healthStorePath,
      adapterResolver() {
        return {
          async testConnection() {
            return { ok: true, status: '可用', httpStatus: 200, latency: 27, message: 'Connected' };
          }
        };
      }
    });
    service.saveProvider('qwen', {
      enabled: true,
      apiKey: 'credential-secret-qwen',
      baseUrl: 'https://provider.invalid/v1',
      defaultModel: 'qwen-test'
    });
    const credentialBefore = await readFile(configPath);
    await chmod(configPath, 0o400);

    const result = await service.testProvider('qwen');

    assert.equal(result.ok, true);
    assert.equal(result.config.healthy, true);
    assert.deepEqual(await readFile(configPath), credentialBefore);
    const healthBytes = await readFile(healthStorePath, 'utf8');
    assert.doesNotMatch(healthBytes, /credential-secret-qwen|apiKey|credential/i);
    assert.equal(JSON.parse(healthBytes)['provider-health'].providers.qwen.httpStatus, 200);
    assert.equal((await stat(healthStorePath)).mode & 0o777, 0o600);
  } finally {
    await chmod(configPath, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('rebuilds a corrupted Provider Health Store without changing credentials', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-health-rebuild-'));
  const configPath = path.join(dir, 'credential.json');
  const healthStorePath = path.join(dir, 'provider-health.json');
  try {
    const service = createCoreAiService({
      configPath,
      healthStorePath,
      adapterResolver() {
        return {
          async testConnection() {
            return { ok: false, status: '连接失败', httpStatus: 400, code: 'HTTP_ERROR', latency: 31, message: '网络错误' };
          }
        };
      }
    });
    service.saveProvider('deepseek', {
      enabled: true,
      apiKey: 'credential-secret-deepseek',
      baseUrl: 'https://provider.invalid',
      defaultModel: 'deepseek-chat'
    });
    const credentialBefore = await readFile(configPath);
    await writeFile(healthStorePath, '{corrupt', { mode: 0o600 });
    await chmod(configPath, 0o400);

    const result = await service.testProvider('deepseek');

    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 400);
    assert.deepEqual(await readFile(configPath), credentialBefore);
    const rebuilt = JSON.parse(await readFile(healthStorePath, 'utf8'));
    assert.equal(rebuilt['provider-health'].providers.deepseek.healthy, false);
    assert.equal(rebuilt['provider-health'].providers.deepseek.errorCode, 'HTTP_ERROR');
  } finally {
    await chmod(configPath, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns only product-safe fields to normal users on success and failure', async () => {
  const settings = { load: () => ({ providers: {} }), listProviderConfigsForAdmin: () => [] };
  const success = new CoreAiService({
    settings,
    router: {
      async run() {
        return { content: 'AI秘书可以帮你处理这件事。', latency: 8, usage: { total_tokens: 4 }, error: null };
      }
    }
  });
  const successResult = await success.run({ input: '你好' });
  assert.deepEqual(successResult, {
    ok: true,
    content: 'AI秘书可以帮你处理这件事。',
    latency: 8,
    usage: { total_tokens: 4 }
  });
  assert.doesNotMatch(JSON.stringify(successResult), /provider|model|router|trace|api.?key|endpoint|capability/i);

  const failed = new CoreAiService({
    settings,
    router: { async run() { return { error: { code: 'AUTH_FAILED' }, latency: 9 }; } }
  });
  assert.deepEqual(await failed.run({ input: '你好' }), {
    ok: false,
    content: '',
    message: 'AI 服务暂时不可用，请稍后重试。',
    code: 'AUTH_FAILED',
    latency: 9,
    usage: null
  });
});

test('normal user responses enforce the unified AI secretary identity', async () => {
  const service = new CoreAiService({
    settings: { load: () => ({ providers: {} }), listProviderConfigsForAdmin: () => [] },
    router: {
      async run() {
        return { content: '你好！我是 AI Work Center 的企业工作秘书，可以帮你安排工作。', error: null };
      }
    }
  });

  assert.equal(
    (await service.run({ input: '你是谁？' })).content,
    '你好！我是AI秘书，可以帮你安排工作。'
  );
});

test('normal user requests cannot enable mock mode or remove the timeout ceiling', async () => {
  let captured;
  const service = new CoreAiService({
    settings: { load: () => ({ providers: {} }), listProviderConfigsForAdmin: () => [] },
    router: {
      async run(task) {
        captured = task;
        return { content: '正常结果', error: null };
      }
    }
  });

  await service.run({ input: '你好', metadata: { mockOnly: true, taskType: 'general' }, options: { timeoutMs: 999999 } });

  assert.equal('mockOnly' in captured.metadata, false);
  assert.equal(captured.options.timeoutMs, 30000);
});

test('Registry-enabled CoreAiService shadow-migrates five credentials and keeps runtime snapshots secret-free', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-registry-runtime-'));
  const configPath = path.join(dir, 'ai-settings.json');
  const registryPath = path.join(dir, 'registry.v1.json');
  const modelCatalogPath = path.join(dir, 'model-catalog.v1.json');
  const vaultPath = path.join(dir, 'provider-credentials.v1.enc');
  const auditLogPath = path.join(dir, 'provider-security-audit.ndjson');
  const kekCredentialPath = path.join(dir, 'provider-vault-kek');
  const providerIds = ['deepseek', 'qwen', 'kimi', 'zhipu', 'doubao'];
  const settings = {
    provider: 'deepseek',
    providers: Object.fromEntries(providerIds.map((providerId, index) => [
      providerId,
      {
        enabled: index === 0,
        apiKey: encryptApiKey(`${providerId}-runtime-secret`),
        baseUrl: `https://${providerId}.example.invalid/v1`,
        defaultModel: `${providerId}-model`,
        healthy: index < 4,
        status: index < 4 ? '可用' : '连接失败'
      }
    ]))
  };
  try {
    await writeFile(configPath, JSON.stringify({ 'ai-settings': settings }, null, 2), { mode: 0o400 });
    await writeFile(kekCredentialPath, Buffer.alloc(32, 0x55), { mode: 0o400 });
    const sourceBefore = await readFile(configPath);
    const service = createCoreAiService({
      configPath,
      providerRegistryConfig: {
        enabled: true,
        registryPath,
        modelCatalogPath,
        vaultPath,
        auditLogPath,
        kekCredentialPath
      }
    });

    assert.equal(service.providerRegistryStore.readRegistry().credential_backend, 'vault_v1');
    assert.deepEqual(await readFile(configPath), sourceBefore);
    const runtimeSettings = service.settings.load();
    assert.equal(runtimeSettings.providers.deepseek.apiKey, '');
    assert.equal(runtimeSettings.providers.deepseek.apiKeyConfigured, true);
    assert.doesNotMatch(JSON.stringify(runtimeSettings), /deepseek-runtime-secret|qwen-runtime-secret/);
    assert.doesNotMatch(JSON.stringify(service.providers.getConfig()), /runtime-secret|awc-key-v1/);
    assert.equal(service.credentialResolver !== null, true);
    const vaultBytes = await readFile(vaultPath, 'utf8');
    providerIds.forEach((providerId) => assert.doesNotMatch(vaultBytes, new RegExp(`${providerId}-runtime-secret`)));
  } finally {
    for (const filePath of [configPath, kekCredentialPath, registryPath, modelCatalogPath, vaultPath, auditLogPath]) {
      await chmod(filePath, 0o600).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('Registry feature-off preserves the legacy CoreAiService credential path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-registry-off-'));
  const configPath = path.join(dir, 'ai-settings.json');
  try {
    const service = createCoreAiService({
      configPath,
      providerRegistryConfig: { enabled: false }
    });
    service.saveProvider('deepseek', {
      enabled: true,
      apiKey: 'legacy-feature-off-secret',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-flash'
    });
    assert.equal(service.settings.load().providers.deepseek.apiKey, 'legacy-feature-off-secret');
    assert.equal(service.providers.getConfig().providerConfigs.deepseek.apiKey, 'legacy-feature-off-secret');
    assert.equal(service.providerRegistryStore, null);
    assert.equal(service.credentialResolver, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
