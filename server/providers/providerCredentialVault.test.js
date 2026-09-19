import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ProviderCredentialVault,
  createVaultKeyRing
} from './providerCredentialVault.js';

const KEK_A = Buffer.alloc(32, 0x11);
const KEK_B = Buffer.alloc(32, 0x22);
const SECRET = 'test-provider-secret-value';

async function withVault(run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'provider-vault-'));
  const vaultPath = path.join(directory, 'provider-credentials.v1.enc');
  try {
    const vault = new ProviderCredentialVault({
      vaultPath,
      keyRing: createVaultKeyRing({ currentKeyId: 'kek-1', keys: { 'kek-1': KEK_A } }),
      clock: () => new Date('2026-07-27T01:00:00.000Z'),
      ...options
    });
    await run({ directory, vaultPath, vault });
  } finally {
    await chmod(vaultPath, 0o600).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

test('AES-256-GCM Vault persists only ciphertext metadata with mode 0600', async () => {
  await withVault(async ({ vaultPath, vault }) => {
    vault.initialize();
    const staged = vault.stageCredentials({
      providerId: 'deepseek',
      variant: 'bearer_api_key',
      credentials: { api_key: SECRET }
    });
    vault.activateRevision('deepseek', staged.revision);

    const bytes = await readFile(vaultPath, 'utf8');
    assert.doesNotMatch(bytes, new RegExp(SECRET));
    assert.doesNotMatch(bytes, /"kek"|"plaintext"|"apiKey"/i);
    assert.match(bytes, /"key_id"|"nonce"|"salt"|"ciphertext"|"auth_tag"/);
    assert.equal((await stat(vaultPath)).mode & 0o777, 0o600);
    assert.deepEqual(vault.readActiveCredentials('deepseek'), { api_key: SECRET });
  });
});

test('each credential revision uses a random 96-bit nonce and random salt', async () => {
  await withVault(async ({ vault }) => {
    vault.initialize();
    const first = vault.stageCredentials({
      providerId: 'deepseek',
      variant: 'bearer_api_key',
      credentials: { api_key: SECRET }
    });
    const second = vault.stageCredentials({
      providerId: 'deepseek',
      variant: 'bearer_api_key',
      credentials: { api_key: SECRET }
    });
    const state = vault.readState();
    const one = state.providers.deepseek.revisions[String(first.revision)].fields.api_key;
    const two = state.providers.deepseek.revisions[String(second.revision)].fields.api_key;
    assert.equal(Buffer.from(one.nonce, 'base64').length, 12);
    assert.notEqual(one.nonce, two.nonce);
    assert.notEqual(one.salt, two.salt);
    assert.notEqual(one.ciphertext, two.ciphertext);
  });
});

test('tamper, wrong KEK, and cross-Provider ciphertext replacement fail closed', async () => {
  await withVault(async ({ vaultPath, vault }) => {
    vault.initialize();
    const deepseek = vault.stageCredentials({
      providerId: 'deepseek',
      variant: 'bearer_api_key',
      credentials: { api_key: SECRET }
    });
    vault.activateRevision('deepseek', deepseek.revision);
    const qwen = vault.stageCredentials({
      providerId: 'qwen',
      variant: 'bearer_api_key',
      credentials: { api_key: 'qwen-secret-value' }
    });
    vault.activateRevision('qwen', qwen.revision);

    const wrongKeyVault = new ProviderCredentialVault({
      vaultPath,
      keyRing: createVaultKeyRing({ currentKeyId: 'kek-1', keys: { 'kek-1': KEK_B } })
    });
    assert.throws(() => wrongKeyVault.readActiveCredentials('deepseek'), /VAULT_DECRYPT_FAILED|FAIL_CLOSED/);

    const original = JSON.parse(await readFile(vaultPath, 'utf8'));
    const replaced = structuredClone(original);
    replaced.providers.qwen.revisions[String(qwen.revision)].fields.api_key =
      structuredClone(replaced.providers.deepseek.revisions[String(deepseek.revision)].fields.api_key);
    await writeFile(vaultPath, JSON.stringify(replaced), { mode: 0o600 });
    assert.throws(() => vault.readActiveCredentials('qwen'), /VAULT_DECRYPT_FAILED|FAIL_CLOSED/);

    const tampered = structuredClone(original);
    const field = tampered.providers.deepseek.revisions[String(deepseek.revision)].fields.api_key;
    field.ciphertext = `${field.ciphertext.slice(0, -2)}AA`;
    await writeFile(vaultPath, JSON.stringify(tampered), { mode: 0o600 });
    assert.throws(() => vault.readActiveCredentials('deepseek'), /VAULT_DECRYPT_FAILED|FAIL_CLOSED/);
  });
});

test('staged write and atomic write failures never replace the active revision', async () => {
  await withVault(async ({ vaultPath }) => {
    let fail = false;
    const vault = new ProviderCredentialVault({
      vaultPath,
      keyRing: createVaultKeyRing({ currentKeyId: 'kek-1', keys: { 'kek-1': KEK_A } }),
      faultInjector(point) {
        if (fail && point === 'before_rename:vault') throw new Error('injected vault failure');
      }
    });
    vault.initialize();
    const active = vault.stageCredentials({
      providerId: 'deepseek',
      variant: 'bearer_api_key',
      credentials: { api_key: SECRET }
    });
    vault.activateRevision('deepseek', active.revision);
    const before = await readFile(vaultPath);

    fail = true;
    assert.throws(() => vault.stageCredentials({
      providerId: 'deepseek',
      variant: 'bearer_api_key',
      credentials: { api_key: 'replacement-secret' }
    }), /injected vault failure/);
    assert.deepEqual(await readFile(vaultPath), before);
    assert.deepEqual(vault.readActiveCredentials('deepseek'), { api_key: SECRET });
  });
});

test('credentials cannot be returned through public descriptors', async () => {
  await withVault(async ({ vault }) => {
    vault.initialize();
    const staged = vault.stageCredentials({
      providerId: 'deepseek',
      variant: 'bearer_api_key',
      credentials: { api_key: SECRET }
    });
    vault.activateRevision('deepseek', staged.revision);
    const descriptor = vault.getProviderDescriptor('deepseek');
    assert.deepEqual(descriptor, {
      provider_id: 'deepseek',
      configured: true,
      active_credential_revision: 1,
      variant: 'bearer_api_key',
      fields: [{ id: 'api_key', configured: true }]
    });
    assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(SECRET));
  });
});
