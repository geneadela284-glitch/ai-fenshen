import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryGovernanceService } from './index.js';
import {
  createGovernanceRepository,
  fakeGovernanceContext,
  fakeGovernanceRecord,
  seed
} from './testing/fixtures.js';

async function setup(records = []) {
  const repository = createGovernanceRepository();
  await seed(repository, records);
  let sequence = 0;
  const service = new MemoryGovernanceService({
    repository,
    clock: () => new Date('2026-07-15T12:00:00.000Z'),
    idFactory: () => `fake-governance-${++sequence}`
  });
  return { repository, service };
}

function mutation(operation, expectedVersion = 1, overrides = {}) {
  return fakeGovernanceContext({ operation, expectedVersion, ...overrides });
}

test('low-risk correction creates a new version without confirmation', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct'), 'old', { value: '虚构新偏好' });
  assert.equal(result.status, 'completed');
  assert.equal(result.data.current.value, '虚构新偏好');
});

test('correction preserves the old record as superseded history', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct'), 'old', { value: '虚构新偏好' });
  const history = await service.getMemoryHistory(fakeGovernanceContext({ operation: 'history' }), result.memoryId);
  assert.deepEqual(history.data.items.map((item) => item.status), ['superseded', 'confirmed']);
});

test('correction builds bidirectional version links', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct'), 'old', { value: '虚构新偏好' });
  assert.equal(result.data.previous.supersededById, result.data.current.id);
  assert.equal(result.data.current.supersedesId, 'old');
});

test('correction records trusted user-confirmed provenance', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct'), 'old', { value: '虚构新偏好' });
  assert.equal(result.data.current.source.type, 'user_confirmed');
  assert.equal(result.data.current.userId, 'fake-user-a');
});

test('correction rejects an ambiguous empty proposal', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct'), 'old', {});
  assert.equal(result.status, 'needs_clarification');
  assert.match(result.safeMessage, /哪项|内容/);
});

test('correction rejects prohibited secret text', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct'), 'old', { value: 'password is fake-secret' });
  assert.equal(result.status, 'rejected');
  assert.equal(JSON.stringify(result).includes('fake-secret'), false);
});

test('high-sensitive correction requests explicit confirmation', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct'), 'old', { value: '虚构健康信息：有过敏史' });
  assert.equal(result.status, 'confirmation_required');
  assert.equal(typeof result.data.confirmationToken, 'string');
});

test('valid confirmation token completes the same high-sensitive correction', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const proposal = { value: '虚构健康信息：有过敏史' };
  const first = await service.correctMemory(mutation('correct'), 'old', proposal);
  const result = await service.correctMemory(mutation('correct', 1, { confirmationToken: first.data.confirmationToken }), 'old', proposal);
  assert.equal(result.status, 'completed');
  assert.equal(result.data.current.sensitivity, 'high');
});

test('relationship correction requests confirmation even when wording is neutral', async () => {
  const { service } = await setup([fakeGovernanceRecord('relationship', { memoryType: 'relationship', predicate: 'knows_person' })]);
  const result = await service.correctMemory(mutation('correct'), 'relationship', { value: '虚构关系更新' });
  assert.equal(result.status, 'confirmation_required');
});

test('confirmation token cannot authorize a different payload', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const first = await service.correctMemory(mutation('correct'), 'old', { value: '虚构健康信息：有过敏史' });
  const result = await service.correctMemory(mutation('correct', 1, { confirmationToken: first.data.confirmationToken }), 'old', { value: '虚构健康信息：有疾病记录' });
  assert.equal(result.status, 'confirmation_required');
});

test('correction requires expectedVersion', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct', null), 'old', { value: '虚构新偏好' });
  assert.equal(result.status, 'failed');
});

test('correction rejects stale expectedVersion', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct', 2), 'old', { value: '虚构新偏好' });
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'MEMORY_VERSION_CONFLICT');
});

test('cross-user correction is indistinguishable from missing memory', async () => {
  const { service } = await setup([fakeGovernanceRecord('old')]);
  const result = await service.correctMemory(mutation('correct', 1, {
    authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b'
  }), 'old', { value: '虚构新偏好' });
  assert.equal(result.status, 'not_found');
});

test('ordinary delete moves one record to the recycle bin', async () => {
  const { service } = await setup([fakeGovernanceRecord('delete')]);
  const result = await service.deleteMemory(mutation('delete'), 'delete');
  assert.equal(result.status, 'completed');
  assert.equal(result.reversible, true);
  assert.equal(result.undoUntil, '2026-07-22T12:00:00.000Z');
});

test('deleted memory immediately disappears from current view', async () => {
  const { service } = await setup([fakeGovernanceRecord('delete')]);
  await service.deleteMemory(mutation('delete'), 'delete');
  assert.equal((await service.listMemories(fakeGovernanceContext())).data.items.length, 0);
});

test('deleted memory appears in recycle bin with restore action', async () => {
  const { service } = await setup([fakeGovernanceRecord('delete')]);
  await service.deleteMemory(mutation('delete'), 'delete');
  const recycle = await service.listMemories(fakeGovernanceContext(), { view: 'recycle_bin' });
  assert.equal(recycle.data.items[0].availableActions.includes('restore'), true);
});

test('high-sensitive delete requests confirmation before entering recycle bin', async () => {
  const { service } = await setup([fakeGovernanceRecord('high-delete', { sensitivity: 'high' })]);
  const result = await service.deleteMemory(mutation('delete'), 'high-delete');
  assert.equal(result.status, 'confirmation_required');
});

test('restore returns a deleted record to its previous state', async () => {
  const { service } = await setup([fakeGovernanceRecord('restore')]);
  await service.deleteMemory(mutation('delete'), 'restore');
  const result = await service.restoreMemory(mutation('restore', 2), 'restore');
  assert.equal(result.status, 'completed');
  assert.equal(result.data.status, 'confirmed');
  assert.equal(result.data.version, 3);
});

test('restore rejects stale expectedVersion', async () => {
  const { service } = await setup([fakeGovernanceRecord('restore')]);
  await service.deleteMemory(mutation('delete'), 'restore');
  const result = await service.restoreMemory(mutation('restore', 1), 'restore');
  assert.equal(result.reasonCode, 'MEMORY_VERSION_CONFLICT');
});

test('permanent purge always requests confirmation first', async () => {
  const { service } = await setup([fakeGovernanceRecord('purge')]);
  const result = await service.purgeMemory(mutation('purge'), 'purge');
  assert.equal(result.status, 'confirmation_required');
  assert.equal(result.reversible, false);
});

test('confirmed permanent purge makes record unrecoverable', async () => {
  const { service } = await setup([fakeGovernanceRecord('purge')]);
  const first = await service.purgeMemory(mutation('purge'), 'purge');
  const result = await service.purgeMemory(mutation('purge', 1, { confirmationToken: first.data.confirmationToken }), 'purge');
  assert.equal(result.status, 'completed');
  assert.equal((await service.getMemoryDetails(fakeGovernanceContext(), 'purge')).status, 'not_found');
});

test('restricted legacy record is purged immediately rather than recycled', async () => {
  const { service } = await setup([fakeGovernanceRecord('restricted', { sensitivity: 'restricted' })]);
  const result = await service.deleteMemory(mutation('delete'), 'restricted');
  assert.equal(result.reasonCode, 'MEMORY_PROHIBITED_PURGED');
  assert.equal((await service.getMemoryDetails(fakeGovernanceContext(), 'restricted')).status, 'not_found');
});

test('raising sensitivity takes effect without extra confirmation', async () => {
  const { service } = await setup([fakeGovernanceRecord('sensitivity')]);
  const result = await service.updateSensitivity(mutation('change_sensitivity'), 'sensitivity', { sensitivity: 'sensitive' });
  assert.equal(result.status, 'completed');
  assert.equal(result.data.sensitivity, 'medium');
});

test('lowering sensitivity requests confirmation', async () => {
  const { service } = await setup([fakeGovernanceRecord('sensitivity', { sensitivity: 'high' })]);
  const result = await service.updateSensitivity(mutation('change_sensitivity'), 'sensitivity', { sensitivity: 'personal' });
  assert.equal(result.status, 'confirmation_required');
});

test('confirmed sensitivity lowering completes', async () => {
  const { service } = await setup([fakeGovernanceRecord('sensitivity', { sensitivity: 'high' })]);
  const options = { sensitivity: 'personal' };
  const first = await service.updateSensitivity(mutation('change_sensitivity'), 'sensitivity', options);
  const result = await service.updateSensitivity(mutation('change_sensitivity', 1, { confirmationToken: first.data.confirmationToken }), 'sensitivity', options);
  assert.equal(result.data.sensitivity, 'low');
});

test('prohibited is not a selectable sensitivity level', async () => {
  const { service } = await setup([fakeGovernanceRecord('sensitivity')]);
  const result = await service.updateSensitivity(mutation('change_sensitivity'), 'sensitivity', { sensitivity: 'prohibited' });
  assert.equal(result.status, 'rejected');
});

test('restricted legacy content cannot be downgraded and is purged', async () => {
  const { service } = await setup([fakeGovernanceRecord('restricted-sensitivity', { sensitivity: 'restricted' })]);
  const result = await service.updateSensitivity(mutation('change_sensitivity'), 'restricted-sensitivity', { sensitivity: 'personal' });
  assert.equal(result.reasonCode, 'MEMORY_PROHIBITED_PURGED');
  assert.equal((await service.getMemoryDetails(fakeGovernanceContext(), 'restricted-sensitivity')).status, 'not_found');
});

test('tightening access to archived_only completes immediately', async () => {
  const { service } = await setup([fakeGovernanceRecord('access')]);
  const result = await service.updateAccessPolicy(mutation('change_access'), 'access', { mode: 'archived_only' });
  assert.equal(result.status, 'completed');
  assert.equal(result.data.accessPolicy.allowRecall, false);
});

test('widening access requests confirmation', async () => {
  const { service } = await setup([fakeGovernanceRecord('access', {
    accessPolicy: { scope: 'private', governanceMode: 'archived_only', allowRecall: false }
  })]);
  const result = await service.updateAccessPolicy(mutation('change_access'), 'access', { mode: 'assistant_only' });
  assert.equal(result.status, 'confirmation_required');
});

test('task_scoped access requires at least one explicit task scope', async () => {
  const { service } = await setup([fakeGovernanceRecord('access')]);
  const result = await service.updateAccessPolicy(mutation('change_access'), 'access', { mode: 'task_scoped', taskScopes: [] });
  assert.equal(result.status, 'needs_clarification');
});

test('explicitly_shared remains a non-sharing contract marker', async () => {
  const { service } = await setup([fakeGovernanceRecord('access')]);
  const options = { mode: 'explicitly_shared' };
  const first = await service.updateAccessPolicy(mutation('change_access'), 'access', options);
  const result = await service.updateAccessPolicy(mutation('change_access', 1, { confirmationToken: first.data.confirmationToken }), 'access', options);
  assert.equal(result.data.accessPolicy.sharingEnabled, false);
});

test('governance audit records mutation ids but no body', async () => {
  const { service } = await setup([fakeGovernanceRecord('audit', { value: '虚构审计不可见正文' })]);
  await service.deleteMemory(mutation('delete'), 'audit');
  const audit = await service.listAuditEvents(fakeGovernanceContext({ operation: 'audit' }));
  assert.equal(JSON.stringify(audit).includes('虚构审计不可见正文'), false);
  assert.equal(audit.data.items[0].affectedMemoryIds[0], 'audit');
});

for (const operation of ['correct', 'delete', 'restore', 'purge', 'change_sensitivity', 'change_access']) {
  test(`${operation} rejects missing trusted user`, async () => {
    const { service } = await setup([fakeGovernanceRecord('record')]);
    const method = {
      correct: () => service.correctMemory(mutation(operation, 1, { authenticatedUserId: '' }), 'record', { value: '虚构' }),
      delete: () => service.deleteMemory(mutation(operation, 1, { authenticatedUserId: '' }), 'record'),
      restore: () => service.restoreMemory(mutation(operation, 1, { authenticatedUserId: '' }), 'record'),
      purge: () => service.purgeMemory(mutation(operation, 1, { authenticatedUserId: '' }), 'record'),
      change_sensitivity: () => service.updateSensitivity(mutation(operation, 1, { authenticatedUserId: '' }), 'record', { sensitivity: 'sensitive' }),
      change_access: () => service.updateAccessPolicy(mutation(operation, 1, { authenticatedUserId: '' }), 'record', { mode: 'private' })
    }[operation];
    assert.equal((await method()).status, 'failed');
  });
}
