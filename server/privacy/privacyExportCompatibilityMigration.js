import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync
} from 'node:fs';
import path from 'node:path';

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(code), { code });
  return normalized;
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function insideDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function invalid(reason) {
  return { valid: false, reason: `LEGACY_EXPORT_${reason}` };
}

function inspectLegacyExport(filePath, exportDir, exportDirRealpath) {
  if (!path.isAbsolute(filePath)) return invalid('PATH_NOT_ABSOLUTE');
  const resolved = path.resolve(filePath);
  if (!insideDirectory(exportDir, resolved)) return invalid('PATH_OUTSIDE_DIRECTORY');

  let firstStats;
  try {
    firstStats = lstatSync(resolved);
  } catch (error) {
    return invalid(error?.code === 'ENOENT' ? 'FILE_MISSING' : 'FILE_UNAVAILABLE');
  }
  if (firstStats.isSymbolicLink()) return invalid('SYMLINK');
  if (!firstStats.isFile()) return invalid('NOT_REGULAR_FILE');
  if (firstStats.nlink !== 1) return invalid('HARDLINK');
  if (typeof constants.O_NOFOLLOW !== 'number') return invalid('NOFOLLOW_UNAVAILABLE');

  let descriptor;
  try {
    const canonical = realpathSync(resolved);
    const expectedCanonical = path.join(exportDirRealpath, path.relative(exportDir, resolved));
    if (!insideDirectory(exportDirRealpath, canonical) || canonical !== expectedCanonical) {
      return invalid('REALPATH_OUTSIDE_DIRECTORY');
    }
    descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorStats = fstatSync(descriptor);
    const finalStats = lstatSync(resolved);
    const finalCanonical = realpathSync(resolved);
    if (!descriptorStats.isFile() || descriptorStats.nlink !== 1 ||
        String(descriptorStats.dev) !== String(firstStats.dev) ||
        String(descriptorStats.ino) !== String(firstStats.ino) ||
        !finalStats.isFile() || finalStats.isSymbolicLink() || finalStats.nlink !== 1 ||
        String(finalStats.dev) !== String(descriptorStats.dev) ||
        String(finalStats.ino) !== String(descriptorStats.ino) ||
        finalCanonical !== canonical) {
      return invalid('FILE_CHANGED_DURING_INSPECTION');
    }
    return {
      valid: true,
      binding: {
        dev: String(descriptorStats.dev),
        ino: String(descriptorStats.ino),
        nlink: descriptorStats.nlink,
        realpath: canonical
      }
    };
  } catch (error) {
    return invalid(error?.code === 'ELOOP' ? 'SYMLINK' : 'FILE_UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function createPrivacyExportCompatibilitySchema(database) {
  if (!database || typeof database.exec !== 'function') {
    throw Object.assign(new Error('PRIVACY_DATABASE_REQUIRED'), { code: 'PRIVACY_DATABASE_REQUIRED' });
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS privacy_export_file_bindings (
      export_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_dev TEXT NOT NULL,
      file_ino TEXT NOT NULL,
      file_nlink INTEGER NOT NULL CHECK(file_nlink = 1),
      file_realpath TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS privacy_export_invalidations (
      export_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      invalidated_at TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      file_path_snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_privacy_export_invalidations_owner
      ON privacy_export_invalidations(owner_id, invalidated_at);

    CREATE TABLE IF NOT EXISTS privacy_export_compatibility_receipts (
      migration_id TEXT PRIMARY KEY,
      migrated_at TEXT NOT NULL
    );
  `);
}

export function applyPrivacyExportCompatibilityMigration({
  database,
  exportDir,
  now = () => new Date().toISOString()
} = {}) {
  if (!database || typeof database.exec !== 'function') {
    throw Object.assign(new Error('PRIVACY_DATABASE_REQUIRED'), { code: 'PRIVACY_DATABASE_REQUIRED' });
  }
  const root = path.resolve(required(exportDir, 'PRIVACY_EXPORT_DIR_REQUIRED'));
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw Object.assign(new Error('Privacy export directory is unsafe.'), {
      code: 'PRIVACY_EXPORT_DIR_UNSAFE'
    });
  }
  const rootRealpath = realpathSync(root);
  const invalidatedAt = required(now(), 'PRIVACY_MIGRATION_TIME_REQUIRED');
  let migrated = 0;
  let invalidated = 0;

  database.exec('BEGIN IMMEDIATE');
  try {
    createPrivacyExportCompatibilitySchema(database);
    const grants = tableExists(database, 'privacy_export_grants')
      ? database.prepare(`
        SELECT grants.id, grants.owner_id, grants.file_path, grants.created_at
        FROM privacy_export_grants AS grants
        LEFT JOIN privacy_export_file_bindings AS bindings ON bindings.export_id = grants.id
        LEFT JOIN privacy_export_invalidations AS invalidations ON invalidations.export_id = grants.id
        WHERE bindings.export_id IS NULL AND invalidations.export_id IS NULL
        ORDER BY grants.created_at ASC, grants.rowid ASC
      `).all()
      : [];
    const insertBinding = database.prepare(`
      INSERT INTO privacy_export_file_bindings (
        export_id, owner_id, file_path, file_dev, file_ino,
        file_nlink, file_realpath, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInvalidation = database.prepare(`
      INSERT INTO privacy_export_invalidations (
        export_id, owner_id, invalidated_at, reason_code, file_path_snapshot
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const grant of grants) {
      const result = inspectLegacyExport(grant.file_path, root, rootRealpath);
      if (result.valid) {
        insertBinding.run(
          grant.id,
          grant.owner_id,
          path.resolve(grant.file_path),
          result.binding.dev,
          result.binding.ino,
          result.binding.nlink,
          result.binding.realpath,
          grant.created_at
        );
        migrated += 1;
      } else {
        insertInvalidation.run(
          grant.id,
          grant.owner_id,
          invalidatedAt,
          result.reason,
          path.resolve(grant.file_path)
        );
        invalidated += 1;
      }
    }
    database.prepare(`
      INSERT OR IGNORE INTO privacy_export_compatibility_receipts (
        migration_id, migrated_at
      ) VALUES ('privacy_export_file_binding_v1', ?)
    `).run(invalidatedAt);
    database.exec('COMMIT');
    return { migrated, invalidated };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
