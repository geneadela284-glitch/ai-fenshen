import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createInMemoryEntityFoundation } from '../entity/inMemoryFoundation.js';
import { createSQLiteEntityFoundation } from '../entity/sqliteFoundation.js';
import { registerRankingV2Conformance } from './rankingV2Conformance.js';

registerRankingV2Conformance('InMemory RankingInputV2', async () => {
  const foundation = createInMemoryEntityFoundation();
  return { foundation, async reopen() {} };
});

registerRankingV2Conformance('Shadow SQLite RankingInputV2', async () => {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-ranking-v2-'));
  const databasePath = path.join(shadowRoot, 'ranking-v2.sqlite');
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
