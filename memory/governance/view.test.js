import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryGovernanceService } from './index.js';
import {
  createGovernanceRepository,
  fakeGovernanceContext,
  fakeGovernanceRecord,
  repositoryOptions,
  seed
} from './testing/fixtures.js';

async function setup(records = []) {
  const repository = createGovernanceRepository();
  await seed(repository, records);
  return { repository, service: new MemoryGovernanceService({ repository, clock: () => new Date('2026-07-15T12:00:00.000Z') }) };
}

test('lists only the authenticated user current memories by default', async () => {
  const { repository, service } = await setup([fakeGovernanceRecord('own')]);
  await seed(repository, [fakeGovernanceRecord('other', { userId: 'fake-user-b' })], 'fake-user-b');
  const result = await service.listMemories(fakeGovernanceContext(), {});
  assert.deepEqual(result.data.items.map((item) => item.memoryId), ['own']);
});

test('admin actor cannot view another user memory', async () => {
  const { service } = await setup([fakeGovernanceRecord('own')]);
  const result = await service.getMemoryDetails(fakeGovernanceContext({
    authenticatedUserId: 'fake-user-b', actorType: 'admin', actorId: 'fake-admin'
  }), 'own');
  assert.equal(result.status, 'not_found');
});

test('memory view contains approved safe fields', async () => {
  const { service } = await setup([fakeGovernanceRecord('view')]);
  const item = (await service.listMemories(fakeGovernanceContext(), {})).data.items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    'availableActions', 'confirmationStatus', 'effectiveFrom', 'effectiveTo', 'memoryId',
    'memoryType', 'recallEligibility', 'safeSummary', 'sensitivity', 'sourceTimestamp',
    'sourceType', 'status', 'updatedAt', 'version'
  ].sort());
});

test('memory view omits checksum metadata and internal paths', async () => {
  const { service } = await setup([fakeGovernanceRecord('safe', { metadata: { internalPath: '/private/fake.sqlite' } })]);
  const output = JSON.stringify(await service.listMemories(fakeGovernanceContext(), {}));
  assert.equal(output.includes('checksum'), false);
  assert.equal(output.includes('/private/'), false);
  assert.equal(output.includes('fake.sqlite'), false);
});

test('high sensitivity memory shows only a safe existence summary', async () => {
  const { service } = await setup([fakeGovernanceRecord('health', {
    memoryType: 'sensitive_memory', predicate: 'health_note', value: '虚构敏感健康正文',
    normalizedValue: '虚构健康', sensitivity: 'high'
  })]);
  const item = (await service.listMemories(fakeGovernanceContext(), {})).data.items[0];
  assert.equal(item.safeSummary.includes('虚构敏感健康正文'), false);
  assert.equal(item.safeSummary.includes('敏感'), true);
});

test('details expose source time status and available actions without internals', async () => {
  const { service } = await setup([fakeGovernanceRecord('detail')]);
  const result = await service.getMemoryDetails(fakeGovernanceContext(), 'detail');
  assert.equal(result.data.memoryId, 'detail');
  assert.equal(result.data.sourceType, 'user_confirmed');
  assert.equal(result.data.recallEligibility, 'eligible');
  assert.equal(result.data.availableActions.includes('correct'), true);
});

test('history view preserves both sides of a supersede chain', async () => {
  const { repository, service } = await setup([fakeGovernanceRecord('old')]);
  const repositoryContext = service.toRepositoryContext(fakeGovernanceContext());
  await repository.supersede(repositoryContext, 'old', fakeGovernanceRecord('current', { value: '虚构新偏好', normalizedValue: '新偏好' }), repositoryOptions({ expectedVersion: 1 }));
  const result = await service.getMemoryHistory(fakeGovernanceContext({ operation: 'history' }), 'current');
  assert.deepEqual(result.data.items.map((item) => item.memoryId), ['old', 'current']);
  assert.equal(result.data.items[0].status, 'superseded');
});

test('deleted memory is visible only when recycle bin is requested', async () => {
  const { repository, service } = await setup([fakeGovernanceRecord('deleted')]);
  await repository.moveToRecycleBin(service.toRepositoryContext(fakeGovernanceContext()), 'deleted', repositoryOptions({ expectedVersion: 1 }));
  assert.equal((await service.listMemories(fakeGovernanceContext(), {})).data.items.length, 0);
  const recycle = await service.listMemories(fakeGovernanceContext(), { view: 'recycle_bin' });
  assert.equal(recycle.data.items[0].memoryId, 'deleted');
  assert.equal(recycle.data.items[0].recallEligibility, 'not_recallable');
  assert.equal(recycle.data.items[0].availableActions.includes('restore'), true);
});

test('deleted memory details remain available to its owner', async () => {
  const { repository, service } = await setup([fakeGovernanceRecord('deleted-detail')]);
  await repository.moveToRecycleBin(service.toRepositoryContext(fakeGovernanceContext()), 'deleted-detail', repositoryOptions({ expectedVersion: 1 }));
  const result = await service.getMemoryDetails(fakeGovernanceContext(), 'deleted-detail');
  assert.equal(result.status, 'completed');
  assert.equal(result.data.status, 'deleted');
});

test('deleted memory version history remains visible to its owner', async () => {
  const { repository, service } = await setup([fakeGovernanceRecord('deleted-history')]);
  await repository.moveToRecycleBin(service.toRepositoryContext(fakeGovernanceContext()), 'deleted-history', repositoryOptions({ expectedVersion: 1 }));
  const result = await service.getMemoryHistory(fakeGovernanceContext({ operation: 'history' }), 'deleted-history');
  assert.equal(result.status, 'completed');
  assert.equal(result.data.items[0].status, 'deleted');
});

test('conflict case contains safe summaries and decisions', async () => {
  const records = [
    fakeGovernanceRecord('conflict-a', { conflictGroupId: 'fake-conflict', normalizedValue: '咖啡' }),
    fakeGovernanceRecord('conflict-b', { conflictGroupId: 'fake-conflict', value: '虚构茶偏好', normalizedValue: '茶' })
  ];
  const { service } = await setup(records);
  const result = await service.getConflictCase(fakeGovernanceContext(), 'fake-conflict');
  assert.equal(result.data.conflictId, 'fake-conflict');
  assert.equal(result.data.safeSummaries.length, 2);
  assert.equal(result.data.availableDecisions.includes('defer'), true);
});

test('view audit contains no memory body', async () => {
  const { service } = await setup([fakeGovernanceRecord('audit-view', { value: '虚构不应进入审计的正文' })]);
  await service.getMemoryDetails(fakeGovernanceContext(), 'audit-view');
  const audits = await service.listAuditEvents(fakeGovernanceContext({ operation: 'audit' }), {});
  assert.equal(JSON.stringify(audits).includes('虚构不应进入审计的正文'), false);
  assert.equal(audits.data.items[0].action, 'governance_viewed');
});
