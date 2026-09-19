import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInitialModelCatalogState, createInitialRegistryState } from './providerCatalog.js';
import { ProviderRegistryStore } from './providerRegistryStore.js';

async function withStore(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'provider-registry-store-'));
  const registryPath = path.join(directory, 'registry.v1.json');
  const modelCatalogPath = path.join(directory, 'model-catalog.v1.json');
  try {
    const store = new ProviderRegistryStore({
      registryPath,
      modelCatalogPath,
      clock: () => new Date('2026-07-27T00:00:00.000Z')
    });
    await run({ directory, registryPath, modelCatalogPath, store });
  } finally {
    await chmod(registryPath, 0o600).catch(() => {});
    await chmod(modelCatalogPath, 0o600).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

test('initializes separate secret-free Registry and Model Catalog files atomically with mode 0600', async () => {
  await withStore(async ({ registryPath, modelCatalogPath, store }) => {
    const initialized = store.initialize();
    assert.equal(initialized.registry.credential_backend, 'legacy_settings_v1');
    assert.ok(initialized.registry.providers.length >= 5);
    assert.ok(initialized.modelCatalog.models.length >= 5);

    assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
    assert.equal((await stat(modelCatalogPath)).mode & 0o777, 0o600);
    const bytes = `${await readFile(registryPath, 'utf8')}\n${await readFile(modelCatalogPath, 'utf8')}`;
    assert.doesNotMatch(bytes, /"apiKey"|"authorization"|"password"|"cookie"|"privateKey"/i);
    assert.doesNotMatch(bytes, /credential_value|secret_value|token_value|encrypted_value/);
  });
});

test('atomically updates Registry backend only with a valid schema', async () => {
  await withStore(async ({ registryPath, store }) => {
    store.initialize();
    const before = await readFile(registryPath, 'utf8');
    const updated = store.updateRegistry((state) => ({ ...state, credential_backend: 'vault_v1' }));
    assert.equal(updated.credential_backend, 'vault_v1');
    assert.equal(store.readRegistry().credential_backend, 'vault_v1');
    assert.notEqual(await readFile(registryPath, 'utf8'), before);

    assert.throws(
      () => store.updateRegistry((state) => ({ ...state, credential_backend: 'unknown_backend' })),
      /REGISTRY_STATE_INVALID|FAIL_CLOSED/
    );
    assert.equal(store.readRegistry().credential_backend, 'vault_v1');
  });
});

test('reconciles the verified Qwen OCR contract into an existing older catalog without replacing other entries', async () => {
  await withStore(async ({ modelCatalogPath, store }) => {
    store.initialize();
    const current = store.readModelCatalog();
    const legacy = {
      ...current,
      catalog_version: 'legacy-before-qwen-ocr',
      models: current.models.filter((model) => model.model_id !== 'qwen3.5-ocr')
    };
    legacy.models.push({
      ...legacy.models[0],
      provider_id: 'deepseek',
      model_id: 'custom-preserved-model',
      display_name: 'Custom Preserved Model'
    });
    await writeFile(modelCatalogPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    const reconciled = store.initialize().modelCatalog;
    const ocr = reconciled.models.find((model) => model.model_id === 'qwen3.5-ocr');
    assert.ok(ocr);
    assert.equal(ocr.capability_status.ocr, 'verified');
    assert.equal(ocr.availability, 'available');
    assert.equal(
      reconciled.models.some((model) => model.model_id === 'custom-preserved-model'),
      true
    );
    assert.equal((await stat(modelCatalogPath)).mode & 0o777, 0o600);
  });
});

test('corrupt or schema-invalid existing state fails closed instead of fabricating defaults', async () => {
  await withStore(async ({ registryPath, modelCatalogPath, store }) => {
    await writeFile(registryPath, '{corrupt', { mode: 0o600 });
    await writeFile(modelCatalogPath, JSON.stringify(createInitialModelCatalogState()), { mode: 0o600 });
    assert.throws(() => store.initialize(), /REGISTRY_READ_FAILED|FAIL_CLOSED/);

    await writeFile(registryPath, JSON.stringify({ ...createInitialRegistryState(), schema_version: 2 }), { mode: 0o600 });
    assert.throws(() => store.initialize(), /REGISTRY_STATE_INVALID|FAIL_CLOSED/);
  });
});

test('a failed atomic replacement leaves the prior active Registry bytes unchanged', async () => {
  await withStore(async ({ registryPath, modelCatalogPath }) => {
    const store = new ProviderRegistryStore({
      registryPath,
      modelCatalogPath,
      clock: () => new Date('2026-07-27T00:00:00.000Z'),
      faultInjector(point) {
        if (point === 'before_rename:registry') throw new Error('injected failure');
      }
    });
    await writeFile(registryPath, JSON.stringify(createInitialRegistryState()), { mode: 0o600 });
    await writeFile(modelCatalogPath, JSON.stringify(createInitialModelCatalogState()), { mode: 0o600 });
    const before = await readFile(registryPath);
    assert.throws(() => store.updateRegistry((state) => ({ ...state, credential_backend: 'vault_v1' })), /injected failure/);
    assert.deepEqual(await readFile(registryPath), before);
  });
});
