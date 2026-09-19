import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import {
  createInitialModelCatalogState,
  createInitialRegistryState,
  MODEL_CATALOG,
  MODEL_CATALOG_VERSION
} from './providerCatalog.js';
import {
  validateModelCatalogEntry,
  validateProviderRegistryEntry
} from './providerRegistryContract.js';

const CREDENTIAL_BACKENDS = new Set(['legacy_settings_v1', 'vault_v1']);
const SENSITIVE_PROPERTY = /^(?:apiKey|authorization|password|cookie|privateKey|credential_value|secret_value|token_value|encrypted_value)$/i;

function failClosed(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function containsSensitiveProperty(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSensitiveProperty);
  return Object.entries(value).some(([key, nested]) => SENSITIVE_PROPERTY.test(key) || containsSensitiveProperty(nested));
}

function validateRegistryState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (state.schema_version !== 1 || !CREDENTIAL_BACKENDS.has(state.credential_backend) || !Array.isArray(state.providers)) return false;
  if (containsSensitiveProperty(state)) return false;
  const ids = new Set();
  for (const provider of state.providers) {
    const validation = validateProviderRegistryEntry(provider);
    if (!validation.valid || ids.has(provider.provider_id)) return false;
    ids.add(provider.provider_id);
  }
  return true;
}

function validateModelCatalogState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (state.schema_version !== 1 || typeof state.catalog_version !== 'string' || !Array.isArray(state.models)) return false;
  if (containsSensitiveProperty(state)) return false;
  const ids = new Set();
  for (const model of state.models) {
    const validation = validateModelCatalogEntry(model);
    const id = `${model.provider_id}:${model.model_id}`;
    if (!validation.valid || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function readJson(filePath, kind) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    failClosed(`${kind.toUpperCase()}_READ_FAILED`, 'FAIL_CLOSED');
  }
}

function atomicWriteJson(filePath, value, kind, faultInjector) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    faultInjector(`before_rename:${kind}`);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

export class ProviderRegistryStore {
  constructor({
    registryPath,
    modelCatalogPath,
    clock = () => new Date(),
    faultInjector = () => {}
  } = {}) {
    if (!path.isAbsolute(String(registryPath || '')) || !path.isAbsolute(String(modelCatalogPath || ''))) {
      failClosed('REGISTRY_PATH_INVALID', 'normalized absolute paths are required');
    }
    this.registryPath = registryPath;
    this.modelCatalogPath = modelCatalogPath;
    this.clock = clock;
    this.faultInjector = faultInjector;
  }

  initialize() {
    const timestamp = this.clock().toISOString();
    if (!existsSync(this.registryPath)) {
      atomicWriteJson(this.registryPath, createInitialRegistryState({ now: timestamp }), 'registry', this.faultInjector);
    }
    if (!existsSync(this.modelCatalogPath)) {
      atomicWriteJson(this.modelCatalogPath, createInitialModelCatalogState({ now: timestamp }), 'model_catalog', this.faultInjector);
    } else {
      const current = this.readModelCatalog();
      const existing = new Set(current.models.map((model) => `${model.provider_id}:${model.model_id}`));
      const additions = MODEL_CATALOG.filter(
        (model) => !existing.has(`${model.provider_id}:${model.model_id}`)
      );
      if (additions.length) {
        atomicWriteJson(this.modelCatalogPath, {
          ...current,
          catalog_version: MODEL_CATALOG_VERSION,
          models: [...current.models, ...structuredClone(additions)],
          updated_at: timestamp
        }, 'model_catalog', this.faultInjector);
      }
    }
    return {
      registry: this.readRegistry(),
      modelCatalog: this.readModelCatalog()
    };
  }

  readRegistry() {
    const state = readJson(this.registryPath, 'registry');
    if (!validateRegistryState(state)) failClosed('REGISTRY_STATE_INVALID', 'FAIL_CLOSED');
    return structuredClone(state);
  }

  readModelCatalog() {
    const state = readJson(this.modelCatalogPath, 'model_catalog');
    if (!validateModelCatalogState(state)) failClosed('MODEL_CATALOG_STATE_INVALID', 'FAIL_CLOSED');
    return structuredClone(state);
  }

  writeRegistry(state) {
    if (!validateRegistryState(state)) failClosed('REGISTRY_STATE_INVALID', 'FAIL_CLOSED');
    atomicWriteJson(this.registryPath, state, 'registry', this.faultInjector);
    return this.readRegistry();
  }

  writeModelCatalog(state) {
    if (!validateModelCatalogState(state)) failClosed('MODEL_CATALOG_STATE_INVALID', 'FAIL_CLOSED');
    atomicWriteJson(this.modelCatalogPath, state, 'model_catalog', this.faultInjector);
    return this.readModelCatalog();
  }

  updateRegistry(updater) {
    const current = this.readRegistry();
    const next = updater(structuredClone(current));
    return this.writeRegistry({
      ...next,
      updated_at: this.clock().toISOString()
    });
  }

  updateModelCatalog(updater) {
    const current = this.readModelCatalog();
    const next = updater(structuredClone(current));
    return this.writeModelCatalog({
      ...next,
      updated_at: this.clock().toISOString()
    });
  }
}

export { validateModelCatalogState, validateRegistryState };
