import { MemoryIntegrationAudit } from './audit.js';

export const MEMORY_FEATURE_FLAGS = Object.freeze([
  'MEMORY_REAL_USER_ENABLED',
  'MEMORY_CAPTURE_ENABLED',
  'MEMORY_RECALL_ENABLED',
  'MEMORY_GOVERNANCE_ENABLED',
  'MEMORY_TIMELINE_ENABLED',
  'MEMORY_INTELLIGENCE_ENABLED'
]);

function enabled(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export class MemoryFeatureFlags {
  constructor({ env = process.env, whitelist = null, audit = new MemoryIntegrationAudit() } = {}) {
    this.env = env;
    this.whitelist = new Set(whitelist || String(env.MEMORY_USER_WHITELIST || 'huage').split(',').map((item) => item.trim()).filter(Boolean));
    this.audit = audit;
  }

  _allowed(user) {
    return user?.status === 'active' && (this.whitelist.has(user.id) || this.whitelist.has(user.username));
  }

  isEnabled(flag, user) {
    if (!MEMORY_FEATURE_FLAGS.includes(flag) || !this._allowed(user)) return false;
    const master = enabled(this.env.MEMORY_REAL_USER_ENABLED, false);
    if (flag === 'MEMORY_REAL_USER_ENABLED') return master;
    return master && enabled(this.env[flag], true);
  }

  evaluate(user) {
    const flags = Object.freeze(Object.fromEntries(MEMORY_FEATURE_FLAGS.map((flag) => [flag, this.isEnabled(flag, user)])));
    this.audit.record({
      userId: user?.id || '',
      action: 'memory_feature_flags_evaluated',
      result: flags.MEMORY_REAL_USER_ENABLED ? 'enabled' : 'disabled',
      reasonCode: flags.MEMORY_REAL_USER_ENABLED ? 'MEMORY_FEATURES_ENABLED' : 'MEMORY_FEATURES_DISABLED',
      requestId: '',
      metadata: { enabledCount: Object.values(flags).filter(Boolean).length }
    });
    return flags;
  }

  listAuditEvents(userId) { return this.audit.list(userId); }
}
