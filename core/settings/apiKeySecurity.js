const MASKED_API_KEY = '********************';
const ENCRYPTED_PREFIX = 'awc-key-v1:';
const LOCAL_SECRET = 'ai-work-center-local-first';

export function maskApiKey(apiKey = '') {
  const value = String(apiKey || '');
  if (!value) return '';
  const prefix = value.match(/^([A-Za-z0-9]+-)/)?.[1] || '';
  return `${prefix}****${value.slice(-4)}`;
}

export function canEditProviderSettings({ developerMode = false } = {}) {
  return Boolean(developerMode);
}

export function canRevealApiKey({ developerMode = false } = {}) {
  return false;
}

export function toSafeProviderConfig(config = {}) {
  const { apiKey, ...safe } = config;
  return {
    ...safe,
    apiKeyConfigured: Boolean(apiKey || safe.apiKeyConfigured),
    maskedApiKey: apiKey ? maskApiKey(apiKey) : String(safe.maskedApiKey || '')
  };
}

function encodeBase64(value) {
  if (typeof btoa === 'function') return btoa(value);
  return Buffer.from(value, 'binary').toString('base64');
}

function decodeBase64(value) {
  if (typeof atob === 'function') return atob(value);
  return Buffer.from(value, 'base64').toString('binary');
}

function xorText(value = '') {
  return String(value).split('').map((char, index) => {
    const key = LOCAL_SECRET.charCodeAt(index % LOCAL_SECRET.length);
    return String.fromCharCode(char.charCodeAt(0) ^ key);
  }).join('');
}

export function encryptApiKey(apiKey = '', { allowLegacyWrite = true } = {}) {
  if (!allowLegacyWrite) {
    const error = new Error('LEGACY_CREDENTIAL_WRITE_DISABLED');
    error.code = 'LEGACY_CREDENTIAL_WRITE_DISABLED';
    throw error;
  }
  const value = String(apiKey || '');
  if (!value || value.startsWith(ENCRYPTED_PREFIX)) return value;
  return `${ENCRYPTED_PREFIX}${encodeBase64(xorText(value))}`;
}

export function decryptApiKey(apiKey = '') {
  const value = String(apiKey || '');
  if (!value || !value.startsWith(ENCRYPTED_PREFIX)) return value;
  try {
    return xorText(decodeBase64(value.slice(ENCRYPTED_PREFIX.length)));
  } catch {
    return '';
  }
}

export function isEncryptedApiKey(apiKey = '') {
  return String(apiKey || '').startsWith(ENCRYPTED_PREFIX);
}
