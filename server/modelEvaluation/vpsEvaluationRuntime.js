import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ProviderManager } from '../../core/providers/providerManager.js';
import { CredentialResolver } from '../providers/credentialResolver.js';
import {
  loadVaultKekCredential,
  ProviderCredentialVault
} from '../providers/providerCredentialVault.js';
import { ProviderRegistryStore } from '../providers/providerRegistryStore.js';
import { ProviderSecurityAudit } from '../providers/providerSecurity.js';
import { FORMAL_PROVIDER_IDS } from './evaluationContract.js';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function settingsPayload(value) {
  return value?.['ai-settings'] || value;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function privateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function sanitizedProviderConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    baseUrl: String(config.baseUrl || ''),
    defaultModel: String(config.defaultModel || config.model || ''),
    temperature: Number(config.temperature ?? 0),
    maxTokens: Number(config.maxTokens ?? 768),
    timeout: Number(config.timeout ?? 30000),
    apiKeyConfigured: Boolean(config.apiKey)
  };
}

export async function createVpsEvaluationRuntime(config = {}) {
  const requiredPaths = [
    'settings_path', 'registry_path', 'model_catalog_path', 'vault_path',
    'kek_credential_path', 'runtime_directory'
  ];
  for (const field of requiredPaths) {
    if (!path.isAbsolute(String(config[field] || ''))) fail(`EVALUATION_${field.toUpperCase()}_INVALID`);
  }
  const settingsBytes = JSON.parse(await readFile(config.settings_path, 'utf8'));
  const settings = settingsPayload(settingsBytes);
  const sourceRegistry = JSON.parse(await readFile(config.registry_path, 'utf8'));
  const sourceCatalog = JSON.parse(await readFile(config.model_catalog_path, 'utf8'));
  const runtimeDirectory = config.runtime_directory;
  const registryPath = path.join(runtimeDirectory, 'registry.v1.json');
  const catalogPath = path.join(runtimeDirectory, 'model-catalog.v1.json');
  const auditPath = path.join(runtimeDirectory, 'provider-security-audit.ndjson');

  const registry = {
    ...sourceRegistry,
    providers: sourceRegistry.providers.map((provider) => ({
      ...provider,
      enabled: FORMAL_PROVIDER_IDS.includes(provider.provider_id)
    }))
  };
  await privateJson(registryPath, registry);
  await privateJson(catalogPath, sourceCatalog);

  const registryStore = new ProviderRegistryStore({
    registryPath,
    modelCatalogPath: catalogPath
  });
  registryStore.readRegistry();
  registryStore.readModelCatalog();
  const vault = new ProviderCredentialVault({
    vaultPath: config.vault_path,
    keyRing: loadVaultKekCredential(config.kek_credential_path)
  });
  vault.initialize();
  const audit = new ProviderSecurityAudit({ auditLogPath: auditPath });
  const resolver = new CredentialResolver({ registryStore, vault, audit });
  const providerConfigs = {};
  const providerTargets = FORMAL_PROVIDER_IDS.map((providerId) => {
    const current = settings.providers?.[providerId];
    if (!current?.apiKey) fail(`EVALUATION_${providerId.toUpperCase()}_CREDENTIAL_NOT_CONFIGURED`);
    const safe = sanitizedProviderConfig(current);
    if (!safe.baseUrl || !safe.defaultModel) fail(`EVALUATION_${providerId.toUpperCase()}_CONFIG_INVALID`);
    providerConfigs[providerId] = {
      baseUrl: safe.baseUrl,
      defaultModel: safe.defaultModel,
      temperature: safe.temperature,
      maxTokens: safe.maxTokens,
      timeout: safe.timeout
    };
    const descriptor = vault.getProviderDescriptor(providerId);
    if (!descriptor.configured) fail(`EVALUATION_${providerId.toUpperCase()}_VAULT_NOT_CONFIGURED`);
    return {
      provider_id: providerId,
      model_id: safe.defaultModel,
      config: safe,
      vault_descriptor: descriptor
    };
  });
  const providers = new ProviderManager({
    credentialMode: 'vault_v1',
    credentialResolver: resolver,
    config: { providerConfigs }
  });
  const catalogPricing = Object.fromEntries(sourceCatalog.models
    .filter(({ provider_id: providerId, model_id: modelId }) =>
      providerTargets.some((target) =>
        target.provider_id === providerId && target.model_id === modelId))
    .map((model) => [
      `${model.provider_id}:${model.model_id}`,
      {
        version: model.pricing?.version ?? null,
        currency: model.pricing?.currency || 'CNY',
        input_per_million: model.pricing?.input_per_million ?? null,
        output_per_million: model.pricing?.output_per_million ?? null
      }
    ]));

  return {
    providerTargets: providerTargets.map(({ provider_id: providerId, model_id: modelId }) => ({
      provider_id: providerId,
      model_id: modelId
    })),
    pricingByModel: catalogPricing,
    metadata: {
      execution_environment: 'vps_temporary_directory',
      canonical_generation: config.canonical_generation ?? null,
      local_head: config.local_head || null,
      public_release: config.public_release || null,
      public_release_head: config.public_release_head || null,
      registry_sha256: await sha256(config.registry_path),
      model_catalog_sha256: await sha256(config.model_catalog_path),
      vault_ciphertext_sha256: await sha256(config.vault_path),
      credential_backend: sourceRegistry.credential_backend,
      production_registry_modified: false,
      production_vault_modified: false,
      provider_targets: providerTargets,
      unavailable_providers: config.unavailable_providers || []
    },
    async invoke({ providerTarget, messages, options }) {
      return providers.chat({
        provider: providerTarget.provider_id,
        messages,
        options: {
          baseUrl: providerConfigs[providerTarget.provider_id].baseUrl,
          model: providerTarget.model_id,
          temperature: options.temperature,
          maxTokens: options.max_tokens,
          timeoutMs: options.timeout_ms
        },
        metadata: {
          source: 'model-evaluation-m12-b1-v1',
          memoryPolicy: 'disabled'
        }
      });
    }
  };
}
