import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialResolver } from './credentialResolver.js';

const SECRET = 'provider-secret-value-123456';

function provider(overrides = {}) {
  return {
    provider_id: 'deepseek',
    edition: 'domestic',
    enabled: true,
    credential_schema: {
      schema_id: 'deepseek.credentials.v1',
      variants: [{
        id: 'bearer_api_key',
        fields: [{ id: 'api_key', kind: 'secret', required: true, write_only: true }]
      }]
    },
    ...overrides
  };
}

function harness({
  providerRecord = provider(),
  backend = 'vault_v1',
  credentials = { api_key: SECRET },
  descriptor = {
    provider_id: 'deepseek',
    configured: true,
    active_credential_revision: 2,
    variant: 'bearer_api_key',
    fields: [{ id: 'api_key', configured: true }]
  }
} = {}) {
  const events = [];
  const resolver = new CredentialResolver({
    registryStore: {
      readRegistry() {
        return { schema_version: 1, credential_backend: backend, providers: [providerRecord] };
      }
    },
    vault: {
      getProviderDescriptor() { return descriptor; },
      readActiveCredentials() { return structuredClone(credentials); }
    },
    audit: { record(event) { events.push(event); } }
  });
  return { resolver, events };
}

test('Resolver exposes complete credentials only inside an enabled domestic Provider callback', async () => {
  const { resolver, events } = harness();
  let captured;
  const result = await resolver.withCredentials({
    providerId: 'deepseek',
    purpose: 'invoke'
  }, async (credentials) => {
    captured = { ...credentials };
    return 'provider-result';
  });
  assert.equal(result, 'provider-result');
  assert.deepEqual(captured, { api_key: SECRET });
  assert.equal(events.at(-1).result, 'granted');
  assert.equal(events.at(-1).credential_revision, 2);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(SECRET));
});

test('disabled, missing, international, and inactive backend credentials fail clearly', async () => {
  const cases = [
    [harness({ providerRecord: provider({ enabled: false }) }).resolver, 'PROVIDER_DISABLED'],
    [harness({ descriptor: { provider_id: 'deepseek', configured: false, active_credential_revision: null, variant: null, fields: [] } }).resolver, 'CREDENTIAL_MISSING'],
    [harness({ providerRecord: provider({ edition: 'international' }) }).resolver, 'PROVIDER_EDITION_DISABLED'],
    [harness({ backend: 'legacy_settings_v1' }).resolver, 'CREDENTIAL_BACKEND_INACTIVE'],
    [harness({ credentials: {} }).resolver, 'CREDENTIAL_INCOMPLETE']
  ];
  for (const [resolver, code] of cases) {
    await assert.rejects(
      resolver.withCredentials({ providerId: 'deepseek', purpose: 'invoke' }, async () => 'must-not-run'),
      (error) => error.code === code && !String(error.message).includes(SECRET)
    );
  }
});

test('unknown Provider and purpose fail before Vault access', async () => {
  const { resolver } = harness();
  await assert.rejects(
    resolver.withCredentials({ providerId: 'unknown', purpose: 'invoke' }, async () => {}),
    (error) => error.code === 'PROVIDER_NOT_REGISTERED'
  );
  await assert.rejects(
    resolver.withCredentials({ providerId: 'deepseek', purpose: 'delete_everything' }, async () => {}),
    (error) => error.code === 'CREDENTIAL_PURPOSE_INVALID'
  );
});

test('Resolver blocks credential escape through callback results', async () => {
  const { resolver } = harness();
  await assert.rejects(
    resolver.withCredentials({ providerId: 'deepseek', purpose: 'invoke' }, async (credentials) => credentials),
    (error) => error.code === 'CREDENTIAL_ESCAPE_BLOCKED'
  );
  await assert.rejects(
    resolver.withCredentials({ providerId: 'deepseek', purpose: 'invoke' }, async (credentials) => ({ copied: credentials.api_key })),
    (error) => error.code === 'CREDENTIAL_ESCAPE_BLOCKED'
  );
});

test('Provider callback errors preserve code/status but never reflect credentials', async () => {
  const { resolver, events } = harness();
  await assert.rejects(
    resolver.withCredentials({ providerId: 'deepseek', purpose: 'invoke' }, async () => {
      throw Object.assign(new Error(`HTTP 401 ${SECRET}`), { code: 'AUTH_FAILED', status: 401 });
    }),
    (error) => error.code === 'AUTH_FAILED'
      && error.status === 401
      && !error.message.includes(SECRET)
  );
  assert.equal(events.at(-1).result, 'failed');
  assert.equal(events.at(-1).reason_code, 'AUTH_FAILED');
  assert.doesNotMatch(JSON.stringify(events), new RegExp(SECRET));
});
