import { isIP } from 'node:net';
import path from 'node:path';

const BUILTIN_QUOTA_PROFILES = Object.freeze({
  closed_beta_user_v1: Object.freeze({
    id: 'closed_beta_user_v1',
    requestsPerMinute: 6,
    maxConcurrentRequests: 2,
    providerCallsPerDay: 120,
    inputTokensPerDay: 300000,
    outputTokensPerDay: 120000,
    dailyCostMicros: 10000000,
    monthlyCostMicros: 150000000,
    lifetimeCostMicros: 500000000,
    builtin: true,
    enabled: true
  }),
  closed_beta_admin_v1: Object.freeze({
    id: 'closed_beta_admin_v1',
    requestsPerMinute: 30,
    maxConcurrentRequests: 4,
    providerCallsPerDay: 1000,
    inputTokensPerDay: 2000000,
    outputTokensPerDay: 1000000,
    dailyCostMicros: 100000000,
    monthlyCostMicros: 2000000000,
    lifetimeCostMicros: 10000000000,
    builtin: true,
    enabled: true
  })
});

const LOGIN_PROTECTION = Object.freeze({
  cooldownFailureCount: 3,
  cooldownMs: 60 * 1000,
  accountWindowFailureCount: 5,
  ipWindowFailureCount: 10,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000
});

const DEFAULT_TRUSTED_PROXY_IPS = Object.freeze([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1'
]);

function exactAbsolutePath(value, name) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${name} must be a normalized absolute path.`);
  }
  return value;
}

function trustedProxyIps(value, production) {
  if (value === undefined) {
    return production ? [...DEFAULT_TRUSTED_PROXY_IPS] : [...DEFAULT_TRUSTED_PROXY_IPS];
  }
  if (typeof value !== 'string') throw new Error('AI_SECRETARY_TRUSTED_PROXY_IPS must be a comma-separated IP list.');
  const entries = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (!entries.length || entries.some((item) => isIP(item) === 0)) {
    throw new Error('AI_SECRETARY_TRUSTED_PROXY_IPS must contain only exact IP addresses.');
  }
  return entries;
}

export function resolveAccessControlConfig({ env = process.env, projectRoot = process.cwd() } = {}) {
  const production = env.NODE_ENV === 'production';
  const dbPath = env.AI_SECRETARY_ACCESS_CONTROL_DB
    ? exactAbsolutePath(env.AI_SECRETARY_ACCESS_CONTROL_DB, 'AI_SECRETARY_ACCESS_CONTROL_DB')
    : env.AI_SECRETARY_DATA_DIR
      ? path.resolve(env.AI_SECRETARY_DATA_DIR, 'security/access-control.sqlite')
      : production
        ? '/data/security/access-control.sqlite'
        : path.resolve(projectRoot, 'data/security/access-control.sqlite');
  return {
    dbPath,
    trustedProxyIps: trustedProxyIps(env.AI_SECRETARY_TRUSTED_PROXY_IPS, production)
  };
}

export {
  BUILTIN_QUOTA_PROFILES,
  DEFAULT_TRUSTED_PROXY_IPS,
  LOGIN_PROTECTION
};
