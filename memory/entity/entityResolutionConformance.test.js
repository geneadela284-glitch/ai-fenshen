import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerEntityResolutionConformance } from './entityResolutionConformance.js';
import { createInMemoryEntityFoundation } from './inMemoryFoundation.js';
import { createSQLiteEntityFoundation } from './sqliteFoundation.js';

registerEntityResolutionConformance('InMemory Entity Resolution', async () => ({
  foundation: createInMemoryEntityFoundation()
}));

registerEntityResolutionConformance('Shadow SQLite Entity Resolution', async () => {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-resolution-'));
  const databasePath = path.join(shadowRoot, 'entity-resolution.sqlite');
  const foundation = createSQLiteEntityFoundation({
    shadowRoot,
    databasePath,
    repositoryRoot: process.cwd()
  });
  return {
    foundation,
    close() {
      foundation.close();
      fs.rmSync(shadowRoot, { recursive: true, force: true });
    }
  };
});
