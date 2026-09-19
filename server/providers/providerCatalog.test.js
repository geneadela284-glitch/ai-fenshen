import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY_CATALOG,
  CURRENT_DOMESTIC_PROVIDER_IDS,
  MODEL_CATALOG,
  PROVIDER_CATALOG,
  createInitialRegistryState
} from './providerCatalog.js';
import {
  MODEL_CATALOG_FIELDS,
  validateModelCatalogEntry,
  validateProviderRegistryEntry
} from './providerRegistryContract.js';

test('Catalog contains the five existing domestic Providers and complete model relations', () => {
  assert.deepEqual(
    [...CURRENT_DOMESTIC_PROVIDER_IDS].sort(),
    ['deepseek', 'doubao', 'kimi', 'qwen', 'zhipu']
  );
  const providerIds = new Set(PROVIDER_CATALOG.map((provider) => provider.provider_id));
  const modelProviderIds = new Set(MODEL_CATALOG.map((model) => model.provider_id));

  for (const providerId of CURRENT_DOMESTIC_PROVIDER_IDS) {
    assert.equal(providerIds.has(providerId), true, `${providerId} Provider missing`);
    assert.equal(modelProviderIds.has(providerId), true, `${providerId} model relation missing`);
  }
  assert.equal(new Set(PROVIDER_CATALOG.map((provider) => provider.provider_id)).size, PROVIDER_CATALOG.length);
  assert.equal(new Set(MODEL_CATALOG.map((model) => `${model.provider_id}:${model.model_id}`)).size, MODEL_CATALOG.length);
});

test('Provider and Model Catalog records obey the archived contracts exactly', () => {
  PROVIDER_CATALOG.forEach((provider) => {
    assert.deepEqual(validateProviderRegistryEntry(provider), { valid: true, errors: [] }, provider.provider_id);
  });
  MODEL_CATALOG.forEach((model) => {
    assert.deepEqual(Object.keys(model).sort(), [...MODEL_CATALOG_FIELDS].sort(), `${model.provider_id}:${model.model_id}`);
    assert.deepEqual(validateModelCatalogEntry(model), { valid: true, errors: [] }, `${model.provider_id}:${model.model_id}`);
  });
  assert.equal(CAPABILITY_CATALOG.includes('chat'), true);
  assert.equal(CAPABILITY_CATALOG.includes('structured_output'), true);
});

test('Catalog and initial Registry state are credential-free', () => {
  const serialized = JSON.stringify({ providers: PROVIDER_CATALOG, models: MODEL_CATALOG, state: createInitialRegistryState() });
  assert.doesNotMatch(serialized, /"apiKey"|"authorization"|"password"|"cookie"|"privateKey"/i);
  assert.doesNotMatch(serialized, /"credential_value"|"secret_value"|"token_value"|"encrypted_value"/);
});

test('international Provider reservations are disabled and cannot be runtime candidates', () => {
  const international = PROVIDER_CATALOG.filter((provider) => provider.edition === 'international');
  assert.equal(international.length, 8);
  international.forEach((provider) => {
    assert.equal(provider.enabled, false);
    assert.equal(provider.health_status.state, 'disabled');
  });
  assert.equal(
    createInitialRegistryState().providers.some((provider) => provider.edition === 'international' && provider.enabled),
    false
  );
});

test('Catalog structures are deeply immutable', () => {
  assert.equal(Object.isFrozen(PROVIDER_CATALOG), true);
  assert.equal(Object.isFrozen(PROVIDER_CATALOG[0]), true);
  assert.equal(Object.isFrozen(PROVIDER_CATALOG[0].credential_schema), true);
  assert.equal(Object.isFrozen(MODEL_CATALOG), true);
  assert.equal(Object.isFrozen(MODEL_CATALOG[0].capability_status), true);
});
