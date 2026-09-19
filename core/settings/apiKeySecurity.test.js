import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRevealApiKey,
  decryptApiKey,
  encryptApiKey,
  isEncryptedApiKey,
  maskApiKey,
  toSafeProviderConfig
} from './apiKeySecurity.js';

test('masks existing API keys and never returns them in administrator view models', () => {
  assert.equal(maskApiKey('sk-example-secret-abcd'), 'sk-****abcd');
  assert.equal(maskApiKey('plain-secret-1234'), 'plain-****1234');
  const safe = toSafeProviderConfig({ id: 'deepseek', apiKey: 'sk-example-secret-abcd', enabled: true });
  assert.equal(safe.apiKey, undefined);
  assert.equal(safe.apiKeyConfigured, true);
  assert.equal(safe.maskedApiKey, 'sk-****abcd');
  assert.equal(canRevealApiKey({ developerMode: true }), false);
});

test('legacy XOR credentials remain readable for migration but new legacy writes can be disabled', () => {
  const encrypted = encryptApiKey('legacy-migration-secret');
  assert.equal(isEncryptedApiKey(encrypted), true);
  assert.equal(decryptApiKey(encrypted), 'legacy-migration-secret');
  assert.throws(
    () => encryptApiKey('must-use-vault', { allowLegacyWrite: false }),
    (error) => error.code === 'LEGACY_CREDENTIAL_WRITE_DISABLED'
  );
});
