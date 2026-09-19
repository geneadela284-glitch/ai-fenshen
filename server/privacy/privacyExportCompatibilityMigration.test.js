import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { PrivacyLifecycle } from './privacyLifecycle.js';

const NOW = new Date('2026-08-02T06:00:00.000Z');
const SECRET = crypto.randomBytes(32).toString('base64url');

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createLegacyDatabase(dbPath) {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE privacy_export_grants (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
  `);
  return database;
}

function insertLegacyGrant(database, {
  id,
  ownerId,
  token,
  filePath,
  expiresAt,
  consumedAt = null
}) {
  database.prepare(`
    INSERT INTO privacy_export_grants (
      id, owner_id, token_hash, file_path, created_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, ownerId, tokenDigest(token), filePath, NOW.toISOString(), expiresAt, consumedAt);
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function compatibilityReceiptCount(database) {
  if (!tableExists(database, 'privacy_export_compatibility_receipts')) return 0;
  return Number(database.prepare(
    'SELECT COUNT(*) AS count FROM privacy_export_compatibility_receipts'
  ).get().count);
}

test('explicit Privacy export compatibility migration upgrades safe legacy grants and invalidates every unsafe path without touching files', async () => {
  const migration = await import('./privacyExportCompatibilityMigration.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-migration-'));
  const exportDir = path.join(root, 'exports');
  const outsideDir = path.join(root, 'outside');
  const dbPath = path.join(root, 'privacy.sqlite');
  mkdirSync(exportDir, { mode: 0o700 });
  mkdirSync(outsideDir, { mode: 0o700 });
  const files = {
    active: path.join(exportDir, 'active.json'),
    expired: path.join(exportDir, 'expired.json'),
    consumed: path.join(exportDir, 'consumed.json'),
    missing: path.join(exportDir, 'missing.json'),
    outside: path.join(outsideDir, 'outside.json'),
    symlink: path.join(exportDir, 'symlink.json'),
    hardlink: path.join(exportDir, 'hardlink.json'),
    hardlinkSource: path.join(outsideDir, 'hardlink-source.json')
  };
  writeFileSync(files.active, JSON.stringify({ kind: 'active' }), { mode: 0o600 });
  writeFileSync(files.expired, JSON.stringify({ kind: 'expired' }), { mode: 0o600 });
  writeFileSync(files.consumed, JSON.stringify({ kind: 'consumed' }), { mode: 0o600 });
  writeFileSync(files.outside, JSON.stringify({ marker: 'outside-private' }), { mode: 0o600 });
  symlinkSync(files.outside, files.symlink);
  writeFileSync(files.hardlinkSource, JSON.stringify({ marker: 'hardlink-private' }), { mode: 0o600 });
  linkSync(files.hardlinkSource, files.hardlink);
  let database = createLegacyDatabase(dbPath);
  let lifecycle;
  const activeToken = 'legacy-active-token';
  try {
    insertLegacyGrant(database, {
      id: 'active', ownerId: 'owner-active', token: activeToken, filePath: files.active,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString()
    });
    insertLegacyGrant(database, {
      id: 'expired', ownerId: 'owner-expired', token: 'expired-token', filePath: files.expired,
      expiresAt: new Date(NOW.getTime() - 1).toISOString()
    });
    insertLegacyGrant(database, {
      id: 'consumed', ownerId: 'owner-consumed', token: 'consumed-token', filePath: files.consumed,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), consumedAt: NOW.toISOString()
    });
    for (const [id, filePath] of [
      ['missing', files.missing],
      ['outside', files.outside],
      ['symlink', files.symlink],
      ['hardlink', files.hardlink]
    ]) {
      insertLegacyGrant(database, {
        id, ownerId: `owner-${id}`, token: `${id}-token`, filePath,
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString()
      });
    }
    database.close();
    database = null;

    assert.throws(() => new PrivacyLifecycle({
      dbPath,
      exportDir,
      secret: SECRET,
      now: () => NOW.toISOString()
    }), (error) => error?.code === 'PRIVACY_EXPORT_COMPATIBILITY_MIGRATION_REQUIRED');
    database = new DatabaseSync(dbPath);
    assert.equal(tableExists(database, 'privacy_export_file_bindings'), false);
    assert.equal(tableExists(database, 'privacy_export_invalidations'), false);

    const result = migration.applyPrivacyExportCompatibilityMigration({
      database,
      exportDir,
      now: () => NOW.toISOString()
    });
    assert.deepEqual(result, { migrated: 3, invalidated: 4 });
    assert.deepEqual(
      database.prepare('SELECT export_id FROM privacy_export_file_bindings ORDER BY export_id')
        .all().map((row) => row.export_id),
      ['active', 'consumed', 'expired']
    );
    const invalidations = database.prepare(`
      SELECT export_id, owner_id, reason_code, invalidated_at, file_path_snapshot
      FROM privacy_export_invalidations ORDER BY export_id
    `).all();
    assert.deepEqual(invalidations.map((row) => row.export_id), ['hardlink', 'missing', 'outside', 'symlink']);
    assert.equal(invalidations.every((row) => row.owner_id === `owner-${row.export_id}`), true);
    assert.equal(invalidations.every((row) => row.reason_code.startsWith('LEGACY_EXPORT_')), true);
    assert.equal(invalidations.every((row) => path.isAbsolute(row.file_path_snapshot)), true);
    assert.equal(invalidations.every((row) => row.invalidated_at === NOW.toISOString()), true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM privacy_export_grants').get().count, 7,
      'migration must not modify or delete legacy grant metadata');
    assert.deepEqual(migration.applyPrivacyExportCompatibilityMigration({
      database,
      exportDir,
      now: () => NOW.toISOString()
    }), { migrated: 0, invalidated: 0 });
    for (const filePath of Object.values(files).filter((candidate) => candidate !== files.missing)) {
      assert.equal(existsSync(filePath), true, `migration must not delete ${filePath}`);
    }
    assert.equal(lstatSync(files.symlink).isSymbolicLink(), true);
    assert.equal(readFileSync(files.outside, 'utf8'), JSON.stringify({ marker: 'outside-private' }));
    assert.equal(readFileSync(files.hardlinkSource, 'utf8'), JSON.stringify({ marker: 'hardlink-private' }));
    database.close();
    database = null;

    lifecycle = new PrivacyLifecycle({
      dbPath,
      exportDir,
      secret: SECRET,
      now: () => NOW.toISOString()
    });
    assert.equal(lifecycle.hasOwnerExports('owner-active'), true);
    assert.equal(existsSync(files.expired), false, 'existing retention cleanup may remove a verified expired file');
    assert.equal(existsSync(files.consumed), false, 'existing retention cleanup may remove a verified consumed file');
    assert.equal(lstatSync(files.symlink).isSymbolicLink(), true);
    assert.equal(existsSync(files.hardlink), true);
    assert.throws(
      () => lifecycle.store.getConsumableExport({ ownerId: 'owner-symlink', token: 'symlink-token' }),
      (error) => error?.code === 'EXPORT_NOT_FOUND'
    );
    const downloaded = lifecycle.consumeExport('owner-active', activeToken);
    assert.deepEqual(JSON.parse(downloaded.buffer.toString('utf8')), { kind: 'active' });
  } finally {
    try { lifecycle?.close(); } catch {}
    try { database?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('Privacy export compatibility migration rolls back every binding and invalidation when SQLite fails', async () => {
  const migration = await import('./privacyExportCompatibilityMigration.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-migration-rollback-'));
  const exportDir = path.join(root, 'exports');
  const dbPath = path.join(root, 'privacy.sqlite');
  const safeFile = path.join(exportDir, 'safe.json');
  const missingFile = path.join(exportDir, 'missing.json');
  mkdirSync(exportDir, { mode: 0o700 });
  writeFileSync(safeFile, JSON.stringify({ safe: true }), { mode: 0o600 });
  const database = createLegacyDatabase(dbPath);
  try {
    insertLegacyGrant(database, {
      id: 'missing-first', ownerId: 'owner-missing', token: 'missing-first-token', filePath: missingFile,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString()
    });
    insertLegacyGrant(database, {
      id: 'safe-second', ownerId: 'owner-safe', token: 'safe-second-token', filePath: safeFile,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString()
    });
    migration.createPrivacyExportCompatibilitySchema(database);
    database.exec(`
      CREATE TRIGGER fail_compatibility_binding
      BEFORE INSERT ON privacy_export_file_bindings
      BEGIN
        SELECT RAISE(ABORT, 'injected compatibility migration failure');
      END;
    `);
    assert.throws(() => migration.applyPrivacyExportCompatibilityMigration({
      database,
      exportDir,
      now: () => NOW.toISOString()
    }), /injected compatibility migration failure/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM privacy_export_file_bindings').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM privacy_export_invalidations').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM privacy_export_grants').get().count, 2);
    assert.equal(existsSync(safeFile), true);
    assert.equal(existsSync(missingFile), false);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing empty legacy Privacy database still requires the explicit compatibility migration', async () => {
  const migration = await import('./privacyExportCompatibilityMigration.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-empty-legacy-'));
  const exportDir = path.join(root, 'exports');
  const dbPath = path.join(root, 'privacy.sqlite');
  mkdirSync(exportDir, { mode: 0o700 });
  let database = createLegacyDatabase(dbPath);
  database.close();
  database = null;
  let lifecycle;
  try {
    assert.throws(() => new PrivacyLifecycle({
      dbPath,
      exportDir,
      secret: SECRET,
      now: () => NOW.toISOString()
    }), (error) => error?.code === 'PRIVACY_EXPORT_COMPATIBILITY_MIGRATION_REQUIRED');
    database = new DatabaseSync(dbPath);
    assert.equal(tableExists(database, 'privacy_export_file_bindings'), false);
    assert.equal(tableExists(database, 'privacy_export_invalidations'), false);
    assert.deepEqual(migration.applyPrivacyExportCompatibilityMigration({
      database,
      exportDir,
      now: () => NOW.toISOString()
    }), { migrated: 0, invalidated: 0 });
    assert.equal(tableExists(database, 'privacy_export_file_bindings'), true);
    assert.equal(tableExists(database, 'privacy_export_invalidations'), true);
    assert.equal(compatibilityReceiptCount(database), 1);
    database.close();
    database = null;
    lifecycle = new PrivacyLifecycle({
      dbPath,
      exportDir,
      secret: SECRET,
      now: () => NOW.toISOString()
    });
    assert.equal(lifecycle.closeStatus().state, 'active');
  } finally {
    try { lifecycle?.close(); } catch {}
    try { database?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pre-existing zero-table database cannot use a public bootstrap bypass and needs explicit preparation', async () => {
  const migration = await import('./privacyExportCompatibilityMigration.js');
  const root = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-ct2-privacy-reserved-empty-'));
  const exportDir = path.join(root, 'exports');
  const dbPath = path.join(root, 'privacy.sqlite');
  mkdirSync(exportDir, { mode: 0o700 });
  let database = new DatabaseSync(dbPath);
  database.close();
  database = null;
  let lifecycle;
  try {
    assert.throws(() => new PrivacyLifecycle({
      dbPath,
      exportDir,
      secret: SECRET,
      now: () => NOW.toISOString(),
      allowEmptyReservedDatabaseBootstrap: true
    }), (error) => error?.code === 'PRIVACY_EXPORT_COMPATIBILITY_MIGRATION_REQUIRED');
    database = new DatabaseSync(dbPath);
    assert.equal(tableExists(database, 'privacy_export_file_bindings'), false);
    assert.equal(tableExists(database, 'privacy_export_invalidations'), false);
    assert.equal(compatibilityReceiptCount(database), 0);
    assert.deepEqual(migration.applyPrivacyExportCompatibilityMigration({
      database,
      exportDir,
      now: () => NOW.toISOString()
    }), { migrated: 0, invalidated: 0 });
    assert.equal(compatibilityReceiptCount(database), 1);
    database.close();
    database = null;
    lifecycle = new PrivacyLifecycle({
      dbPath,
      exportDir,
      secret: SECRET,
      now: () => NOW.toISOString()
    });
    assert.equal(lifecycle.closeStatus().state, 'active');
  } finally {
    try { lifecycle?.close(); } catch {}
    try { database?.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
