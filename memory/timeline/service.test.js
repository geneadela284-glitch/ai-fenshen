import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryMemoryRepository } from '../repository/index.js';
import { MemoryLifeTimelineService } from './index.js';
import {
  fakeTimelineContext,
  fakeTimelineMemory,
  seedTimelineRepository
} from './testing/fixtures.js';

async function setup(records = []) {
  const repository = createInMemoryMemoryRepository({ clock: () => new Date('2026-07-15T08:00:00.000Z') });
  await seedTimelineRepository(repository, records);
  return { repository, service: new MemoryLifeTimelineService({ repository, idFactory: (() => { let n = 0; return () => `fake-${++n}`; })() }) };
}

test('MemoryLifeTimelineService builds a timeline from Repository Memory', async () => {
  const { service } = await setup([fakeTimelineMemory('fake-service-memory')]);
  const result = await service.build(fakeTimelineContext());
  assert.equal(result.ok, true);
  assert.deepEqual(result.events[0].memoryIds, ['fake-service-memory']);
});

test('MemoryLifeTimelineService never calls a Repository mutation', async () => {
  const { repository, service } = await setup([fakeTimelineMemory('fake-read-only')]);
  for (const method of ['create', 'createMany', 'update', 'confirm', 'reject', 'dispute', 'archive', 'expire', 'supersede', 'moveToRecycleBin', 'restore', 'purge']) {
    repository[method] = async () => { throw new Error(`mutation called: ${method}`); };
  }
  const result = await service.build(fakeTimelineContext());
  assert.equal(result.ok, true);
});

test('MemoryLifeTimelineService fails closed for invalid context', async () => {
  const { service } = await setup();
  const result = await service.build(fakeTimelineContext({ authenticatedUserId: '' }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMELINE_INVALID_CONTEXT');
});

test('MemoryLifeTimelineService cannot read another user through a frontend userId', async () => {
  const { service } = await setup([fakeTimelineMemory('fake-user-a-only')]);
  const result = await service.build(fakeTimelineContext({ userId: 'fake-user-b' }));
  assert.equal(result.ok, false);
  assert.equal(result.events.length, 0);
});

test('MemoryLifeTimelineService returns an honest empty result', async () => {
  const { service } = await setup();
  const result = await service.build(fakeTimelineContext());
  assert.equal(result.ok, true);
  assert.deepEqual(result.events, []);
  assert.equal(result.reasonCode, 'TIMELINE_EMPTY');
});

test('MemoryLifeTimelineService distinguishes Repository failure from empty data', async () => {
  const { repository, service } = await setup();
  repository.query = async () => { throw new Error('fictional unavailable'); };
  const result = await service.build(fakeTimelineContext());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMELINE_REPOSITORY_UNAVAILABLE');
});

test('MemoryLifeTimelineService applies query filtering after Repository access', async () => {
  const { service } = await setup([
    fakeTimelineMemory('fake-service-goal', { memoryType: 'goal' }),
    fakeTimelineMemory('fake-service-preference')
  ]);
  const result = await service.query(fakeTimelineContext(), { memoryTypes: ['goal'] });
  assert.deepEqual(result.events.map((event) => event.memoryIds[0]), ['fake-service-goal']);
});

test('MemoryLifeTimelineService applies output limit after occurrence-time ordering', async () => {
  const { service } = await setup([
    fakeTimelineMemory('fake-created-first-but-occurs-late', {
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      effectiveFrom: '2026-12-01T00:00:00.000Z'
    }),
    fakeTimelineMemory('fake-created-later-but-occurs-early', {
      createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
      effectiveFrom: '2026-03-01T00:00:00.000Z'
    })
  ]);
  const result = await service.build(fakeTimelineContext(), { limit: 1 });
  assert.deepEqual(result.events[0].memoryIds, ['fake-created-later-but-occurs-early']);
});

test('MemoryLifeTimelineService does not silently omit an event beyond five hundred stored records', async () => {
  const records = Array.from({ length: 501 }, (_, index) => {
    const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    return fakeTimelineMemory(`fake-scale-${String(index).padStart(3, '0')}`, {
      createdAt,
      updatedAt: createdAt,
      effectiveFrom: index === 500 ? '2020-01-01T00:00:00.000Z' : '2026-12-01T00:00:00.000Z'
    });
  });
  const { service } = await setup(records);
  const result = await service.build(fakeTimelineContext(), { limit: 1 });
  assert.deepEqual(result.events[0].memoryIds, ['fake-scale-500']);
});

test('MemoryLifeTimelineService renders data segments without UI markup', async () => {
  const { service } = await setup([fakeTimelineMemory('fake-render-service')]);
  const result = await service.build(fakeTimelineContext(), { granularity: 'month' });
  assert.equal(result.segments.length, 1);
  assert.equal(JSON.stringify(result).includes('<div'), false);
});

test('MemoryLifeTimelineService audits why events were generated', async () => {
  const { service } = await setup([fakeTimelineMemory('fake-audit-build')]);
  const result = await service.build(fakeTimelineContext());
  assert.equal(result.auditEvents.some((event) => event.action === 'timeline_built' && event.reasonCode === 'TIMELINE_MEMORY_DERIVED'), true);
});

test('MemoryLifeTimelineService audits sensitive hiding without正文', async () => {
  const { service } = await setup([fakeTimelineMemory('fake-audit-sensitive', { sensitivity: 'high', value: '虚构敏感正文' })]);
  const result = await service.build(fakeTimelineContext());
  const audit = result.auditEvents.find((event) => event.action === 'timeline_sensitive_hidden');
  assert.ok(audit);
  assert.equal(JSON.stringify(audit).includes('虚构敏感正文'), false);
});

test('MemoryLifeTimelineService audits merge reasons', async () => {
  const { service } = await setup([
    fakeTimelineMemory('fake-audit-merge-a', { value: 'same', normalizedValue: 'same' }),
    fakeTimelineMemory('fake-audit-merge-b', { value: 'same', normalizedValue: 'same' })
  ]);
  const result = await service.build(fakeTimelineContext());
  assert.equal(result.auditEvents.some((event) => event.action === 'timeline_merged' && event.reasonCode === 'TIMELINE_EXACT_DUPLICATE_MERGE'), true);
});

test('MemoryLifeTimelineService audits unresolved conflict without deciding it', async () => {
  const { service } = await setup([
    fakeTimelineMemory('fake-audit-conflict-a', { conflictGroupId: 'fake-audit-cg', normalizedValue: 'a' }),
    fakeTimelineMemory('fake-audit-conflict-b', { conflictGroupId: 'fake-audit-cg', normalizedValue: 'b' })
  ]);
  const result = await service.build(fakeTimelineContext());
  assert.equal(result.auditEvents.some((event) => event.action === 'timeline_conflict_marked'), true);
  assert.equal(result.conflicts[0].resolution, 'governance_required');
});

test('MemoryLifeTimelineService audit view is isolated by user', async () => {
  const { service } = await setup([fakeTimelineMemory('fake-audit-isolation')]);
  await service.build(fakeTimelineContext());
  assert.equal(service.listAuditEvents(fakeTimelineContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' })).length, 0);
});

test('MemoryLifeTimelineService results cannot mutate internal or Memory state', async () => {
  const { service } = await setup([fakeTimelineMemory('fake-result-immutable')]);
  const result = await service.build(fakeTimelineContext());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.events[0]), true);
});
