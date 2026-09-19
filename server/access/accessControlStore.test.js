import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILTIN_QUOTA_PROFILES,
  resolveAccessControlConfig
} from './accessControlConfig.js';
import { AccessControlStore } from './accessControlStore.js';

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-access-store-'));
  const dbPath = path.join(directory, 'security', 'access-control.sqlite');
  const store = new AccessControlStore({
    dbPath,
    clock: () => new Date('2026-07-28T08:00:00.000Z')
  });
  store.initialize();
  return {
    directory,
    dbPath,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('resolves an isolated production access database and exact trusted proxies', () => {
  assert.deepEqual(resolveAccessControlConfig({
    env: { NODE_ENV: 'production' },
    projectRoot: '/tmp/project'
  }), {
    dbPath: '/data/security/access-control.sqlite',
    trustedProxyIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1']
  });

  assert.deepEqual(resolveAccessControlConfig({
    env: {
      AI_SECRETARY_ACCESS_CONTROL_DB: '/tmp/isolated/access.sqlite',
      AI_SECRETARY_TRUSTED_PROXY_IPS: '127.0.0.1, 10.0.0.2'
    },
    projectRoot: '/tmp/project'
  }), {
    dbPath: '/tmp/isolated/access.sqlite',
    trustedProxyIps: ['127.0.0.1', '10.0.0.2']
  });
});

test('creates a mode-0600 security database with only bounded security tables', () => {
  const h = harness();
  try {
    assert.equal(statSync(h.dbPath).mode & 0o777, 0o600);
    assert.deepEqual(h.store.getProfile('closed_beta_user_v1'), {
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
    });
    assert.deepEqual(
      h.store.getProfile('closed_beta_admin_v1'),
      BUILTIN_QUOTA_PROFILES.closed_beta_admin_v1
    );
    assert.equal(h.store.getAccountAccess('unbound-account'), null);

    const tables = h.store.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [
      'account_access',
      'login_account_state',
      'login_ip_state',
      'provider_attempts',
      'quota_profiles',
      'request_leases',
      'security_events',
      'session_bindings',
      'usage_buckets'
    ]);

    const columns = tables.flatMap((table) =>
      h.store.database.prepare(`PRAGMA table_info("${table}")`).all()
        .map((row) => `${table}.${row.name}`));
    assert.doesNotMatch(
      columns.join('\n'),
      /prompt|response|password|cookie|(^|[._])token($|[._])|api.?key|credential|authorization/i
    );
  } finally {
    h.close();
  }
});

test('seeds immutable built-in profiles and accepts only bounded custom profiles', () => {
  const h = harness();
  try {
    assert.throws(
      () => h.store.putCustomProfile({
        ...BUILTIN_QUOTA_PROFILES.closed_beta_user_v1,
        requestsPerMinute: 7
      }),
      { code: 'BUILTIN_QUOTA_PROFILE_IMMUTABLE' }
    );
    assert.throws(
      () => h.store.putCustomProfile({
        id: 'unbounded',
        requestsPerMinute: 0,
        maxConcurrentRequests: 1,
        providerCallsPerDay: 1,
        inputTokensPerDay: 1,
        outputTokensPerDay: 1,
        dailyCostMicros: 1,
        monthlyCostMicros: 1,
        lifetimeCostMicros: 1,
        enabled: true
      }),
      { code: 'QUOTA_PROFILE_INVALID' }
    );

    const custom = h.store.putCustomProfile({
      id: 'tiny_test_v1',
      requestsPerMinute: 2,
      maxConcurrentRequests: 1,
      providerCallsPerDay: 3,
      inputTokensPerDay: 1000,
      outputTokensPerDay: 500,
      dailyCostMicros: 1000000,
      monthlyCostMicros: 5000000,
      lifetimeCostMicros: 10000000,
      enabled: true
    });
    assert.equal(custom.id, 'tiny_test_v1');
    assert.equal(custom.builtin, false);
    assert.deepEqual(h.store.getProfile('tiny_test_v1'), custom);
  } finally {
    h.close();
  }
});
