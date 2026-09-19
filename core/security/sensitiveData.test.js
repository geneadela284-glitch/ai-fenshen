import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeSensitiveData } from './sensitiveData.js';

test('drops secrets, credentials, raw payloads, stacks and absolute paths recursively', () => {
  const sanitized = sanitizeSensitiveData({
    apiKey: 'sk-secret-value',
    providerApiKey: 'sk-provider-secret',
    clientSecret: 'client-secret-value',
    password: 'password-value',
    userPassword: 'user-password-value',
    headers: {
      Authorization: 'Bearer secret-token',
      authorizationHeader: 'Bearer another-token',
      Cookie: 'session=secret',
      cookieHeader: 'session=another-secret'
    },
    request: { body: { prompt: 'full user input' }, rawRequestBody: 'raw provider request' },
    eventPayload: { originalInput: 'full user input' },
    stack: 'Error at /Users/private/project/file.js',
    safe: 'kept',
    path: '/Users/private/project/file.txt'
  });

  assert.deepEqual(sanitized, { headers: {}, request: {}, safe: 'kept' });
});

test('redacts generic Authorization schemes and credential assignment text', () => {
  const result = sanitizeSensitiveData({
    message: 'authorization: Token provider-secret-value-123456',
    detail: 'credential=provider-secret-value-123456',
    safe: 'Provider unavailable'
  });
  assert.equal(result.message, '[REDACTED]');
  assert.equal(result.detail, '[REDACTED]');
  assert.equal(result.safe, 'Provider unavailable');
});
