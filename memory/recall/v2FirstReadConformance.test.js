import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createInMemoryEntityFoundation } from '../entity/inMemoryFoundation.js';
import { createSQLiteEntityFoundation } from '../entity/sqliteFoundation.js';
import { registerV2FirstReadConformance } from './v2FirstReadConformance.js';

registerV2FirstReadConformance('InMemory V2-first read', async () => {
  const foundation = createInMemoryEntityFoundation();
  return { foundation, async reopen() {} };
});

registerV2FirstReadConformance('Shadow SQLite V2-first read', async () => {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-v2-first-read-'));
  const databasePath = path.join(shadowRoot, 'v2-first-read.sqlite');
  let foundation = createSQLiteEntityFoundation({
    shadowRoot,
    databasePath,
    repositoryRoot: process.cwd()
  });
  return {
    get foundation() { return foundation; },
    async reopen() {
      foundation.close();
      foundation = createSQLiteEntityFoundation({
        shadowRoot,
        databasePath,
        repositoryRoot: process.cwd()
      });
    },
    async close() {
      foundation?.close();
      fs.rmSync(shadowRoot, { recursive: true, force: true });
    }
  };
});
