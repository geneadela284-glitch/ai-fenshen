import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSQLitePersistenceAdapter } from '../persistence/sqlite/sqlitePersistenceAdapter.js';
import { createPersistenceMemoryRepository } from '../repository/index.js';
import { MemoryLifeTimelineService } from './index.js';
import {
  TIMELINE_NOW,
  fakeLifeEvent,
  fakeTimelineContext,
  fakeTimelineMemory,
  fakeTimelineRepositoryContext
} from './testing/fixtures.js';

function options(overrides = {}) {
  return {
    idempotencyKey: null,
    requestId: 'fake-timeline-sqlite-request',
    expectedVersion: null,
    operationReason: 'fictional_timeline_acceptance',
    ...overrides
  };
}

test('real SQLite reopen preserves a read-only isolated Life Timeline', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-timeline-sqlite-'));
  const adapterOptions = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups' };
  let adapter;
  let repository;
  try {
    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(TIMELINE_NOW) });
    const contextA = fakeTimelineRepositoryContext();
    await repository.create(contextA, fakeTimelineMemory('fake-sqlite-preference'), options());
    await repository.create(contextA, fakeLifeEvent('fake-sqlite-life-event', {
      effectiveFrom: '2025-05-08T00:00:00.000Z',
      metadata: { timeline: { period: { id: 'fake-sqlite-period', title: '虚构人生阶段' } } }
    }), options());
    await repository.create(contextA, fakeTimelineMemory('fake-sqlite-sensitive', {
      memoryType: 'sensitive_memory', sensitivity: 'high', value: '虚构高敏感正文', normalizedValue: '虚构高敏感正文'
    }), options());
    await repository.create(contextA, fakeTimelineMemory('fake-sqlite-old-city', {
      memoryType: 'fact', predicate: 'lives_in', value: '虚构旧地点', normalizedValue: '虚构旧地点',
      effectiveFrom: '2024-01-01T00:00:00.000Z'
    }), options());
    await repository.supersede(contextA, 'fake-sqlite-old-city', fakeTimelineMemory('fake-sqlite-current-city', {
      memoryType: 'fact', predicate: 'lives_in', value: '虚构当前地点', normalizedValue: '虚构当前地点',
      effectiveFrom: '2026-01-01T00:00:00.000Z'
    }), options({ expectedVersion: 1, idempotencyKey: 'fake-timeline-supersede' }));
    await repository.create(contextA, fakeTimelineMemory('fake-sqlite-deleted'), options());
    await repository.moveToRecycleBin(contextA, 'fake-sqlite-deleted', options({ expectedVersion: 1 }));
    await repository.create(fakeTimelineRepositoryContext('fake-user-b'), fakeTimelineMemory('fake-sqlite-user-b', { userId: 'fake-user-b' }), options());

    await repository.close();
    repository = null;
    adapter = null;

    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(TIMELINE_NOW) });
    const service = new MemoryLifeTimelineService({ repository, clock: () => new Date(TIMELINE_NOW), idFactory: () => 'fake-sqlite-audit' });
    const before = await repository.count(contextA, { userId: 'fake-user-a', includeHistorical: true });
    const current = await service.build(fakeTimelineContext());
    assert.equal(current.ok, true);
    assert.equal(current.events.some((event) => event.memoryIds.includes('fake-sqlite-current-city')), true);
    assert.equal(current.events.some((event) => event.memoryIds.includes('fake-sqlite-old-city')), false);
    assert.equal(current.events.some((event) => event.memoryIds.includes('fake-sqlite-deleted')), false);
    const sensitive = current.events.find((event) => event.memoryIds.includes('fake-sqlite-sensitive'));
    assert.equal(sensitive.visibility, 'hidden_sensitive');
    assert.equal(JSON.stringify(current).includes('虚构高敏感正文'), false);
    assert.equal(current.periods[0].id, 'fake-sqlite-period');

    const history = await service.build(fakeTimelineContext(), { includeHistorical: true });
    assert.equal(history.events.some((event) => event.memoryIds.includes('fake-sqlite-old-city')), true);
    assert.equal(history.events.find((event) => event.memoryIds.includes('fake-sqlite-old-city')).status, 'historical');

    const userB = await service.build(fakeTimelineContext({
      authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b',
      requestId: 'fake-user-b-timeline', correlationId: 'fake-user-b-correlation'
    }));
    assert.deepEqual(userB.events.flatMap((event) => event.memoryIds), ['fake-sqlite-user-b']);
    assert.equal(userB.events.some((event) => event.memoryIds.includes('fake-sqlite-preference')), false);
    const after = await repository.count(contextA, { userId: 'fake-user-a', includeHistorical: true });
    assert.equal(after, before);
    assert.equal((await adapter.integrityCheck()).status, 'valid');
  } finally {
    if (repository) await repository.close();
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});
