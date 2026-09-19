import { knowledgeRepository } from '../repositories/knowledgeRepository.js';

export const knowledgeTypes = [
  { id: 'company', label: 'Company' },
  { id: 'product', label: 'Product' },
  { id: 'brand', label: 'Brand' },
  { id: 'document', label: 'Document' },
  { id: 'faq', label: 'FAQ' },
  { id: 'template', label: 'Template' }
];

function createId() {
  return `knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).map((tag) => tag.trim()).filter(Boolean);
  return String(tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeKnowledge(item) {
  const createdAt = item.createdAt || now();
  return {
    id: item.id || createId(),
    type: item.type || 'document',
    title: item.title || '未命名知识',
    content: item.content || '',
    tags: normalizeTags(item.tags),
    enabled: item.enabled !== false,
    createdAt,
    updatedAt: item.updatedAt || createdAt
  };
}

function matchesKeyword(item, keyword) {
  if (!keyword) return true;
  const target = `${item.title} ${item.content} ${item.tags.join(' ')}`.toLowerCase();
  return target.includes(keyword.toLowerCase());
}

export class KnowledgeManager {
  constructor({ repository = knowledgeRepository } = {}) {
    this.repository = repository;
  }

  list({ includeDisabled = true, type = 'all', keyword = '', tag = '' } = {}) {
    const items = this.repository.readAll().map(normalizeKnowledge);
    return items
      .filter((item) => includeDisabled || item.enabled)
      .filter((item) => type === 'all' || item.type === type)
      .filter((item) => !tag || item.tags.includes(tag))
      .filter((item) => matchesKeyword(item, keyword))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  saveAll(items) {
    const normalized = items.map(normalizeKnowledge);
    this.repository.replaceAll(normalized);
    return normalized;
  }

  create(item) {
    const knowledge = normalizeKnowledge(item);
    this.saveAll([knowledge, ...this.list()]);
    return knowledge;
  }

  update(knowledgeId, updates) {
    let updated = null;
    const next = this.list().map((item) => {
      if (item.id !== knowledgeId) return item;
      updated = normalizeKnowledge({ ...item, ...updates, id: item.id, updatedAt: now() });
      return updated;
    });
    this.saveAll(next);
    return updated;
  }

  delete(knowledgeId) {
    this.saveAll(this.list().filter((item) => item.id !== knowledgeId));
    return true;
  }

  toggle(knowledgeId, enabled) {
    return this.update(knowledgeId, { enabled });
  }

  search(query = {}) {
    return this.list({
      includeDisabled: false,
      type: query.type || 'all',
      keyword: query.keyword || '',
      tag: query.tag || ''
    });
  }

  count({ includeDisabled = true } = {}) {
    return this.list({ includeDisabled }).length;
  }

  exportJson() {
    return {
      version: 1,
      exportedAt: now(),
      knowledge: this.list()
    };
  }

  importJson(payload, { replace = false } = {}) {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const incoming = Array.isArray(data) ? data : data?.knowledge;
    if (!Array.isArray(incoming)) {
      throw new Error('Knowledge JSON 格式错误');
    }
    const normalized = incoming.map(normalizeKnowledge);
    const next = replace ? normalized : [...normalized, ...this.list()];
    this.saveAll(next);
    return normalized;
  }
}

export const knowledgeManager = new KnowledgeManager();
