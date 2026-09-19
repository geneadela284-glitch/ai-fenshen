import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApprovalEngine, DryRunEngine, MemoryMigrationFramework, MigrationApprovalStatus,
  MigrationAudit, MigrationCandidateStatus, MigrationError, MigrationExecutionStatus,
  MigrationPlanner, MigrationPlanStatus, RollbackEngine
} from './index.js';
import {
  FakeMigrationTarget, MIGRATION_NOW, fakeExistingMemory, fakeLegacyItem,
  fakeMigrationContext, fakeMigrationSource, fakeTimelineEvent
} from './testing/fixtures.js';

function ids(prefix = 'fake-id') {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function framework(options = {}) {
  return new MemoryMigrationFramework({ clock: () => new Date(MIGRATION_NOW), idFactory: ids(), ...options });
}

async function preview(items, options = {}) {
  return framework().preview(fakeMigrationContext(), fakeMigrationSource(items), options);
}

test('planner marks normal candidates ready for approval', async () => {
  const result = await preview([fakeLegacyItem('normal')]);
  assert.equal(result.plan.candidates[0].status, MigrationCandidateStatus.READY_FOR_APPROVAL);
});

test('planner marks exact Memory duplicates without deleting them', async () => {
  const item = fakeLegacyItem('duplicate', { normalizedValue: 'same' });
  const result = await preview([item], { existingMemories: [fakeExistingMemory('existing', { normalizedValue: 'same' })] });
  assert.equal(result.plan.candidates[0].status, MigrationCandidateStatus.DUPLICATE);
  assert.equal(result.plan.candidates[0].duplicateReport.isDuplicate, true);
});

test('planner marks exact Timeline duplicates without modifying Timeline', async () => {
  const item = fakeLegacyItem('duplicate', { value: '虚构咖啡', normalizedValue: '虚构咖啡' });
  const event = fakeTimelineEvent('event');
  const before = structuredClone(event);
  const result = await preview([item], { existingTimelineEvents: [event] });
  assert.equal(result.plan.candidates[0].status, MigrationCandidateStatus.DUPLICATE);
  assert.deepEqual(event, before);
});

test('planner sends differing current facts to the conflict queue', async () => {
  const result = await preview([fakeLegacyItem('conflict')], { existingMemories: [fakeExistingMemory('existing')] });
  assert.equal(result.plan.candidates[0].status, MigrationCandidateStatus.CONFLICT);
  assert.equal(result.plan.candidates[0].conflictReport.resolution, 'governance_required');
});

test('planner requires explicit approval for high sensitivity', async () => {
  const result = await preview([fakeLegacyItem('health', { value: '虚构健康病历', normalizedValue: '虚构健康病历' })]);
  assert.equal(result.plan.candidates[0].status, MigrationCandidateStatus.SENSITIVE_APPROVAL_REQUIRED);
  assert.equal(result.plan.candidates[0].proposedMemory.sensitivity, 'high');
});

for (const [name, value] of [
  ['password', 'password: not-a-real-password'], ['api key', 'api_key: not-a-real-key'],
  ['cookie', 'cookie: not-a-real-cookie'], ['token', 'access_token: not-a-real-token'],
  ['private key', 'private_key: not-a-real-key'], ['recovery', 'recovery_code: not-a-real-code']
]) {
  test(`planner blocks and redacts prohibited ${name}`, async () => {
    const result = await preview([fakeLegacyItem(name, { value, normalizedValue: value })]);
    const candidate = result.plan.candidates[0];
    assert.equal(candidate.status, MigrationCandidateStatus.PROHIBITED);
    assert.equal(JSON.stringify(result).includes(value), false);
  });
}

test('planner gives duplicate precedence over conflict', async () => {
  const item = fakeLegacyItem('duplicate', { normalizedValue: 'same' });
  const existing = [fakeExistingMemory('same', { normalizedValue: 'same' }), fakeExistingMemory('different')];
  const result = await preview([item], { existingMemories: existing });
  assert.equal(result.plan.candidates[0].status, MigrationCandidateStatus.DUPLICATE);
});

test('planner treats later identical source candidates as duplicates', async () => {
  const result = await preview([fakeLegacyItem('a'), fakeLegacyItem('b', { value: '虚构偏好-a', normalizedValue: '虚构偏好-a' })]);
  assert.equal(result.plan.candidates[0].status, MigrationCandidateStatus.READY_FOR_APPROVAL);
  assert.equal(result.plan.candidates[1].status, MigrationCandidateStatus.DUPLICATE);
});

test('planner treats later differing source candidates as conflicts', async () => {
  const result = await preview([fakeLegacyItem('a'), fakeLegacyItem('b')]);
  assert.equal(result.plan.candidates[1].status, MigrationCandidateStatus.CONFLICT);
});

test('planner preserves independent life events', async () => {
  const result = await preview([
    fakeLegacyItem('a', { memoryType: 'life_event', predicate: 'visited', occurredAt: '2020-01-01T00:00:00.000Z' }),
    fakeLegacyItem('b', { memoryType: 'life_event', predicate: 'visited', occurredAt: '2021-01-01T00:00:00.000Z' })
  ]);
  assert.deepEqual(result.plan.candidates.map((item) => item.status), ['ready_for_approval', 'ready_for_approval']);
});

test('planner output is immutable and does not mutate inputs', async () => {
  const item = fakeLegacyItem('one');
  const before = structuredClone(item);
  const result = await preview([item]);
  assert.equal(Object.isFrozen(result.plan), true);
  assert.deepEqual(item, before);
});

test('planner checksum is stable for equivalent deterministic inputs', async () => {
  const left = await preview([fakeLegacyItem('one')]);
  const right = await preview([fakeLegacyItem('one')]);
  assert.equal(left.plan.checksum, right.plan.checksum);
});

for (const [name, items, expected] of [
  ['empty', [], { candidates: 0, newCandidates: 0, duplicates: 0, conflicts: 0, sensitive: 0, prohibited: 0 }],
  ['normal', [fakeLegacyItem('n')], { candidates: 1, newCandidates: 1, duplicates: 0, conflicts: 0, sensitive: 0, prohibited: 0 }],
  ['sensitive', [fakeLegacyItem('s', { value: '虚构健康病历', normalizedValue: '虚构健康病历' })], { candidates: 1, newCandidates: 1, duplicates: 0, conflicts: 0, sensitive: 1, prohibited: 0 }],
  ['prohibited', [fakeLegacyItem('p', { value: 'password: not-a-real-password', normalizedValue: 'password: not-a-real-password' })], { candidates: 1, newCandidates: 0, duplicates: 0, conflicts: 0, sensitive: 0, prohibited: 1 }]
]) {
  test(`dry run reports ${name} counts`, async () => {
    const result = await preview(items);
    for (const [key, value] of Object.entries(expected)) assert.equal(result.dryRun.report.counts[key], value);
  });
}

test('dry run reports duplicate counts', async () => {
  const result = await preview([fakeLegacyItem('d', { normalizedValue: 'same' })], { existingMemories: [fakeExistingMemory('m', { normalizedValue: 'same' })] });
  assert.equal(result.dryRun.report.counts.duplicates, 1);
  assert.equal(result.dryRun.report.counts.newCandidates, 0);
});

test('dry run reports conflict counts', async () => {
  const result = await preview([fakeLegacyItem('c')], { existingMemories: [fakeExistingMemory('m')] });
  assert.equal(result.dryRun.report.counts.conflicts, 1);
  assert.equal(result.dryRun.report.counts.newCandidates, 0);
});

for (const [type, timeline, intelligence] of [
  ['fact', 1, 0], ['preference', 1, 1], ['goal', 1, 1], ['relationship', 1, 0],
  ['life_event', 1, 0], ['habit_routine', 1, 1], ['context', 1, 0]
]) {
  test(`dry run estimates derived impact for ${type} without generating artifacts`, async () => {
    const result = await preview([fakeLegacyItem(type, { memoryType: type })]);
    assert.equal(result.dryRun.report.estimatedTimelineChanges, timeline);
    assert.equal(result.dryRun.report.estimatedInsightRecomputes, intelligence);
    assert.equal('timelineEvents' in result.dryRun.report, false);
    assert.equal('insights' in result.dryRun.report, false);
  });
}

test('empty dry run does not request approval', async () => {
  const result = await preview([]);
  assert.equal(result.plan.status, MigrationPlanStatus.APPROVAL_REQUIRED);
  assert.equal(result.dryRun.report.requiresApproval, false);
});

test('non-empty dry run requests approval and never stages data', async () => {
  const target = new FakeMigrationTarget();
  const result = await preview([fakeLegacyItem('one')]);
  assert.equal(result.dryRun.report.requiresApproval, true);
  assert.equal(target.list().length, 0);
});

test('approval accepts explicitly selected normal candidates', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  const id = result.plan.candidates[0].id;
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: [id], sensitiveCandidateIds: [] });
  assert.equal(approval.status, MigrationApprovalStatus.APPROVED);
  assert.deepEqual(approval.approvedCandidateIds, [id]);
});

test('approval cancellation stages nothing', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'cancel', candidateIds: [], sensitiveCandidateIds: [] });
  assert.equal(approval.status, MigrationApprovalStatus.CANCELLED);
});

test('system actors cannot approve a migration', async () => {
  const result = await preview([fakeLegacyItem('one')]);
  assert.throws(
    () => new ApprovalEngine().approve(fakeMigrationContext({ actorType: 'system', actorId: 'fake-system' }), result.dryRun, { decision: 'approve', candidateIds: [result.plan.candidates[0].id], sensitiveCandidateIds: [] }),
    (error) => error.code === 'MIGRATION_USER_APPROVAL_REQUIRED'
  );
});

test('cross-user contexts cannot approve a migration', async () => {
  const result = await preview([fakeLegacyItem('one')]);
  assert.throws(
    () => new ApprovalEngine().approve(fakeMigrationContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' }), result.dryRun, { decision: 'approve', candidateIds: [result.plan.candidates[0].id], sensitiveCandidateIds: [] }),
    (error) => error.code === 'USER_SCOPE_MISMATCH'
  );
});

test('high sensitivity requires candidate-specific approval', async () => {
  const result = await preview([fakeLegacyItem('health', { value: '虚构健康病历', normalizedValue: '虚构健康病历' })]);
  const id = result.plan.candidates[0].id;
  assert.throws(
    () => new ApprovalEngine().approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: [id], sensitiveCandidateIds: [] }),
    (error) => error.code === 'MIGRATION_SENSITIVE_APPROVAL_REQUIRED'
  );
});

test('high sensitivity can be explicitly approved', async () => {
  const result = await preview([fakeLegacyItem('health', { value: '虚构健康病历', normalizedValue: '虚构健康病历' })]);
  const id = result.plan.candidates[0].id;
  const approval = new ApprovalEngine({ clock: () => new Date(MIGRATION_NOW), idFactory: ids('approval') }).approve(
    fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: [id], sensitiveCandidateIds: [id] }
  );
  assert.equal(approval.status, MigrationApprovalStatus.APPROVED);
});

for (const status of [MigrationCandidateStatus.DUPLICATE, MigrationCandidateStatus.CONFLICT, MigrationCandidateStatus.PROHIBITED]) {
  test(`approval rejects ineligible ${status} candidates`, async () => {
    const result = await preview([fakeLegacyItem('one')]);
    const candidate = { ...structuredClone(result.plan.candidates[0]), status };
    const dryRun = { ...structuredClone(result.dryRun), plan: { ...structuredClone(result.plan), candidates: [candidate] } };
    assert.throws(
      () => new ApprovalEngine().approve(fakeMigrationContext(), dryRun, { decision: 'approve', candidateIds: [candidate.id], sensitiveCandidateIds: [] }),
      (error) => error.code === 'MIGRATION_CANDIDATE_NOT_ELIGIBLE'
    );
  });
}

test('approval rejects unknown candidate ids', async () => {
  const result = await preview([fakeLegacyItem('one')]);
  assert.throws(
    () => new ApprovalEngine().approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: ['missing'], sensitiveCandidateIds: [] }),
    (error) => error.code === 'MIGRATION_CANDIDATE_NOT_ELIGIBLE'
  );
});

test('execution requires an approved plan', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  await assert.rejects(app.execute(fakeMigrationContext(), { status: 'cancelled', planId: result.plan.id }, new FakeMigrationTarget()), (error) => error.code === 'MIGRATION_APPROVAL_REQUIRED');
});

test('execution stages Migration Candidates, never formal Memory', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  const id = result.plan.candidates[0].id;
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: [id], sensitiveCandidateIds: [] });
  const target = new FakeMigrationTarget();
  const execution = await app.execute(fakeMigrationContext(), approval, target);
  assert.equal(execution.status, MigrationExecutionStatus.COMPLETED);
  assert.equal(target.list()[0].id, id);
  assert.equal(target.list()[0].proposedMemory.status, 'pending_confirmation');
});

test('failed execution is atomic with zero partial candidates', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one'), fakeLegacyItem('two', { predicate: 'other' })]));
  const ids = result.plan.candidates.map((item) => item.id);
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: ids, sensitiveCandidateIds: [] });
  const target = new FakeMigrationTarget({ failStageAt: 2 });
  const execution = await app.execute(fakeMigrationContext(), approval, target);
  assert.equal(execution.status, MigrationExecutionStatus.FAILED);
  assert.equal(target.list().length, 0);
});

test('repeating an approved execution is idempotent', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  const id = result.plan.candidates[0].id;
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: [id], sensitiveCandidateIds: [] });
  const target = new FakeMigrationTarget();
  const first = await app.execute(fakeMigrationContext(), approval, target);
  const second = await app.execute(fakeMigrationContext(), approval, target);
  assert.deepEqual(second, first);
  assert.equal(target.list().length, 1);
});

test('rollback removes every staged candidate atomically', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one'), fakeLegacyItem('two', { predicate: 'other' })]));
  const candidateIds = result.plan.candidates.map((item) => item.id);
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds, sensitiveCandidateIds: [] });
  const target = new FakeMigrationTarget();
  const execution = await app.execute(fakeMigrationContext(), approval, target);
  const rolledBack = await app.rollback(fakeMigrationContext(), execution, target);
  assert.equal(rolledBack.status, MigrationExecutionStatus.ROLLED_BACK);
  assert.equal(target.list().length, 0);
});

test('failed rollback leaves all staged candidates intact', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one'), fakeLegacyItem('two', { predicate: 'other' })]));
  const candidateIds = result.plan.candidates.map((item) => item.id);
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds, sensitiveCandidateIds: [] });
  const target = new FakeMigrationTarget();
  const execution = await app.execute(fakeMigrationContext(), approval, target);
  target.failRemoveAt = 2;
  await assert.rejects(app.rollback(fakeMigrationContext(), execution, target), (error) => error.code === 'MIGRATION_ROLLBACK_FAILED');
  assert.equal(target.list().length, 2);
});

test('cross-user execution fails closed', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  const id = result.plan.candidates[0].id;
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: [id], sensitiveCandidateIds: [] });
  await assert.rejects(
    app.execute(fakeMigrationContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' }), approval, new FakeMigrationTarget()),
    (error) => error.code === 'USER_SCOPE_MISMATCH'
  );
});

test('audit records lifecycle actions without candidate bodies', async () => {
  const app = framework();
  const result = await app.preview(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  const id = result.plan.candidates[0].id;
  const approval = app.approve(fakeMigrationContext(), result.dryRun, { decision: 'approve', candidateIds: [id], sensitiveCandidateIds: [] });
  const target = new FakeMigrationTarget();
  const execution = await app.execute(fakeMigrationContext(), approval, target);
  await app.rollback(fakeMigrationContext(), execution, target);
  const events = app.listAuditEvents(fakeMigrationContext());
  assert.ok(events.length >= 8);
  assert.equal(JSON.stringify(events).includes('虚构偏好-one'), false);
  assert.equal(JSON.stringify(events).includes('not-a-real'), false);
});

test('audit is isolated by user', () => {
  const audit = new MigrationAudit({ clock: () => new Date(MIGRATION_NOW), idFactory: ids('audit') });
  audit.record(fakeMigrationContext(), 'migration_scan_started', 'MIGRATION_SCAN_STARTED');
  assert.equal(audit.list(fakeMigrationContext()).length, 1);
  assert.equal(audit.list(fakeMigrationContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' })).length, 0);
});

test('scan failure creates a safe failed audit event', async () => {
  const app = framework();
  const source = fakeMigrationSource([], { scan: async () => { throw new Error('not-a-real-secret'); } });
  await assert.rejects(app.preview(fakeMigrationContext(), source), (error) => error.code === 'MIGRATION_SOURCE_SCAN_FAILED');
  const events = app.listAuditEvents(fakeMigrationContext());
  assert.equal(events.at(-1).action, 'migration_failed');
  assert.equal(JSON.stringify(events).includes('not-a-real-secret'), false);
});

test('rollback engine rejects failed executions', async () => {
  await assert.rejects(
    new RollbackEngine().rollback(fakeMigrationContext(), { status: 'failed', userId: 'fake-user-a' }, new FakeMigrationTarget()),
    (error) => error.code === 'MIGRATION_ROLLBACK_NOT_AVAILABLE'
  );
});
