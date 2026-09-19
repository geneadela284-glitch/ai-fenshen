import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyFinanceMigrations } from './migrations.js';
import { FinanceRepository } from './repository.js';
import { FinanceService } from './service.js';
import { MonthlyFinanceReportService } from './monthlyReportService.js';

const F2_0_1_REQUIRED_SCHEMA_VERSION = 2;

function financeF201SchemaNotReady() {
  return Object.assign(
    new Error(
      'Finance 2.0-1 schema is not ready. Disable AI_SECRETARY_FINANCE_F2_0_1_ENABLED or run the separately authorized Migration first.'
    ),
    { code: 'FINANCE_F2_0_1_SCHEMA_NOT_READY' }
  );
}

function readFinanceSchemaVersion(database) {
  try {
    const table = database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'finance_schema_versions'
    `).get();
    if (!table) return null;
    const row = database.prepare('SELECT MAX(version) AS version FROM finance_schema_versions').get();
    return Number.isSafeInteger(row?.version) ? row.version : null;
  } catch {
    return null;
  }
}

export function assertFinanceF201SchemaReady({ databasePath, database: databaseOverride } = {}) {
  let database = databaseOverride || null;
  let closeProbe = false;
  if (!database) {
    if (!databasePath) throw financeF201SchemaNotReady();
    const resolvedPath = path.resolve(databasePath);
    if (!existsSync(resolvedPath)) throw financeF201SchemaNotReady();
    try {
      database = new DatabaseSync(resolvedPath, { readOnly: true });
      closeProbe = true;
    } catch {
      throw financeF201SchemaNotReady();
    }
  }
  try {
    const version = readFinanceSchemaVersion(database);
    if (version === null || version < F2_0_1_REQUIRED_SCHEMA_VERSION) {
      throw financeF201SchemaNotReady();
    }
  } finally {
    if (closeProbe) database.close();
  }
}

export function createFinanceRuntime({ databasePath, database: databaseOverride, applyMigrations = false,
  f201Enabled = false, timezone = 'Asia/Shanghai', clock = () => new Date() } = {}) {
  if (!databaseOverride && !databasePath) throw new Error('Finance databasePath is required.');
  if (typeof f201Enabled !== 'boolean') {
    throw new Error('Finance f201Enabled must be a boolean.');
  }
  if (f201Enabled && applyMigrations) {
    throw Object.assign(
      new Error('Finance 2.0-1 automatic Migration is forbidden.'),
      { code: 'FINANCE_F2_0_1_AUTO_MIGRATION_FORBIDDEN' }
    );
  }
  if (f201Enabled) {
    assertFinanceF201SchemaReady({ databasePath, database: databaseOverride });
  }
  const database = databaseOverride || new DatabaseSync(path.resolve(databasePath));
  database.exec('PRAGMA foreign_keys = ON');
  if (applyMigrations) applyFinanceMigrations(database);
  const repository = new FinanceRepository({ database, clock, timezone, f201Enabled });
  const service = new FinanceService({ repository, clock, timezone });
  const reportService = new MonthlyFinanceReportService({ repository, clock, timezone });
  let closed = false;
  return {
    database, repository, service, reportService, timezone, clock,
    close() {
      if (closed) return;
      closed = true;
      if (!databaseOverride) database.close();
    }
  };
}
