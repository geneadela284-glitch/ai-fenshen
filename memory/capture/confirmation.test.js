import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureChecksum,
  CaptureOutcome,
  CaptureReasonCode,
  ConfirmationDecision,
  ConfirmationPolicy,
  MemoryCaptureService
} from './index.js';
import { fakeConversation, fakeRepository, fakeUserContext, FAKE_NOW } from './testFixtures.js';

test('ConfirmationPolicy authorizes explicit instructions and clear high-value statements without another prompt', () => {
  const policy = new ConfirmationPolicy();
  assert.equal(policy.evaluate({ explicit: true, sensitivity: 'low', prohibited: false }), ConfirmationDecision.AUTHORIZED);
  assert.equal(policy.evaluate({ explicit: false, directSaveAuthorized: true, sensitivity: 'low', prohibited: false }), ConfirmationDecision.AUTHORIZED);
  assert.equal(policy.evaluate({ explicit: false, sensitivity: 'low', prohibited: false }), ConfirmationDecision.REQUIRED);
  assert.equal(policy.evaluate({ explicit: true, sensitivity: 'high', prohibited: false }), ConfirmationDecision.REQUIRED);
  assert.equal(policy.evaluate({ explicit: true, sensitivity: 'restricted', prohibited: true }), ConfirmationDecision.REJECTED);
});

test('confirm promotes a pending preference candidate and writes once', async () => {
  const repository = fakeRepository();
  let nextId = 0;
  const service = new MemoryCaptureService({
    repository,
    clock: () => new Date(FAKE_NOW),
    idFactory: () => `fake-confirm-id-${++nextId}`
  });
  const context = fakeUserContext();
  const candidateResult = await service.capture(context, fakeConversation('我喜欢喝乌龙茶，好像是这样'));
  const result = await service.confirm(context, candidateResult.candidate, {
    requestId: 'fake-confirm-request-001',
    idempotencyKey: 'fake-confirm-key-001'
  });
  assert.equal(result.outcome, CaptureOutcome.STORED);
  assert.equal(result.reasonCode, CaptureReasonCode.USER_CONFIRMED);
  assert.equal(result.memory.status, 'confirmed');
  assert.equal(result.memory.confirmationStatus, 'user_confirmed');
  assert.equal(repository.created.length, 1);
});

test('confirming a high-sensitivity candidate records user confirmation', async () => {
  const repository = fakeRepository();
  const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
  const context = fakeUserContext();
  const candidateResult = await service.capture(context, fakeConversation('记住我对花生严重过敏'));
  const result = await service.confirm(context, candidateResult.candidate, { requestId: 'fake-confirm-high' });
  assert.equal(result.memory.sensitivity, 'high');
  assert.equal(result.memory.confirmationStatus, 'user_confirmed');
});

test('confirm fails closed when candidate ownership is tampered', async () => {
  const repository = fakeRepository();
  const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
  const context = fakeUserContext();
  const candidateResult = await service.capture(context, fakeConversation('我喜欢喝乌龙茶，好像是这样'));
  const tampered = structuredClone(candidateResult.candidate);
  tampered.userId = 'fake-user-b';
  const result = await service.confirm(context, tampered, { requestId: 'fake-confirm-tampered' });
  assert.equal(result.outcome, CaptureOutcome.REJECTED);
  assert.equal(result.reasonCode, CaptureReasonCode.INVALID_CANDIDATE);
  assert.equal(repository.created.length, 0);
});

test('confirm rejects a candidate whose proposed value was changed', async () => {
  const repository = fakeRepository();
  const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
  const context = fakeUserContext();
  const candidateResult = await service.capture(context, fakeConversation('我喜欢喝乌龙茶，好像是这样'));
  const tampered = structuredClone(candidateResult.candidate);
  tampered.proposedMemory.value = '被篡改的内容';
  const result = await service.confirm(context, tampered, { requestId: 'fake-confirm-tampered-value' });
  assert.equal(result.outcome, CaptureOutcome.REJECTED);
  assert.equal(result.reasonCode, CaptureReasonCode.CANDIDATE_INTEGRITY_FAILED);
  assert.equal(repository.created.length, 0);
});

test('confirm rejects tampering even when the caller recomputes the public candidate checksum', async () => {
  const repository = fakeRepository();
  const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
  const context = fakeUserContext();
  const candidateResult = await service.capture(context, fakeConversation('我喜欢喝乌龙茶，好像是这样'));
  const tampered = structuredClone(candidateResult.candidate);
  tampered.proposedMemory.value = '被篡改且重算校验的内容';
  tampered.metadata.integrityChecksum = captureChecksum(tampered.proposedMemory);
  const result = await service.confirm(context, tampered, { requestId: 'fake-confirm-rehashed-tamper' });
  assert.equal(result.outcome, CaptureOutcome.REJECTED);
  assert.equal(result.reasonCode, CaptureReasonCode.CANDIDATE_INTEGRITY_FAILED);
  assert.equal(repository.created.length, 0);
});
