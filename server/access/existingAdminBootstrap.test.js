import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { hashPassword } from '../../core/auth/betaAuthService.js';
import { createBetaServer } from '../betaServer.js';

function seedLegacyAuth(dbPath) {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      displayName TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      status TEXT NOT NULL,
      role TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastLoginAt TEXT
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      revokedAt TEXT,
      userAgent TEXT,
      ip TEXT
    );
  `);
  const insert = database.prepare(`
    INSERT INTO accounts (
      id, username, displayName, passwordHash, status, role,
      createdAt, updatedAt, lastLoginAt
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)
  `);
  const now = '2026-07-28T08:00:00.000Z';
  insert.run(
    'acct-existing-admin',
    'existing_admin',
    'Existing Admin',
    hashPassword('ExistingAdminPassword1!'),
    'admin',
    now,
    now
  );
  insert.run(
    'acct-existing-user',
    'existing_user',
    'Existing User',
    hashPassword('ExistingUserPassword1!'),
    'beta_user',
    now,
    now
  );
  database.close();
}

test('existing admins receive a finite bootstrap profile while unbound ordinary accounts stay denied', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiwc-existing-admin-'));
  const authDb = path.join(directory, 'auth.sqlite');
  seedLegacyAuth(authDb);
  const instance = await createBetaServer({
    config: {
      publicDir: path.join(directory, 'public'),
      authDb,
      accessControlDb: path.join(directory, 'access-control.sqlite'),
      cookieSecret: 'existing-admin-bootstrap-secret-32',
      secureCookie: false
    },
    aiService: { getStatus: () => ({ available: false }) },
    memoryRuntime: {
      initialize: async () => ({ status: 'disabled', pathSummary: 'test-memory.sqlite' }),
      close: async () => {},
      service: {}
    }
  });
  try {
    assert.deepEqual(
      instance.accessControl.getAccountAccess('acct-existing-admin'),
      {
        accountId: 'acct-existing-admin',
        profileId: 'closed_beta_admin_v1',
        enabled: true,
        sessionEpoch: 1,
        createdAt: instance.accessControl.getAccountAccess('acct-existing-admin').createdAt,
        updatedAt: instance.accessControl.getAccountAccess('acct-existing-admin').updatedAt
      }
    );
    assert.equal(instance.accessControl.getAccountAccess('acct-existing-user'), null);
    assert.equal((await instance.auth.login({
      username: 'existing_admin',
      password: 'ExistingAdminPassword1!'
    })).ok, true);
    assert.equal((await instance.auth.login({
      username: 'existing_user',
      password: 'ExistingUserPassword1!'
    })).ok, false);
  } finally {
    instance.server.close();
    instance.auth.close();
    instance.accessControlStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
