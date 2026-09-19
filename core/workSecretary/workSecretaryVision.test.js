import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventManager } from '../events/eventManager.js';
import { EventRepository } from '../events/eventRepository.js';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { WorkSecretaryManager } from './workSecretaryManager.js';
import { WorkSecretaryRepository } from './workSecretaryRepository.js';

test('sends image bytes to the capability router without persisting the temporary payload', async () => {
  const storage = createMemoryStorage();
  const repository = new WorkSecretaryRepository({ storage });
  const captured = [];
  const manager = new WorkSecretaryManager({
    repository,
    events: new EventManager({ repository: new EventRepository({ storage }) }),
    workspaceTools: { runForInput: async () => ({ handled: false, memoryContext: { items: [] } }) },
    settings: {
      load: () => ({ providers: { qwen: { enabled: true, apiKey: 'local-key' } } })
    },
    ai: {
      async generate(request) {
        captured.push(request);
        return { content: '图片中是一张测试图。', error: null, capability: 'VISION' };
      }
    }
  });
  const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';

  const task = manager.createTask('请描述这张图片', {
    conversationId: 'vision-conversation',
    attachments: [{
      id: 'image-1',
      name: 'test.png',
      mimeType: 'image/png',
      size: 8,
      contentType: 'image',
      parseable: true,
      readable: true,
      parseStatus: 'readable',
      imageDataUrl,
      metadata: { visionRequired: true }
    }]
  });

  assert.equal(repository.read(task.taskId).attachments[0].imageDataUrl, undefined);

  const completed = await manager.executeTask(task.taskId);
  const request = captured[0];
  const userContent = request.messages.at(-1).content;

  assert.equal(completed.status, 'completed');
  assert.equal(request.capability, 'VISION');
  assert.equal(Array.isArray(userContent), true);
  assert.equal(userContent[0].type, 'text');
  assert.equal(userContent[1].type, 'image_url');
  assert.equal(userContent[1].image_url.url, imageDataUrl);
});
