import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createInMemoryEntityFoundation } from './inMemoryFoundation.js';
import { createSQLiteEntityFoundation } from './sqliteFoundation.js';
import { registerV2PresenceConformance } from './v2PresenceConformance.js';

registerV2PresenceConformance('InMemory V2 Presence', async () => {
  const foundation = createInMemoryEntityFoundation();
  return {
    foundation,
    async assertNoFullScan() {
      foundation.memories.holder.state.memories.values = () => {
        throw new Error('full Memory scan is forbidden');
      };
    },
    async reopen() {}
  };
});

registerV2PresenceConformance('Shadow SQLite V2 Presence', async () => {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-v2-presence-'));
  const databasePath = path.join(shadowRoot, 'v2-presence.sqlite');
  let foundation = createSQLiteEntityFoundation({
    shadowRoot,
    databasePath,
    repositoryRoot: process.cwd()
  });
  return {
    get foundation() { return foundation; },
    async assertNoFullScan() {
      const plan = foundation.diagnostics.queryPlan('memory-v2-presence');
      if (plan.some((line) => /SCAN memory_records_v2\b/i.test(line))) {
        throw new Error(`full Memory scan detected: ${plan.join('; ')}`);
      }
    },
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
