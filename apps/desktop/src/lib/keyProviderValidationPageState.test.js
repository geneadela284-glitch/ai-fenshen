import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getValidationPageOptions,
  getValidationPageMode,
  isRecoveryCredentialFormatValid,
  normalizeRecoveryCredential,
  toValidationPageState
} from './keyProviderValidationPageState.js';

test('validation page is disabled unless query flag and build flag are both explicit', () => {
  assert.equal(getValidationPageMode('?keyProviderValidation=1', { VITE_ENABLE_KEY_PROVIDER_VALIDATION: '1' }), true);
  assert.equal(getValidationPageMode('?keyProviderValidation=1', { VITE_ENABLE_KEY_PROVIDER_VALIDATION: '0' }), false);
  assert.equal(getValidationPageMode('?keyProviderValidation=0', { VITE_ENABLE_KEY_PROVIDER_VALIDATION: '1' }), false);
  assert.equal(getValidationPageMode('', { VITE_ENABLE_KEY_PROVIDER_VALIDATION: '1' }), false);
});

test('second-device recovery query selects an explicit recovery mode without local device state', () => {
  assert.deepEqual(
    getValidationPageOptions('?keyProviderValidation=1&secondDeviceRecovery=true', {
      VITE_ENABLE_KEY_PROVIDER_VALIDATION: '1'
    }),
    {
      enabled: true,
      secondDeviceRecovery: true,
      mode: 'SECOND_DEVICE_RECOVERY'
    }
  );
  assert.deepEqual(
    getValidationPageOptions('?keyProviderValidation=1&secondDeviceRecovery=false', {
      VITE_ENABLE_KEY_PROVIDER_VALIDATION: '1'
    }),
    {
      enabled: true,
      secondDeviceRecovery: false,
      mode: 'KEY_PROVIDER_VALIDATION'
    }
  );
  assert.deepEqual(
    getValidationPageOptions('?keyProviderValidation=1&secondDeviceRecovery=true', {
      VITE_ENABLE_KEY_PROVIDER_VALIDATION: '0'
    }),
    {
      enabled: false,
      secondDeviceRecovery: false,
      mode: 'DISABLED'
    }
  );
});

test('recovery credential validation accepts only a trimmed 32-byte base64url secret', () => {
  const credential = 'A'.repeat(43);
  assert.equal(normalizeRecoveryCredential(`  ${credential}\n`), credential);
  assert.equal(isRecoveryCredentialFormatValid(credential), true);
  assert.equal(isRecoveryCredentialFormatValid(''), false);
  assert.equal(isRecoveryCredentialFormatValid('A'.repeat(42)), false);
  assert.equal(isRecoveryCredentialFormatValid(`${credential}!`), false);
  assert.equal(isRecoveryCredentialFormatValid(`mrc1.${'A'.repeat(80)}`), true);
});

test('validation page state exposes only sanitized capability data', () => {
  const state = toValidationPageState({
    probeVersion: 'probe-v2',
    environment: 'test',
    assessment: 'TEST_ENV_CAPABILITY_UNAVAILABLE',
    productionReady: false,
    runtime: { secureContext: true, browserVersion: '17.6', platform: 'iPhone', userAgent: 'sanitized' },
    capabilities: { recoveryKeyWrapping: false, persistentCryptoKey: true },
    errorCodes: { recoveryKeyWrapping: 'NON_EXPORTABLE_KEY_CANNOT_BE_WRAPPED' },
    secret: 'must-not-pass-through'
  });
  assert.equal(state.verdict, 'TEST_ENV_CAPABILITY_UNAVAILABLE');
  assert.equal(state.probeVersion, 'probe-v2');
  assert.deepEqual(state.capabilities, { recoveryKeyWrapping: false, persistentCryptoKey: true });
  assert.deepEqual(state.errorCodes, { recoveryKeyWrapping: 'NON_EXPORTABLE_KEY_CANNOT_BE_WRAPPED' });
  assert.equal(Object.hasOwn(state, 'secret'), false);
});

test('validation page state has a stable loading and error shape', () => {
  assert.deepEqual(toValidationPageState(null), { status: 'loading', verdict: null, capabilities: {}, errorCodes: {} });
  assert.deepEqual(toValidationPageState({ errorCode: 'PROBE_FAILED' }), {
    status: 'error',
    verdict: 'BROWSER_CAPABILITY_INCOMPLETE',
    capabilities: {},
    errorCodes: { probe: 'PROBE_FAILED' }
  });
});
