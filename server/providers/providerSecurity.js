import {
  appendFileSync,
  chmodSync,
  mkdirSync
} from 'node:fs';
import path from 'node:path';

const SENSITIVE_FIELD = /(?:^|_)(?:api_?key|authorization|headers?|cookie|password|passwd|secret|private_?key|access_?token|refresh_?token|session_?token|credential(?:_value)?|raw|payload)(?:$|_)/i;
const GENERIC_SECRET_TEXT = /(?:authorization\s*[:=]|bearer\s+\S+|token\s+\S+|credential\s*[:=]|api[-_\s]?key\s*[:=]|password\s*[:=]|cookie\s*[:=]|private[-_\s]?key\s*[:=])/i;

function redactText(value, secrets) {
  let text = String(value);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return GENERIC_SECRET_TEXT.test(text) ? '[REDACTED]' : text;
}

export function redactProviderSecrets(value, secrets = []) {
  const secretValues = [...new Set(secrets.map(String).filter(Boolean))];
  function redact(nested) {
    if (Array.isArray(nested)) return nested.map(redact);
    if (!nested || typeof nested !== 'object') {
      return typeof nested === 'string' ? redactText(nested, secretValues) : nested;
    }
    return Object.fromEntries(
      Object.entries(nested)
        .filter(([key]) => !SENSITIVE_FIELD.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')))
        .map(([key, item]) => [key, redact(item)])
    );
  }
  return redact(value);
}

export function sanitizeProviderError(error, secrets = []) {
  const safe = new Error(redactText(error?.message || 'Provider request failed.', secrets));
  if (error?.code) safe.code = String(error.code);
  if (Number.isInteger(Number(error?.status))) safe.status = Number(error.status);
  if (error?.name && error.name !== 'Error') safe.name = String(error.name);
  return safe;
}

export class ProviderSecurityAudit {
  constructor({ auditLogPath, clock = () => new Date() } = {}) {
    if (!path.isAbsolute(String(auditLogPath || ''))) {
      const error = new Error('PROVIDER_AUDIT_PATH_INVALID: FAIL_CLOSED');
      error.code = 'PROVIDER_AUDIT_PATH_INVALID';
      throw error;
    }
    this.auditLogPath = auditLogPath;
    this.clock = clock;
  }

  record(event = {}) {
    const safe = {
      schema_version: 1,
      event: String(event.event || 'credential_access'),
      provider_id: String(event.provider_id || ''),
      purpose: String(event.purpose || ''),
      credential_revision: Number.isInteger(event.credential_revision) ? event.credential_revision : null,
      result: String(event.result || 'denied'),
      reason_code: event.reason_code ? String(event.reason_code) : null,
      at: this.clock().toISOString()
    };
    if (typeof event.configured === 'boolean') safe.configured = event.configured;
    if (typeof event.config_digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(event.config_digest)) {
      safe.config_digest = event.config_digest;
    }
    mkdirSync(path.dirname(this.auditLogPath), { recursive: true, mode: 0o700 });
    appendFileSync(this.auditLogPath, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    chmodSync(this.auditLogPath, 0o600);
    return safe;
  }
}
