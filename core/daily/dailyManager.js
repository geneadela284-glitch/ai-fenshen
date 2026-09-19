import { normalizeEvent } from '../events/eventManager.js';
import { dailyRepository } from './dailyRepository.js';

function toDateKey(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return toDateKey(new Date().toISOString());
  return date.toISOString().slice(0, 10);
}

function toTimeLabel(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function normalizeDailyItem(event) {
  const normalized = normalizeEvent(event);
  const aiSummary = normalized.metadata.aiSummary || normalized.metadata.summary || '';
  return {
    id: normalized.id,
    time: toTimeLabel(normalized.createdAt),
    type: normalized.type,
    source: normalized.source || normalized.type,
    title: normalized.title,
    content: normalized.content,
    tags: normalized.tags,
    status: normalized.status,
    priority: normalized.priority,
    aiSummary,
    aiSuggestion: normalized.metadata.aiSuggestion || '',
    review: normalized.metadata.review || '',
    reflection: normalized.metadata.reflection || '',
    metadata: normalized.metadata,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt
  };
}

export class DailyManager {
  constructor({ repository = dailyRepository } = {}) {
    this.repository = repository;
  }

  today() {
    return toDateKey(new Date().toISOString());
  }

  yesterday() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return toDateKey(date.toISOString());
  }

  listDates() {
    const dates = new Set(this.repository.listEvents().map((event) => toDateKey(event.createdAt)));
    dates.add(this.today());
    dates.add(this.yesterday());
    return Array.from(dates).sort((a, b) => new Date(b) - new Date(a));
  }

  getTimeline(dateKey = this.today()) {
    const targetDate = toDateKey(dateKey);
    const events = this.repository
      .searchEvents((event) => toDateKey(event.createdAt) === targetDate)
      .map(normalizeDailyItem)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    return {
      date: targetDate,
      items: events,
      aiSummary: '',
      aiSuggestion: '',
      review: '',
      reflection: ''
    };
  }
}

export const dailyManager = new DailyManager();
