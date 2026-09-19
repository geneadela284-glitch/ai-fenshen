import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { EventManager } from '../events/eventManager.js';
import { EventRepository } from '../events/eventRepository.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';
import { WorkspaceToolRegistry } from '../workspace/workspaceToolRegistry.js';
import { WorkSecretaryManager } from './workSecretaryManager.js';
import { WorkSecretaryRepository } from './workSecretaryRepository.js';

test('main conversation saves new memory, answers it in a new conversation, and bypasses AI for the direct query', async () => {
  const storage = createMemoryStorage();
  const memoryRepository = new MemoryRepository({ storage, namespace: 'test-work-secretary-memory', now: () => new Date('2026-07-13T09:00:00.000Z') });
  const workspaceTools = new WorkspaceToolRegistry({ memoryService: new MemoryService({ repository: memoryRepository, now: () => new Date('2026-07-13T09:00:00.000Z') }) });
  let aiCalls = 0;
  const manager = new WorkSecretaryManager({
    repository: new WorkSecretaryRepository({ storage }),
    events: new EventManager({ repository: new EventRepository({ storage }) }),
    workspaceTools,
    memoryIntegration: {
      async process() { return { enabled: false, handled: false, memoryContext: { items: [] } }; }
    },
    settings: { load: () => ({ apiKey: 'test-key' }) },
    ai: { async generate(request) { aiCalls += 1; return { content: `AI：${request.input}`, error: null, taskType: 'general' }; } }
  });
  const saved = manager.createTask('今天买菜花了100元。', { conversationId: 'conversation-one' });
  await manager.executeTask(saved.taskId);
  const queried = manager.createTask('我今天买菜花了多少钱？', { conversationId: 'conversation-two' });
  const answer = await manager.executeTask(queried.taskId);
  assert.equal(memoryRepository.count(), 1);
  assert.match(answer.result, /今天一共支出 100 元，共 1 笔/);
  assert.doesNotMatch(answer.result, /长期记忆|Repository|Memory/);
  assert.equal(aiCalls, 0);
});
