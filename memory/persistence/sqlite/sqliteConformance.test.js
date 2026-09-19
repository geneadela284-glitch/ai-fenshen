import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPersistenceAdapterConformanceSuite } from '../conformance.js';
import { createSQLitePersistenceAdapter } from './sqlitePersistenceAdapter.js';

const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sqlite-conformance-'));
const adapters = [];
let sequence = 0;

function factory() {
  sequence += 1;
  const adapter = createSQLitePersistenceAdapter({
    rootDirectory,
    databasePath: `conformance-${sequence}.sqlite`,
    backupDirectory: 'backups'
  });
  adapters.push(adapter);
  return adapter;
}

runPersistenceAdapterConformanceSuite(factory);

test.after(async () => {
  for (const adapter of adapters) await adapter.close();
  fs.rmSync(rootDirectory, { recursive: true, force: true });
});
