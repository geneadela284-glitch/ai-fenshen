import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryType } from '../kernel/index.js';
import { createSQLitePersistenceAdapter } from '../persistence/sqlite/sqlitePersistenceAdapter.js';
import { createPersistenceMemoryRepository } from '../repository/index.js';
import { MemoryLifeTimelineService } from '../timeline/index.js';
import {
  TIMELINE_NOW,
  fakeTimelineContext,
  fakeTimelineMemory,
  fakeTimelineRepositoryContext
} from '../timeline/testing/fixtures.js';
import { LifeIntelligenceService } from './index.js';

function options(overrides = {}) {
  return { idempotencyKey: null, requestId: 'fake-intelligence-sqlite', expectedVersion: null, operationReason: 'fictional_life_intelligence_acceptance', ...overrides };
}

function habit(id, date) {
  return fakeTimelineMemory(id, {
    memoryType: MemoryType.HABIT_ROUTINE,
    predicate: 'does_reading',
    value: `虚构阅读记录-${id}`,
    normalizedValue: 'reading',
    effectiveFrom: date,
    createdAt: date,
    updatedAt: date
  });
}

test('real SQLite reopen supports isolated read-only Life Intelligence', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-intelligence-sqlite-'));
  const adapterOptions = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups' };
  let adapter;
  let repository;
  try {
    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(TIMELINE_NOW) });
    const contextA = fakeTimelineRepositoryContext();
    for (const item of [
      habit('sqlite-reading-1', '2026-05-01T00:00:00.000Z'),
      habit('sqlite-reading-2', '2026-06-01T00:00:00.000Z'),
      habit('sqlite-reading-3', '2026-07-01T00:00:00.000Z'),
      fakeTimelineMemory('sqlite-goal-old', { memoryType: MemoryType.GOAL, predicate: 'has_goal', value: '虚构旧目标', normalizedValue: 'goal-a', effectiveFrom: '2025-01-01T00:00:00.000Z' }),
      fakeTimelineMemory('sqlite-stage', { memoryType: MemoryType.LIFE_EVENT, effectiveFrom: '2026-01-01T00:00:00.000Z', metadata: { timeline: { period: { id: 'sqlite-period', title: '虚构创业阶段' } } } }),
      fakeTimelineMemory('sqlite-sensitive', { memoryType: MemoryType.SENSITIVE_MEMORY, sensitivity: 'high', value: '虚构高敏感正文', normalizedValue: '虚构高敏感正文' })
    ]) await repository.create(contextA, item, options());
    await repository.supersede(contextA, 'sqlite-goal-old', fakeTimelineMemory('sqlite-goal-new', {
      memoryType: MemoryType.GOAL,
      predicate: 'has_goal',
      value: '虚构新目标',
      normalizedValue: 'goal-b',
      effectiveFrom: '2026-07-01T00:00:00.000Z'
    }), options({ expectedVersion: 1, idempotencyKey: 'fake-intelligence-goal-change' }));
    await repository.create(fakeTimelineRepositoryContext('fake-user-b'), {
      ...habit('sqlite-user-b', '2026-07-01T00:00:00.000Z'),
      userId: 'fake-user-b'
    }, options());

    await repository.close();
    repository = null;
    adapter = null;

    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(TIMELINE_NOW) });
    const timelineService = new MemoryLifeTimelineService({ repository, clock: () => new Date(TIMELINE_NOW), idFactory: () => 'fake-intelligence-timeline-audit' });
    const intelligence = new LifeIntelligenceService({ clock: () => new Date(TIMELINE_NOW), idFactory: () => 'fake-intelligence-audit' });
    const before = await repository.count(contextA, { userId: 'fake-user-a', includeHistorical: true });
    const timelineA = await timelineService.build(fakeTimelineContext(), { includeHistorical: true });
    const resultA = intelligence.analyze(fakeTimelineContext(), timelineA);
    assert.equal(resultA.patterns.length, 1);
    assert.equal(resultA.trends.length, 1);
    assert.equal(resultA.stages.length, 1);
    assert.equal(resultA.insights.length, 3);
    assert.equal(resultA.suggestions.length, 3);
    assert.equal(JSON.stringify(resultA).includes('虚构高敏感正文'), false);

    const contextB = fakeTimelineContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b', requestId: 'fake-user-b-intelligence', correlationId: 'fake-user-b-intelligence-correlation' });
    const resultB = intelligence.analyze(contextB, await timelineService.build(contextB, { includeHistorical: true }));
    assert.equal(resultB.patterns.length, 0);
    assert.equal(JSON.stringify(resultB).includes('sqlite-reading-1'), false);
    const after = await repository.count(contextA, { userId: 'fake-user-a', includeHistorical: true });
    assert.equal(after, before);
    assert.equal((await adapter.integrityCheck()).status, 'valid');
  } finally {
    if (repository) await repository.close();
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});
