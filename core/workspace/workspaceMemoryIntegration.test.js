import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';
import { WorkspaceToolRegistry } from './workspaceToolRegistry.js';

const now = '2026-07-13T09:00:00.000Z';
function createRegistry() {
  const repository = new MemoryRepository({ storage: createMemoryStorage(), namespace: 'test-conversation-memory', now: () => new Date(now) });
  const memoryService = new MemoryService({ repository, now: () => new Date(now) });
  return { repository, registry: new WorkspaceToolRegistry({ memoryService }) };
}

test('routes new conversation input through MemoryService and calculates persistent balance', async () => {
  const { repository, registry } = createRegistry();
  await registry.runForInput('今天收到客户货款5000元。', { conversationId: 'c1', now });
  await registry.runForInput('今天买菜花了100元。', { conversationId: 'c1', now });
  await registry.runForInput('停车费20元。', { conversationId: 'c1', now });
  const result = await registry.runForInput('我今天的收支怎么样？', { conversationId: 'c2', now });
  assert.equal(repository.count(), 3);
  assert.equal(result.handled, true);
  assert.match(result.result, /今天收入 5000 元，支出 120 元，结余 4880 元/);
  assert.doesNotMatch(result.result, /长期记忆|Repository|Memory/);
});

test('queries schedules and quotes across conversations while filtering unsafe and duplicate input', async () => {
  const { repository, registry } = createRegistry();
  await registry.runForInput('明天下午3点见张总。', { conversationId: 'c1', now });
  await registry.runForInput('记一下，华南客户报价12万元。', { conversationId: 'c1', now });
  await registry.runForInput('你好。', { conversationId: 'c1', now });
  await registry.runForInput('今晚8点。', { conversationId: 'c1', now });
  await registry.runForInput('我的银行卡号是6222021234567890123。', { conversationId: 'c1', now });
  await registry.runForInput('记一下，华南客户报价12万元。', { conversationId: 'c1', now });
  const schedule = await registry.runForInput('我最近和张总有什么安排？', { conversationId: 'c2', now });
  const quote = await registry.runForInput('华南客户的报价是多少？', { conversationId: 'c2', now });
  assert.equal(repository.count(), 2);
  assert.match(schedule.result, /张总/);
  assert.match(quote.result, /120000元/);
  assert.match(quote.result, /来源：华南客户报价记录/);
});

test('returns bounded safe memory context and does not let failed memory saving block dispatch', async () => {
  const memoryService = { remember: () => ({ ok: false, code: 'MEMORY_STORAGE_FAILED' }), searchMemories: () => ({ ok: true, data: [] }) };
  const registry = new WorkspaceToolRegistry({ memoryService });
  const result = await registry.runForInput('根据之前给华南客户的报价写邮件。', { conversationId: 'c1', now });
  assert.equal(result.handled, false);
  assert.equal(result.memoryWrite.code, 'MEMORY_STORAGE_FAILED');
  assert.deepEqual(result.memoryContext.items, []);
});
