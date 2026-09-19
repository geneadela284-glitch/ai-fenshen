import { createHash } from 'node:crypto';
import {
  decryptApiKey,
  isEncryptedApiKey
} from '../../core/settings/apiKeySecurity.js';
import { CURRENT_DOMESTIC_PROVIDER_IDS } from './providerCatalog.js';

const VOLATILE_OR_SECRET = /api.?key|authorization|cookie|password|secret|token|healthy|health|lastError|lastSuccess|lastFailure|lastTested|lastChecked|latency|responseTime/i;

function migrationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_OR_SECRET.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)])
  );
}

function configDigest(providerId, config) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ provider_id: providerId, config: canonicalValue(config) }))
    .digest('hex')}`;
}

function legacyConfig(settings, providerId) {
  if (settings.providers?.[providerId]) return settings.providers[providerId];
  if (settings.provider === providerId) return settings;
  return null;
}

function legacyCredential(config) {
  const stored = config?.apiKey;
  if (!isEncryptedApiKey(stored)) throw migrationError('LEGACY_CREDENTIAL_FORMAT_INVALID');
  const value = decryptApiKey(stored);
  if (!value) throw migrationError('LEGACY_CREDENTIAL_MISSING');
  return value;
}

function credentialsEqual(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function migrateLegacyProviderCredentials({
  legacySettings,
  registryStore,
  vault,
  audit,
  expectedProviderIds = CURRENT_DOMESTIC_PROVIDER_IDS
} = {}) {
  if (!legacySettings || !registryStore || !vault || !audit) throw migrationError('LEGACY_MIGRATION_DEPENDENCY_MISSING');
  const providerIds = [...expectedProviderIds];
  const legacy = providerIds.map((providerId) => {
    const config = legacyConfig(legacySettings, providerId);
    if (!config?.apiKey) throw migrationError('LEGACY_CREDENTIAL_MISSING');
    return {
      providerId,
      config,
      credentials: { api_key: legacyCredential(config) },
      configDigest: configDigest(providerId, config)
    };
  });

  let migrated = 0;
  let reused = 0;
  for (const item of legacy) {
    const descriptor = vault.getProviderDescriptor(item.providerId);
    if (descriptor.configured) {
      const active = vault.readActiveCredentials(item.providerId);
      if (credentialsEqual(active, item.credentials)) {
        reused += 1;
        continue;
      }
    }
    const staged = vault.stageCredentials({
      providerId: item.providerId,
      variant: 'bearer_api_key',
      credentials: item.credentials
    });
    const selfCheck = vault.readCredentials(item.providerId, staged.revision);
    if (!credentialsEqual(selfCheck, item.credentials)) throw migrationError('VAULT_SELF_CHECK_FAILED');
    vault.activateRevision(item.providerId, staged.revision);
    migrated += 1;
  }

  for (const item of legacy) {
    const descriptor = vault.getProviderDescriptor(item.providerId);
    if (!descriptor.configured || !credentialsEqual(vault.readActiveCredentials(item.providerId), item.credentials)) {
      throw migrationError('VAULT_SELF_CHECK_FAILED');
    }
  }

  const registry = registryStore.readRegistry();
  if (registry.credential_backend !== 'vault_v1') {
    registryStore.updateRegistry((state) => ({
      ...state,
      credential_backend: 'vault_v1',
      providers: state.providers.map((provider) => {
        const item = legacy.find((candidate) => candidate.providerId === provider.provider_id);
        if (!item) return provider;
        const enabled = item.config.enabled === true;
        return {
          ...provider,
          enabled,
          endpoint_config: {
            ...provider.endpoint_config,
            base_url: String(item.config.baseUrl || provider.endpoint_config.base_url)
          },
          health_status: {
            state: enabled ? 'unchecked' : 'disabled',
            reason_code: null,
            last_checked_at: null,
            latency_ms: null
          }
        };
      })
    }));
  }

  for (const item of legacy) {
    const descriptor = vault.getProviderDescriptor(item.providerId);
    audit.record({
      event: 'credential_migration',
      provider_id: item.providerId,
      purpose: 'migration',
      credential_revision: descriptor.active_credential_revision,
      result: migrated > 0 ? 'migrated' : 'reused',
      reason_code: null,
      configured: descriptor.configured,
      config_digest: item.configDigest
    });
  }

  for (const item of legacy) {
    Object.keys(item.credentials).forEach((fieldId) => { item.credentials[fieldId] = ''; });
  }

  return {
    status: migrated > 0 ? 'migrated' : 'already_migrated',
    migrated_provider_count: migrated,
    reused_provider_count: reused,
    credential_backend: 'vault_v1'
  };
}
