import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStorage } from '../storage/memoryStorage.js';
import { EventManager } from '../events/eventManager.js';
import { EventRepository } from '../events/eventRepository.js';
import { WorkSecretaryManager } from './workSecretaryManager.js';
import { WorkSecretaryRepository } from './workSecretaryRepository.js';

function manager({ memoryResult, workspaceResult = { handled: false, memoryContext: { items: [] } } } = {}) {
  const storage = createMemoryStorage();
  let workspaceCalls = 0;
  let aiCalls = 0;
  let aiRequest = null;
  const instance = new WorkSecretaryManager({
    repository: new WorkSecretaryRepository({ storage }),
    events: new EventManager({ repository: new EventRepository({ storage }) }),
    memoryIntegration: {
      async process(payload) {
        assert.equal('userId' in payload, false);
        if (memoryResult instanceof Error) throw memoryResult;
        return memoryResult;
      }
    },
    workspaceTools: {
      async runForInput(_input, options) {
        workspaceCalls += 1;
        if (memoryResult?.enabled) assert.equal(options.skipMemory, true);
        return workspaceResult;
      }
    },
    ai: {
      async generate(request) {
        aiCalls += 1;
        aiRequest = request;
        return { content: '普通 AI 回复', error: null };
      }
    }
  });
  return { instance, calls: () => ({ workspaceCalls, aiCalls, aiRequest }) };
}

test('real memory capture response completes the conversation without legacy memory or Provider calls', async () => {
  const { instance, calls } = manager({
    memoryResult: { enabled: true, handled: true, status: 'stored', safeMessage: '已永久保存', memoryContext: { items: [] } }
  });
  const task = instance.createTask('记住我喜欢虚构无糖咖啡', { conversationId: 'fake-conversation' });
  const completed = await instance.executeTask(task.taskId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, '已永久保存');
  assert.equal(completed.workspaceMetadata.memoryIntegration.status, 'stored');
  assert.equal(completed.workspaceMetadata.memoryIntegration.confirmationId, '');
  assert.equal(calls().workspaceCalls, 0);
  assert.equal(calls().aiCalls, 0);
});

test('high-sensitive memory confirmation remains a completed task with actionable metadata instead of a retry error', async () => {
  const { instance, calls } = manager({
    memoryResult: {
      enabled: true,
      handled: true,
      status: 'confirmation_required',
      safeMessage: '需要确认，尚未保存。',
      safeSummary: '存在一条高敏感记忆，确认后才会长期保存。',
      memoryType: 'fact',
      sensitivity: 'high',
      confirmationId: 'fake-confirm-sensitive',
      longTerm: true,
      memoryContext: { items: [] }
    }
  });
  const task = instance.createTask('记住一条虚构高敏感信息', { conversationId: 'fake-conversation' });
  const completed = await instance.executeTask(task.taskId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.error, '');
  assert.equal(completed.result, '需要确认，尚未保存。');
  assert.deepEqual(completed.workspaceMetadata.memoryIntegration, {
    status: 'confirmation_required',
    confirmationId: 'fake-confirm-sensitive',
    safeSummary: '存在一条高敏感记忆，确认后才会长期保存。',
    memoryType: 'fact',
    sensitivity: 'high',
    longTerm: true
  });
  assert.equal(calls().workspaceCalls, 0);
  assert.equal(calls().aiCalls, 0);
});

test('resolved high-sensitive memory confirmation replaces the pending message and cannot render as retry', async () => {
  const { instance } = manager({
    memoryResult: {
      enabled: true,
      handled: true,
      status: 'confirmation_required',
      safeMessage: '需要确认，尚未保存。',
      safeSummary: '存在一条高敏感记忆，确认后才会长期保存。',
      memoryType: 'fact',
      sensitivity: 'high',
      confirmationId: 'fake-confirm-sensitive',
      longTerm: true,
      memoryContext: { items: [] }
    }
  });
  const task = instance.createTask('记住一条虚构高敏感信息', { conversationId: 'fake-conversation' });
  await instance.executeTask(task.taskId);
  const resolved = instance.resolveMemoryConfirmation(task.taskId, {
    status: 'stored',
    safeMessage: '已永久保存',
    memoryId: 'fake-memory-spicy'
  });
  assert.equal(resolved.status, 'completed');
  assert.equal(resolved.error, '');
  assert.equal(resolved.result, '已永久保存');
  assert.equal(resolved.workspaceMetadata.memoryIntegration.status, 'stored');
  assert.equal(resolved.workspaceMetadata.memoryIntegration.confirmationId, '');
  assert.equal(resolved.workspaceMetadata.memoryIntegration.memoryId, 'fake-memory-spicy');
});

test('safe recall response completes directly without exposing technical fields', async () => {
  const { instance, calls } = manager({
    memoryResult: {
      enabled: true, handled: true, status: 'recalled', safeMessage: '你之前让我记住：虚构饮品偏好',
      memoryContext: { items: [{ safeText: '虚构饮品偏好', sourceType: 'user_explicit' }] }
    }
  });
  const task = instance.createTask('我平时喜欢喝什么？', { conversationId: 'fake-conversation' });
  const completed = await instance.executeTask(task.taskId);
  assert.equal(completed.result, '你之前让我记住：虚构饮品偏好');
  assert.equal(calls().workspaceCalls, 0);
  assert.equal(calls().aiCalls, 0);
  assert.doesNotMatch(completed.result, /Memory ID|SQLite|Repository/);
});

test('enabled memory with empty recall skips only legacy memory and preserves ordinary workspace and AI flow', async () => {
  const { instance, calls } = manager({
    memoryResult: { enabled: true, handled: false, status: 'empty', memoryContext: { items: [] } }
  });
  const task = instance.createTask('帮我写一句问候语', { conversationId: 'fake-conversation' });
  const completed = await instance.executeTask(task.taskId);
  assert.equal(completed.result, '普通 AI 回复');
  assert.equal(calls().workspaceCalls, 1);
  assert.equal(calls().aiCalls, 1);
});

test('task-oriented recall passes only the safe context pack into the original AI flow', async () => {
  const { instance, calls } = manager({
    memoryResult: {
      enabled: true,
      handled: false,
      status: 'recalled',
      memoryContext: { items: [{ safeText: '虚构饮品偏好', sourceType: 'user_explicit' }] }
    }
  });
  const task = instance.createTask('按我的偏好写一句饮品介绍', { conversationId: 'fake-conversation' });
  const completed = await instance.executeTask(task.taskId);
  assert.equal(completed.result, '普通 AI 回复');
  assert.equal(calls().workspaceCalls, 1);
  assert.equal(calls().aiCalls, 1);
  assert.equal(calls().aiRequest.metadata.injectedMemoryCount, 1);
});

test('memory service failure degrades safely and does not block ordinary conversation', async () => {
  const { instance, calls } = manager({ memoryResult: new Error('network failed') });
  const task = instance.createTask('帮我写一句问候语', { conversationId: 'fake-conversation' });
  const completed = await instance.executeTask(task.taskId);
  assert.equal(completed.result, '普通 AI 回复');
  assert.equal(calls().workspaceCalls, 1);
  assert.equal(calls().aiCalls, 1);
});

test('requested recall outage returns the transparent memory error without a fabricated Provider answer', async () => {
  const { instance, calls } = manager({
    memoryResult: {
      enabled: true,
      handled: true,
      status: 'degraded',
      safeMessage: '记忆服务暂时不可用，暂时无法确认你之前保存的内容。',
      memoryContext: { items: [] }
    }
  });
  const task = instance.createTask('我喜欢吃什么？', { conversationId: 'fake-conversation' });
  const completed = await instance.executeTask(task.taskId);
  assert.match(completed.result, /记忆服务暂时不可用/);
  assert.doesNotMatch(completed.result, /没有.*记录|不清楚/);
  assert.equal(calls().workspaceCalls, 0);
  assert.equal(calls().aiCalls, 0);
});
