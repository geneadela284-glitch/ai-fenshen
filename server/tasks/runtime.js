import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applyTasksMigrations } from './migrations.js';
import { TasksRepository } from './repository.js';
import { TasksService } from './service.js';

export function createTasksRuntime({
  databasePath,
  database: databaseOverride,
  applyMigrations = false,
  clock = () => new Date()
} = {}) {
  if (!databaseOverride && !databasePath) throw new Error('Tasks databasePath is required.');
  const database = databaseOverride || new DatabaseSync(path.resolve(databasePath));
  database.exec('PRAGMA foreign_keys = ON');
  if (applyMigrations) applyTasksMigrations(database);
  const repository = new TasksRepository({ database, clock });
  const service = new TasksService({ repository, clock });
  let closed = false;
  return {
    database,
    repository,
    service,
    clock,
    close() {
      if (closed) return;
      closed = true;
      if (!databaseOverride) database.close();
    }
  };
}
