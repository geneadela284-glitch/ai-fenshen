import { randomUUID } from 'node:crypto';
import { applyHealthMigrations, HealthRepository, healthError } from './repository.js';
import { HealthService } from './service.js';
function assertSharedDatabase(database, tasksService) {
  if (!database || !tasksService || tasksService.repository?.database !== database) {
    throw new Error('HEALTH_SHARED_DATABASE_REQUIRED');
  }
}
export function createHealthRuntime({
  database,
  tasksService,
  encryptionKey,
  clock = () => new Date(),
  applyMigrations = false
} = {}) {
  assertSharedDatabase(database, tasksService);
  if (applyMigrations) applyHealthMigrations(database);
  const repository = new HealthRepository({
    database,
    encryptionKey,
    clock
  });
  const service = new HealthService({
    repository,
    tasksService,
    clock
  });
  let closed = false;
  return {
    database,
    repository,
    service,
    clock,
    close() {
      if (closed) return;
      closed = true;
      repository.key.fill(0);
    }
  };
}
function ownerId(value) {
  if (typeof value !== 'string' || !value.trim()) throw healthError('AUTH_REQUIRED', 401);
  return value.trim();
}
export function createHealthLifecycleRuntime({
  database,
  tasksService,
  encryptionKey,
  clock = () => new Date()
} = {}) {
  assertSharedDatabase(database, tasksService);
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'health_records'").get();
  if (!exists) return null;
  if (Buffer.isBuffer(encryptionKey) && encryptionKey.length === 32) {
    return createHealthRuntime({
      database,
      tasksService,
      encryptionKey,
      clock,
      applyMigrations: false
    });
  }
  const service = {
    healthIdForTask(owner, taskId) {
      return database.prepare('SELECT health_id FROM health_task_links WHERE user_id = ? AND task_id = ?').get(ownerId(owner), taskId)?.health_id || null;
    },
    export(owner) {
      owner = ownerId(owner);
      if (database.prepare('SELECT 1 FROM health_records WHERE user_id = ? LIMIT 1').get(owner)) {
        throw healthError('HEALTH_KEY_REQUIRED', 503);
      }
      return {
        version: 'health-v1',
        exportedAt: clock().toISOString(),
        records: []
      };
    },
    list(owner) {
      return this.export(owner).records;
    },
    deleteAllForOwner(owner) {
      owner = ownerId(owner);
      const savepoint = `health_lifecycle_${randomUUID().replaceAll('-', '')}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const links = database.prepare('SELECT task_id FROM health_task_links WHERE user_id = ?').all(owner);
        for (const link of links) tasksService.update(owner, link.task_id, {
          status: 'cancelled'
        });
        const removed = Number(database.prepare('DELETE FROM health_records WHERE user_id = ?').run(owner).changes);
        for (const table of ['health_requests', 'health_audit', 'health_task_links']) {
          database.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(owner);
        }
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return removed;
      } catch (error) {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }
  };
  return {
    database,
    service,
    clock,
    lifecycleOnly: true,
    close() {}
  };
}
