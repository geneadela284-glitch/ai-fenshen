import {
  isLegacyRecoverySecret,
  isPortableRecoveryCredentialFormat
} from './portableRecoveryCredential.js';

export function getValidationPageOptions(search = '', env = {}) {
  const query = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const enabled = query.get('keyProviderValidation') === '1' && env.VITE_ENABLE_KEY_PROVIDER_VALIDATION === '1';
  const secondDeviceRecovery = enabled && query.get('secondDeviceRecovery') === 'true';
  return Object.freeze({
    enabled,
    secondDeviceRecovery,
    mode: enabled ? (secondDeviceRecovery ? 'SECOND_DEVICE_RECOVERY' : 'KEY_PROVIDER_VALIDATION') : 'DISABLED'
  });
}

export function getValidationPageMode(search = '', env = {}) {
  return getValidationPageOptions(search, env).enabled;
}

export function normalizeRecoveryCredential(value) {
  return String(value ?? '').trim();
}

export function isRecoveryCredentialFormatValid(value) {
  const normalized = normalizeRecoveryCredential(value);
  return isPortableRecoveryCredentialFormat(normalized) || isLegacyRecoverySecret(normalized);
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => typeof key === 'string' && (typeof entry === 'boolean' || typeof entry === 'string' || entry === null)));
}

export function toValidationPageState(probe) {
  if (!probe) return { status: 'loading', verdict: null, capabilities: {}, errorCodes: {} };
  if (probe.errorCode) {
    return {
      status: 'error',
      verdict: 'BROWSER_CAPABILITY_INCOMPLETE',
      capabilities: {},
      errorCodes: { probe: String(probe.errorCode) }
    };
  }
  const assessment = String(
    probe.assessment || (probe.productionReady === true ? 'PRODUCTION_KEYPROVIDER_VALIDATED' : 'BROWSER_CAPABILITY_INCOMPLETE')
  );
  return {
    status: 'ready',
    verdict: assessment,
    assessment,
    environment: String(probe.environment || 'unknown'),
    capabilitiesReady: probe.capabilitiesReady === true,
    probeVersion: String(probe.probeVersion || 'unknown'),
    runtime: safeObject(probe.runtime),
    capabilities: safeObject(probe.capabilities),
    errorCodes: safeObject(probe.errorCodes)
  };
}
