import { memoryRepository } from '../repositories/memoryRepository.js';

export const memoryTypes = [
  { id: 'user', label: 'User Memory' },
  { id: 'brand', label: 'Brand Memory' },
  { id: 'writingStyle', label: 'Writing Style' },
  { id: 'businessInfo', label: 'Business Info' },
  { id: 'preference', label: 'Preference' }
];

function createId() {
  return `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeMemory(memory) {
  const createdAt = memory.createdAt || now();
  return {
    id: memory.id || createId(),
    type: memory.type || 'user',
    title: memory.title || '未命名记忆',
    content: memory.content || '',
    enabled: memory.enabled !== false,
    createdAt,
    updatedAt: memory.updatedAt || createdAt
  };
}

function estimateTokens(text = '') {
  return Math.ceil(String(text).length / 3);
}

export class MemoryManager {
  constructor({ repository = memoryRepository } = {}) {
    this.repository = repository;
  }

  list({ includeDisabled = true } = {}) {
    const items = this.repository.readAll();
    const normalized = items.map(normalizeMemory);
    return includeDisabled ? normalized : normalized.filter((item) => item.enabled);
  }

  saveAll(items) {
    const normalized = items.map(normalizeMemory);
    this.repository.replaceAll(normalized);
    return normalized;
  }

  create(memory) {
    const item = normalizeMemory(memory);
    this.saveAll([item, ...this.list()]);
    return item;
  }

  update(memoryId, updates) {
    let updated = null;
    const next = this.list().map((item) => {
      if (item.id !== memoryId) return item;
      updated = normalizeMemory({ ...item, ...updates, id: item.id, updatedAt: now() });
      return updated;
    });
    this.saveAll(next);
    return updated;
  }

  delete(memoryId) {
    this.saveAll(this.list().filter((item) => item.id !== memoryId));
    return true;
  }

  toggle(memoryId, enabled) {
    return this.update(memoryId, { enabled });
  }

  buildPromptContext() {
    const enabled = this.list({ includeDisabled: false }).filter((item) => item.content.trim());
    if (!enabled.length) {
      return {
        loaded: 0,
        tokens: 0,
        preview: '',
        content: '',
        items: []
      };
    }

    const grouped = memoryTypes
      .map((type) => {
        const items = enabled.filter((item) => item.type === type.id);
        if (!items.length) return '';
        const lines = items.map((item) => `- ${item.title}: ${item.content}`);
        return `${type.label}\n${lines.join('\n')}`;
      })
      .filter(Boolean)
      .join('\n\n');

    const content = `长期记忆：\n${grouped}\n\n请在不暴露这些记忆来源的前提下，结合以上长期记忆回答用户。`;

    return {
      loaded: enabled.length,
      tokens: estimateTokens(content),
      preview: content.slice(0, 240),
      content,
      items: enabled
    };
  }

  exportJson() {
    return {
      version: 1,
      exportedAt: now(),
      memories: this.list()
    };
  }

  importJson(payload, { replace = false } = {}) {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const incoming = Array.isArray(data) ? data : data?.memories;
    if (!Array.isArray(incoming)) {
      throw new Error('Memory JSON 格式错误');
    }

    const normalized = incoming.map(normalizeMemory);
    const next = replace ? normalized : [...normalized, ...this.list()];
    this.saveAll(next);
    return normalized;
  }
}

export const memoryManager = new MemoryManager();
