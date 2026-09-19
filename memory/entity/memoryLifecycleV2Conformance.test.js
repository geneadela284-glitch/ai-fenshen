import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createInMemoryEntityFoundation } from './inMemoryFoundation.js';
import { registerMemoryLifecycleV2Conformance } from './memoryLifecycleV2Conformance.js';
import { createSQLiteEntityFoundation } from './sqliteFoundation.js';

function clockHarness(openFoundation) {
  let instant = '2026-07-18T00:00:00.000Z';
  let foundation = openFoundation(() => instant);
  return {
    get foundation() { return foundation; },
    now() { return instant; },
    setNow(value) { instant = value; },
    async reopen() {
      foundation.close?.();
      foundation = openFoundation(() => instant);
    },
    async close() { foundation.close?.(); }
  };
}

registerMemoryLifecycleV2Conformance('InMemory Memory Lifecycle V2', async () => {
  let instant = '2026-07-18T00:00:00.000Z';
  const foundation = createInMemoryEntityFoundation({ now: () => instant });
  return {
    foundation,
    now() { return instant; },
    setNow(value) { instant = value; },
    async reopen() {},
    async close() {}
  };
});

registerMemoryLifecycleV2Conformance('Shadow SQLite Memory Lifecycle V2', async () => {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-lifecycle-v2-'));
  const databasePath = path.join(shadowRoot, 'memory-lifecycle-v2.sqlite');
  const harness = clockHarness((now) => createSQLiteEntityFoundation({
    shadowRoot,
    databasePath,
    repositoryRoot: process.cwd(),
    now
  }));
  const close = harness.close.bind(harness);
  harness.close = async () => {
    await close();
    fs.rmSync(shadowRoot, { recursive: true, force: true });
  };
  return harness;
});
