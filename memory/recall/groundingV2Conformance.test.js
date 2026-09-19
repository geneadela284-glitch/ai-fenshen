import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createInMemoryEntityFoundation } from '../entity/inMemoryFoundation.js';
import { createSQLiteEntityFoundation } from '../entity/sqliteFoundation.js';
import { registerGroundingV2Conformance } from './groundingV2Conformance.js';

registerGroundingV2Conformance('InMemory Evidence Grounding V2', async () => {
  const foundation = createInMemoryEntityFoundation();
  return { foundation, async reopen() {} };
});

registerGroundingV2Conformance('Shadow SQLite Evidence Grounding V2', async () => {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-grounding-v2-'));
  const databasePath = path.join(shadowRoot, 'grounding-v2.sqlite');
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
