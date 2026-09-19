import { quickNoteManager } from '../quickNote/quickNoteManager.js';
import { workspaceContextService } from './workspaceContextService.js';
import { persistentMemoryService } from '../memory/memoryRuntime.js';
import { UnifiedInputRouter, unifiedInputRouter, inputIntentTypes } from '../inputRouter/index.js';
import { DataTrustService, formatTrustedFinanceReply } from '../trust/dataTrustService.js';
import { resolveDateRange } from '../trust/dateRangeResolver.js';

export const TASK_INTENTS = {
  CURRENT_DATE: 'application.current_date',
  WORKSPACE_QUERY: 'workspace.query',
  QUICKNOTE_CREATE: 'quicknote.create',
  QUICKNOTE_QUERY: 'quicknote.query',
  QUICKNOTE_REPORT: 'quicknote.report',
  QUICKNOTE_STATISTICS: 'quicknote.statistics',
  SCHEDULE_CREATE: 'schedule.create',
  SCHEDULE_QUERY: 'schedule.query',
  TODO_CREATE: 'todo.create',
  REMINDER_CREATE: 'reminder.create',
  KNOWLEDGE_SEARCH: 'knowledge.search',
  RESULT_QUERY: 'result.query',
  RESULT_MODIFY: 'result.modify',
  RESULT_EXPORT: 'result.export'
};

function cleanInput(input = '') {
  return String(input || '').trim();
}

function removeCommandPrefix(input = '') {
  return cleanInput(input)
    .replace(/^(记一下|帮我记一下|记录一下|记下|提醒我|提醒一下)[，,、:：\s]*/u, '')
    .trim();
}

function reportPeriodFromInput(input = '') {
  if (/月报|本月|这个月/.test(input)) return 'month';
  if (/周报|本周|这周|这一周/.test(input)) return 'week';
  return 'today';
}

function formatMoney(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? `${number}元` : `${number.toFixed(2)}元`;
}

function formatNoteLine(note = {}, index = 0) {
  const time = note.timeText || note.dateText || note.scheduledAt || note.createdAt || '';
  const content = note.content || note.input || '未命名记录';
  return `${index + 1}. ${time ? `${time}：` : ''}${content}`;
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function shortChineseTime(time = '') {
  const [hourSource = '0', minuteSource = '0'] = String(time || '00:00').split(':');
  const hour = Number(hourSource);
  const minute = Number(minuteSource);
  if (!Number.isFinite(hour)) return '';
  const period = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour === 12 ? '中午' : hour < 18 ? '下午' : '晚上';
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${period}${displayHour}点${minute ? `${minute}分` : ''}`;
}

function localizedScheduleTime(note = {}, now = new Date()) {
  const date = note.date || String(note.scheduledAt || '').slice(0, 10);
  const time = note.time || String(note.scheduledAt || '').slice(11, 16);
  const today = localDateKey(new Date(now));
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const prefix = date === today ? '今天' : date === localDateKey(tomorrowDate) ? '明天' : date ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日` : '';
  return `${prefix}${shortChineseTime(time)}`;
}

function scheduleConfirmationText(note = {}, now = new Date()) {
  return `已安排：${localizedScheduleTime(note, now)}${note.content || note.input || '日程'}。`;
}

function sourceLine(label, count) {
  return `来源：${label} ${count} 条`;
}

function isPlanningRequest(text = '') {
  return /帮我.*(?:安排.*计划|规划)|给我.*(?:方案|计划|建议)|(?:周末|两天).*怎么安排|我想.*(?:放松|休息).*(?:建议|方案)/.test(text);
}

function isScheduleQuery(text = '') {
  return /(?:查一下|查询|看看).*(?:安排|日程|会议|提醒|待办)|(?:今天|明天|后天|周末|周[一二三四五六日天]|星期[一二三四五六日天]).*(?:有什么(?:安排|事)|有(?:什么)?会议吗)|我.*有什么安排/.test(text);
}

function isScheduleWrite(text = '') {
  return /(?:今天|明天|后天|周末|周[一二三四五六日天]|星期[一二三四五六日天]).*(?:提醒我|安排|加一个|新增|创建).*(?:日程|会议|聚餐|提醒|待办|健身|买菜)/.test(text);
}

function detectIntent(input = '') {
  const text = cleanInput(input);
  if (!text) return null;

  if (/^(?:请问)?(?:今天|现在)(?:是)?(?:几号|几月几日|什么日期|星期几|周几)[？?。]*$/.test(text)) {
    return { type: TASK_INTENTS.CURRENT_DATE };
  }

  if (/导出|下载/.test(text)) return { type: TASK_INTENTS.RESULT_EXPORT };
  if (/打开|查看/.test(text) && /(刚才|最近|生成|成果|产品介绍|报告)/.test(text)) return { type: TASK_INTENTS.RESULT_QUERY };
  if (/根据.*(资料|报价单|文件|合同)|报价单|资料库|知识库/.test(text)) return { type: TASK_INTENTS.KNOWLEDGE_SEARCH };
  if (/(收支|收入|支出|结余|消费统计|花了多少|赚了多少)/.test(text)) return { type: TASK_INTENTS.QUICKNOTE_STATISTICS };
  if (/(日报|周报|月报|随手记.*整理|整理.*随手记)/.test(text)) return { type: TASK_INTENTS.QUICKNOTE_REPORT };
  if (isPlanningRequest(text)) return null;
  if (isScheduleQuery(text)) return { type: TASK_INTENTS.SCHEDULE_QUERY };
  if (isScheduleWrite(text)) {
    const note = quickNoteManager.classify(text);
    if (note.category === 'todo') return { type: TASK_INTENTS.TODO_CREATE, note };
    if (note.category === 'reminder') return { type: TASK_INTENTS.REMINDER_CREATE, note };
    return { type: TASK_INTENTS.SCHEDULE_CREATE, note };
  }
  if (/^(记一下|帮我记一下|记录一下|记下|提醒我|提醒一下)/.test(text)) {
    const note = quickNoteManager.classify(removeCommandPrefix(text));
    if (note.category === 'todo') return { type: TASK_INTENTS.TODO_CREATE, note };
    if (note.category === 'reminder') return { type: TASK_INTENTS.REMINDER_CREATE, note };
    if (note.category === 'schedule') return { type: TASK_INTENTS.SCHEDULE_CREATE, note };
    return { type: TASK_INTENTS.QUICKNOTE_CREATE, note };
  }
  if (/新增.*(日程|提醒|待办)|创建.*(日程|提醒|待办)/.test(text)) {
    const note = quickNoteManager.classify(text);
    if (note.category === 'todo') return { type: TASK_INTENTS.TODO_CREATE, note };
    if (note.category === 'reminder') return { type: TASK_INTENTS.REMINDER_CREATE, note };
    return { type: TASK_INTENTS.SCHEDULE_CREATE, note };
  }
  if (/查.*随手记|随手记.*(记录|有什么|查)/.test(text)) return { type: TASK_INTENTS.QUICKNOTE_QUERY };
  return null;
}

function buildCompleted({ intent, result, sources = [], metadata = {} }) {
  return {
    handled: true,
    status: 'completed',
    intent,
    result,
    sources,
    metadata
  };
}

function buildNeedsInput({ intent, message, metadata = {} }) {
  return {
    handled: true,
    status: 'needs_input',
    intent,
    error: message,
    result: message,
    sources: [],
    metadata
  };
}

function readableKnowledgeItem(item = {}) {
  if (item.sourceType === 'knowledge') return Boolean(item.content);
  return ['parsed', 'readable', 'ready'].includes(item.parseStatus) && Boolean(item.content);
}

function isScheduleIntent(intent = '') {
  return [inputIntentTypes.SCHEDULE, inputIntentTypes.TODO, inputIntentTypes.REMINDER].includes(intent);
}

export class WorkspaceToolRegistry {
  constructor({
    context = workspaceContextService,
    quickNotes = quickNoteManager,
    memoryService = persistentMemoryService,
    inputRouter = unifiedInputRouter,
    dataTrustService = null
  } = {}) {
    this.context = context;
    this.quickNotes = quickNotes;
    this.memoryService = memoryService;
    this.dataTrustService = dataTrustService || new DataTrustService({ memoryService });
    this.inputRouter = inputRouter === unifiedInputRouter && memoryService !== persistentMemoryService
      ? new UnifiedInputRouter({ memoryService })
      : inputRouter;
  }

  classify(input) {
    return detectIntent(input);
  }

  async runForInput(input, options = {}) {
    const applicationIntent = this.classify(input);
    if (applicationIntent?.type === TASK_INTENTS.CURRENT_DATE) {
      return this.answerCurrentDate(applicationIntent, options);
    }
    if (applicationIntent?.type === TASK_INTENTS.SCHEDULE_QUERY
      && /今天|明天|后天|周末|周[一二三四五六日天]|星期[一二三四五六日天]/.test(cleanInput(input))) {
      return this.querySchedule(input, applicationIntent, options);
    }
    if (isPlanningRequest(cleanInput(input))) {
      return { handled: false, memoryWrite: null, memoryContext: { items: [] } };
    }

    const scheduleUpdate = this.updateRecentSchedule(input, options);
    if (scheduleUpdate) return scheduleUpdate;

    const memory = options.skipMemory
      ? { handled: false, memoryWrite: null, memoryContext: { items: [] } }
      : await this.runMemoryCapability(input, options);
    if (memory.handled) return memory;
    const intent = this.classify(input);
    if (!intent) return { handled: false, memoryWrite: memory.memoryWrite, memoryContext: memory.memoryContext };

    switch (intent.type) {
      case TASK_INTENTS.CURRENT_DATE:
        return this.answerCurrentDate(intent, options);
      case TASK_INTENTS.QUICKNOTE_STATISTICS:
        return this.calculateIncomeExpense(input, intent, options);
      case TASK_INTENTS.QUICKNOTE_REPORT:
        return this.summarizeQuickNotes(input, intent, options);
      case TASK_INTENTS.SCHEDULE_QUERY:
        return this.querySchedule(input, intent, options);
      case TASK_INTENTS.SCHEDULE_CREATE:
      case TASK_INTENTS.TODO_CREATE:
      case TASK_INTENTS.REMINDER_CREATE:
      case TASK_INTENTS.QUICKNOTE_CREATE:
        return this.createQuickNote(input, intent);
      case TASK_INTENTS.QUICKNOTE_QUERY:
        return this.queryQuickNotes(input, intent, options);
      case TASK_INTENTS.KNOWLEDGE_SEARCH:
        return this.searchKnowledge(input, intent);
      case TASK_INTENTS.RESULT_QUERY:
        return this.openResult(input, intent);
      case TASK_INTENTS.RESULT_EXPORT:
        return buildNeedsInput({
          intent,
          message: '请先打开需要导出的成果，然后使用成果下方的导出按钮。',
          metadata: { taskId: options.task?.taskId || '' }
        });
      default:
        return { handled: false, memoryWrite: memory.memoryWrite, memoryContext: memory.memoryContext };
    }
  }

  answerCurrentDate(intent, options = {}) {
    const date = new Date(options.now || new Date());
    const locale = options.locale || 'zh-CN';
    const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat(locale, {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        weekday: 'long'
      }).formatToParts(date).map((part) => [part.type, part.value])
    );
    return buildCompleted({
      intent,
      result: `今天是 ${parts.year}年${Number(parts.month)}月${Number(parts.day)}日，${parts.weekday}。`,
      metadata: { answerSource: 'application_context', timeZone }
    });
  }

  updateRecentSchedule(input, options = {}) {
    const text = cleanInput(input);
    if (!/^(?:刚才)?(?:改到|改成|改为|调整到|挪到)/.test(text)) return null;
    const parsed = this.quickNotes.classify(text);
    if (!parsed.scheduledAt || !parsed.time) return null;
    const target = this.quickNotes.listNotes()
      .filter((note) => ['schedule', 'reminder', 'todo'].includes(note.category))
      .filter((note) => note.status === 'confirmed')
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0];
    if (!target) return null;
    const updated = this.quickNotes.updateNote(target.id, {
      scheduledAt: parsed.scheduledAt,
      date: parsed.date,
      time: parsed.time,
      dateText: parsed.dateText,
      timeText: parsed.timeText,
      content: target.content || target.input
    });
    if (!updated) return null;
    return buildCompleted({
      intent: { type: TASK_INTENTS.SCHEDULE_CREATE, action: 'schedule.update' },
      result: scheduleConfirmationText(updated, options.now || new Date()),
      sources: [{ type: updated.category, id: updated.id, title: updated.content || updated.input }],
      metadata: { scheduleId: updated.id, actions: ['修改', '撤销', '查看日程'], formalScheduleSource: 'quick-note' }
    });
  }

  async runMemoryCapability(input, options = {}) {
    if (!options.conversationId) {
      return { handled: false, memoryWrite: null, memoryContext: { items: [] } };
    }
    const sourceId = String(options.sourceId || options.task?.taskId || `${options.conversationId || 'conversation'}:${cleanInput(input)}`);
    try {
      const result = await this.inputRouter.handle(input, {
        sourceType: 'conversation',
        sourceId,
        conversationId: String(options.conversationId || ''),
        workspaceId: options.workspaceId || '',
        userId: options.userId || '',
        currentTime: options.now || new Date().toISOString(),
        locale: options.locale || 'zh-CN'
      });
      if (['completed', 'ignored'].includes(result.status) && isScheduleIntent(result.intent?.intent)) {
        const note = this.quickNotes.noteFromUnifiedIntent(input, {
          ...result.intent,
          sourceId,
          sourceType: 'conversation',
          memoryId: result.metadata?.memoryId || result.memoryWrite?.memoryId || ''
        });
        const existing = this.quickNotes.findBySourceId(note.sourceId, note.category) || this.quickNotes.findMatchingSchedule(note);
        const saved = this.quickNotes.save(note);
        const syncedResult = result.status === 'ignored' && !existing
          ? { ...result, status: 'completed', result: scheduleConfirmationText(saved, options.now || new Date()) }
          : result;
        return {
          ...syncedResult,
          sources: [
            ...(syncedResult.sources || []),
            { type: saved.category, id: saved.id, title: saved.content || saved.input }
          ],
          metadata: {
            ...(syncedResult.metadata || {}),
            scheduleId: saved.id,
            formalScheduleSource: 'quick-note'
          }
        };
      }
      return result;
    } catch {
      return { handled: false, memoryWrite: { ok: false, code: 'INPUT_ROUTER_FAILED' }, memoryContext: { items: [] } };
    }
  }

  createQuickNote(input, intent) {
    const contentInput = removeCommandPrefix(input);
    const note = intent.note || this.quickNotes.classify(contentInput);
    if (note.missing || note.needsConfirmation) {
      return buildNeedsInput({
        intent,
        message: note.missing || '请补充要记录的具体内容。',
        metadata: { note }
      });
    }

    const saved = this.quickNotes.save(note);
    const typeLabel = {
      schedule: '日程',
      reminder: '提醒',
      todo: '待办',
      work_log: '工作日志',
      note: '随手记'
    }[saved.category] || '随手记';
    const time = saved.timeText || saved.dateText || '';
    return buildCompleted({
      intent,
      result: [
        `已创建${typeLabel}。`,
        time ? `时间：${time}` : '',
        `内容：${saved.content || saved.input}`,
        `来源：${typeLabel} 1 条`
      ].filter(Boolean).join('\n'),
      sources: [{ type: saved.category, id: saved.id, title: saved.content || saved.input }],
      metadata: { noteId: saved.id, category: saved.category }
    });
  }

  querySchedule(input, intent, options = {}) {
    const dateRange = resolveDateRange(input, {
      now: options.now || new Date(),
      timezone: options.timezone || options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    });
    if (dateRange.requiresConfirmation) return buildNeedsInput({ intent, message: '请确认要查询的时间范围。' });
    const items = this.context.getQuickNotes({
      from: new Date(dateRange.startAt),
      to: new Date(new Date(dateRange.endAt).getTime() - 1),
      limit: 100
    }).filter((note) => ['schedule', 'reminder', 'todo'].includes(note.category)).slice(0, 20);
    const label = `${dateRange.label}安排`;
    if (!items.length) {
      return buildCompleted({
        intent,
        result: `来源：${label} 0 项\n\n${label}暂无记录。`,
        sources: [],
        metadata: { period: dateRange.rangeType, dateRange }
      });
    }
    return buildCompleted({
      intent,
      result: [
        `来源：${label} ${items.length} 项`,
        '',
        `${label}`,
        ...items.map(formatNoteLine)
      ].join('\n'),
      sources: items.map((item) => ({ type: item.category, id: item.id, title: item.content || item.input })),
      metadata: { period: dateRange.rangeType, count: items.length, dateRange }
    });
  }

  queryQuickNotes(input, intent, options = {}) {
    const dateRange = resolveDateRange(input, {
      now: options.now || new Date(),
      timezone: options.timezone || options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    });
    if (dateRange.requiresConfirmation) return buildNeedsInput({ intent, message: '请确认要查询的时间范围。' });
    const notes = this.context.getQuickNotes({
      from: new Date(dateRange.startAt),
      to: new Date(new Date(dateRange.endAt).getTime() - 1),
      limit: 10
    });
    const label = dateRange.label;
    if (!notes.length) {
      return buildCompleted({
        intent,
        result: `${sourceLine(label, 0)}\n\n${label}暂无随手记记录。`,
        sources: [],
        metadata: { period: dateRange.rangeType, dateRange }
      });
    }
    return buildCompleted({
      intent,
      result: [
        sourceLine(`随手记`, notes.length),
        '',
        `${label}随手记`,
        ...notes.map(formatNoteLine)
      ].join('\n'),
      sources: notes.map((item) => ({ type: 'quick_note', id: item.id, title: item.content || item.input })),
      metadata: { period: dateRange.rangeType, count: notes.length, dateRange }
    });
  }

  calculateIncomeExpense(input, intent, options = {}) {
    const dateRange = resolveDateRange(input, {
      now: options.now || new Date(),
      timezone: options.timezone || options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      locale: options.locale || 'zh-CN',
      userId: options.userId || '',
      workspaceId: options.workspaceId || ''
    });
    if (dateRange.requiresConfirmation) {
      return buildNeedsInput({ intent, message: '请确认要统计的时间范围，例如今天、昨天、本周或本月。' });
    }
    const query = { dateRange, userId: options.userId || '', workspaceId: options.workspaceId || '', currency: 'CNY' };
    const onlyIncome = /收入|赚了|收到/.test(input) && !/收支|结余/.test(input);
    const onlyExpense = /支出|花了|花费|多少钱/.test(input) && !/收支|结余/.test(input);
    const result = onlyIncome
      ? this.dataTrustService.calculateIncome(query)
      : onlyExpense
        ? this.dataTrustService.calculateExpenses(query)
        : this.dataTrustService.calculateBalance(query);
    return buildCompleted({
      intent,
      result: formatTrustedFinanceReply(result),
      sources: result.includedRecords.map((record) => ({ type: record.sourceType, id: record.recordId, title: record.summary })),
      metadata: {
        period: dateRange.rangeType,
        income: result.income,
        expense: result.expense,
        balance: result.balance,
        entryCount: result.matchedCount,
        finance: result
      }
    });
  }

  summarizeQuickNotes(input, intent, options = {}) {
    const period = reportPeriodFromInput(input);
    const stats = this.context.getQuickNoteStatistics({ period });
    const notes = stats.notes;
    if (!notes.length) {
      return buildCompleted({
        intent,
        result: `来源：随手记 0 条\n\n${stats.label}暂无随手记记录，暂时无法生成${stats.label}总结。`,
        sources: [],
        metadata: { period }
      });
    }
    const byCategory = notes.reduce((acc, note) => {
      acc[note.category] = (acc[note.category] || 0) + 1;
      return acc;
    }, {});
    const periodExpression = period === 'month' ? '本月' : period === 'week' ? '本周' : '今天';
    const dateRange = resolveDateRange(periodExpression, {
      now: options.now || new Date(),
      timezone: options.timezone || options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    });
    const finance = this.dataTrustService.calculateBalance({
      dateRange,
      userId: options.userId || '',
      workspaceId: options.workspaceId || '',
      currency: 'CNY'
    });
    return buildCompleted({
      intent,
      result: [
        `来源：随手记 ${notes.length} 条`,
        '',
        `${stats.label}随手记总结`,
        `- 记录数量：${notes.length} 条`,
        `- 收入：${formatMoney(finance.income)}`,
        `- 支出：${formatMoney(finance.expense)}`,
        `- 结余：${formatMoney(finance.balance)}`,
        `- 分类：${Object.entries(byCategory).map(([key, count]) => `${key} ${count} 条`).join('、') || '无'}`,
        '',
        '重点记录：',
        ...notes.slice(0, 8).map(formatNoteLine)
      ].join('\n'),
      sources: notes.map((item) => ({ type: 'quick_note', id: item.id, title: item.content || item.input })),
      metadata: { period, count: notes.length, income: finance.income, expense: finance.expense, balance: finance.balance, finance }
    });
  }

  searchKnowledge(input, intent) {
    let items = this.context.searchKnowledge(input, { limit: 5 });
    if (!items.length && /报价单|报价表|最新/.test(input)) {
      items = this.context.getKnowledgeFiles({ limit: 5 })
        .filter((file) => /报价|价格|price/i.test(file.name || ''))
        .map((file) => ({ ...file, sourceType: 'knowledge_file', title: file.name, content: '', score: 1 }));
    }
    if (!items.length) {
      return buildCompleted({
        intent,
        result: '来源：资料库 0 条\n\n没有找到匹配的资料。请先通过“投资料”加入报价单、合同或相关文件。',
        sources: [],
        metadata: { query: input }
      });
    }

    const readable = items.filter(readableKnowledgeItem);
    if (!readable.length) {
      return buildCompleted({
        intent,
        result: [
          `来源：资料库 ${items.length} 条`,
          '',
          '已找到相关资料，但当前资料没有可引用正文，不能伪造引用内容。',
          ...items.map((item, index) => `${index + 1}. ${item.title || item.name}（${item.parseStatus || item.status || '未解析'}）`)
        ].join('\n'),
        sources: items.map((item) => ({ type: item.sourceType, id: item.id, title: item.title || item.name })),
        metadata: { query: input, readableCount: 0 }
      });
    }

    return buildCompleted({
      intent,
      result: [
        `来源：资料库 ${readable.length} 条`,
        '',
        '已找到可引用资料：',
        ...readable.map((item, index) => `${index + 1}. 《${item.title || item.name}》\n${String(item.content || '').slice(0, 800)}`)
      ].join('\n'),
      sources: readable.map((item) => ({ type: item.sourceType, id: item.id, title: item.title || item.name })),
      metadata: { query: input, readableCount: readable.length }
    });
  }

  openResult(input, intent) {
    const query = input.replace(/打开|查看|我|刚才|最近|生成的|成果|一下|。|，|,/g, ' ').trim();
    const results = this.context.getRecentResults({ query, limit: 5 });
    const selected = results[0];
    if (!selected) {
      return buildCompleted({
        intent,
        result: '来源：最近成果 0 条\n\n没有找到匹配的成果记录。',
        sources: [],
        metadata: { query }
      });
    }
    return buildCompleted({
      intent,
      result: [
        `来源：最近成果《${selected.title}》`,
        '',
        selected.resultText
      ].join('\n'),
      sources: [{ type: 'work_result', id: selected.taskId || selected.id, title: selected.title }],
      metadata: { taskId: selected.taskId || selected.id, query }
    });
  }
}

export const workspaceToolRegistry = new WorkspaceToolRegistry();
