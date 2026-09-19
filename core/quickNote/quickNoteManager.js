import { eventManager } from '../events/index.js';
import aiEngine from '../ai/AIEngine.js';
import { quickNoteRepository } from './quickNoteRepository.js';
import { unifiedInputRouter, inputIntentTypes } from '../inputRouter/index.js';

function now() {
  return new Date().toISOString();
}

function createId() {
  return `quick-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeInput(input = '') {
  return String(input || '').trim();
}

export function normalizeTimeExpression(text = '') {
  return normalizeInput(text)
    .replace(/\s+/g, ' ')
    .replace(/今下午/g, '今天下午')
    .replace(/今早|今晨/g, '今天上午')
    .replace(/今晚|今夜/g, '今天晚上')
    .replace(/明早/g, '明天上午')
    .replace(/明晚/g, '明天晚上')
    .replace(/后天早上/g, '后天上午')
    .replace(/下周([一二三四五六日天])晚(?!上)/g, '下周$1晚上')
    .replace(/(?<![本下])周([一二三四五六日天])晚(?!上)/g, '本周$1晚上')
    .replace(/(?<![本下])星期([一二三四五六日天])晚(?!上)/g, '本周$1晚上')
    .replace(/这个周末/g, '本周末')
    .replace(/下个周末/g, '下周末')
    .replace(/(?<![今天明后])晚(?=[一二两三四五六七八九十零\d])/g, '今天晚上');
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时间';
  } catch {
    return '本地时间';
  }
}

function chineseNumber(value) {
  if (!value) return NaN;
  if (/^\d+$/.test(String(value))) return Number(value);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (digits[value.slice(1)] || 0);
  if (value.endsWith('十')) return (digits[value.slice(0, -1)] || 1) * 10;
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return (digits[tens] || 1) * 10 + (digits[ones] || 0);
  }
  return digits[value] ?? NaN;
}

function dateLabel(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function isoDateText(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function weekdayNumber(value = '') {
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[value];
}

function resolveRelativeDate(keyword = '', weekday = '') {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  if (keyword === '明天') date.setDate(date.getDate() + 1);
  if (keyword === '后天') date.setDate(date.getDate() + 2);
  if (weekday) {
    const target = weekdayNumber(weekday);
    if (!Number.isInteger(target)) return date;
    const today = date.getDay();
    let delta = (target - today + 7) % 7;
    if (keyword === '下周' && delta === 0) delta = 7;
    if (keyword === '本周' && delta === 0) delta = 0;
    if (!keyword && delta === 0) delta = 7;
    date.setDate(date.getDate() + delta);
  }
  return date;
}

function normalizeHour(hour, period = '') {
  if (['下午', '晚上'].includes(period) && hour < 12) return hour + 12;
  if (period === '中午' && hour < 11) return hour + 12;
  if (period === '凌晨' && hour === 12) return 0;
  return hour;
}

function parseMinute(minuteSource = '') {
  if (!minuteSource) return 0;
  if (minuteSource === '半') return 30;
  if (minuteSource === '一刻') return 15;
  if (minuteSource === '三刻') return 45;
  return chineseNumber(minuteSource);
}

function parseRelativeDateTime(input = '') {
  const source = normalizeTimeExpression(input);
  const match = source.match(/(?:(今天|明天|后天)|(本周|下周)([一二三四五六日天])|(?<![本下])(?:周|星期)([一二三四五六日天]))?\s*(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十零]+)(?::([0-5]\d)|\s*(?:点钟|点|时)(?:\s*(半|一刻|三刻|\d{1,2}|[一二两三四五六七八九十零]+)\s*分?)?)/);
  if (!match) return null;

  const relativeKeyword = match[1] || match[2] || (match[4] ? '' : '今天');
  const weekday = match[3] || match[4] || '';
  const period = match[5] || '';
  const hour = chineseNumber(match[6]);
  const minute = match[7] ? Number(match[7]) : parseMinute(match[8] || '');
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  const date = resolveRelativeDate(relativeKeyword, weekday);
  const normalizedHour = normalizeHour(hour, period);
  date.setHours(normalizedHour, minute, 0, 0);

  const relativeText = weekday ? `${relativeKeyword}${weekday === '天' ? '日' : weekday}` : relativeKeyword;
  const periodText = period ? `${period} ` : '';
  return {
    source: match[0],
    normalizedText: source,
    scheduledAt: date.toISOString(),
    timezone: localTimezone(),
    date: isoDateText(date),
    time: `${String(normalizedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    relativeDateText: relativeText,
    dateText: dateLabel(date),
    timeText: `${relativeText}${periodText}${String(normalizedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}（${dateLabel(date)}）`
  };
}

function classifyCategory(input) {
  const normalized = normalizeTimeExpression(input);
  if (/今天完成|完成了|已完成|做完/.test(input)) return 'work_log';
  if (/今天|明天|后天|本周|下周|上午|下午|晚上|凌晨|中午|点|点钟|时|\d{1,2}:\d{2}|会议|例会|日程/.test(normalized)) return 'schedule';
  if (/跟进|提醒|记得|别忘/.test(input)) return 'reminder';
  if (/提交|完成|处理|准备|待办/.test(input)) return 'todo';
  return 'note';
}

function extractTime(input, category) {
  if (category === 'schedule') return parseRelativeDateTime(input)?.timeText || '';
  if (/周[一二三四五六日天]|星期[一二三四五六日天]/.test(input)) return input.match(/(周|星期)[一二三四五六日天]/)?.[0] || '';
  return '';
}

function cleanTimeExpression(input = '', parsedTime = null) {
  let content = normalizeTimeExpression(input).replace(/^记一下[:：]?/, '');
  if (parsedTime?.source) content = content.replace(parsedTime.source, '');
  return content
    .replace(/^(提醒我|提醒|记得|别忘了?|要|请)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractContent(input, category, parsedTime = null) {
  if (category === 'schedule') return cleanTimeExpression(input, parsedTime);
  if (category === 'note') return input.replace(/^记一下[:：]?/, '').trim() || input;
  return input;
}

function normalizeNote(note = {}) {
  const input = normalizeInput(note.input);
  const category = ['reminder', 'todo', 'schedule', 'work_log', 'note'].includes(note.category) ? note.category : classifyCategory(input);
  const normalizedText = normalizeTimeExpression(note.normalizedText || input);
  const parsedTime = note.scheduledAt ? null : parseRelativeDateTime(normalizedText);
  const scheduledAt = note.scheduledAt || parsedTime?.scheduledAt || '';
  const timezone = note.timezone || (scheduledAt ? parsedTime?.timezone || localTimezone() : '');
  const content = note.content ?? extractContent(normalizedText, category, parsedTime);
  const needsConfirmation = note.needsConfirmation ?? Boolean(note.missing || !content);
  return {
    id: note.id || createId(),
    input,
    normalizedText,
    category,
    content,
    date: note.date || parsedTime?.date || '',
    time: note.time || parsedTime?.time || '',
    dateText: note.dateText || parsedTime?.dateText || extractTime(input, category),
    timeText: note.timeText || parsedTime?.timeText || extractTime(input, category),
    scheduledAt,
    timezone,
    status: note.status || 'needs_confirmation',
    missing: note.missing || '',
    needsConfirmation,
    sourceId: note.sourceId || '',
    sourceType: note.sourceType || '',
    memoryId: note.memoryId || '',
    createdAt: note.createdAt || now(),
    updatedAt: note.updatedAt || note.createdAt || now()
  };
}

export class QuickNoteManager {
  constructor({ repository = quickNoteRepository, events = eventManager, ai = aiEngine, inputRouter = unifiedInputRouter } = {}) {
    this.repository = repository;
    this.events = events;
    this.ai = ai;
    this.inputRouter = inputRouter;
    this.scheduleListeners = new Set();
  }

  classify(input) {
    const normalizedInput = normalizeInput(input);
    const normalizedText = normalizeTimeExpression(normalizedInput);
    const category = classifyCategory(normalizedText);
    const parsedTime = category === 'schedule' ? parseRelativeDateTime(normalizedText) : null;
    const timeText = parsedTime?.timeText || extractTime(normalizedInput, category);
    const weekdayOnly = ['reminder', 'todo'].includes(category) && /周[一二三四五六日天]|星期[一二三四五六日天]/.test(timeText) && !/\d|点|上午|下午|晚上/.test(normalizedInput);
    const content = extractContent(normalizedText, category, parsedTime);
    const recognizedTimeText = parsedTime?.relativeDateText || parsedTime?.dateText || '';
    const missing = parsedTime && !content ? `已识别时间为${recognizedTimeText} ${parsedTime.time}，请补充要做什么。` : (['schedule', 'reminder', 'todo'].includes(category) && (!timeText || weekdayOnly) ? '请补充明确的日期或时间。' : '');
    return normalizeNote({
      input: normalizedInput,
      normalizedText,
      category,
      content,
      date: parsedTime?.date || '',
      time: parsedTime?.time || '',
      timeText,
      dateText: parsedTime?.dateText || timeText,
      scheduledAt: parsedTime?.scheduledAt || '',
      timezone: parsedTime?.timezone || '',
      missing,
      needsConfirmation: Boolean(missing),
      status: 'needs_confirmation'
    });
  }

  async classifyWithAI(input) {
    const ruleResult = this.classify(input);
    if (ruleResult.category !== 'note' || !this.ai?.classify) return ruleResult;

    try {
      const response = await this.ai.classify({
        input: `请把下面这条随手记分类为 reminder、todo、schedule、work_log、note 之一，只返回 category: 分类值。\n${ruleResult.input}`,
        metadata: { source: 'quick-note-classification' }
      });
      const content = String(response?.content || response?.result?.content || '').toLowerCase();
      const matched = ['reminder', 'todo', 'schedule', 'work_log', 'note'].find((category) => content.includes(category));
      return matched ? normalizeNote({ ...ruleResult, category: matched }) : ruleResult;
    } catch {
      return ruleResult;
    }
  }

  listNotes() {
    return this.repository.readAll().map(normalizeNote).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  subscribeScheduleChanges(listener) {
    if (typeof listener !== 'function') return () => {};
    this.scheduleListeners.add(listener);
    return () => this.scheduleListeners.delete(listener);
  }

  isScheduleLike(category = '') {
    return ['schedule', 'reminder', 'todo'].includes(category);
  }

  emitScheduleChange(type, note) {
    if (!this.isScheduleLike(note?.category)) return;
    const event = { type, note };
    this.scheduleListeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // UI subscriptions must not block persistence.
      }
    });
  }

  findBySourceId(sourceId = '', category = '') {
    if (!sourceId) return null;
    return this.listNotes().find((note) => note.sourceId === sourceId && (!category || note.category === category)) || null;
  }

  findMatchingSchedule(note = {}) {
    if (!this.isScheduleLike(note.category)) return null;
    return this.listNotes().find((item) => (
      item.category === note.category
      && item.date === note.date
      && item.time === note.time
      && String(item.content || item.input || '').trim() === String(note.content || note.input || '').trim()
    )) || null;
  }

  save(note) {
    const normalized = normalizeNote({ ...note, status: 'confirmed' });
    const existing = this.findBySourceId(normalized.sourceId, normalized.category);
    if (existing) return existing;
    const matchingSchedule = this.findMatchingSchedule(normalized);
    if (matchingSchedule) return matchingSchedule;
    this.repository.create(normalized);
    this.events.createEvent({
      type: normalized.category === 'note' || normalized.category === 'work_log' ? 'note' : 'todo',
      source: 'quick-note',
      title: 'quick_note_saved',
      content: normalized.content,
      tags: ['quick_note_saved', normalized.category],
      status: 'open',
      priority: 'normal',
      metadata: {
        eventType: 'quick_note_saved',
        noteId: normalized.id,
        category: normalized.category,
        dateText: normalized.dateText,
        scheduledAt: normalized.scheduledAt,
        timezone: normalized.timezone
      }
    });
    this.emitScheduleChange('schedule.created', normalized);
    return normalized;
  }

  updateNote(noteId, updates = {}) {
    const current = this.repository.read(noteId);
    if (!current) return null;
    const updated = normalizeNote({
      ...current,
      ...updates,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now()
    });
    this.repository.update(noteId, updated);
    this.emitScheduleChange('schedule.updated', updated);
    return updated;
  }

  deleteNote(noteId) {
    const current = this.repository.read(noteId);
    const deleted = this.repository.delete(noteId);
    if (current) this.emitScheduleChange('schedule.deleted', normalizeNote(current));
    return deleted;
  }

  async handleInput(input, context = {}) {
    const result = await this.inputRouter.handle(input, {
      sourceType: 'quick_note',
      sourceId: context.sourceId || `quick-note-input-${Date.now()}`,
      workspaceId: context.workspaceId || '',
      userId: context.userId || '',
      currentTime: context.currentTime || context.now || new Date().toISOString(),
      locale: context.locale || 'zh-CN'
    });

    if (result.status === 'completed' && this.shouldMirrorAsQuickNote(result.intent?.intent)) {
      const note = this.noteFromUnifiedIntent(input, result.intent);
      const saved = this.save(note);
      return { ...result, quickNote: saved };
    }

    return result;
  }

  shouldMirrorAsQuickNote(intent) {
    return [
      inputIntentTypes.MEMORY_RECORD,
      inputIntentTypes.EXPENSE,
      inputIntentTypes.INCOME,
      inputIntentTypes.SCHEDULE,
      inputIntentTypes.TODO,
      inputIntentTypes.REMINDER,
      inputIntentTypes.CUSTOMER_FACT,
      inputIntentTypes.PROJECT_FACT,
      inputIntentTypes.QUOTE
    ].includes(intent);
  }

  noteFromUnifiedIntent(input, intent = {}) {
    const entities = intent.entities || {};
    const categoryMap = {
      [inputIntentTypes.SCHEDULE]: 'schedule',
      [inputIntentTypes.TODO]: 'todo',
      [inputIntentTypes.REMINDER]: 'reminder'
    };
    const category = categoryMap[intent.intent] || 'note';
    return normalizeNote({
      input,
      normalizedText: intent.normalizedInput || input,
      category,
      content: entities.summary || intent.normalizedInput || input,
      date: entities.eventDate || '',
      time: entities.eventTime || '',
      dateText: entities.eventDate || '',
      timeText: [entities.eventDate, entities.eventTime].filter(Boolean).join(' '),
      scheduledAt: entities.startAt || '',
      sourceId: intent.sourceId || '',
      sourceType: intent.sourceType || '',
      memoryId: intent.memoryId || '',
      missing: '',
      needsConfirmation: false,
      status: 'confirmed'
    });
  }
}

export const quickNoteManager = new QuickNoteManager();
