import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(code), { code });
  return normalized;
}

function tokenDigest(value) {
  return crypto.createHash('sha256').update(required(value, 'TOKEN_REQUIRED')).digest('hex');
}

function consentRow(row, currentPolicy) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.owner_id,
    privacyNoticeVersion: row.privacy_notice_version,
    termsVersion: row.terms_version,
    acceptedAt: row.accepted_at,
    locale: row.locale,
    status: row.status,
    withdrewAt: row.withdrew_at || null,
    source: row.source,
    current: row.privacy_notice_version === currentPolicy.privacyNoticeVersion &&
      row.terms_version === currentPolicy.termsVersion &&
      row.status === 'accepted' &&
      !row.withdrew_at
  };
}

function receiptRow(row) {
  return row ? {
    receiptId: row.receipt_id,
    subjectRef: row.subject_ref,
    status: row.status,
    completedAt: row.completed_at,
    scopeVersion: row.scope_version,
    tombstoneVersion: row.tombstone_version,
    signature: row.signature
  } : null;
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function hasExportCompatibilityReceipt(database) {
  if (!tableExists(database, 'privacy_export_compatibility_receipts')) return false;
  return Boolean(database.prepare(`
    SELECT 1 AS found FROM privacy_export_compatibility_receipts
    WHERE migration_id = 'privacy_export_file_binding_v1'
  `).get());
}

function requiresExportCompatibilityMigration(database, databaseExisted) {
  if (!databaseExisted) return false;
  if (!tableExists(database, 'privacy_export_file_bindings') ||
      !tableExists(database, 'privacy_export_invalidations')) return true;
  const baseSchemaExists = tableExists(database, 'privacy_consents') &&
    tableExists(database, 'privacy_export_grants');
  if (!baseSchemaExists && !hasExportCompatibilityReceipt(database)) return true;
  if (!tableExists(database, 'privacy_export_grants')) return false;
  return Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM privacy_export_grants AS grants
    LEFT JOIN privacy_export_file_bindings AS bindings ON bindings.export_id = grants.id
    LEFT JOIN privacy_export_invalidations AS invalidations ON invalidations.export_id = grants.id
    WHERE bindings.export_id IS NULL AND invalidations.export_id IS NULL
  `).get().count) > 0;
}

export class PrivacyStore {
  constructor({ dbPath, policy, now = () => new Date().toISOString() } = {}) {
    this.dbPath = path.resolve(required(dbPath, 'PRIVACY_DB_REQUIRED'));
    this.policy = policy;
    this.now = now;
    this.database = null;
  }

  initialize() {
    const databaseExisted = existsSync(this.dbPath);
    mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(this.dbPath), 0o700);
    this.database = new DatabaseSync(this.dbPath);
    if (requiresExportCompatibilityMigration(this.database, databaseExisted)) {
      throw Object.assign(new Error('Explicit Privacy export compatibility Migration is required.'), {
        code: 'PRIVACY_EXPORT_COMPATIBILITY_MIGRATION_REQUIRED'
      });
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS privacy_consents (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        privacy_notice_version TEXT NOT NULL,
        terms_version TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        locale TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('accepted', 'withdrawn')),
        withdrew_at TEXT,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_privacy_consents_owner
        ON privacy_consents(owner_id, accepted_at DESC);

      CREATE TABLE IF NOT EXISTS privacy_export_grants (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_privacy_exports_owner
        ON privacy_export_grants(owner_id, expires_at);

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

      CREATE TABLE IF NOT EXISTS generated_report_records (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        report_type TEXT NOT NULL,
        format TEXT NOT NULL,
        period_start TEXT,
        period_end TEXT,
        generated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_generated_reports_owner
        ON generated_report_records(owner_id, generated_at DESC);

      CREATE TABLE IF NOT EXISTS deletion_requests (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        subject_ref TEXT,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'failed', 'completed')),
        failure_code TEXT,
        receipt_id TEXT
      );

      CREATE TABLE IF NOT EXISTS deletion_receipts (
        receipt_id TEXT PRIMARY KEY,
        subject_ref TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL CHECK(status = 'completed'),
        completed_at TEXT NOT NULL,
        scope_version TEXT NOT NULL,
        tombstone_version TEXT NOT NULL,
        signature TEXT NOT NULL
      );
    `);
    this.#secureFiles();
    return this;
  }

  #secureFiles() {
    for (const candidate of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }

  close() {
    this.database?.close();
    this.database = null;
  }

  getConsent(ownerId) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const row = this.database.prepare(`
      SELECT * FROM privacy_consents
      WHERE owner_id = ?
      ORDER BY accepted_at DESC, rowid DESC
      LIMIT 1
    `).get(owner);
    const consent = consentRow(row, this.policy);
    return consent?.current ? consent : {
      userId: owner,
      privacyNoticeVersion: this.policy.privacyNoticeVersion,
      termsVersion: this.policy.termsVersion,
      acceptedAt: null,
      locale: this.policy.locale,
      status: 'pending',
      withdrewAt: null,
      source: null,
      current: false
    };
  }

  listConsents(ownerId) {
    return this.database.prepare(`
      SELECT * FROM privacy_consents
      WHERE owner_id = ?
      ORDER BY accepted_at ASC, rowid ASC
    `).all(required(ownerId, 'OWNER_REQUIRED')).map((row) => consentRow(row, this.policy));
  }

  acceptConsent({ ownerId, privacyNoticeVersion, termsVersion, locale, source } = {}) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    if (privacyNoticeVersion !== this.policy.privacyNoticeVersion ||
        termsVersion !== this.policy.termsVersion) {
      throw Object.assign(new Error('PRIVACY_VERSION_MISMATCH'), { code: 'PRIVACY_VERSION_MISMATCH' });
    }
    const acceptedAt = this.now();
    const record = {
      id: `consent_${crypto.randomUUID()}`,
      userId: owner,
      privacyNoticeVersion,
      termsVersion,
      acceptedAt,
      locale: required(locale || this.policy.locale, 'CONSENT_LOCALE_REQUIRED').slice(0, 32),
      status: 'accepted',
      withdrewAt: null,
      source: required(source, 'CONSENT_SOURCE_REQUIRED').slice(0, 80)
    };
    this.database.prepare(`
      INSERT INTO privacy_consents (
        id, owner_id, privacy_notice_version, terms_version,
        accepted_at, locale, status, withdrew_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', NULL, ?)
    `).run(record.id, record.userId, record.privacyNoticeVersion, record.termsVersion,
      record.acceptedAt, record.locale, record.source);
    this.#secureFiles();
    return { ...record, current: true };
  }

  withdrawConsent(ownerId, source = 'settings') {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const current = this.getConsent(owner);
    if (!current.current) return current;
    const withdrewAt = this.now();
    this.database.prepare(`
      UPDATE privacy_consents
      SET status = 'withdrawn', withdrew_at = ?, source = ?
      WHERE id = ? AND owner_id = ?
    `).run(withdrewAt, required(source, 'CONSENT_SOURCE_REQUIRED').slice(0, 80), current.id, owner);
    this.#secureFiles();
    return this.getConsent(owner);
  }

  createExportGrant({ ownerId, token, filePath, fileBinding, ttlMs } = {}) {
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    const binding = {
      ownerId: required(fileBinding?.ownerId, 'EXPORT_BINDING_OWNER_REQUIRED'),
      dev: required(fileBinding?.dev, 'EXPORT_BINDING_DEVICE_REQUIRED'),
      ino: required(fileBinding?.ino, 'EXPORT_BINDING_INODE_REQUIRED'),
      nlink: Number(fileBinding?.nlink),
      realpath: path.resolve(required(fileBinding?.realpath, 'EXPORT_BINDING_REALPATH_REQUIRED'))
    };
    const row = {
      id: `export_${crypto.randomUUID()}`,
      ownerId: required(ownerId, 'OWNER_REQUIRED'),
      tokenHash: tokenDigest(token),
      filePath: path.resolve(required(filePath, 'EXPORT_FILE_REQUIRED')),
      createdAt,
      expiresAt
    };
    if (binding.ownerId !== row.ownerId || binding.nlink !== 1) {
      throw Object.assign(new Error('EXPORT_BINDING_INVALID'), { code: 'EXPORT_BINDING_INVALID' });
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO privacy_export_grants (
          id, owner_id, token_hash, file_path, created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(row.id, row.ownerId, row.tokenHash, row.filePath, row.createdAt, row.expiresAt);
      this.database.prepare(`
        INSERT INTO privacy_export_file_bindings (
          export_id, owner_id, file_path, file_dev, file_ino,
          file_nlink, file_realpath, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, row.ownerId, row.filePath, binding.dev, binding.ino,
        binding.nlink, binding.realpath, row.createdAt);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.#secureFiles();
    return { id: row.id, expiresAt };
  }

  listExportAuthorizations() {
    return this.database.prepare(`
      SELECT
        grants.id,
        grants.owner_id AS ownerId,
        grants.file_path AS filePath,
        grants.created_at AS createdAt,
        grants.expires_at AS expiresAt,
        grants.consumed_at AS consumedAt,
        bindings.owner_id AS bindingOwnerId,
        bindings.file_path AS bindingFilePath,
        bindings.file_dev AS bindingDev,
        bindings.file_ino AS bindingIno,
        bindings.file_nlink AS bindingNlink,
        bindings.file_realpath AS bindingRealpath
      FROM privacy_export_grants AS grants
      LEFT JOIN privacy_export_file_bindings AS bindings
        ON bindings.export_id = grants.id
      LEFT JOIN privacy_export_invalidations AS invalidations
        ON invalidations.export_id = grants.id
      WHERE invalidations.export_id IS NULL
      ORDER BY grants.created_at ASC, grants.rowid ASC
    `).all().map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      filePath: row.filePath,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt || null,
      binding: row.bindingDev == null ? null : {
        ownerId: row.bindingOwnerId,
        filePath: row.bindingFilePath,
        dev: String(row.bindingDev),
        ino: String(row.bindingIno),
        nlink: Number(row.bindingNlink),
        realpath: row.bindingRealpath
      }
    }));
  }

  getConsumableExport({ ownerId, token } = {}) {
    const row = this.database.prepare(`
      SELECT grants.*
      FROM privacy_export_grants AS grants
      LEFT JOIN privacy_export_invalidations AS invalidations ON invalidations.export_id = grants.id
      WHERE grants.token_hash = ? AND invalidations.export_id IS NULL
    `).get(tokenDigest(token));
    if (!row || row.owner_id !== required(ownerId, 'OWNER_REQUIRED')) {
      throw Object.assign(new Error('EXPORT_NOT_FOUND'), { code: 'EXPORT_NOT_FOUND' });
    }
    if (row.consumed_at || Date.parse(this.now()) >= Date.parse(row.expires_at)) {
      throw Object.assign(new Error('EXPORT_GONE'), { code: 'EXPORT_GONE' });
    }
    return { id: row.id, filePath: row.file_path, expiresAt: row.expires_at };
  }

  consumeExport({ ownerId, token, expectedGrantId } = {}) {
    const row = this.getConsumableExport({ ownerId, token });
    if (expectedGrantId && row.id !== expectedGrantId) {
      throw Object.assign(new Error('EXPORT_NOT_FOUND'), { code: 'EXPORT_NOT_FOUND' });
    }
    const consumedAt = this.now();
    const changed = this.database.prepare(`
      UPDATE privacy_export_grants SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL
    `).run(consumedAt, row.id).changes;
    if (changed !== 1) {
      throw Object.assign(new Error('EXPORT_GONE'), { code: 'EXPORT_GONE' });
    }
    this.#secureFiles();
    return row;
  }

  invalidateOwnerExports(ownerId, { validateFile } = {}) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const rows = this.database.prepare(`
      SELECT grants.file_path
      FROM privacy_export_grants AS grants
      LEFT JOIN privacy_export_invalidations AS invalidations ON invalidations.export_id = grants.id
      WHERE grants.owner_id = ? AND invalidations.export_id IS NULL
    `).all(owner);
    for (const row of rows) {
      if (existsSync(row.file_path)) {
        validateFile?.(row.file_path, 'export_invalidate_delete');
        unlinkSync(row.file_path);
      }
    }
    const deleted = this.database.prepare(`
      DELETE FROM privacy_export_grants
      WHERE owner_id = ? AND id NOT IN (SELECT export_id FROM privacy_export_invalidations)
    `).run(owner).changes;
    this.database.prepare(
      'DELETE FROM privacy_export_file_bindings WHERE owner_id = ?'
    ).run(owner);
    this.#secureFiles();
    return Number(deleted);
  }

  cleanupExports({ validateFile } = {}) {
    const now = this.now();
    const rows = this.database.prepare(`
      SELECT grants.id, grants.file_path
      FROM privacy_export_grants AS grants
      LEFT JOIN privacy_export_invalidations AS invalidations ON invalidations.export_id = grants.id
      WHERE invalidations.export_id IS NULL
        AND (grants.consumed_at IS NOT NULL OR grants.expires_at <= ?)
    `).all(now);
    for (const row of rows) {
      if (existsSync(row.file_path)) {
        validateFile?.(row.file_path, 'retention_delete');
        unlinkSync(row.file_path);
      }
    }
    this.#secureFiles();
    return rows.length;
  }

  hasOwnerExports(ownerId, { validateFile } = {}) {
    const rows = this.database.prepare(
      `SELECT grants.file_path
       FROM privacy_export_grants AS grants
       LEFT JOIN privacy_export_invalidations AS invalidations ON invalidations.export_id = grants.id
       WHERE grants.owner_id = ? AND grants.consumed_at IS NULL AND grants.expires_at > ?
         AND invalidations.export_id IS NULL`
    ).all(required(ownerId, 'OWNER_REQUIRED'), this.now());
    for (const row of rows) validateFile?.(row.file_path, 'export_status');
    return rows.length > 0;
  }

  hasOwnerExportMetadata(ownerId) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const grants = Number(this.database.prepare(
      'SELECT COUNT(*) AS count FROM privacy_export_grants WHERE owner_id = ?'
    ).get(owner).count);
    const invalidations = Number(this.database.prepare(
      'SELECT COUNT(*) AS count FROM privacy_export_invalidations WHERE owner_id = ?'
    ).get(owner).count);
    const bindings = Number(this.database.prepare(
      'SELECT COUNT(*) AS count FROM privacy_export_file_bindings WHERE owner_id = ?'
    ).get(owner).count);
    return grants > 0 || invalidations > 0 || bindings > 0;
  }

  recordGeneratedReport({ ownerId, reportType, format, periodStart = null, periodEnd = null } = {}) {
    const row = {
      id: `report_${crypto.randomUUID()}`,
      ownerId: required(ownerId, 'OWNER_REQUIRED'),
      reportType: required(reportType, 'REPORT_TYPE_REQUIRED'),
      format: required(format, 'REPORT_FORMAT_REQUIRED'),
      periodStart,
      periodEnd,
      generatedAt: this.now()
    };
    this.database.prepare(`
      INSERT INTO generated_report_records (
        id, owner_id, report_type, format, period_start, period_end, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.ownerId, row.reportType, row.format, row.periodStart, row.periodEnd, row.generatedAt);
    this.#secureFiles();
    return row;
  }

  listGeneratedReports(ownerId) {
    return this.database.prepare(`
      SELECT id, report_type AS reportType, format, period_start AS periodStart,
        period_end AS periodEnd, generated_at AS generatedAt
      FROM generated_report_records
      WHERE owner_id = ?
      ORDER BY generated_at ASC, rowid ASC
    `).all(required(ownerId, 'OWNER_REQUIRED')).map((row) => ({ ...row }));
  }

  createDeletionRequest({ ownerId, subjectRef, token, ttlMs } = {}) {
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    const row = {
      id: `delete_request_${crypto.randomUUID()}`,
      ownerId: required(ownerId, 'OWNER_REQUIRED'),
      subjectRef: required(subjectRef, 'SUBJECT_REF_REQUIRED'),
      tokenHash: tokenDigest(token),
      createdAt,
      expiresAt
    };
    this.database.prepare(`
      INSERT INTO deletion_requests (
        id, owner_id, subject_ref, token_hash, created_at, expires_at,
        status, failure_code, receipt_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)
    `).run(row.id, row.ownerId, row.subjectRef, row.tokenHash, row.createdAt, row.expiresAt);
    this.#secureFiles();
    return { id: row.id, expiresAt };
  }

  getDeletionRequest({ ownerId, subjectRef, token } = {}) {
    const row = this.database.prepare(
      'SELECT * FROM deletion_requests WHERE token_hash = ?'
    ).get(tokenDigest(token));
    if (!row || (row.owner_id && row.owner_id !== required(ownerId, 'OWNER_REQUIRED')) ||
        row.subject_ref !== required(subjectRef, 'SUBJECT_REF_REQUIRED')) {
      throw Object.assign(new Error('DELETION_REQUEST_NOT_FOUND'), { code: 'DELETION_REQUEST_NOT_FOUND' });
    }
    if (row.status !== 'completed' && Date.parse(this.now()) >= Date.parse(row.expires_at)) {
      throw Object.assign(new Error('DELETION_REQUEST_EXPIRED'), { code: 'DELETION_REQUEST_EXPIRED' });
    }
    return { ...row };
  }

  markDeletionProcessing(id) {
    this.database.prepare(`
      UPDATE deletion_requests SET status = 'processing', failure_code = NULL WHERE id = ?
    `).run(required(id, 'DELETION_REQUEST_ID_REQUIRED'));
    this.#secureFiles();
  }

  markDeletionFailed(id, code) {
    this.database.prepare(`
      UPDATE deletion_requests SET status = 'failed', failure_code = ? WHERE id = ?
    `).run(String(code || 'DELETION_FAILED').slice(0, 120), required(id, 'DELETION_REQUEST_ID_REQUIRED'));
    this.#secureFiles();
  }

  deleteOwnerPrivacyData(ownerId) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM privacy_consents WHERE owner_id = ?').run(owner);
      this.database.prepare('DELETE FROM generated_report_records WHERE owner_id = ?').run(owner);
      this.database.prepare('DELETE FROM privacy_export_file_bindings WHERE owner_id = ?').run(owner);
      this.database.prepare('DELETE FROM privacy_export_invalidations WHERE owner_id = ?').run(owner);
      this.database.prepare('DELETE FROM privacy_export_grants WHERE owner_id = ?').run(owner);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.#secureFiles();
  }

  completeDeletion({ requestId, receipt } = {}) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO deletion_receipts (
          receipt_id, subject_ref, status, completed_at,
          scope_version, tombstone_version, signature
        ) VALUES (?, ?, 'completed', ?, ?, ?, ?)
      `).run(receipt.receiptId, receipt.subjectRef, receipt.completedAt,
        receipt.scopeVersion, receipt.tombstoneVersion, receipt.signature);
      this.database.prepare(`
        UPDATE deletion_requests
        SET owner_id = NULL, status = 'completed', failure_code = NULL, receipt_id = ?
        WHERE id = ?
      `).run(receipt.receiptId, required(requestId, 'DELETION_REQUEST_ID_REQUIRED'));
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.#secureFiles();
    return receipt;
  }

  getDeletionReceipt(receiptId) {
    return receiptRow(this.database.prepare(
      'SELECT * FROM deletion_receipts WHERE receipt_id = ?'
    ).get(required(receiptId, 'RECEIPT_ID_REQUIRED')));
  }

  listDeletionReceipts() {
    return this.database.prepare(
      'SELECT * FROM deletion_receipts ORDER BY completed_at ASC'
    ).all().map(receiptRow);
  }
}
