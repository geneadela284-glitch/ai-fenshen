import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTrustedClientIp } from './trustedClientIp.js';

function request(remoteAddress, forwardedFor = '') {
  return {
    socket: { remoteAddress },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}
  };
}

const trusted = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

test('ignores forged X-Forwarded-For from an untrusted socket peer', () => {
  assert.equal(
    resolveTrustedClientIp(request('198.51.100.20', '203.0.113.99'), trusted),
    '198.51.100.20'
  );
});

test('accepts one valid client IP only from an exact trusted proxy', () => {
  assert.equal(
    resolveTrustedClientIp(request('127.0.0.1', '203.0.113.99'), trusted),
    '203.0.113.99'
  );
  assert.equal(
    resolveTrustedClientIp(request('::ffff:127.0.0.1', '2001:db8::8'), trusted),
    '2001:db8::8'
  );
});

test('falls back to the trusted socket IP for malformed or multi-hop values', () => {
  assert.equal(
    resolveTrustedClientIp(request('127.0.0.1', 'attacker, 203.0.113.99'), trusted),
    '127.0.0.1'
  );
  assert.equal(
    resolveTrustedClientIp(request('127.0.0.1', 'not-an-ip'), trusted),
    '127.0.0.1'
  );
});
