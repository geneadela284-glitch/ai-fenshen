import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes
} from 'node:crypto';
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

function failClosed(code) {
  const error = new Error(`${code}: FAIL_CLOSED`);
  error.code = code;
  throw error;
}

function normalizedKek(value) {
  const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
  if (buffer.length !== 32) failClosed('VAULT_KEK_INVALID');
  return buffer;
}

export function createVaultKeyRing({ currentKeyId, keys = {} } = {}) {
  if (!currentKeyId || typeof currentKeyId !== 'string') failClosed('VAULT_KEY_ID_INVALID');
  const normalizedKeys = Object.fromEntries(
    Object.entries(keys).map(([keyId, kek]) => [keyId, normalizedKek(kek)])
  );
  if (!normalizedKeys[currentKeyId]) failClosed('VAULT_CURRENT_KEK_MISSING');
  return { currentKeyId, keys: normalizedKeys };
}

export function loadVaultKekCredential(filePath, { keyId = 'provider-vault-kek-v1' } = {}) {
  if (!path.isAbsolute(String(filePath || ''))) failClosed('VAULT_KEK_CREDENTIAL_PATH_INVALID');
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch {
    failClosed('VAULT_KEK_CREDENTIAL_READ_FAILED');
  }
  return createVaultKeyRing({ currentKeyId: keyId, keys: { [keyId]: bytes } });
}

function initialState(now) {
  return {
    schema_version: 1,
    current_key_id: null,
    providers: {},
    created_at: now,
    updated_at: now
  };
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (state.schema_version !== 1 || !state.providers || typeof state.providers !== 'object' || Array.isArray(state.providers)) return false;
  return Object.entries(state.providers).every(([providerId, provider]) => {
    if (!providerId || !provider || typeof provider !== 'object' || Array.isArray(provider)) return false;
    if (!Number.isInteger(provider.active_revision) && provider.active_revision !== null) return false;
    if (!provider.revisions || typeof provider.revisions !== 'object' || Array.isArray(provider.revisions)) return false;
    return Object.entries(provider.revisions).every(([revisionKey, revision]) => {
      if (String(revision.revision) !== revisionKey || !Number.isInteger(revision.revision) || revision.revision < 1) return false;
      if (typeof revision.variant !== 'string' || !revision.variant || !revision.fields || typeof revision.fields !== 'object') return false;
      return Object.values(revision.fields).every((field) =>
        field
        && typeof field.key_id === 'string'
        && typeof field.nonce === 'string'
        && typeof field.salt === 'string'
        && typeof field.ciphertext === 'string'
        && typeof field.auth_tag === 'string'
      );
    });
  });
}

function atomicWrite(filePath, value, faultInjector) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    faultInjector('before_rename:vault');
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function aad(providerId, fieldId, revision) {
  return Buffer.from(`1:${providerId}:${fieldId}:${revision}`, 'utf8');
}

function deriveKey(kek, salt, providerId, fieldId, revision) {
  return Buffer.from(hkdfSync(
    'sha256',
    kek,
    salt,
    Buffer.from(`provider-credential-vault-v1:${providerId}:${fieldId}:${revision}`, 'utf8'),
    32
  ));
}

function encryptField({ keyId, kek, providerId, fieldId, revision, value }) {
  const nonce = randomBytes(12);
  const salt = randomBytes(32);
  const key = deriveKey(kek, salt, providerId, fieldId, revision);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(providerId, fieldId, revision));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return {
    key_id: keyId,
    nonce: nonce.toString('base64'),
    salt: salt.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64')
  };
}

function decryptField({ keyRing, providerId, fieldId, revision, record }) {
  try {
    const kek = keyRing.keys[record.key_id];
    if (!kek) failClosed('VAULT_KEK_MISSING');
    const nonce = Buffer.from(record.nonce, 'base64');
    const salt = Buffer.from(record.salt, 'base64');
    const key = deriveKey(kek, salt, providerId, fieldId, revision);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad(providerId, fieldId, revision));
    decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (error) {
    if (error?.code === 'VAULT_KEK_MISSING') throw error;
    failClosed('VAULT_DECRYPT_FAILED');
  }
}

export class ProviderCredentialVault {
  constructor({
    vaultPath,
    keyRing,
    clock = () => new Date(),
    faultInjector = () => {}
  } = {}) {
    if (!path.isAbsolute(String(vaultPath || ''))) failClosed('VAULT_PATH_INVALID');
    this.vaultPath = vaultPath;
    this.keyRing = createVaultKeyRing(keyRing);
    this.clock = clock;
    this.faultInjector = faultInjector;
  }

  initialize() {
    if (!existsSync(this.vaultPath)) {
      const now = this.clock().toISOString();
      atomicWrite(this.vaultPath, {
        ...initialState(now),
        current_key_id: this.keyRing.currentKeyId
      }, this.faultInjector);
    }
    return this.readState();
  }

  readState() {
    let state;
    try {
      state = JSON.parse(readFileSync(this.vaultPath, 'utf8'));
    } catch {
      failClosed('VAULT_READ_FAILED');
    }
    if (!validateState(state)) failClosed('VAULT_STATE_INVALID');
    return structuredClone(state);
  }

  writeState(state) {
    if (!validateState(state)) failClosed('VAULT_STATE_INVALID');
    atomicWrite(this.vaultPath, state, this.faultInjector);
    return this.readState();
  }

  stageCredentials({ providerId, variant, credentials } = {}) {
    if (!providerId || !variant || !credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      failClosed('VAULT_CREDENTIAL_INPUT_INVALID');
    }
    const entries = Object.entries(credentials);
    if (entries.length === 0 || entries.some(([fieldId, value]) => !fieldId || typeof value !== 'string' || !value)) {
      failClosed('VAULT_CREDENTIAL_INPUT_INVALID');
    }
    const state = this.readState();
    const provider = state.providers[providerId] || { active_revision: null, revisions: {} };
    const revision = Math.max(0, ...Object.keys(provider.revisions).map(Number).filter(Number.isInteger)) + 1;
    const keyId = this.keyRing.currentKeyId;
    const fields = Object.fromEntries(entries.map(([fieldId, value]) => [
      fieldId,
      encryptField({
        keyId,
        kek: this.keyRing.keys[keyId],
        providerId,
        fieldId,
        revision,
        value
      })
    ]));
    const now = this.clock().toISOString();
    this.writeState({
      ...state,
      current_key_id: keyId,
      providers: {
        ...state.providers,
        [providerId]: {
          ...provider,
          revisions: {
            ...provider.revisions,
            [revision]: {
              revision,
              variant,
              fields,
              created_at: now
            }
          }
        }
      },
      updated_at: now
    });
    return {
      provider_id: providerId,
      revision,
      variant,
      fields: entries.map(([fieldId]) => fieldId)
    };
  }

  activateRevision(providerId, revision) {
    this.readCredentials(providerId, revision);
    const state = this.readState();
    const provider = state.providers[providerId];
    if (!provider?.revisions?.[String(revision)]) failClosed('VAULT_REVISION_MISSING');
    this.writeState({
      ...state,
      providers: {
        ...state.providers,
        [providerId]: {
          ...provider,
          active_revision: revision
        }
      },
      updated_at: this.clock().toISOString()
    });
    return this.getProviderDescriptor(providerId);
  }

  readCredentials(providerId, revision) {
    const state = this.readState();
    const record = state.providers?.[providerId]?.revisions?.[String(revision)];
    if (!record) failClosed('VAULT_REVISION_MISSING');
    return Object.fromEntries(Object.entries(record.fields).map(([fieldId, fieldRecord]) => [
      fieldId,
      decryptField({
        keyRing: this.keyRing,
        providerId,
        fieldId,
        revision,
        record: fieldRecord
      })
    ]));
  }

  readActiveCredentials(providerId) {
    const state = this.readState();
    const revision = state.providers?.[providerId]?.active_revision;
    if (!Number.isInteger(revision)) failClosed('VAULT_ACTIVE_REVISION_MISSING');
    return this.readCredentials(providerId, revision);
  }

  getProviderDescriptor(providerId) {
    const state = this.readState();
    const provider = state.providers?.[providerId];
    const revision = provider?.active_revision;
    const active = Number.isInteger(revision) ? provider.revisions[String(revision)] : null;
    return {
      provider_id: providerId,
      configured: Boolean(active),
      active_credential_revision: active ? revision : null,
      variant: active?.variant || null,
      fields: active
        ? Object.keys(active.fields).map((fieldId) => ({ id: fieldId, configured: true }))
        : []
    };
  }
}
