import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { mergeAttachmentLimits } from './contract.js';
import { applyAttachmentMigrations } from './migrations.js';
import { AttachmentRepository } from './repository.js';
import { AttachmentService } from './service.js';
import { AttachmentStorage } from './storage.js';
import { EvidenceMerger } from './evidenceMerger.js';
import { AttachmentProcessingService } from './processingService.js';
import { AttachmentProviderExecutor } from './providerExecutor.js';

function secureDatabaseFiles(databasePath) {
  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`
  ]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

export function createAttachmentRuntime({
  databasePath,
  database: databaseOverride,
  storageRoot,
  accessControl,
  conversationRuntime,
  aiService = null,
  providerExecutor: providerExecutorOverride = null,
  limits: limitsInput,
  clock = () => new Date(),
  logger = () => {},
  cleanupIntervalMs = 60 * 1000
} = {}) {
  if (!databaseOverride && (!databasePath || !path.isAbsolute(databasePath))) {
    throw new Error('Attachment databasePath is required.');
  }
  if (!accessControl) throw new Error('Attachment accessControl is required.');
  const resolvedDatabasePath = databaseOverride ? null : path.normalize(databasePath);
  if (resolvedDatabasePath) {
    mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(resolvedDatabasePath), 0o700);
  }
  const database = databaseOverride || new DatabaseSync(resolvedDatabasePath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  applyAttachmentMigrations(database);
  if (resolvedDatabasePath) secureDatabaseFiles(resolvedDatabasePath);
  const limits = mergeAttachmentLimits(limitsInput);
  const repository = new AttachmentRepository({ database, clock });
  const storage = new AttachmentStorage({ root: storageRoot });
  const service = new AttachmentService({
    repository,
    storage,
    accessControl,
    conversationRuntime,
    limits,
    clock,
    logger
  });
  const providerExecutor = providerExecutorOverride ||
    (typeof aiService?.runExactCapability === 'function'
      ? new AttachmentProviderExecutor({ aiService })
      : null);
  const processingService = providerExecutor
    ? new AttachmentProcessingService({
        repository,
        storage,
        providerExecutor,
        evidenceMerger: new EvidenceMerger(),
        conversationRuntime,
        logger
      })
    : null;
  service.setProcessingService(processingService);
  try { processingService?.recoverInterruptedJobs(); } catch {}
  try { service.cleanupExpired(); } catch {}
  const timer = setInterval(() => {
    try { service.cleanupExpired(); } catch {}
  }, Math.max(10, Number(cleanupIntervalMs) || 60 * 1000));
  timer.unref?.();
  let closed = false;
  return {
    database,
    databasePath: resolvedDatabasePath,
    repository,
    storage,
    service,
    processingService,
    limits,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { service.cleanupExpired(); } catch {}
      if (resolvedDatabasePath) secureDatabaseFiles(resolvedDatabasePath);
      if (!databaseOverride) database.close();
      if (resolvedDatabasePath) secureDatabaseFiles(resolvedDatabasePath);
    }
  };
}
