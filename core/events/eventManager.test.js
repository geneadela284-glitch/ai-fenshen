import assert from 'node:assert/strict';
import test from 'node:test';
import { EventManager } from './eventManager.js';
import { EventRepository } from './eventRepository.js';
import { createMemoryStorage } from '../storage/memoryStorage.js';

test('system events retain references but not raw input, credentials or local paths', () => {
  const manager = new EventManager({ repository: new EventRepository({ storage: createMemoryStorage() }) });
  const event = manager.createEvent({
    type: 'ai',
    source: 'work-secretary',
    title: 'work_secretary_task',
    content: '完整用户输入 sk-secret-value',
    metadata: {
      taskId: 'task-1',
      Authorization: 'Bearer secret-token',
      path: '/Users/private/file.txt'
    }
  });

  assert.equal(event.content, '');
  assert.deepEqual(event.metadata, { taskId: 'task-1' });
});
