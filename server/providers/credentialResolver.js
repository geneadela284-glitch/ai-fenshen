import { requiredCredentialFields } from './credentialSchemas.js';
import { sanitizeProviderError } from './providerSecurity.js';

const PURPOSES = new Set(['invoke', 'model_sync', 'health_check']);

function credentialError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function containsCredential(value, secrets) {
  if (typeof value === 'string') return secrets.some((secret) => secret && value.includes(secret));
  if (Array.isArray(value)) return value.some((item) => containsCredential(item, secrets));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((item) => containsCredential(item, secrets));
}

export class CredentialResolver {
  constructor({ registryStore, vault, audit } = {}) {
    if (!registryStore || !vault || !audit) throw credentialError('CREDENTIAL_RESOLVER_DEPENDENCY_MISSING');
    this.registryStore = registryStore;
    this.vault = vault;
    this.audit = audit;
  }

  record({ providerId, purpose, revision = null, result, reasonCode = null }) {
    return this.audit.record({
      event: 'credential_access',
      provider_id: providerId,
      purpose,
      credential_revision: revision,
      result,
      reason_code: reasonCode
    });
  }

  deny(providerId, purpose, code, revision = null) {
    this.record({ providerId, purpose, revision, result: 'denied', reasonCode: code });
    throw credentialError(code);
  }

  describeProvider({ providerId = '', purpose = '' } = {}) {
    const normalizedProviderId = String(providerId || '').trim();
    const normalizedPurpose = String(purpose || '').trim();
    const blocked = (reasonCode, credentialRevision = null) => Object.freeze({
      providerId: normalizedProviderId,
      purpose: normalizedPurpose,
      available: false,
      status: 'blocked',
      reasonCode,
      credentialRevision
    });
    if (!PURPOSES.has(normalizedPurpose)) return blocked('CREDENTIAL_PURPOSE_INVALID');

    let registry;
    try {
      registry = this.registryStore.readRegistry();
    } catch (error) {
      return blocked(error?.code || 'PROVIDER_REGISTRY_UNAVAILABLE');
    }
    const provider = registry.providers.find((item) => item.provider_id === normalizedProviderId);
    if (!provider) return blocked('PROVIDER_NOT_REGISTERED');
    if (provider.edition === 'international') return blocked('PROVIDER_EDITION_DISABLED');
    if (provider.enabled !== true) return blocked('PROVIDER_DISABLED');
    if (registry.credential_backend !== 'vault_v1') return blocked('CREDENTIAL_BACKEND_INACTIVE');

    let descriptor;
    try {
      descriptor = this.vault.getProviderDescriptor(normalizedProviderId);
    } catch (error) {
      return blocked(error?.code || 'CREDENTIAL_DESCRIPTOR_UNAVAILABLE');
    }
    const revision = descriptor?.active_credential_revision;
    if (!descriptor?.configured || !Number.isInteger(revision)) return blocked('CREDENTIAL_MISSING', revision);
    const required = requiredCredentialFields(provider.credential_schema, descriptor.variant);
    const configuredFields = new Set(
      (Array.isArray(descriptor.fields) ? descriptor.fields : [])
        .filter((field) => field?.configured !== false)
        .map((field) => String(field?.id || '').trim())
        .filter(Boolean)
    );
    if (required.some((fieldId) => !configuredFields.has(fieldId))) {
      return blocked('CREDENTIAL_INCOMPLETE', revision);
    }
    return Object.freeze({
      providerId: normalizedProviderId,
      purpose: normalizedPurpose,
      available: true,
      status: 'ready',
      reasonCode: null,
      credentialRevision: revision
    });
  }

  async withCredentials({ providerId = '', purpose = '' } = {}, callback) {
    if (!PURPOSES.has(purpose)) this.deny(providerId, purpose, 'CREDENTIAL_PURPOSE_INVALID');
    if (typeof callback !== 'function') this.deny(providerId, purpose, 'CREDENTIAL_CALLBACK_INVALID');

    const registry = this.registryStore.readRegistry();
    const provider = registry.providers.find((item) => item.provider_id === providerId);
    if (!provider) this.deny(providerId, purpose, 'PROVIDER_NOT_REGISTERED');
    if (provider.edition === 'international') this.deny(providerId, purpose, 'PROVIDER_EDITION_DISABLED');
    if (provider.enabled !== true) this.deny(providerId, purpose, 'PROVIDER_DISABLED');
    if (registry.credential_backend !== 'vault_v1') this.deny(providerId, purpose, 'CREDENTIAL_BACKEND_INACTIVE');

    const descriptor = this.vault.getProviderDescriptor(providerId);
    const revision = descriptor.active_credential_revision;
    if (!descriptor.configured || !Number.isInteger(revision)) {
      this.deny(providerId, purpose, 'CREDENTIAL_MISSING', revision);
    }
    const credentials = this.vault.readActiveCredentials(providerId);
    const required = requiredCredentialFields(provider.credential_schema, descriptor.variant);
    if (required.some((fieldId) => typeof credentials[fieldId] !== 'string' || !credentials[fieldId])) {
      Object.keys(credentials).forEach((fieldId) => { credentials[fieldId] = ''; });
      this.deny(providerId, purpose, 'CREDENTIAL_INCOMPLETE', revision);
    }

    const secrets = Object.values(credentials).map(String).filter(Boolean);
    try {
      const result = await callback(credentials);
      if (containsCredential(result, secrets)) {
        this.record({
          providerId,
          purpose,
          revision,
          result: 'denied',
          reasonCode: 'CREDENTIAL_ESCAPE_BLOCKED'
        });
        throw credentialError('CREDENTIAL_ESCAPE_BLOCKED');
      }
      this.record({ providerId, purpose, revision, result: 'granted' });
      return result;
    } catch (error) {
      if (error?.code === 'CREDENTIAL_ESCAPE_BLOCKED') throw error;
      const safe = sanitizeProviderError(error, secrets);
      this.record({
        providerId,
        purpose,
        revision,
        result: 'failed',
        reasonCode: safe.code || 'PROVIDER_CALLBACK_FAILED'
      });
      throw safe;
    } finally {
      Object.keys(credentials).forEach((fieldId) => { credentials[fieldId] = ''; });
    }
  }
}
