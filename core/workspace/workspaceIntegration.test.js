import assert from 'node:assert/strict';
import test from 'node:test';
import { SettingsRepository } from '../repositories/settingsRepository.js';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { WorkSecretaryManager } from '../workSecretary/workSecretaryManager.js';
import { WorkSecretaryRepository } from '../workSecretary/workSecretaryRepository.js';
import { WorkspaceToolRegistry } from './workspaceToolRegistry.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';

test('work secretary executes handled workspace intent before provider checks', async () => {
  const storage = createMemoryStorage();
  const repository = new WorkSecretaryRepository({ storage });
  const settingsRepository = new SettingsRepository({ storage });
  const settings = { load: () => settingsRepository.read() || {} };
  const memoryService = new MemoryService({
    repository: new MemoryRepository({ storage, namespace: 'test-workspace-integration-trust' })
  });
  const currentTime = new Date().toISOString();
  memoryService.remember('今天收到客户货款5000元', { context: { sourceType: 'conversation', sourceId: 'income-1', now: currentTime } });
  memoryService.remember('今天停车费20元', { context: { sourceType: 'conversation', sourceId: 'expense-1', now: currentTime } });
  let aiCalls = 0;
  const manager = new WorkSecretaryManager({
    repository,
    settings,
    ai: {
      generate: async () => {
        aiCalls += 1;
        return { content: 'should not be called' };
      }
    },
    events: { createEvent: () => null },
    workspaceTools: new WorkspaceToolRegistry({ memoryService })
  });

  const task = manager.createTask('我今天的收支怎么样？');
  const result = await manager.executeTask(task.taskId);

  assert.equal(result.status, 'completed');
  assert.equal(aiCalls, 0);
  assert.match(result.result, /今天收入 5000 元，支出 20 元，结余 4980 元/);
});
