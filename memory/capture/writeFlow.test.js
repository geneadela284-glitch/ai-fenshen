import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryMemoryRepository } from '../repository/index.js';
import {
  CaptureOutcome,
  CaptureReasonCode,
  MemoryCaptureService
} from './index.js';
import { fakeConversation, fakeUserContext, FAKE_NOW } from './testFixtures.js';

function fixture() {
  const repository = createInMemoryMemoryRepository({ clock: () => new Date(FAKE_NOW) });
  let id = 0;
  const service = new MemoryCaptureService({
    repository,
    clock: () => new Date(FAKE_NOW),
    idFactory: () => `fake-write-flow-${++id}`
  });
  return { repository, service };
}

test('an exclusive fact conflict becomes a pending candidate without overwriting history', async () => {
  const { repository, service } = fixture();
  const context = fakeUserContext();
  const first = await service.capture(context, fakeConversation('记住我的常住城市是上海', {
    sourceId: 'fake-city-source-1'
  }));
  const conflict = await service.capture(context, fakeConversation('记住我已经搬到深圳', {
    sourceId: 'fake-city-source-2'
  }));
  assert.equal(conflict.outcome, CaptureOutcome.CANDIDATE);
  assert.equal(conflict.reasonCode, CaptureReasonCode.CONFLICT_CONFIRMATION_REQUIRED);
  assert.equal(conflict.requiresConfirmation, true);
  assert.equal((await repository.getById(context, first.memory.id)).status, 'confirmed');
  assert.equal((await repository.query(context, { userId: 'fake-user-a' })).items.length, 1);
});

test('confirming a conflict atomically supersedes the old fact', async () => {
  const { repository, service } = fixture();
  const context = fakeUserContext();
  const first = await service.capture(context, fakeConversation('记住我的常住城市是上海', {
    sourceId: 'fake-city-source-1'
  }));
  const conflict = await service.capture(context, fakeConversation('记住我已经搬到深圳', {
    sourceId: 'fake-city-source-2'
  }));
  const result = await service.confirm(context, conflict.candidate, {
    requestId: 'fake-conflict-confirm',
    idempotencyKey: 'fake-conflict-confirm-key'
  });
  assert.equal(result.outcome, CaptureOutcome.STORED);
  assert.equal(result.reasonCode, CaptureReasonCode.CONFLICT_SUPERSEDED);
  assert.equal(result.memory.value, '深圳');
  const chain = await repository.getVersionChain(context, result.memory.id);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].id, first.memory.id);
  assert.equal(chain[0].status, 'superseded');
  assert.equal(chain[1].supersedesId, first.memory.id);
});

test('forget intent moves an exact version to recycle bin and stops normal recall', async () => {
  const { repository, service } = fixture();
  const context = fakeUserContext();
  const stored = await service.capture(context, fakeConversation('记住我喜欢喝乌龙茶'));
  const result = await service.capture(context, fakeConversation('忘掉这条记忆', {
    targetMemoryId: stored.memory.id,
    expectedVersion: stored.memory.version,
    idempotencyKey: 'fake-forget-key'
  }));
  assert.equal(result.outcome, CaptureOutcome.FORGOTTEN);
  assert.equal(result.reasonCode, CaptureReasonCode.MOVED_TO_RECYCLE_BIN);
  assert.equal((await repository.query(context, { userId: 'fake-user-a' })).items.length, 0);
  await assert.rejects(() => repository.getById(context, stored.memory.id), (error) => error?.code === 'MEMORY_RECORD_NOT_FOUND');
});

test('forget intent requires an exact target and expected version', async () => {
  const { service } = fixture();
  const context = fakeUserContext();
  const missingTarget = await service.capture(context, fakeConversation('忘掉这条记忆'));
  assert.equal(missingTarget.reasonCode, CaptureReasonCode.TARGET_MEMORY_REQUIRED);
  const missingVersion = await service.capture(context, fakeConversation('忘掉这条记忆', { targetMemoryId: 'fake-memory' }));
  assert.equal(missingVersion.reasonCode, CaptureReasonCode.EXPECTED_VERSION_REQUIRED);
});

test('forget retry with the same idempotency key returns the same safe result', async () => {
  const { service } = fixture();
  const context = fakeUserContext();
  const stored = await service.capture(context, fakeConversation('记住我喜欢喝乌龙茶'));
  const request = fakeConversation('忘掉这条记忆', {
    targetMemoryId: stored.memory.id,
    expectedVersion: stored.memory.version,
    idempotencyKey: 'fake-forget-retry-key'
  });
  const first = await service.capture(context, request);
  const retry = await service.capture(context, request);
  assert.deepEqual(retry, first);
});
