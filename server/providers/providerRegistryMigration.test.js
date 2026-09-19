import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { encryptApiKey } from '../../core/settings/apiKeySecurity.js';
import { ProviderCredentialVault, createVaultKeyRing } from './providerCredentialVault.js';
import { ProviderRegistryStore } from './providerRegistryStore.js';
import { ProviderSecurityAudit } from './providerSecurity.js';
import { migrateLegacyProviderCredentials } from './providerRegistryMigration.js';

const PROVIDERS = ['deepseek', 'qwen', 'kimi', 'zhipu', 'doubao'];

function legacySettings() {
  return {
    provider: 'deepseek',
    providers: Object.fromEntries(PROVIDERS.map((providerId, index) => [
      providerId,
      {
        enabled: index === 0,
        apiKey: encryptApiKey(`${providerId}-legacy-secret-value`),
        baseUrl: `https://${providerId}.example.invalid/v1`,
        defaultModel: `${providerId}-current-model`,
        healthy: index < 4,
        lastError: index === 4 ? 'HTTP_404' : ''
      }
    ]))
  };
}

async function withHarness(run, { vaultFaultInjector = () => {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'provider-migration-'));
  const legacyPath = path.join(directory, 'ai-settings.json');
  const registryPath = path.join(directory, 'registry.v1.json');
  const modelCatalogPath = path.join(directory, 'model-catalog.v1.json');
  const vaultPath = path.join(directory, 'provider-credentials.v1.enc');
  const auditLogPath = path.join(directory, 'provider-security-audit.ndjson');
  try {
    await writeFile(legacyPath, JSON.stringify(legacySettings(), null, 2), { mode: 0o400 });
    const registryStore = new ProviderRegistryStore({ registryPath, modelCatalogPath });
    registryStore.initialize();
    const vault = new ProviderCredentialVault({
      vaultPath,
      keyRing: createVaultKeyRing({ currentKeyId: 'kek-1', keys: { 'kek-1': Buffer.alloc(32, 0x33) } }),
      faultInjector: vaultFaultInjector
    });
    vault.initialize();
    const audit = new ProviderSecurityAudit({ auditLogPath });
    await run({
      directory,
      legacyPath,
      registryPath,
      vaultPath,
      auditLogPath,
      registryStore,
      vault,
      audit
    });
  } finally {
    for (const filePath of [legacyPath, registryPath, modelCatalogPath, vaultPath, auditLogPath]) {
      await chmod(filePath, 0o600).catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('shadow migration moves all five existing credentials without changing legacy source bytes', async () => {
  await withHarness(async ({ legacyPath, vaultPath, auditLogPath, registryStore, vault, audit }) => {
    const before = await readFile(legacyPath);
    const raw = JSON.parse(before.toString('utf8'));
    const result = migrateLegacyProviderCredentials({
      legacySettings: raw,
      registryStore,
      vault,
      audit,
      expectedProviderIds: PROVIDERS
    });
    assert.deepEqual(result, {
      status: 'migrated',
      migrated_provider_count: 5,
      reused_provider_count: 0,
      credential_backend: 'vault_v1'
    });
    assert.deepEqual(await readFile(legacyPath), before);
    assert.equal(registryStore.readRegistry().credential_backend, 'vault_v1');
    PROVIDERS.forEach((providerId) => {
      assert.deepEqual(vault.readActiveCredentials(providerId), {
        api_key: `${providerId}-legacy-secret-value`
      });
    });

    const persisted = `${await readFile(vaultPath, 'utf8')}\n${await readFile(auditLogPath, 'utf8')}`;
    PROVIDERS.forEach((providerId) => assert.doesNotMatch(persisted, new RegExp(`${providerId}-legacy-secret-value`)));
    assert.doesNotMatch(persisted, /key_hash|secret_hash|last_four|suffix/i);
    assert.match(await readFile(auditLogPath, 'utf8'), /config_digest/);
  });
});

test('shadow migration is idempotent and does not create replacement revisions on rerun', async () => {
  await withHarness(async ({ legacyPath, vaultPath, registryStore, vault, audit }) => {
    const raw = JSON.parse(await readFile(legacyPath, 'utf8'));
    migrateLegacyProviderCredentials({ legacySettings: raw, registryStore, vault, audit, expectedProviderIds: PROVIDERS });
    const before = await readFile(vaultPath);
    const result = migrateLegacyProviderCredentials({ legacySettings: raw, registryStore, vault, audit, expectedProviderIds: PROVIDERS });
    assert.deepEqual(result, {
      status: 'already_migrated',
      migrated_provider_count: 0,
      reused_provider_count: 5,
      credential_backend: 'vault_v1'
    });
    assert.deepEqual(await readFile(vaultPath), before);
  });
});

test('missing legacy credential fails explicitly and keeps the legacy backend active', async () => {
  await withHarness(async ({ legacyPath, registryStore, vault, audit }) => {
    const raw = JSON.parse(await readFile(legacyPath, 'utf8'));
    delete raw.providers.kimi.apiKey;
    assert.throws(
      () => migrateLegacyProviderCredentials({ legacySettings: raw, registryStore, vault, audit, expectedProviderIds: PROVIDERS }),
      (error) => error.code === 'LEGACY_CREDENTIAL_MISSING'
    );
    assert.equal(registryStore.readRegistry().credential_backend, 'legacy_settings_v1');
  });
});

test('Vault write failure leaves the Registry backend and legacy source unchanged', async () => {
  let writes = 0;
  await withHarness(async ({ legacyPath, registryStore, vault, audit }) => {
    const before = await readFile(legacyPath);
    const raw = JSON.parse(before.toString('utf8'));
    assert.throws(
      () => migrateLegacyProviderCredentials({ legacySettings: raw, registryStore, vault, audit, expectedProviderIds: PROVIDERS }),
      /injected migration failure/
    );
    assert.equal(registryStore.readRegistry().credential_backend, 'legacy_settings_v1');
    assert.deepEqual(await readFile(legacyPath), before);
  }, {
    vaultFaultInjector(point) {
      if (point === 'before_rename:vault' && ++writes === 3) throw new Error('injected migration failure');
    }
  });
});
