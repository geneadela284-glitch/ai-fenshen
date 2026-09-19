import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { registerMemoryQueryV2Conformance } from './memoryQueryV2Conformance.js';
import { createInMemoryEntityFoundation } from './inMemoryFoundation.js';
import { createSQLiteEntityFoundation } from './sqliteFoundation.js';
import { computeMemoryRecordV2Checksum } from './validation.js';

registerMemoryQueryV2Conformance('InMemory MemoryQueryV2 conformance', async () => {
  const foundation = createInMemoryEntityFoundation();
  return {
    foundation,
    async assertNoFullScan() {
      foundation.memories.holder.state.memories.values = () => {
        throw new Error('full Memory scan is forbidden');
      };
    },
    async corruptScopedRecord(memoryId, field, value) {
      const key = JSON.stringify(['user-entity-contract', memoryId]);
      const current = foundation.memories.holder.state.memories.get(key);
      const corrupted = { ...structuredClone(current), [field]: value };
      corrupted.checksum = computeMemoryRecordV2Checksum(corrupted);
      foundation.memories.holder.state.memories.set(key, corrupted);
    },
    async reopen() {}
  };
});

registerMemoryQueryV2Conformance('Shadow SQLite MemoryQueryV2 conformance', async () => {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-'));
  const databasePath = path.join(shadowRoot, 'memory-query-v2.sqlite');
  let foundation = createSQLiteEntityFoundation({
    shadowRoot,
    databasePath,
    repositoryRoot: process.cwd()
  });
  return {
    get foundation() { return foundation; },
    async assertNoFullScan() {
      const plan = foundation.diagnostics.queryPlan('memory-query-v2');
      if (plan.some((line) => /SCAN memory_records_v2\b/i.test(line))) {
        throw new Error(`full Memory scan detected: ${plan.join('; ')}`);
      }
    },
    async corruptScopedRecord(memoryId, field, value) {
      const db = new DatabaseSync(databasePath);
      try {
        const row = db.prepare(`
          SELECT payload_json FROM memory_records_v2
          WHERE owner_user_id = ? AND memory_id = ?
        `).get('user-entity-contract', memoryId);
        const corrupted = { ...JSON.parse(row.payload_json), [field]: value };
        corrupted.checksum = computeMemoryRecordV2Checksum(corrupted);
        db.prepare(`
          UPDATE memory_records_v2 SET payload_json = ?
          WHERE owner_user_id = ? AND memory_id = ?
        `).run(JSON.stringify(corrupted), 'user-entity-contract', memoryId);
      } finally {
        db.close();
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
