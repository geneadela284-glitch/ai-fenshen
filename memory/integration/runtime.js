import fs from 'node:fs';
import path from 'node:path';

import { MemoryCaptureService } from '../capture/index.js';
import { MemoryGovernanceService } from '../governance/index.js';
import { LifeIntelligenceService } from '../intelligence/index.js';
import { createSQLitePersistenceAdapter } from '../persistence/sqlite/sqlitePersistenceAdapter.js';
import { MemoryRecallEngine } from '../recall/index.js';
import { createPersistenceMemoryRepository } from '../repository/index.js';
import { MemoryLifeTimelineService } from '../timeline/index.js';
import { AuthenticatedMemoryContextFactory } from './context.js';
import { MemoryFeatureFlags } from './featureFlags.js';
import { MemoryRealUserService } from './service.js';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function flag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function resolveRealUserMemoryPaths({ projectRoot = process.cwd(), env = process.env } = {}) {
  const explicit = env.AI_SECRETARY_MEMORY_DB ? path.resolve(env.AI_SECRETARY_MEMORY_DB) : null;
  const rootDirectory = explicit
    ? path.dirname(explicit)
    : path.resolve(env.AI_SECRETARY_DATA_DIR || path.join(projectRoot, 'data'), 'memory');
  const databasePath = explicit || path.join(rootDirectory, 'memory.sqlite');
  const authPath = env.AI_SECRETARY_AUTH_DB ? path.resolve(env.AI_SECRETARY_AUTH_DB) : path.resolve(projectRoot, 'data/auth/auth.sqlite');
  if (databasePath === authPath) fail('MEMORY_PATH_COLLIDES_WITH_AUTH', 'Memory database must be separate from authentication.');
  return Object.freeze({
    rootDirectory,
    databasePath,
    backupDirectory: path.join(rootDirectory, 'backups'),
    exportDirectory: path.join(rootDirectory, 'exports')
  });
}

export function createRealUserMemoryRuntime({
  projectRoot = process.cwd(),
  env = process.env,
  clock = () => new Date(),
  idFactory
} = {}) {
  const paths = resolveRealUserMemoryPaths({ projectRoot, env });
  const adapter = createSQLitePersistenceAdapter({
    rootDirectory: paths.rootDirectory,
    databasePath: paths.databasePath,
    backupDirectory: 'backups',
    clock
  });
  const repository = createPersistenceMemoryRepository({ adapter, clock });
  const contextFactory = new AuthenticatedMemoryContextFactory({ clock, ...(idFactory ? { idFactory } : {}) });
  const flags = new MemoryFeatureFlags({ env });
  const capture = new MemoryCaptureService({ repository, clock, ...(idFactory ? { idFactory } : {}) });
  const recall = new MemoryRecallEngine({ repository });
  const governance = new MemoryGovernanceService({
    repository,
    clock,
    exportDirectory: paths.exportDirectory,
    ...(idFactory ? { idFactory } : {})
  });
  const timeline = new MemoryLifeTimelineService({ repository, clock, ...(idFactory ? { idFactory } : {}) });
  const intelligence = new LifeIntelligenceService({ clock, ...(idFactory ? { idFactory } : {}) });
  const service = new MemoryRealUserService({
    contextFactory, flags, capture, recall, governance, timeline, intelligence, clock, ...(idFactory ? { idFactory } : {})
  });
  let initialized = false;

  return {
    paths,
    adapter,
    repository,
    service,
    async initialize() {
      if (!flag(env.MEMORY_REAL_USER_ENABLED)) {
        return { status: 'disabled', integrity: 'not_run', backupVerified: false, pathSummary: 'data/memory/memory.sqlite' };
      }
      if (initialized) return { status: 'ready', integrity: 'valid', backupVerified: true, pathSummary: 'data/memory/memory.sqlite' };
      await adapter.open();
      const integrity = await adapter.integrityCheck();
      if (integrity.status !== 'valid') fail('PERSISTENCE_CORRUPT', 'Memory database integrity check failed.');
      fs.mkdirSync(paths.backupDirectory, { recursive: true });
      let backupVerified = true;
      if (!fs.readdirSync(paths.backupDirectory).some((name) => name.endsWith('.sqlite'))) {
        const backup = await adapter.createBackup();
        backupVerified = (await adapter.verifyBackup(backup.id)).status === 'valid';
      }
      initialized = true;
      const relative = path.relative(projectRoot, paths.databasePath);
      const pathSummary = relative && !relative.startsWith('..') ? relative : path.basename(paths.databasePath);
      return { status: 'ready', integrity: integrity.status, backupVerified, pathSummary };
    },
    async close() {
      try { await repository.close(); } finally { await adapter.close(); }
      initialized = false;
    }
  };
}
