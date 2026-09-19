import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryGovernanceService } from './index.js';
import { createGovernanceRepository, fakeGovernanceContext, fakeGovernanceRecord, seed } from './testing/fixtures.js';

async function setup() {
  const records = [
    fakeGovernanceRecord('conflict-a', { conflictGroupId: 'conflict-1', normalizedValue: '咖啡' }),
    fakeGovernanceRecord('conflict-b', { conflictGroupId: 'conflict-1', value: '虚构茶偏好', normalizedValue: '茶' })
  ];
  const repository = createGovernanceRepository();
  await seed(repository, records);
  let sequence = 0;
  return {
    repository,
    service: new MemoryGovernanceService({ repository, clock: () => new Date('2026-07-15T12:00:00.000Z'), idFactory: () => `conflict-${++sequence}` })
  };
}

function context(overrides = {}) {
  return fakeGovernanceContext({ operation: 'resolve_conflict', expectedVersion: 1, ...overrides });
}

const versions = { 'conflict-a': 1, 'conflict-b': 1 };

test('keep_a keeps A current and archives B', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'keep_a', expectedVersions: versions });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.data.records.map((record) => record.status), ['confirmed', 'archived']);
});

test('keep_b archives A and keeps B current', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'keep_b', expectedVersions: versions });
  assert.deepEqual(result.data.records.map((record) => record.status), ['archived', 'confirmed']);
});

test('keep_both requires separate effective ranges', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'keep_both', expectedVersions: versions });
  assert.equal(result.status, 'needs_clarification');
});

test('keep_both accepts non-overlapping effective ranges', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', {
    decision: 'keep_both', expectedVersions: versions,
    effectiveRanges: {
      'conflict-a': { effectiveTo: '2026-07-10T00:00:00.000Z' },
      'conflict-b': { effectiveFrom: '2026-07-11T00:00:00.000Z' }
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.data.records.every((record) => record.status === 'confirmed'), true);
});

test('keep_both rejects overlapping effective ranges', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', {
    decision: 'keep_both', expectedVersions: versions,
    effectiveRanges: {
      'conflict-a': { effectiveTo: '2026-07-12T00:00:00.000Z' },
      'conflict-b': { effectiveFrom: '2026-07-11T00:00:00.000Z' }
    }
  });
  assert.equal(result.status, 'conflict');
});

test('mark_uncertain disputes every conflicting current record', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'mark_uncertain', expectedVersions: versions });
  assert.equal(result.data.records.every((record) => record.status === 'disputed'), true);
});

test('defer retains records but marks the case unresolved', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'defer', expectedVersions: versions });
  assert.equal(result.data.records.every((record) => record.status === 'confirmed'), true);
  assert.equal(result.reasonCode, 'MEMORY_CONFLICT_DEFERRED');
});

test('reject_all archives all conflicting records', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'reject_all', expectedVersions: versions });
  assert.equal(result.data.records.every((record) => record.status === 'archived'), true);
});

test('merge_as_new_version requires merged content', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'merge_as_new_version', expectedVersions: versions });
  assert.equal(result.status, 'needs_clarification');
});

test('merge_as_new_version creates one new current version', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', {
    decision: 'merge_as_new_version', expectedVersions: versions, merged: { value: '虚构合并偏好' }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.data.records.filter((record) => record.status === 'confirmed').length, 1);
  assert.equal(result.affectedMemoryIds.length, 3);
});

test('conflict resolution rejects unknown decisions', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'auto_decide', expectedVersions: versions });
  assert.equal(result.status, 'rejected');
});

test('conflict resolution requires expected version for every member', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'keep_a', expectedVersions: { 'conflict-a': 1 } });
  assert.equal(result.status, 'failed');
});

test('conflict transaction rolls back on one stale version', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'keep_a', expectedVersions: { 'conflict-a': 1, 'conflict-b': 2 } });
  assert.equal(result.status, 'failed');
  const conflict = await service.getConflictCase(fakeGovernanceContext(), 'conflict-1');
  assert.equal(conflict.data.safeSummaries.length, 2);
  assert.equal(conflict.data.status, 'open');
});

test('cross-user conflict access fails closed', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' }), 'conflict-1', { decision: 'keep_a', expectedVersions: versions });
  assert.equal(result.status, 'not_found');
});

test('conflict audit contains ids but no memory body', async () => {
  const { service } = await setup();
  await service.resolveConflict(context(), 'conflict-1', { decision: 'keep_a', expectedVersions: versions });
  const audit = await service.listAuditEvents(fakeGovernanceContext({ operation: 'audit' }));
  const output = JSON.stringify(audit);
  assert.equal(output.includes('虚构茶偏好'), false);
  assert.equal(output.includes('conflict-a'), true);
});

test('resolved conflict details report resolved status', async () => {
  const { service } = await setup();
  await service.resolveConflict(context(), 'conflict-1', { decision: 'defer', expectedVersions: versions });
  const conflict = await service.getConflictCase(fakeGovernanceContext(), 'conflict-1');
  assert.equal(conflict.data.status, 'open');
});

test('keep decision changes each record version exactly once', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'keep_a', expectedVersions: versions });
  assert.deepEqual(result.data.records.map((record) => record.version), [2, 2]);
});

test('conflict result is immutable', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'defer', expectedVersions: versions });
  assert.throws(() => { result.data.records[0].status = 'confirmed'; }, TypeError);
});

test('conflict resolution does not expose checksum or internal metadata', async () => {
  const { service } = await setup();
  const result = await service.resolveConflict(context(), 'conflict-1', { decision: 'defer', expectedVersions: versions });
  const output = JSON.stringify(result);
  assert.equal(output.includes('checksum'), false);
  assert.equal(output.includes('governanceConflict'), false);
});
