import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY_STATUS_VALUES,
  MODEL_CATALOG_FIELDS,
  PROVIDER_REGISTRY_FIELDS,
  validateModelCatalogEntry,
  validateProviderRegistryEntry
} from './providerRegistryContract.js';

const provider = {
  schema_version: 1,
  provider_id: 'deepseek',
  display_name: 'DeepSeek',
  region: 'cn-mainland',
  enabled: true,
  edition: 'domestic',
  capabilities: ['chat', 'reasoning', 'structured_output'],
  credential_schema: {
    schema_id: 'deepseek.credentials.v1',
    variants: [{
      id: 'bearer_api_key',
      fields: [{ id: 'api_key', kind: 'secret', required: true, write_only: true }]
    }]
  },
  endpoint_config: {
    profile: 'pay_as_you_go',
    base_url: 'https://api.deepseek.com',
    region: 'cn-mainland',
    allow_custom_base_url: false
  },
  model_catalog: {
    source: 'official_catalog',
    catalog_version: 'sha256:test',
    model_count: 1,
    last_synced_at: null
  },
  health_status: {
    state: 'unchecked',
    reason_code: null,
    last_checked_at: null,
    latency_ms: null
  },
  timeout_policy: { connect_ms: 5000, request_ms: 30000 },
  retry_policy: {
    max_attempts: 1,
    retry_on: ['network_error', 'timeout', 'http_502', 'http_503', 'http_504'],
    never_retry: ['auth_failed', 'quota_exhausted', 'invalid_request']
  },
  concurrency_limit: 1,
  spending_limit: { currency: 'CNY', daily_minor: null, monthly_minor: null },
  priority: 100,
  metadata: {
    protocol: 'openai_compatible',
    catalog_source_url: null,
    verified_at: null
  }
};

const model = {
  provider_id: 'deepseek',
  model_id: 'deepseek-v4-flash',
  display_name: 'DeepSeek V4 Flash',
  capabilities: ['chat', 'reasoning', 'structured_output'],
  capability_status: {
    chat: 'declared',
    reasoning: 'declared',
    structured_output: 'declared'
  },
  endpoint_profile: 'pay_as_you_go',
  context_window: null,
  max_output_tokens: null,
  pricing: {
    version: null,
    currency: 'CNY',
    input_per_million: null,
    output_per_million: null
  },
  availability: 'unknown',
  source: 'official_catalog',
  synced_at: null
};

test('Provider contract accepts only the archived M12-A1 field set', () => {
  assert.deepEqual(Object.keys(provider).sort(), [...PROVIDER_REGISTRY_FIELDS].sort());
  assert.deepEqual(validateProviderRegistryEntry(provider), { valid: true, errors: [] });

  const extra = { ...provider, apiKey: 'must-not-be-accepted' };
  const validation = validateProviderRegistryEntry(extra);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === 'UNKNOWN_FIELD' && error.path === 'apiKey'));
});

test('Model Catalog accepts only archived fields and capability status enums', () => {
  assert.deepEqual(Object.keys(model).sort(), [...MODEL_CATALOG_FIELDS].sort());
  assert.deepEqual([...CAPABILITY_STATUS_VALUES].sort(), ['declared', 'unknown', 'unsupported', 'verified']);
  assert.deepEqual(validateModelCatalogEntry(model), { valid: true, errors: [] });

  const extra = { ...model, thinking_supported: true };
  const extraValidation = validateModelCatalogEntry(extra);
  assert.equal(extraValidation.valid, false);
  assert.ok(extraValidation.errors.some((error) => error.path === 'thinking_supported' && error.code === 'UNKNOWN_FIELD'));

  const invalidStatus = {
    ...model,
    capability_status: { ...model.capability_status, chat: 'assumed' }
  };
  assert.equal(validateModelCatalogEntry(invalidStatus).valid, false);
});

test('Credential Schema never stores values and secret fields are write-only', () => {
  const validation = validateProviderRegistryEntry({
    ...provider,
    credential_schema: {
      ...provider.credential_schema,
      variants: [{
        id: 'bearer_api_key',
        fields: [{
          id: 'api_key',
          kind: 'secret',
          required: true,
          write_only: false,
          value: 'must-not-be-accepted'
        }]
      }]
    }
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => /credential_schema/.test(error.path)));
});
