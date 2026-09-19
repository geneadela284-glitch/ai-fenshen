const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EDITIONS = new Set(['domestic', 'international', 'private']);
const HEALTH_STATES = new Set(['unconfigured', 'unchecked', 'healthy', 'degraded', 'unavailable', 'disabled']);
const CATALOG_SOURCES = new Set(['remote_models_api', 'official_catalog', 'curated']);
const MODEL_AVAILABILITY = new Set(['available', 'unavailable', 'unknown']);

export const CAPABILITY_STATUS_VALUES = Object.freeze(['verified', 'declared', 'unsupported', 'unknown']);

export const PROVIDER_REGISTRY_FIELDS = Object.freeze([
  'schema_version',
  'provider_id',
  'display_name',
  'region',
  'enabled',
  'edition',
  'capabilities',
  'credential_schema',
  'endpoint_config',
  'model_catalog',
  'health_status',
  'timeout_policy',
  'retry_policy',
  'concurrency_limit',
  'spending_limit',
  'priority',
  'metadata'
]);

export const MODEL_CATALOG_FIELDS = Object.freeze([
  'provider_id',
  'model_id',
  'display_name',
  'capabilities',
  'capability_status',
  'endpoint_profile',
  'context_window',
  'max_output_tokens',
  'pricing',
  'availability',
  'source',
  'synced_at'
]);

function issue(path, code) {
  return { path, code };
}

function unknownFields(value, allowed, path = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [issue(path || '$', 'INVALID_TYPE')];
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => issue(path ? `${path}.${key}` : key, 'UNKNOWN_FIELD'));
}

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function validateCapabilities(capabilities, path, errors) {
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some((item) => !validIdentifier(item))) {
    errors.push(issue(path, 'INVALID_CAPABILITIES'));
  }
}

function validateCredentialSchema(schema, errors) {
  errors.push(...unknownFields(schema, new Set(['schema_id', 'variants']), 'credential_schema'));
  if (!validIdentifier(schema?.schema_id)) errors.push(issue('credential_schema.schema_id', 'INVALID_IDENTIFIER'));
  if (!Array.isArray(schema?.variants) || schema.variants.length === 0) {
    errors.push(issue('credential_schema.variants', 'INVALID_VARIANTS'));
    return;
  }
  schema.variants.forEach((variant, variantIndex) => {
    const variantPath = `credential_schema.variants.${variantIndex}`;
    errors.push(...unknownFields(variant, new Set(['id', 'fields']), variantPath));
    if (!validIdentifier(variant?.id)) errors.push(issue(`${variantPath}.id`, 'INVALID_IDENTIFIER'));
    if (!Array.isArray(variant?.fields) || variant.fields.length === 0) {
      errors.push(issue(`${variantPath}.fields`, 'INVALID_FIELDS'));
      return;
    }
    variant.fields.forEach((field, fieldIndex) => {
      const fieldPath = `${variantPath}.fields.${fieldIndex}`;
      errors.push(...unknownFields(field, new Set(['id', 'kind', 'required', 'write_only']), fieldPath));
      if (!validIdentifier(field?.id)) errors.push(issue(`${fieldPath}.id`, 'INVALID_IDENTIFIER'));
      if (!['secret', 'identifier', 'enum'].includes(field?.kind)) errors.push(issue(`${fieldPath}.kind`, 'INVALID_KIND'));
      if (typeof field?.required !== 'boolean' || typeof field?.write_only !== 'boolean') {
        errors.push(issue(fieldPath, 'INVALID_FIELD_FLAGS'));
      }
      if (field?.kind === 'secret' && field?.write_only !== true) {
        errors.push(issue(`${fieldPath}.write_only`, 'SECRET_MUST_BE_WRITE_ONLY'));
      }
    });
  });
}

export function validateProviderRegistryEntry(value = {}) {
  const errors = unknownFields(value, new Set(PROVIDER_REGISTRY_FIELDS));
  if (value.schema_version !== 1) errors.push(issue('schema_version', 'UNSUPPORTED_SCHEMA'));
  if (!validIdentifier(value.provider_id)) errors.push(issue('provider_id', 'INVALID_IDENTIFIER'));
  if (typeof value.display_name !== 'string' || !value.display_name.trim()) errors.push(issue('display_name', 'REQUIRED'));
  if (typeof value.region !== 'string' || !value.region.trim()) errors.push(issue('region', 'REQUIRED'));
  if (typeof value.enabled !== 'boolean') errors.push(issue('enabled', 'INVALID_TYPE'));
  if (!EDITIONS.has(value.edition)) errors.push(issue('edition', 'INVALID_ENUM'));
  validateCapabilities(value.capabilities, 'capabilities', errors);
  validateCredentialSchema(value.credential_schema, errors);

  errors.push(...unknownFields(value.endpoint_config, new Set(['profile', 'base_url', 'region', 'allow_custom_base_url']), 'endpoint_config'));
  if (typeof value.endpoint_config?.profile !== 'string' || !value.endpoint_config.profile) errors.push(issue('endpoint_config.profile', 'REQUIRED'));
  if (typeof value.endpoint_config?.base_url !== 'string') errors.push(issue('endpoint_config.base_url', 'INVALID_TYPE'));
  if (typeof value.endpoint_config?.allow_custom_base_url !== 'boolean') errors.push(issue('endpoint_config.allow_custom_base_url', 'INVALID_TYPE'));

  errors.push(...unknownFields(value.model_catalog, new Set(['source', 'catalog_version', 'model_count', 'last_synced_at']), 'model_catalog'));
  if (!CATALOG_SOURCES.has(value.model_catalog?.source)) errors.push(issue('model_catalog.source', 'INVALID_ENUM'));
  if (!Number.isInteger(value.model_catalog?.model_count) || value.model_catalog.model_count < 0) errors.push(issue('model_catalog.model_count', 'INVALID_NUMBER'));

  errors.push(...unknownFields(value.health_status, new Set(['state', 'reason_code', 'last_checked_at', 'latency_ms']), 'health_status'));
  if (!HEALTH_STATES.has(value.health_status?.state)) errors.push(issue('health_status.state', 'INVALID_ENUM'));

  errors.push(...unknownFields(value.timeout_policy, new Set(['connect_ms', 'request_ms']), 'timeout_policy'));
  if (!Number.isInteger(value.timeout_policy?.connect_ms) || value.timeout_policy.connect_ms <= 0) errors.push(issue('timeout_policy.connect_ms', 'INVALID_NUMBER'));
  if (!Number.isInteger(value.timeout_policy?.request_ms) || value.timeout_policy.request_ms <= 0) errors.push(issue('timeout_policy.request_ms', 'INVALID_NUMBER'));

  errors.push(...unknownFields(value.retry_policy, new Set(['max_attempts', 'retry_on', 'never_retry']), 'retry_policy'));
  if (!Number.isInteger(value.retry_policy?.max_attempts) || value.retry_policy.max_attempts < 1) errors.push(issue('retry_policy.max_attempts', 'INVALID_NUMBER'));
  if (!Array.isArray(value.retry_policy?.retry_on) || !Array.isArray(value.retry_policy?.never_retry)) errors.push(issue('retry_policy', 'INVALID_RETRY_POLICY'));
  if (!Number.isInteger(value.concurrency_limit) || value.concurrency_limit < 1) errors.push(issue('concurrency_limit', 'INVALID_NUMBER'));

  errors.push(...unknownFields(value.spending_limit, new Set(['currency', 'daily_minor', 'monthly_minor']), 'spending_limit'));
  if (typeof value.spending_limit?.currency !== 'string' || !value.spending_limit.currency) errors.push(issue('spending_limit.currency', 'REQUIRED'));
  if (!Number.isFinite(Number(value.priority))) errors.push(issue('priority', 'INVALID_NUMBER'));

  errors.push(...unknownFields(value.metadata, new Set(['protocol', 'catalog_source_url', 'verified_at']), 'metadata'));
  if (typeof value.metadata?.protocol !== 'string' || !value.metadata.protocol) errors.push(issue('metadata.protocol', 'REQUIRED'));
  return { valid: errors.length === 0, errors };
}

export function validateModelCatalogEntry(value = {}) {
  const errors = unknownFields(value, new Set(MODEL_CATALOG_FIELDS));
  if (!validIdentifier(value.provider_id)) errors.push(issue('provider_id', 'INVALID_IDENTIFIER'));
  if (!validIdentifier(value.model_id)) errors.push(issue('model_id', 'INVALID_IDENTIFIER'));
  if (typeof value.display_name !== 'string' || !value.display_name.trim()) errors.push(issue('display_name', 'REQUIRED'));
  validateCapabilities(value.capabilities, 'capabilities', errors);
  if (!value.capability_status || typeof value.capability_status !== 'object' || Array.isArray(value.capability_status)) {
    errors.push(issue('capability_status', 'INVALID_TYPE'));
  } else {
    Object.entries(value.capability_status).forEach(([capability, status]) => {
      if (!value.capabilities?.includes(capability)) errors.push(issue(`capability_status.${capability}`, 'UNKNOWN_CAPABILITY'));
      if (!CAPABILITY_STATUS_VALUES.includes(status)) errors.push(issue(`capability_status.${capability}`, 'INVALID_ENUM'));
    });
  }
  if (typeof value.endpoint_profile !== 'string' || !value.endpoint_profile) errors.push(issue('endpoint_profile', 'REQUIRED'));
  for (const field of ['context_window', 'max_output_tokens']) {
    if (value[field] !== null && (!Number.isInteger(value[field]) || value[field] <= 0)) errors.push(issue(field, 'INVALID_NUMBER'));
  }
  errors.push(...unknownFields(value.pricing, new Set(['version', 'currency', 'input_per_million', 'output_per_million']), 'pricing'));
  if (typeof value.pricing?.currency !== 'string' || !value.pricing.currency) errors.push(issue('pricing.currency', 'REQUIRED'));
  if (!MODEL_AVAILABILITY.has(value.availability)) errors.push(issue('availability', 'INVALID_ENUM'));
  if (!CATALOG_SOURCES.has(value.source)) errors.push(issue('source', 'INVALID_ENUM'));
  return { valid: errors.length === 0, errors };
}

export function assertProviderRegistryEntry(value) {
  const result = validateProviderRegistryEntry(value);
  if (!result.valid) {
    const error = new Error('PROVIDER_REGISTRY_CONTRACT_INVALID');
    error.code = 'PROVIDER_REGISTRY_CONTRACT_INVALID';
    error.issues = result.errors;
    throw error;
  }
  return value;
}

export function assertModelCatalogEntry(value) {
  const result = validateModelCatalogEntry(value);
  if (!result.valid) {
    const error = new Error('MODEL_CATALOG_CONTRACT_INVALID');
    error.code = 'MODEL_CATALOG_CONTRACT_INVALID';
    error.issues = result.errors;
    throw error;
  }
  return value;
}
