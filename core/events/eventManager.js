import { eventRepository } from './eventRepository.js';
import { sanitizeSensitiveData } from '../security/sensitiveData.js';

export const eventTypes = [
  'manual',
  'document',
  'meeting',
  'contract',
  'email',
  'note',
  'todo',
  'ai'
];

export const eventStatuses = ['open', 'done', 'archived'];
export const eventPriorities = ['low', 'normal', 'high', 'urgent'];

function createId() {
  return `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

export function normalizeEvent(event = {}) {
  const createdAt = event.createdAt || now();
  const type = eventTypes.includes(event.type) ? event.type : 'manual';
  const status = eventStatuses.includes(event.status) ? event.status : 'open';
  const priority = eventPriorities.includes(event.priority) ? event.priority : 'normal';

  return {
    id: event.id || createId(),
    type,
    source: event.source || 'manual',
    title: event.title || '未命名事件',
    content: '',
    tags: normalizeTags(event.tags),
    status,
    priority,
    createdAt,
    updatedAt: event.updatedAt || createdAt,
    metadata: event.metadata && typeof event.metadata === 'object' ? sanitizeSensitiveData(event.metadata) : {}
  };
}

function matchesEvent(event, query = {}) {
  const keyword = String(query.keyword || '').trim().toLowerCase();
  if (query.type && query.type !== 'all' && event.type !== query.type) return false;
  if (query.status && query.status !== 'all' && event.status !== query.status) return false;
  if (query.priority && query.priority !== 'all' && event.priority !== query.priority) return false;
  if (query.source && event.source !== query.source) return false;
  if (query.tag && !event.tags.includes(query.tag)) return false;
  if (!keyword) return true;

  const target = `${event.title} ${event.content} ${event.tags.join(' ')} ${event.source}`.toLowerCase();
  return target.includes(keyword);
}

export class EventManager {
  constructor({ repository = eventRepository } = {}) {
    this.repository = repository;
  }

  createEvent(event) {
    const normalized = normalizeEvent(event);
    this.repository.create(normalized);
    return normalized;
  }

  updateEvent(eventId, updates) {
    const current = this.repository.read(eventId);
    if (!current) return null;
    const updated = normalizeEvent({
      ...current,
      ...updates,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now()
    });
    this.repository.update(eventId, updated);
    return updated;
  }

  deleteEvent(eventId) {
    return this.repository.delete(eventId);
  }

  listEvents(query = {}) {
    return this.repository
      .readAll()
      .map(normalizeEvent)
      .filter((event) => matchesEvent(event, query))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  searchEvents(query = {}) {
    return this.listEvents(query);
  }
}

export const eventManager = new EventManager();
