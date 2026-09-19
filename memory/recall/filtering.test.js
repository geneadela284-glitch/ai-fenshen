import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRecallEngine } from './index.js';
import { fakeMemoryRecord, fakeRecallContext, staticRepository } from './testing/fixtures.js';

async function recall(records, text = '按我的偏好推荐咖啡', context = fakeRecallContext(), repositoryOptions = {}) {
  return new MemoryRecallEngine({ repository: staticRepository(records, repositoryOptions) }).recall(context, { text });
}

const EXCLUDED_STATES = [
  ['deleted', { status: 'deleted' }],
  ['expired', { status: 'expired' }],
  ['superseded', { status: 'superseded', supersededById: 'fake-next' }],
  ['disputed', { status: 'disputed' }],
  ['archived', { status: 'archived' }],
  ['candidate', { status: 'candidate', confirmationStatus: 'pending' }],
  ['pending_confirmation', { status: 'pending_confirmation', confirmationStatus: 'pending' }]
];

for (const [name, overrides] of EXCLUDED_STATES) {
  test(`default filtering excludes ${name}`, async () => {
    const result = await recall([fakeMemoryRecord(`fake-${name}`, overrides)]);
    assert.equal(result.selected.length, 0);
    assert.equal(result.excluded[0].exclusionReason, `status_${name}`);
  });
}

test('default filtering excludes user-rejected confirmation', async () => {
  const result = await recall([fakeMemoryRecord('fake-rejected', { confirmationStatus: 'user_rejected' })]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'confirmation_user_rejected');
});

test('default filtering excludes a cross-user record even from a faulty repository', async () => {
  const result = await recall([fakeMemoryRecord('fake-user-b-record', { userId: 'fake-user-b', subject: 'fake-user-b' })]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'user_scope');
});

test('admin actor cannot bypass record ownership', async () => {
  const context = fakeRecallContext({ authenticatedUserId: 'fake-admin', actorType: 'admin', actorId: 'fake-admin' });
  const result = await recall([fakeMemoryRecord('fake-user-a-record')], '按我的偏好推荐', context);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'user_scope');
});

test('filtering rejects a missing source id', async () => {
  const result = await recall([fakeMemoryRecord('fake-no-source', { source: { type: 'user_confirmed', id: '' } })]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'invalid_record');
});

test('filtering rejects an unknown source type', async () => {
  const result = await recall([fakeMemoryRecord('fake-bad-source', { source: { type: 'unknown', id: 'fake-source' } })]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'invalid_record');
});

test('filtering rejects a record that is not yet effective', async () => {
  const result = await recall([fakeMemoryRecord('fake-future', { effectiveFrom: '2027-01-01T00:00:00.000Z' })]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'not_effective');
});

test('filtering rejects a record whose effective range ended', async () => {
  const result = await recall([fakeMemoryRecord('fake-ended', { effectiveTo: '2026-07-02T00:00:00.000Z' })]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'not_effective');
});

test('filtering rejects an expired temporary context', async () => {
  const result = await recall([fakeMemoryRecord('fake-expired-context', { expiresAt: '2026-07-01T00:00:00.000Z' })]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'expired');
});

for (const accessPolicy of [
  { scope: 'shared' },
  { scope: 'private', allowRecall: false },
  { scope: 'private', allowedPurposes: ['different_purpose'] }
]) {
  test(`filtering enforces accessPolicy ${JSON.stringify(accessPolicy)}`, async () => {
    const result = await recall([fakeMemoryRecord('fake-access-denied', { accessPolicy })]);
    assert.equal(result.selected.length, 0);
    assert.equal(result.excluded[0].exclusionReason, 'access_policy');
  });
}

test('private owner memory is recallable', async () => {
  const result = await recall([fakeMemoryRecord('fake-private')]);
  assert.deepEqual(result.selected.map((item) => item.record.id), ['fake-private']);
});

test('ordinary recall filters high-sensitivity memory', async () => {
  const record = fakeMemoryRecord('fake-health', { memoryType: 'fact', sensitivity: 'high', confirmationStatus: 'user_confirmed', value: '虚构健康记录', normalizedValue: '虚构健康记录' });
  const result = await recall([record], '我的健康记录是什么');
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'sensitivity');
});

test('restricted memory is never recallable', async () => {
  const record = fakeMemoryRecord('fake-restricted', { sensitivity: 'restricted' });
  const context = fakeRecallContext({ purpose: 'sensitive_assistance', sensitivityAllowance: 'high', metadata: { sensitiveAccessApproved: true } });
  const result = await recall([record], '我的健康记录是什么', context);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'prohibited');
});

test('prohibited secret-like text is excluded even if a faulty repository returns it', async () => {
  const record = fakeMemoryRecord('fake-secret', { value: 'Access Token fake-secret-value', normalizedValue: 'access token fake-secret-value' });
  const result = await recall([record]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.excluded[0].exclusionReason, 'prohibited');
});

test('ordinary chat request returns an empty result without querying memory', async () => {
  const result = await recall([], '今天天气怎么样', fakeRecallContext(), { error: Object.assign(new Error('must not query'), { code: 'PERSISTENCE_CLOSED' }) });
  assert.equal(result.ok, true);
  assert.equal(result.selected.length, 0);
  assert.equal(result.intent.intent, 'no_memory_needed');
});

test('repository unavailable returns a safe error instead of an empty-memory claim', async () => {
  const result = await recall([], '按我的偏好推荐', fakeRecallContext(), { error: Object.assign(new Error('absolute /private/path'), { code: 'PERSISTENCE_CLOSED' }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEMORY_RECALL_UNAVAILABLE');
  assert.equal(result.intent.intent, 'personal_preference');
  assert.deepEqual(result.plan.memoryTypes, ['preference']);
  assert.equal(JSON.stringify(result).includes('/private/path'), false);
});

test('invalid RecallContext fails closed before Repository access', async () => {
  const result = await recall([], '按我的偏好推荐', fakeRecallContext({ authenticatedUserId: '' }), { error: new Error('must not query') });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEMORY_RECALL_INVALID_CONTEXT');
});

test('historical recall may include a superseded record', async () => {
  const old = fakeMemoryRecord('fake-old-city', { memoryType: 'fact', predicate: 'resides_in_city', value: '虚构旧城市', normalizedValue: '虚构旧城市', status: 'superseded', supersededById: 'fake-new-city' });
  const current = fakeMemoryRecord('fake-new-city', { memoryType: 'fact', predicate: 'resides_in_city', value: '虚构新城市', normalizedValue: '虚构新城市', supersedesId: 'fake-old-city' });
  const result = await recall([old, current], '我以前住在哪里');
  assert.equal(result.selected.length, 2);
});
