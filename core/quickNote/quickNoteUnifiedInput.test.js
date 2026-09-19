import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../storage/memoryStorage.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';
import { UnifiedInputRouter } from '../inputRouter/index.js';
import { QuickNoteManager } from './quickNoteManager.js';

const now = '2026-07-13T09:00:00.000Z';

function createHarness() {
  const memoryRepository = new MemoryRepository({
    storage: createMemoryStorage(),
    namespace: 'test-quick-note-unified-input',
    now: () => new Date(now)
  });
  const memoryService = new MemoryService({ repository: memoryRepository, now: () => new Date(now) });
  const inputRouter = new UnifiedInputRouter({ memoryService, now: () => new Date(now) });
  const quickNoteRepository = {
    items: [],
    create(item) { this.items.unshift(item); return item; },
    readAll() { return [...this.items]; }
  };
  const quickNotes = new QuickNoteManager({
    repository: quickNoteRepository,
    events: { createEvent(event) { return event; } },
    inputRouter
  });
  return { inputRouter, memoryRepository, quickNotes };
}

test('quick note submission uses unified input router and can be queried from conversation', async () => {
  const { inputRouter, memoryRepository, quickNotes } = createHarness();

  const saved = await quickNotes.handleInput('今天停车费20元。', {
    sourceId: 'quick-note-1',
    currentTime: now
  });
  const query = await inputRouter.handle('我今天停车花了多少钱？', {
    sourceType: 'conversation',
    sourceId: 'c1',
    conversationId: 'c1',
    currentTime: now
  });

  assert.equal(saved.status, 'completed');
  assert.equal(saved.quickNote.category, 'note');
  assert.equal(quickNotes.listNotes().length, 1);
  assert.equal(memoryRepository.count(), 1);
  assert.match(query.result, /今天一共支出 20 元，共 1 笔/);
  assert.doesNotMatch(query.result, /长期记忆|Repository|Memory/);
});

test('quick note questions pass through instead of being saved as local notes', async () => {
  const { memoryRepository, quickNotes } = createHarness();
  const result = await quickNotes.handleInput('你觉得简洁界面好吗？', {
    sourceId: 'quick-note-2',
    currentTime: now
  });

  assert.equal(result.status, 'pass_through');
  assert.equal(quickNotes.listNotes().length, 0);
  assert.equal(memoryRepository.count(), 0);
});
