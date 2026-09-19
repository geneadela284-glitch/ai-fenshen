import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureOutcome,
  CaptureReasonCode,
  MemoryCaptureService
} from './index.js';
import { validateMemoryCandidate, validateMemoryRecord } from '../kernel/index.js';
import { fakeConversation, fakeRepository, fakeUserContext, FAKE_NOW } from './testFixtures.js';

function serviceFixture() {
  const repository = fakeRepository();
  let nextId = 0;
  const service = new MemoryCaptureService({
    repository,
    clock: () => new Date(FAKE_NOW),
    idFactory: () => `fake-capture-id-${++nextId}`
  });
  return { repository, service };
}

test('non-memory input is rejected without calling Repository', async () => {
  const { repository, service } = serviceFixture();
  const result = await service.capture(fakeUserContext(), fakeConversation('你好'));
  assert.equal(result.outcome, CaptureOutcome.REJECTED);
  assert.equal(result.reasonCode, CaptureReasonCode.NOT_MEMORY);
  assert.equal(repository.created.length, 0);
});

test('temporary context stays outside Memory Repository', async () => {
  const { repository, service } = serviceFixture();
  const result = await service.capture(fakeUserContext(), fakeConversation('这次请用简短回答'));
  assert.equal(result.outcome, CaptureOutcome.CONTEXT_ONLY);
  assert.equal(result.context.value, '这次请用简短回答');
  assert.equal(result.memory, null);
  assert.equal(repository.created.length, 0);
});

test('clear long-term preference is directly stored as a user-stated high-value fact', async () => {
  const { repository, service } = serviceFixture();
  const context = fakeUserContext();
  const result = await service.capture(context, fakeConversation('我喜欢喝乌龙茶'));
  assert.equal(result.outcome, CaptureOutcome.STORED);
  assert.equal(result.reasonCode, CaptureReasonCode.PROACTIVE_HIGH_VALUE_AUTHORIZED);
  assert.equal(result.memory.status, 'confirmed');
  assert.equal(result.memory.confirmationStatus, 'not_required');
  assert.equal(validateMemoryRecord(result.memory, { trustedUserId: context.authenticatedUserId }).valid, true);
  assert.equal(repository.created.length, 1);
});

test('clear low-risk family birthday is directly stored with a stable birthday key', async () => {
  const { repository, service } = serviceFixture();
  const result = await service.capture(fakeUserContext(), fakeConversation('我妈是阴历7月16生日'));
  assert.equal(result.outcome, CaptureOutcome.STORED);
  assert.equal(result.reasonCode, CaptureReasonCode.PROACTIVE_HIGH_VALUE_AUTHORIZED);
  assert.equal(result.memory.memoryType, 'relationship');
  assert.equal(result.memory.subject, 'family:mother');
  assert.equal(result.memory.predicate, 'birthday');
  assert.equal(result.memory.value, '我妈妈的生日是农历七月十六日');
  assert.equal(repository.created.length, 1);
});

test('a clear family birthday with a year is still a low-risk formal write', async () => {
  const { repository, service } = serviceFixture();
  const result = await service.capture(fakeUserContext(), fakeConversation('我儿子生日是2020年5月1日'));
  assert.equal(result.outcome, CaptureOutcome.STORED);
  assert.equal(result.memory.subject, 'family:son');
  assert.equal(result.memory.value, '我儿子的生日是2020年五月一日');
  assert.equal(repository.created.length, 1);
});

test('uncertain birthday remains a pending candidate and is never directly stored', async () => {
  const { repository, service } = serviceFixture();
  const result = await service.capture(fakeUserContext(), fakeConversation('我妈妈生日好像是七月十六'));
  assert.equal(result.outcome, CaptureOutcome.CANDIDATE);
  assert.equal(result.reasonCode, CaptureReasonCode.CONFIRMATION_REQUIRED);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(validateMemoryCandidate(result.candidate, { trustedUserId: 'fake-user-a' }).valid, true);
  assert.equal(repository.created.length, 0);
});

test('explicit low-sensitivity remember creates a confirmed MemoryRecord', async () => {
  const { repository, service } = serviceFixture();
  const context = fakeUserContext();
  const result = await service.capture(context, fakeConversation('记住我喜欢喝乌龙茶'));
  assert.equal(result.outcome, CaptureOutcome.STORED);
  assert.equal(result.reasonCode, CaptureReasonCode.EXPLICIT_REMEMBER_AUTHORIZED);
  assert.equal(result.memory.status, 'confirmed');
  assert.equal(result.memory.confirmationStatus, 'not_required');
  assert.equal(validateMemoryRecord(result.memory, { trustedUserId: context.authenticatedUserId }).valid, true);
  assert.equal(repository.created.length, 1);
  assert.equal(repository.created[0].context.authenticatedUserId, 'fake-user-a');
  assert.equal(repository.created[0].record.userId, 'fake-user-a');
});

test('capture derives ownership from RepositoryContext, not the input payload', async () => {
  const { service } = serviceFixture();
  const result = await service.capture(fakeUserContext(), {
    ...fakeConversation('记住我喜欢喝乌龙茶'),
    userId: 'fake-user-b'
  });
  assert.equal(result.memory.userId, 'fake-user-a');
});

test('capture requires a traceable source id before building a candidate', async () => {
  const { repository, service } = serviceFixture();
  const result = await service.capture(fakeUserContext(), { text: '记住我喜欢喝乌龙茶' });
  assert.equal(result.outcome, CaptureOutcome.REJECTED);
  assert.equal(result.reasonCode, CaptureReasonCode.SOURCE_REQUIRED);
  assert.equal(repository.created.length, 0);
});

test('returned objects cannot mutate the stored Repository input', async () => {
  const { repository, service } = serviceFixture();
  const result = await service.capture(fakeUserContext(), fakeConversation('记住我喜欢喝乌龙茶'));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.memory));
  assert.throws(() => { result.memory.value = 'tampered'; }, TypeError);
  assert.notEqual(repository.created[0].record.value, 'tampered');
});
