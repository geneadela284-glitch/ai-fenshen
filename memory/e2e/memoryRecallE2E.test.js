import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInMemoryEntityFoundation } from '../entity/inMemoryFoundation.js';
import { createSQLiteEntityFoundation } from '../entity/sqliteFoundation.js';
import { registerMemoryRecallE2EConformance } from './memoryRecallE2EConformance.js';

const Conversation = await import('./fakeConversationHarness.js').catch(() => ({}));
const Planner = await import('./fakeQueryPlanner.js').catch(() => ({}));
const Orchestrator = await import('./memoryRecallE2EOrchestrator.js').catch(() => ({}));

const REPOSITORY_ROOT = process.cwd();

test('Sprint 4F exposes only fake conversation, planning, and E2E orchestration adapters', () => {
  assert.equal(typeof Conversation.createFakeConversationHarness, 'function');
  assert.equal(typeof Planner.createFakeQueryPlanner, 'function');
  assert.equal(typeof Orchestrator.createMemoryRecallE2EOrchestrator, 'function');
});

async function inMemoryBackend() {
  const backend = {
    type: 'in-memory',
    foundation: createInMemoryEntityFoundation(),
    async close() {}
  };
  return backend;
}

async function sqliteBackend() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-entity-shadow-sprint4f-e2e-'));
  const databasePath = path.join(root, 'shadow.sqlite');
  let foundation = createSQLiteEntityFoundation({
    shadowRoot: root,
    databasePath,
    repositoryRoot: REPOSITORY_ROOT
  });
  let closed = false;
  return {
    type: 'shadow-sqlite',
    root,
    databasePath,
    get foundation() { return foundation; },
    async reopen() {
      foundation.close();
      foundation = createSQLiteEntityFoundation({
        shadowRoot: root,
        databasePath,
        repositoryRoot: REPOSITORY_ROOT
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      foundation.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

registerMemoryRecallE2EConformance('Sprint 4F InMemory E2E', inMemoryBackend);
registerMemoryRecallE2EConformance('Sprint 4F Shadow SQLite E2E', sqliteBackend, {
  sqliteRestart: true,
  repositoryRoot: REPOSITORY_ROOT
});
