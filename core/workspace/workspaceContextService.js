import { knowledgeManager } from '../knowledge/knowledgeManager.js';
import { knowledgeFileManager } from '../knowledgeDrop/knowledgeFileManager.js';
import { quickNoteManager } from '../quickNote/quickNoteManager.js';
import { workSecretaryConversationRepository } from '../workSecretary/conversationRepository.js';
import { workSecretaryRepository } from '../workSecretary/workSecretaryRepository.js';
import { resolveDateRange } from '../trust/dateRangeResolver.js';

function startOfDay(date = new Date()) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date = new Date()) {
  const next = startOfDay(date);
  next.setDate(next.getDate() + 1);
  next.setMilliseconds(-1);
  return next;
}

function toDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function isWithin(value, from, to) {
  const date = toDate(value);
  if (!date) return false;
  return (!from || date >= from) && (!to || date <= to);
}

function noteDate(note = {}) {
  return note.scheduledAt || note.createdAt || '';
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';
  if (typeof value.content === 'string') return value.content;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.result === 'string') return value.result;
  if (typeof value.answer === 'string') return value.answer;
  if (typeof value.message === 'string') return value.message;
  return '';
}

function compactTitle(item = {}) {
  const resultText = normalizeText(item.result);
  return String(item.title || item.userInput || item.name || resultText.slice(0, 48) || '未命名记录').trim();
}

function termsFrom(input = '') {
  return String(input)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function scoreText(target = '', terms = []) {
  const text = String(target || '').toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

function dateRangeFor(period = 'today', baseDate = new Date()) {
  const expression = period === 'tomorrow' ? '明天' : period === 'week' ? '本周' : period === 'month' ? '本月' : '今天';
  const resolved = resolveDateRange(expression, {
    now: baseDate,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  });
  return {
    from: new Date(resolved.startAt),
    to: new Date(new Date(resolved.endAt).getTime() - 1),
    label: period === 'tomorrow' ? '明日' : resolved.label === '今天' ? '今日' : resolved.label
  };
}

export class WorkspaceContextService {
  constructor({
    quickNotes = quickNoteManager,
    knowledgeFiles = knowledgeFileManager,
    knowledge = knowledgeManager,
    taskRepository = workSecretaryRepository,
    conversationRepository = workSecretaryConversationRepository
  } = {}) {
    this.quickNotes = quickNotes;
    this.knowledgeFiles = knowledgeFiles;
    this.knowledge = knowledge;
    this.taskRepository = taskRepository;
    this.conversationRepository = conversationRepository;
  }

  getQuickNotes({ from = null, to = null, category = '', limit = 100 } = {}) {
    return this.quickNotes
      .listNotes()
      .filter((note) => !category || note.category === category)
      .filter((note) => (!from && !to) || isWithin(noteDate(note), from, to))
      .slice(0, limit);
  }

  getSchedules({ date = new Date(), period = 'today', limit = 20 } = {}) {
    const range = period === 'custom'
      ? { from: startOfDay(date), to: endOfDay(date), label: '指定日期' }
      : dateRangeFor(period, date);
    return this.getQuickNotes({ from: range.from, to: range.to })
      .filter((note) => ['schedule', 'reminder', 'todo'].includes(note.category))
      .slice(0, limit);
  }

  getTodos(options = {}) {
    return this.getQuickNotes(options).filter((note) => note.category === 'todo');
  }

  getReminders(options = {}) {
    return this.getQuickNotes(options).filter((note) => ['reminder', 'schedule'].includes(note.category));
  }

  getKnowledgeFiles({ limit = 50 } = {}) {
    return this.knowledgeFiles.listFiles().slice(0, limit);
  }

  searchKnowledge(query = '', { limit = 8 } = {}) {
    const keyword = String(query || '').trim();
    const terms = termsFrom(keyword);
    const knowledgeItems = this.knowledge.search({ keyword })
      .map((item) => ({ ...item, sourceType: 'knowledge', score: scoreText(`${item.title} ${item.content}`, terms) + 2 }));
    const fileItems = this.getKnowledgeFiles()
      .map((file) => ({ ...file, sourceType: 'knowledge_file', title: file.name, content: '', score: scoreText(file.name, terms) + (terms.length ? 0 : 1) }));

    return [...knowledgeItems, ...fileItems]
      .filter((item) => !terms.length || item.score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, limit);
  }

  getRecentResults({ query = '', limit = 10 } = {}) {
    const terms = termsFrom(query);
    return this.taskRepository.readAll()
      .filter((task) => task.status === 'completed' && normalizeText(task.result))
      .map((task) => ({
        ...task,
        title: compactTitle(task),
        resultText: normalizeText(task.result),
        score: scoreText(`${task.userInput || ''} ${normalizeText(task.result)}`, terms)
      }))
      .filter((task) => !terms.length || task.score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.completedAt || b.updatedAt || b.createdAt || 0) - new Date(a.completedAt || a.updatedAt || a.createdAt || 0))
      .slice(0, limit);
  }

  getConversationHistory({ limit = 20 } = {}) {
    return this.conversationRepository.readAll()
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, limit);
  }

  getQuickNoteStatistics({ period = 'today', baseDate = new Date() } = {}) {
    const range = dateRangeFor(period, baseDate);
    const notes = this.getQuickNotes({ from: range.from, to: range.to, limit: 500 });
    return {
      period,
      label: range.label,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      noteCount: notes.length,
      income: null,
      expense: null,
      balance: null,
      entries: [],
      financeSource: 'data_trust_service_required',
      notes
    };
  }

  getWorkspaceSummary() {
    const today = dateRangeFor('today');
    return {
      quickNotes: this.getQuickNotes({ limit: 1000 }).length,
      todaySchedules: this.getSchedules({ period: 'today' }).length,
      knowledgeFiles: this.getKnowledgeFiles({ limit: 1000 }).length,
      recentResults: this.getRecentResults({ limit: 1000 }).length,
      conversations: this.getConversationHistory({ limit: 1000 }).length,
      dateRange: {
        todayFrom: today.from.toISOString(),
        todayTo: today.to.toISOString()
      }
    };
  }
}

export const workspaceContextService = new WorkspaceContextService();
