import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ProviderSecurityAudit,
  redactProviderSecrets,
  sanitizeProviderError
} from './providerSecurity.js';

const SECRET = 'provider-secret-value-123456';

test('provider security redaction removes nested credential fields and exact secret values', () => {
  const safe = redactProviderSecrets({
    providerId: 'deepseek',
    apiKey: SECRET,
    headers: { Authorization: `Bearer ${SECRET}` },
    error: `upstream rejected ${SECRET}`,
    nested: [{ cookie: 'session=secret' }, { message: `credential=${SECRET}` }]
  }, [SECRET]);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, /authorization|apiKey|cookie|bearer/i);
  assert.equal(safe.providerId, 'deepseek');
});

test('sanitized Provider errors preserve stable routing fields without secret text', () => {
  const original = Object.assign(new Error(`HTTP 401 for ${SECRET}`), {
    code: 'AUTH_FAILED',
    status: 401,
    headers: { authorization: `Bearer ${SECRET}` }
  });
  const safe = sanitizeProviderError(original, [SECRET]);
  assert.notEqual(safe, original);
  assert.equal(safe.code, 'AUTH_FAILED');
  assert.equal(safe.status, 401);
  assert.doesNotMatch(safe.message, new RegExp(SECRET));
  assert.equal('headers' in safe, false);
});

test('credential access audit writes an allowlisted secret-free 0600 NDJSON event', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'provider-audit-'));
  const auditLogPath = path.join(directory, 'provider-security-audit.ndjson');
  try {
    const audit = new ProviderSecurityAudit({
      auditLogPath,
      clock: () => new Date('2026-07-27T02:00:00.000Z')
    });
    audit.record({
      event: 'credential_access',
      provider_id: 'deepseek',
      purpose: 'invoke',
      credential_revision: 3,
      result: 'granted',
      reason_code: null,
      apiKey: SECRET,
      raw: { authorization: `Bearer ${SECRET}` }
    });
    const bytes = await readFile(auditLogPath, 'utf8');
    const event = JSON.parse(bytes.trim());
    assert.deepEqual(event, {
      schema_version: 1,
      event: 'credential_access',
      provider_id: 'deepseek',
      purpose: 'invoke',
      credential_revision: 3,
      result: 'granted',
      reason_code: null,
      at: '2026-07-27T02:00:00.000Z'
    });
    assert.doesNotMatch(bytes, new RegExp(SECRET));
    assert.equal((await stat(auditLogPath)).mode & 0o777, 0o600);
  } finally {
    await chmod(auditLogPath, 0o600).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
