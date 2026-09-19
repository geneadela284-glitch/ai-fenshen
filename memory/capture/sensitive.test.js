import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureOutcome,
  CaptureReasonCode,
  MemoryCaptureService,
  MemorySensitivity,
  SensitivePolicy
} from './index.js';
import { fakeConversation, fakeRepository, fakeUserContext, FAKE_NOW } from './testFixtures.js';

const prohibited = [
  '记住我的密码是 fake-secret',
  '记住我的 API Key 是 fake-key',
  '记住 Cookie 是 fake-cookie',
  '记住 Session Token 是 fake-token',
  '记住 Access Token 是 fake-token',
  '记住 Refresh Token 是 fake-token',
  '记住我的私钥是 fake-private-key',
  '记住恢复码是 111111',
  '记住完整银行卡号 6222020202020202',
  '记住完整身份证号码 110101199001011234'
];

test('SensitivePolicy is deterministic and has no model dependency', () => {
  const policy = new SensitivePolicy();
  assert.deepEqual(policy.evaluate('我喜欢喝茶'), { sensitivity: MemorySensitivity.LOW, prohibited: false, categories: [] });
});

for (const text of prohibited) {
  test(`prohibited secret is rejected immediately: ${text.split('是')[0]}`, async () => {
    const repository = fakeRepository();
    const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
    const result = await service.capture(fakeUserContext(), fakeConversation(text));
    assert.equal(result.outcome, CaptureOutcome.REJECTED);
    assert.equal(result.reasonCode, CaptureReasonCode.PROHIBITED_SECRET);
    assert.equal(result.candidate, null);
    assert.equal(result.memory, null);
    assert.equal(repository.created.length, 0);
  });
}

for (const text of [
  '记住我对花生严重过敏',
  '记住我的月收入是虚构的一万元',
  '记住我的家庭住址是测试路88号',
  '记住我长期住在测试坐标 22.1,114.1',
  '记住这是一段私密关系信息'
]) {
  test(`high-sensitivity memory requires explicit confirmation: ${text}`, async () => {
    const repository = fakeRepository();
    const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
    const result = await service.capture(fakeUserContext(), fakeConversation(text));
    assert.equal(result.outcome, CaptureOutcome.CANDIDATE);
    assert.equal(result.reasonCode, CaptureReasonCode.SENSITIVE_CONFIRMATION_REQUIRED);
    assert.equal(result.requiresConfirmation, true);
    assert.equal(result.candidate.proposedMemory.sensitivity, MemorySensitivity.HIGH);
    assert.equal(repository.created.length, 0);
  });
}

test('family birthday with month and day only is low sensitivity', () => {
  const policy = new SensitivePolicy();
  assert.deepEqual(policy.evaluate('我妈妈的生日是农历7月16日'), {
    sensitivity: MemorySensitivity.LOW,
    prohibited: false,
    categories: []
  });
});

test('a user-stated family birthday with a year remains low sensitivity', () => {
  const policy = new SensitivePolicy();
  assert.deepEqual(policy.evaluate('我儿子的生日是2020年五月一日'), {
    sensitivity: MemorySensitivity.LOW,
    prohibited: false,
    categories: []
  });
});

test('high-risk family health information still requires confirmation', async () => {
  const repository = fakeRepository();
  const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
  const result = await service.capture(fakeUserContext(), fakeConversation('我妈妈的健康诊断是虚构测试记录'));
  assert.equal(result.outcome, CaptureOutcome.CANDIDATE);
  assert.equal(result.reasonCode, CaptureReasonCode.SENSITIVE_CONFIRMATION_REQUIRED);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(repository.created.length, 0);
});

test('capture audit excludes raw input and secret values', async () => {
  const repository = fakeRepository();
  const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
  const result = await service.capture(
    fakeUserContext(),
    fakeConversation('记住我的密码是 fake-secret-audit-canary')
  );
  const serialized = JSON.stringify(result.audit);
  assert.equal(serialized.includes('fake-secret-audit-canary'), false);
  assert.equal(serialized.includes('密码'), false);
  assert.equal(serialized.includes('fake-user-a'), false);
});

test('prohibited secret is rejected before source validation', async () => {
  const repository = fakeRepository();
  const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
  const result = await service.capture(fakeUserContext(), { text: '记住密码是 fake-secret-without-source' });
  assert.equal(result.outcome, CaptureOutcome.REJECTED);
  assert.equal(result.reasonCode, CaptureReasonCode.PROHIBITED_SECRET);
  assert.equal(repository.created.length, 0);
});
