import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureOutcome,
  CaptureReasonCode,
  FakeAssistantBoundary,
  MemoryCaptureService
} from './index.js';
import { fakeConversation, fakeRepository, fakeUserContext, FAKE_NOW } from './testFixtures.js';

test('Fake Assistant can only propose a low-sensitivity pending candidate', async () => {
  const repository = fakeRepository();
  const boundary = new FakeAssistantBoundary({ content: '用户偏好简短回答', memoryType: 'preference' });
  const service = new MemoryCaptureService({ repository, assistantBoundary: boundary, clock: () => new Date(FAKE_NOW) });
  const result = await service.captureAssistantCandidate(fakeUserContext(), fakeConversation('fixture assistant input'));
  assert.equal(result.outcome, CaptureOutcome.CANDIDATE);
  assert.equal(result.reasonCode, CaptureReasonCode.ASSISTANT_CANDIDATE_ONLY);
  assert.equal(result.candidate.modelGenerated, true);
  assert.equal(result.candidate.source.type, 'model_inferred');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(repository.created.length, 0);
});

test('Fake Assistant high-sensitivity proposal is rejected before Candidate creation', async () => {
  const repository = fakeRepository();
  const boundary = new FakeAssistantBoundary({ content: '用户有严重过敏', memoryType: 'constraint' });
  const service = new MemoryCaptureService({ repository, assistantBoundary: boundary, clock: () => new Date(FAKE_NOW) });
  const result = await service.captureAssistantCandidate(fakeUserContext(), fakeConversation('fixture assistant input'));
  assert.equal(result.outcome, CaptureOutcome.REJECTED);
  assert.equal(result.reasonCode, CaptureReasonCode.ASSISTANT_SENSITIVE_REJECTED);
  assert.equal(result.candidate, null);
  assert.equal(repository.created.length, 0);
});

test('Fake Assistant prohibited-secret proposal is rejected without exposing it to Audit', async () => {
  const repository = fakeRepository();
  const boundary = new FakeAssistantBoundary({ content: 'password: fake-assistant-secret', memoryType: 'fact' });
  const service = new MemoryCaptureService({ repository, assistantBoundary: boundary, clock: () => new Date(FAKE_NOW) });
  const result = await service.captureAssistantCandidate(fakeUserContext(), fakeConversation('fixture assistant input'));
  assert.equal(result.reasonCode, CaptureReasonCode.PROHIBITED_SECRET);
  assert.equal(JSON.stringify(result.audit).includes('fake-assistant-secret'), false);
  assert.equal(repository.created.length, 0);
});

test('Fake Assistant Boundary has no Provider or Repository capability', async () => {
  const boundary = new FakeAssistantBoundary({ content: 'fixture', memoryType: 'fact' });
  assert.equal('repository' in boundary, false);
  assert.equal('provider' in boundary, false);
  assert.deepEqual(await boundary.propose({ text: 'ignored fixture text' }), { content: 'fixture', memoryType: 'fact' });
});
