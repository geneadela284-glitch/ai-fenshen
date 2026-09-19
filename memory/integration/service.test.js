import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryCaptureService } from '../capture/index.js';
import { MemoryGovernanceService } from '../governance/index.js';
import { MemoryRecallEngine } from '../recall/index.js';
import { InMemoryMemoryRepository } from '../repository/index.js';
import { MemoryLifeTimelineService } from '../timeline/index.js';
import { LifeIntelligenceService } from '../intelligence/index.js';
import {
  AuthenticatedMemoryContextFactory,
  MemoryFeatureFlags,
  MemoryRealUserService
} from './index.js';

const NOW = '2026-07-16T08:00:00.000Z';
const userA = Object.freeze({ id: 'fake-user-a', username: 'fake-user-a', role: 'user', status: 'active' });
const userB = Object.freeze({ id: 'fake-user-b', username: 'fake-user-b', role: 'user', status: 'active' });

function harness(env = {}, options = {}) {
  let sequence = 0;
  const clock = options.clock || (() => new Date(NOW));
  const idFactory = () => `m9-${++sequence}`;
  const repository = new InMemoryMemoryRepository({ clock });
  const contextFactory = new AuthenticatedMemoryContextFactory({ clock, idFactory });
  const flags = new MemoryFeatureFlags({
    env: { MEMORY_REAL_USER_ENABLED: 'true', ...env },
    whitelist: ['fake-user-a', 'fake-user-b']
  });
  const service = new MemoryRealUserService({
    contextFactory,
    flags,
    capture: new MemoryCaptureService({ repository, clock, idFactory }),
    recall: options.recall || new MemoryRecallEngine({ repository }),
    governance: new MemoryGovernanceService({ repository, clock, idFactory }),
    timeline: new MemoryLifeTimelineService({ repository, clock, idFactory }),
    intelligence: new LifeIntelligenceService({ clock, idFactory }),
    clock,
    idFactory
  });
  return { service, repository, contextFactory };
}

function request(input, suffix = '1', overrides = {}) {
  return {
    input,
    sourceId: `fake-source-${suffix}`,
    requestId: `fake-request-${suffix}`,
    conversationId: 'fake-conversation',
    idempotencyKey: `fake-idempotency-${suffix}`,
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    ...overrides
  };
}

async function remember(service, user, input, suffix = 'save') {
  return service.processConversation(user, request(input, suffix));
}

for (const [index, content] of [
  '无糖咖啡', '乌龙茶', '低糖豆浆', '热柠檬水', '美式咖啡',
  '茉莉花茶', '温水', '燕麦奶', '红茶', '绿茶',
  '拿铁', '苏打水', '椰子水', '黑咖啡', '普洱茶',
  '白茶', '矿泉水', '抹茶', '牛奶', '果汁'
].entries()) {
  test(`explicit low-risk memory is directly and formally stored ${index + 1}`, async () => {
    const { service } = harness();
    const result = await remember(service, userA, `记住我喜欢${content}`, String(index + 1));
    assert.equal(result.status, 'stored');
    assert.equal(result.safeMessage, '已永久保存');
    assert.equal(result.memoryId.startsWith('memory-'), true);
    assert.equal('value' in result, false);
  });
}

for (const input of ['你好', '今天天气怎么样？', '帮我写一封邮件', '谢谢', '1+1等于多少', '量子计算是什么？']) {
  test(`ordinary conversation is not written: ${input}`, async () => {
    const { service, repository, contextFactory } = harness();
    const result = await service.processConversation(userA, request(input, input.length));
    assert.equal(result.handled, false);
    assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
  });
}

test('clear user-stated preference is proactively saved without a second confirmation', async () => {
  const { service, repository, contextFactory } = harness();
  const result = await service.processConversation(userA, request('我喜欢吃辣', 'proactive-spicy'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'stored');
  assert.match(result.safeMessage, /我记住了.*喜欢吃辣/);
  assert.equal('confirmationId' in result, false);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 1);
});

test('clear family birthday is proactively saved and naturally acknowledged', async () => {
  const { service, repository, contextFactory } = harness();
  const result = await service.processConversation(userA, request('我妈是阴历7月16生日', 'mother-birthday'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'stored');
  assert.equal(result.safeMessage, '我记住了：你妈妈的生日是农历七月十六。');
  const record = await repository.getById(contextFactory.repository(userA), result.memoryId);
  assert.equal(record.subject, 'family:mother');
  assert.equal(record.predicate, 'birthday');
});

for (const [index, input] of [
  '我妈妈阴历七月十六生日',
  '我妈生日是农历七月十六',
  '我母亲的生日是阴历7月16',
  '我爸阳历3月8号生日',
  '我老婆生日是农历八月初五',
  '我儿子生日是2020年5月1日'
].entries()) {
  test(`natural family birthday reaches the formal write flow ${index + 1}`, async () => {
    const { service, repository, contextFactory } = harness();
    const result = await service.processConversation(userA, request(input, `natural-birthday-${index}`));
    assert.equal(result.handled, true);
    assert.equal(result.status, 'stored');
    assert.match(result.safeMessage, /我记住了/);
    assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 1);
  });
}

test('equivalent family aliases and date forms are semantically idempotent', async () => {
  const { service, repository, contextFactory } = harness();
  const first = await service.processConversation(userA, request('我妈是阴历7月16生日', 'birthday-natural-first'));
  const repeated = await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'birthday-natural-repeat'));
  assert.equal(first.status, 'stored');
  assert.equal(repeated.status, 'stored');
  assert.equal(repeated.memoryId, first.memoryId);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 1);
});

test('recent tiredness is not proactively stored as a long-term fact', async () => {
  const { service, repository, contextFactory } = harness();
  const result = await service.processConversation(userA, request('我最近有点累', 'temporary-tired'));
  assert.equal(result.status === 'stored', false);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
});

test('uncertain family birthday requires confirmation and is not directly stored', async () => {
  const { service, repository, contextFactory } = harness();
  const result = await service.processConversation(userA, request('我妈妈生日好像是七月十六', 'uncertain-birthday'));
  assert.equal(result.status, 'confirmation_required');
  assert.equal(result.confirmationRequired, true);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
});

test('repeated high-value statement is semantically idempotent across separate requests', async () => {
  const { service, repository, contextFactory } = harness();
  const first = await service.processConversation(userA, request('我妈妈阴历7月16生日', 'birthday-first'));
  const repeated = await service.processConversation(userA, request('我妈妈阴历7月16生日', 'birthday-repeat'));
  assert.equal(first.status, 'stored');
  assert.equal(repeated.status, 'stored');
  assert.equal(repeated.memoryId, first.memoryId);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 1);
});

test('conflicting family birthday becomes a confirmation case without silent overwrite', async () => {
  const { service, repository, contextFactory } = harness();
  await service.processConversation(userA, request('我妈是阴历7月16生日', 'birthday-old'));
  const conflict = await service.processConversation(userA, request('我妈妈生日是农历七月十七', 'birthday-new'));
  assert.equal(conflict.status, 'confirmation_required');
  assert.equal(conflict.reasonCode, 'CAPTURE_CONFLICT_CONFIRMATION_REQUIRED');
  assert.match(conflict.safeMessage, /不一致/);
  const records = await repository.query(contextFactory.repository(userA), { userId: userA.id });
  assert.equal(records.items.length, 1);
  assert.equal(records.items[0].value, '我妈妈的生日是农历七月十六日');
});

test('family birthday can be recalled naturally and capture audit stores no full body', async () => {
  const { service } = harness();
  await service.processConversation(userA, request('我妈是阴历7月16生日', 'birthday-save'));
  const recalled = await service.processConversation(userA, request('我妈妈生日是哪天？', 'birthday-recall'));
  assert.equal(recalled.status, 'recalled');
  assert.match(recalled.safeMessage, /^我记得：/);
  assert.match(recalled.safeMessage, /妈妈.*农历七月十六日/);
  const audit = JSON.stringify(service.audit.list(userA.id));
  assert.equal(audit.includes('我妈是阴历7月16生日'), false);
  assert.equal(audit.includes('农历七月十六日'), false);
});

test('mother birthday never answers a wife birthday query', async () => {
  const { service } = harness();
  await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'mother-only'));
  const result = await service.processConversation(userA, request('我老婆什么时候生日？', 'wife-no-match'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'no_matching_memory');
  assert.equal(result.memoryContext.items.length, 0);
  assert.equal(result.safeMessage, '我目前还不知道你老婆的生日。你告诉我后，我可以记住。');
  assert.doesNotMatch(result.safeMessage, /七月十六/);
});

test('mother birthday never answers a daughter birthday query', async () => {
  const { service } = harness();
  await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'mother-for-daughter'));
  const result = await service.processConversation(userA, request('我女儿什么时候生日？', 'daughter-no-match'));
  assert.equal(result.status, 'no_matching_memory');
  assert.match(result.safeMessage, /不知道你女儿的生日/);
  assert.equal(result.memoryContext.items.length, 0);
});

test('mother and wife birthdays are recalled independently', async () => {
  const { service } = harness();
  await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'independent-mother'));
  await service.processConversation(userA, request('我老婆生日是农历八月初五', 'independent-wife'));
  const mother = await service.processConversation(userA, request('我母亲什么时候生日？', 'query-mother'));
  const wife = await service.processConversation(userA, request('我太太什么时候生日？', 'query-wife'));
  assert.match(mother.safeMessage, /妈妈.*七月十六/);
  assert.doesNotMatch(mother.safeMessage, /八月初五/);
  assert.match(wife.safeMessage, /妻子.*八月初五/);
  assert.doesNotMatch(wife.safeMessage, /七月十六/);
});

test('mother father daughter and son birthdays never cross entity boundaries', async () => {
  const { service } = harness();
  const statements = [
    ['我妈妈阴历七月十六生日', '妈妈', '七月十六'],
    ['我爸爸阳历三月八日生日', '爸爸', '三月八'],
    ['我女儿生日是2020年5月1日', '女儿', '五月一'],
    ['我儿子生日是2021年6月2日', '儿子', '六月二']
  ];
  for (const [index, [statement]] of statements.entries()) {
    const stored = await service.processConversation(userA, request(statement, `family-${index}`));
    assert.equal(stored.status, 'stored');
  }
  for (const [index, [, relation, expected]] of statements.entries()) {
    const result = await service.processConversation(userA, request(`我${relation}什么时候生日？`, `family-query-${index}`));
    assert.match(result.safeMessage, new RegExp(expected));
    for (const other of statements.map((item) => item[2]).filter((value) => value !== expected)) {
      assert.doesNotMatch(result.safeMessage, new RegExp(other));
    }
  }
});

test('explicit same-conversation entity context can resolve a pronoun', async () => {
  const { service } = harness();
  await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'pronoun-save'));
  await service.processConversation(userA, request('我妈妈什么时候生日？', 'pronoun-explicit', { conversationId: 'pronoun-thread' }));
  const result = await service.processConversation(userA, request('她什么时候生日？', 'pronoun-follow-up', { conversationId: 'pronoun-thread' }));
  assert.equal(result.status, 'recalled');
  assert.match(result.safeMessage, /妈妈.*七月十六/);
});

test('ambiguous pronoun asks one clarification instead of guessing', async () => {
  const { service } = harness();
  await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'ambiguous-pronoun-save'));
  const result = await service.processConversation(userA, request('她什么时候生日？', 'ambiguous-pronoun', { conversationId: 'new-thread' }));
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.handled, true);
  assert.match(result.safeMessage, /她.*谁/);
  assert.equal(result.safeMessage.match(/？/g)?.length, 1);
});

test('deleted relationship memory is not recalled or replaced by another relation', async () => {
  const { service } = harness();
  const wife = await service.processConversation(userA, request('我老婆生日是农历八月初五', 'deleted-wife'));
  await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'other-mother'));
  await service.deleteMemory(userA, wife.memoryId, { expectedVersion: 1 });
  const result = await service.processConversation(userA, request('我妻子什么时候生日？', 'query-deleted-wife'));
  assert.equal(result.status, 'no_matching_memory');
  assert.doesNotMatch(result.safeMessage, /七月十六/);
});

test('superseded relationship recall returns only the current version for the same entity', async () => {
  const { service } = harness();
  const stored = await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'superseded-mother-old'));
  const proposed = await service.correctMemory(userA, stored.memoryId, {
    expectedVersion: 1,
    value: '我妈妈的生日是农历七月十七日'
  });
  assert.equal(proposed.status, 'confirmation_required');
  const corrected = await service.correctMemory(userA, stored.memoryId, {
    expectedVersion: 1,
    confirmationToken: proposed.data.confirmationToken,
    value: '我妈妈的生日是农历七月十七日'
  });
  assert.equal(corrected.status, 'completed');
  const result = await service.processConversation(userA, request('我妈妈什么时候生日？', 'superseded-mother-query'));
  assert.equal(result.status, 'recalled');
  assert.match(result.safeMessage, /七月十七/);
  assert.doesNotMatch(result.safeMessage, /七月十六/);
  assert.equal(result.memoryContext.items.length, 1);
});

test('cross-user relationship memories remain isolated by owner and entity', async () => {
  const { service } = harness();
  await service.processConversation(userA, request('我妈妈阴历七月十六生日', 'user-a-mother'));
  const result = await service.processConversation(userB, request('我妈妈什么时候生日？', 'user-b-query'));
  assert.equal(result.status, 'no_matching_memory');
  assert.equal(result.memoryContext.items.length, 0);
  assert.doesNotMatch(result.safeMessage, /七月十六/);
});

test('short opt-out wording is acknowledged without storing anything', async () => {
  const { service, repository, contextFactory } = harness();
  const result = await service.processConversation(userA, request('不要记这个'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'opted_out');
  assert.match(result.safeMessage, /不会保存/);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
});

test('reference-only remember wording asks one clarification instead of guessing prior content', async () => {
  const { service, repository, contextFactory } = harness();
  const result = await service.processConversation(userA, request('把刚才这件事记下来。'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'needs_clarification');
  assert.match(result.safeMessage, /要记住的具体内容/);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
});

test('non-explicit preference change requests one confirmation and never silently supersedes', async () => {
  const { service, repository, contextFactory } = harness();
  await remember(service, userA, '记住我喜欢喝咖啡', 'old');
  const result = await service.processConversation(userA, request('我现在不喝咖啡了，改成喝茶。', 'change'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'needs_clarification');
  assert.match(result.safeMessage, /作为新的长期偏好保存/);
  const records = await repository.query(contextFactory.repository(userA), { userId: userA.id });
  assert.equal(records.items.length, 1);
  assert.equal(records.items[0].status, 'confirmed');
});

test('high-sensitive memory requires a short confirmation and exposes no body', async () => {
  const { service, repository, contextFactory } = harness();
  const pending = await service.processConversation(userA, request('记住我的健康信息是虚构测试记录'));
  assert.equal(pending.status, 'confirmation_required');
  assert.equal(pending.confirmationRequired, true);
  assert.equal(pending.safeSummary, '存在一条高敏感记忆，确认后才会长期保存。');
  assert.equal(JSON.stringify(pending).includes('虚构测试记录'), false);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
  const confirmed = await service.confirmCapture(userA, { confirmationId: pending.confirmationId, action: 'confirm', requestId: 'confirm-1' });
  assert.equal(confirmed.status, 'stored');
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 1);
});

test('explicit low-risk memory is directly stored without a confirmation candidate', async () => {
  const { service, repository, contextFactory } = harness();
  const stored = await service.processConversation(userA, request('记住我喜欢吃辣', 'spicy'));
  assert.equal(stored.status, 'stored');
  assert.equal(stored.safeMessage, '已永久保存');
  assert.equal('confirmationId' in stored, false);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 1);
});

for (const [index, input] of ['记住我喜欢吃辣', '以后记得我喜欢吃辣', '帮我保存我喜欢吃辣'].entries()) {
  test(`explicit authorization wording directly stores without confirmation ${index + 1}`, async () => {
    const { service } = harness();
    const result = await service.processConversation(userA, request(input, `explicit-wording-${index}`));
    assert.equal(result.status, 'stored');
    assert.equal(result.safeMessage, '已永久保存');
    assert.equal('confirmationId' in result, false);
  });
}

test('retrying the same explicit low-risk request is idempotent and creates no duplicate', async () => {
  const { service, repository, contextFactory } = harness();
  const sameRequest = request('记住我喜欢吃辣', 'direct-spicy');
  const first = await service.processConversation(userA, sameRequest);
  const repeated = await service.processConversation(userA, sameRequest);
  assert.equal(first.status, 'stored');
  assert.equal(repeated.status, 'stored');
  assert.equal(repeated.memoryId, first.memoryId);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 1);
});

test('editing a high-sensitive pending candidate reruns policy and can directly store safe low-risk content', async () => {
  const { service, repository, contextFactory } = harness();
  const pending = await service.processConversation(userA, request('记住我的健康信息是虚构测试记录', 'edit-sensitive'));
  const edited = await service.confirmCapture(userA, {
    confirmationId: pending.confirmationId,
    action: 'edit',
    editedText: '我喜欢清淡饮食',
    requestId: 'edit-sensitive-request'
  });
  assert.equal(edited.status, 'stored');
  const record = await repository.getById(contextFactory.repository(userA), edited.memoryId);
  assert.equal(record.value, '我喜欢清淡饮食');
});

test('editing a pending candidate reruns prohibited-secret detection without persisting content', async () => {
  const { service, repository, contextFactory } = harness();
  const pending = await service.processConversation(userA, request('记住我的健康信息是虚构测试记录', 'edit-secret'));
  const edited = await service.confirmCapture(userA, {
    confirmationId: pending.confirmationId,
    action: 'edit',
    editedText: '密码是虚构测试秘密',
    requestId: 'edit-secret-request'
  });
  assert.equal(edited.status, 'rejected');
  assert.equal(edited.reasonCode, 'CAPTURE_PROHIBITED_SECRET');
  assert.equal(JSON.stringify(edited).includes('虚构测试秘密'), false);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
});

test('cancelled confirmation writes nothing', async () => {
  const { service, repository, contextFactory } = harness();
  const pending = await service.processConversation(userA, request('记住我的健康信息是虚构测试记录', 'cancel-sensitive'));
  const cancelled = await service.confirmCapture(userA, { confirmationId: pending.confirmationId, action: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
});

test('another user cannot confirm a candidate or learn whether it exists', async () => {
  const { service, repository, contextFactory } = harness();
  const pending = await service.processConversation(userA, request('记住我的健康信息是虚构测试记录', 'cross-user-confirm'));
  const denied = await service.confirmCapture(userB, {
    confirmationId: pending.confirmationId,
    action: 'confirm',
    requestId: 'cross-user-attempt'
  });
  assert.equal(denied.status, 'expired');
  assert.equal(denied.reasonCode, 'MEMORY_CONFIRMATION_INVALID_OR_EXPIRED');
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
  assert.equal(await repository.count(contextFactory.repository(userB), { userId: userB.id }), 0);
});

test('expired candidate returns a clear safe result and writes nothing', async () => {
  let now = Date.parse(NOW);
  const { service, repository, contextFactory } = harness({}, { clock: () => new Date(now) });
  const pending = await service.processConversation(userA, request('记住我的健康信息是虚构测试记录', 'expired-confirm'));
  now += 6 * 60 * 1000;
  const expired = await service.confirmCapture(userA, {
    confirmationId: pending.confirmationId,
    action: 'confirm',
    requestId: 'expired-confirm-attempt'
  });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.reasonCode, 'MEMORY_CONFIRMATION_INVALID_OR_EXPIRED');
  assert.match(expired.safeMessage, /过期/);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
});

test('version conflict during confirmation is reported safely without overwriting', async () => {
  const { service, repository, contextFactory } = harness();
  const old = await remember(service, userA, '记住我的常住城市是上海', 'city-old');
  const pending = await service.processConversation(userA, request('记住我已经搬到深圳', 'city-new'));
  assert.equal(pending.status, 'confirmation_required');
  const context = contextFactory.repository(userA, { requestId: 'city-concurrent-update' });
  await repository.update(context, old.memoryId, { importance: 0.8 }, {
    expectedVersion: 1,
    requestId: 'city-concurrent-update',
    operationReason: 'fake_concurrent_update'
  });
  const conflicted = await service.confirmCapture(userA, {
    confirmationId: pending.confirmationId,
    action: 'confirm',
    requestId: 'city-new-confirm'
  });
  assert.equal(conflicted.status, 'conflict');
  assert.equal(conflicted.reasonCode, 'MEMORY_VERSION_CONFLICT');
  assert.match(conflicted.safeMessage, /发生变化/);
  const current = await repository.query(contextFactory.repository(userA), { userId: userA.id });
  assert.equal(current.items.length, 1);
  assert.equal(current.items[0].value, '上海');
});

for (const secret of [
  '密码是测试内容', 'API Key 是测试内容', 'Cookie 是测试内容', 'Access Token 是测试内容',
  'Refresh Token 是测试内容', '私钥是测试内容', '恢复码是测试内容'
]) {
  test(`prohibited secret is rejected without persistence: ${secret.split('是')[0].trim()}`, async () => {
    const { service, repository, contextFactory } = harness();
    const result = await service.processConversation(userA, request(`记住${secret}`, secret.length));
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'CAPTURE_PROHIBITED_SECRET');
    assert.equal(JSON.stringify(result).includes('测试内容'), false);
    assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
  });
}

test('capture off rejects an explicit remember request without falling through as saved', async () => {
  const { service } = harness({ MEMORY_CAPTURE_ENABLED: 'false' });
  const result = await service.processConversation(userA, request('记住我喜欢无糖咖啡'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'disabled');
  assert.match(result.safeMessage, /未保存/);
});

test('master rollback leaves conversation unhandled and never writes', async () => {
  const { service, repository, contextFactory } = harness({ MEMORY_REAL_USER_ENABLED: 'false' });
  const result = await service.processConversation(userA, request('记住我喜欢无糖咖啡'));
  assert.equal(result.enabled, false);
  assert.equal(result.handled, false);
  assert.equal(await repository.count(contextFactory.repository(userA), { userId: userA.id }), 0);
});

test('stored preference is recalled with a bounded safe context pack', async () => {
  const { service } = harness();
  await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const recalled = await service.processConversation(userA, request('我平时喜欢喝什么？', 'recall'));
  assert.equal(recalled.handled, true);
  assert.equal(recalled.status, 'recalled');
  assert.equal(recalled.memoryContext.items.length, 1);
  assert.match(recalled.safeMessage, /你之前让我记住/);
  assert.equal(recalled.memoryContext.items[0].safeText.includes('无糖咖啡'), true);
});

test('explicit food preference is immediately recalled by the exact acceptance wording', async () => {
  const { service } = harness();
  const stored = await remember(service, userA, '记住我喜欢吃辣', 'save-spicy-recall');
  assert.equal(stored.status, 'stored');

  const recalled = await service.processConversation(userA, request('我喜欢吃什么？', 'recall-spicy'));
  assert.equal(recalled.handled, true);
  assert.equal(recalled.status, 'recalled');
  assert.equal(recalled.memoryContext.items.length, 1);
  assert.match(recalled.safeMessage, /你之前让我记住/);
  assert.equal(recalled.memoryContext.items[0].safeText.includes('喜欢吃辣'), true);
});

test('preference recall outage is transparent and cannot fall through as no matching memory', async () => {
  const unavailableRecall = {
    async recall() {
      return {
        ok: false,
        intent: { intent: 'personal_preference', reasonCode: 'RECALL_PREFERENCE_SIGNAL' },
        plan: { memoryTypes: ['preference'] },
        selected: [],
        excluded: [],
        conflictNotices: [],
        warnings: [],
        error: { code: 'MEMORY_RECALL_UNAVAILABLE' }
      };
    },
    buildContextPack() {
      throw new Error('failed recall must not build a context pack');
    }
  };
  const { service } = harness({}, { recall: unavailableRecall });
  const result = await service.processConversation(userA, request('我喜欢吃什么？', 'recall-outage'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'degraded');
  assert.match(result.safeMessage, /暂时不可用/);
  assert.doesNotMatch(result.safeMessage, /没有.*记录|不清楚/);
});

test('recognized birthday capture failure is transparent and cannot fall through to a generic reply', async () => {
  const { service } = harness();
  service.capture.capture = async () => { throw new Error('fake capture outage'); };
  const result = await service.processConversation(userA, request('我妈是阴历7月16生日', 'birthday-capture-outage'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'degraded');
  assert.match(result.safeMessage, /未保存|暂时不可用/);
  assert.doesNotMatch(result.safeMessage, /收到您的信息/);
});

test('disabled capture explicitly reports that a recognized birthday was not saved', async () => {
  const { service } = harness({ MEMORY_CAPTURE_ENABLED: 'false' });
  const result = await service.processConversation(userA, request('我妈是阴历7月16生日', 'birthday-capture-disabled'));
  assert.equal(result.handled, true);
  assert.equal(result.status, 'disabled');
  assert.match(result.safeMessage, /未保存/);
});

test('task-oriented recall enriches the original task instead of replacing it', async () => {
  const { service } = harness();
  await remember(service, userA, '记住我喜欢无糖咖啡', 'save-task');
  const recalled = await service.processConversation(userA, request('按我的偏好写一句饮品介绍', 'task-recall'));
  assert.equal(recalled.status, 'recalled');
  assert.equal(recalled.handled, false);
  assert.equal(recalled.memoryContext.items.length, 1);
});

test('recall off never returns a context pack', async () => {
  const { service } = harness({ MEMORY_RECALL_ENABLED: 'false' });
  await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const recalled = await service.processConversation(userA, request('我平时喜欢喝什么？', 'recall'));
  assert.equal(recalled.handled, false);
  assert.deepEqual(recalled.memoryContext.items, []);
});

test('user B cannot recall user A memory', async () => {
  const { service } = harness();
  await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const recalled = await service.processConversation(userB, request('我平时喜欢喝什么？', 'recall'));
  assert.equal(recalled.handled, false);
  assert.deepEqual(recalled.memoryContext.items, []);
});

test('admin role does not bypass memory ownership', async () => {
  const { service } = harness();
  await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const adminB = { ...userB, role: 'admin' };
  const recalled = await service.processConversation(adminB, request('我平时喜欢喝什么？', 'recall'));
  assert.equal(recalled.handled, false);
});

test('deleted preference is excluded from the real-user conversation recall path', async () => {
  const { service } = harness();
  const stored = await remember(service, userA, '记住我喜欢吃辣', 'delete-before-recall');
  await service.deleteMemory(userA, stored.memoryId, { expectedVersion: 1 });

  const recalled = await service.processConversation(userA, request('我喜欢吃什么？', 'recall-deleted'));
  assert.equal(recalled.handled, false);
  assert.equal(recalled.status, 'empty');
  assert.deepEqual(recalled.memoryContext.items, []);
});

test('superseded preference recall selects only the current version', async () => {
  const { service } = harness();
  const stored = await remember(service, userA, '记住我喜欢吃辣', 'supersede-old');
  const corrected = await service.correctMemory(userA, stored.memoryId, {
    expectedVersion: 1,
    value: '我喜欢吃清淡食物'
  });
  assert.equal(corrected.status, 'completed');

  const recalled = await service.processConversation(userA, request('我喜欢吃什么？', 'recall-current'));
  assert.equal(recalled.status, 'recalled');
  assert.equal(recalled.memoryContext.items.length, 1);
  assert.equal(recalled.memoryContext.items[0].safeText.includes('清淡食物'), true);
  assert.equal(recalled.memoryContext.items[0].safeText.includes('喜欢吃辣'), false);
});

test('unrelated query does not recall a stored preference', async () => {
  const { service } = harness();
  await remember(service, userA, '记住我喜欢吃辣', 'save-before-unrelated');
  const result = await service.processConversation(userA, request('解释一下量子计算', 'unrelated'));
  assert.equal(result.handled, false);
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.memoryContext.items, []);
});

test('governance lists only the current user memories', async () => {
  const { service } = harness();
  await remember(service, userA, '记住我喜欢无糖咖啡', 'a');
  await remember(service, userB, '记住我喜欢乌龙茶', 'b');
  const listA = await service.listMemories(userA);
  assert.equal(listA.status, 'completed');
  assert.equal(listA.data.items.length, 1);
  assert.equal(listA.data.items[0].safeSummary.includes('无糖咖啡'), true);
});

test('governance off returns a transparent disabled result', async () => {
  const { service } = harness({ MEMORY_GOVERNANCE_ENABLED: 'false' });
  const result = await service.listMemories(userA);
  assert.equal(result.status, 'disabled');
  assert.match(result.safeMessage, /暂未开启/);
});

test('correction creates a version chain instead of overwriting history', async () => {
  const { service } = harness();
  const stored = await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const corrected = await service.correctMemory(userA, stored.memoryId, { expectedVersion: 1, value: '我喜欢喝茶' });
  assert.equal(corrected.status, 'completed');
  const history = await service.getMemoryHistory(userA, corrected.memoryId);
  assert.equal(history.data.items.length, 2);
  assert.equal(history.data.items.some((item) => item.status === 'superseded'), true);
});

test('ordinary deletion, restore and permanent purge preserve governance semantics', async () => {
  const { service } = harness();
  const first = await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const deleted = await service.deleteMemory(userA, first.memoryId, { expectedVersion: 1 });
  assert.equal(deleted.reversible, true);
  const restored = await service.restoreMemory(userA, first.memoryId, { expectedVersion: 2 });
  assert.equal(restored.status, 'completed');
  const firstPurge = await service.purgeMemory(userA, first.memoryId, { expectedVersion: 3 });
  assert.equal(firstPurge.status, 'confirmation_required');
  const purged = await service.purgeMemory(userA, first.memoryId, {
    expectedVersion: 3,
    confirmationToken: firstPurge.data.confirmationToken
  });
  assert.equal(purged.status, 'completed');
  assert.equal((await service.listMemories(userA)).data.items.length, 0);
});

test('cross-user governance returns not found without existence leakage', async () => {
  const { service } = harness();
  const stored = await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const result = await service.deleteMemory(userB, stored.memoryId, { expectedVersion: 1 });
  assert.equal(result.status, 'not_found');
  assert.equal(result.safeMessage, '未找到这条记忆。');
});

test('timeline reads new memory without modifying it', async () => {
  const { service } = harness();
  const stored = await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const timeline = await service.getTimeline(userA, {});
  assert.equal(timeline.ok, true);
  assert.equal(timeline.events.some((event) => event.memoryIds.includes(stored.memoryId)), true);
  const list = await service.listMemories(userA);
  assert.equal(list.data.items[0].version, 1);
});

test('intelligence returns rule artifacts only and never writes memory', async () => {
  const { service } = harness();
  await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const before = (await service.listMemories(userA)).data.items.length;
  const intelligence = await service.getIntelligence(userA, {});
  assert.equal(intelligence.ok, true);
  const after = (await service.listMemories(userA)).data.items.length;
  assert.equal(after, before);
});

test('integration audit does not retain conversation input or memory body', async () => {
  const { service } = harness();
  await remember(service, userA, '记住我喜欢无糖咖啡', 'save');
  const events = service.listAuditEvents(userA);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('无糖咖啡'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(events.length > 0, true);
});

test('missing authenticated user is rejected before any memory operation', async () => {
  const { service } = harness();
  await assert.rejects(
    () => service.processConversation(null, request('记住我喜欢无糖咖啡')),
    (error) => error?.code === 'MEMORY_AUTH_REQUIRED'
  );
});

test('client-supplied userId is rejected before capture', async () => {
  const { service } = harness();
  await assert.rejects(
    () => service.processConversation(userA, request('记住我喜欢无糖咖啡', 'forged', { userId: 'fake-user-b' })),
    (error) => error?.code === 'MEMORY_AUTH_FORGED_IDENTITY'
  );
});
