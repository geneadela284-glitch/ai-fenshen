import { persistentMemoryService } from '../memory/memoryRuntime.js';
import { extractOrganizations, extractPeople } from '../memory/memoryExtractor.js';
import {
  isEligibleBusinessFact,
  isEligibleTransactionFact
} from './inputSafetyGuards.js';
import { InputIntentClassifier, inputIntentClassifier } from './inputIntentClassifier.js';
import { inputIntentTypes } from './inputIntentTypes.js';
import { shouldAskFollowup, shouldPassThrough, shouldRememberIntent } from './inputRoutingPolicy.js';
import { createUnifiedInputResult } from './unifiedInputResult.js';
import { DataTrustService, formatTrustedFinanceReply } from '../trust/dataTrustService.js';
import { resolveDateRange } from '../trust/dateRangeResolver.js';
import {
  ACTION_RESULT_STATUS,
  ACTION_TYPES,
  createSecretaryActionFramework
} from '../actions/secretary/index.js';

function money(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? `${number}元` : `${number.toFixed(2)}元`;
}

function transactionMoney(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? `${number} 元` : `${number.toFixed(2)} 元`;
}

function buildMemoryContext(context = {}) {
  const sourceType = context.sourceType || 'unknown';
  const sourceId = context.sourceId || context.conversationId || '';
  const now = context.currentTime || context.now || new Date().toISOString();
  return {
    sourceType,
    sourceId: String(sourceId || ''),
    conversationId: context.conversationId || '',
    workspaceId: context.workspaceId || '',
    userId: context.userId || '',
    locale: context.locale || 'zh-CN',
    timezone: context.timezone || context.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    submissionId: context.submissionId || '',
    role: context.role || 'user',
    isAiOutput: Boolean(context.isAiOutput),
    now
  };
}

function safeMemoryItem(record) {
  return {
    memoryId: record.id,
    sourceType: record.sourceType,
    eventDate: record.eventDate || '',
    createdAt: record.createdAt,
    summary: String(record.summary || record.title || '').slice(0, 240)
  };
}

function sourceTitle(record = {}) {
  return record.summary || record.title || record.normalizedText || '长期记忆';
}

function financeCacheKey(context = {}) {
  return String(context.conversationId || context.sourceId || 'global');
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function shortChineseTime(hour, minute = 0) {
  const period = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour === 12 ? '中午' : hour < 18 ? '下午' : '晚上';
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${period}${displayHour}点${minute ? `${minute}分` : ''}`;
}

function weekdayLabel(date) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
}

export class UnifiedInputRouter {
  constructor({
    classifier = inputIntentClassifier,
    memoryService = persistentMemoryService,
    dataTrustService = null,
    actionFramework = null,
    now = () => new Date()
  } = {}) {
    this.classifier = classifier instanceof InputIntentClassifier ? classifier : classifier;
    this.memoryService = memoryService;
    this.dataTrustService = dataTrustService || new DataTrustService({ memoryService });
    this.now = now;
    this.actionFramework = actionFramework || createSecretaryActionFramework({ memoryService, now });
    this.lastFinanceResults = new Map();
  }

  classify(input = '', context = {}) {
    return this.classifier.classify(input, { ...context, now: context.currentTime || context.now || this.now().toISOString() });
  }

  async classifyWithAI(input = '', context = {}) {
    return this.classify(input, context);
  }

  async handle(input = '', context = {}) {
    let intent;
    try {
      intent = this.classify(input, context);
    } catch {
      intent = {
        intent: inputIntentTypes.WORK_TASK,
        confidence: 0.3,
        reason: 'classification_failed_fallback',
        entities: {},
        requiresConfirmation: false,
        shouldRemember: false,
        proposedAction: 'work_task',
        normalizedInput: String(input || '').trim(),
        warnings: ['classification_failed'],
        memoryCandidate: null,
        metadata: {}
      };
    }

    if (intent.intent === inputIntentTypes.REJECTED) {
      return createUnifiedInputResult({ handled: true, status: 'ignored', intent, result: '未保存。' });
    }

    if ([
      inputIntentTypes.MEMORY_QUERY,
      inputIntentTypes.EXPLANATION_QUERY,
      inputIntentTypes.PROVENANCE_QUERY,
      inputIntentTypes.CALCULATION_QUERY
    ].includes(intent.intent)) {
      return this.queryMemory(input, intent, context);
    }

    if (intent.intent === inputIntentTypes.CORRECTION_REQUEST) {
      return createUnifiedInputResult({
        handled: true,
        status: 'needs_input',
        intent,
        result: '请指出要更正的具体记忆或金额明细，确认后再修改。',
        error: '请指出要更正的具体记忆或金额明细，确认后再修改。'
      });
    }

    if (shouldAskFollowup(intent)) {
      return createUnifiedInputResult({
        handled: true,
        status: 'needs_input',
        intent,
        result: this.followupMessage(intent),
        error: this.followupMessage(intent),
        metadata: { requiresConfirmation: intent.requiresConfirmation }
      });
    }

    if (shouldRememberIntent(intent.intent) && intent.shouldRemember) {
      const eligible = [inputIntentTypes.EXPENSE, inputIntentTypes.INCOME].includes(intent.intent)
        ? isEligibleTransactionFact(input, intent, intent.memoryCandidate, context)
        : isEligibleBusinessFact(input, intent, intent.memoryCandidate, context);
      if (!eligible) {
        if ([inputIntentTypes.EXPENSE, inputIntentTypes.INCOME].includes(intent.intent)) {
          return createUnifiedInputResult({
            handled: true,
            status: 'needs_input',
            intent,
            result: '请提供大于 0、最多两位小数的有效金额。',
            error: '请提供大于 0、最多两位小数的有效金额。'
          });
        }
        return createUnifiedInputResult({
          handled: false,
          status: 'pass_through',
          intent: { ...intent, shouldRemember: false },
          memoryContext: this.selectMemoryContext(input)
        });
      }
      if ([inputIntentTypes.EXPENSE, inputIntentTypes.SCHEDULE].includes(intent.intent)) {
        return this.runAction(input, intent, context);
      }
      return this.remember(input, intent, context);
    }

    if (shouldPassThrough(intent.intent)) {
      return createUnifiedInputResult({
        handled: false,
        status: 'pass_through',
        intent,
        memoryContext: this.selectMemoryContext(input)
      });
    }

    return createUnifiedInputResult({ handled: false, status: 'pass_through', intent, memoryContext: this.selectMemoryContext(input) });
  }

  async runAction(input, intent, context = {}) {
    const memoryContext = buildMemoryContext(context);
    const actionName = intent.intent === inputIntentTypes.EXPENSE ? 'CreateExpense' : 'CreateSchedule';
    const actionType = intent.intent === inputIntentTypes.EXPENSE ? ACTION_TYPES.EXPENSE : ACTION_TYPES.SCHEDULE;
    const proposal = this.actionFramework.propose({
      actionName,
      actionType,
      arguments: { input, memoryContext },
      source: { type: memoryContext.sourceType, id: memoryContext.sourceId },
      userId: memoryContext.userId,
      workspaceId: memoryContext.workspaceId,
      conversationId: memoryContext.conversationId,
      confidence: intent.confidence,
      proposedBy: 'program',
      idempotencyKey: memoryContext.submissionId || `${memoryContext.sourceType}:${memoryContext.sourceId}`
    });
    const actionResult = await this.actionFramework.execute(proposal, { confirmed: false });
    const actionMetadata = {
      name: actionName,
      type: actionType,
      result: actionResult.status,
      code: actionResult.code,
      proposalId: proposal.proposalId,
      auditId: actionResult.auditId
    };

    if (actionResult.status === ACTION_RESULT_STATUS.NEED_CONFIRMATION || actionResult.status === ACTION_RESULT_STATUS.PENDING) {
      return createUnifiedInputResult({
        handled: true,
        status: 'needs_input',
        intent,
        result: actionResult.message || '需要确认，尚未执行。',
        error: actionResult.message || '需要确认，尚未执行。',
        metadata: { action: actionMetadata }
      });
    }

    const memoryWrite = actionResult.data?.memoryWrite || null;
    if (actionResult.status === ACTION_RESULT_STATUS.SUCCESS && actionResult.code === 'MEMORY_SAVED') {
      const isExpense = intent.intent === inputIntentTypes.EXPENSE;
      let record = actionResult.data.record;
      if (isExpense) {
        const verification = this.verifyTransactionWrite(record, intent, memoryContext);
        if (!verification.ok) return this.transactionWriteFailure(intent, actionMetadata, record, verification.message);
        record = verification.record;
      }
      return createUnifiedInputResult({
        handled: true,
        status: 'completed',
        intent,
        result: isExpense ? this.transactionSavedText(record) : this.scheduleSavedText(record, intent.intent),
        sources: [{ type: 'memory', id: record.id, title: sourceTitle(record) }],
        memoryWrite,
        metadata: {
          memoryId: record.id,
          actions: isExpense ? ['修改', '撤销', '查看明细'] : ['修改', '撤销', '查看日程'],
          action: actionMetadata
        }
      });
    }

    if (actionResult.status === ACTION_RESULT_STATUS.SUCCESS && actionResult.code === 'MEMORY_DUPLICATE_FOUND') {
      return createUnifiedInputResult({
        handled: true,
        status: 'ignored',
        intent,
        result: '这条内容已经记录过，未重复保存。',
        memoryWrite,
        metadata: { ...(memoryWrite?.data || {}), action: actionMetadata }
      });
    }

    if (intent.intent === inputIntentTypes.EXPENSE) {
      return this.transactionWriteFailure(intent, actionMetadata, null, '这笔记录未保存，请稍后重试。');
    }
    return createUnifiedInputResult({ handled: false, status: 'pass_through', intent, memoryWrite, memoryContext: this.selectMemoryContext(input), metadata: { action: actionMetadata } });
  }

  remember(input, intent, context = {}) {
    const memoryContext = buildMemoryContext(context);
    let memoryWrite;
    try {
      memoryWrite = this.memoryService.remember(input, { context: memoryContext });
    } catch {
      memoryWrite = { ok: false, code: 'MEMORY_STORAGE_FAILED' };
    }

    if (memoryWrite?.requiresConfirmation || memoryWrite?.code === 'MEMORY_CONFIRMATION_REQUIRED' || memoryWrite?.action === 'prepared') {
      return createUnifiedInputResult({
        handled: true,
        status: 'needs_input',
        intent,
        result: '需要确认，尚未保存。',
        error: '需要确认，尚未保存。',
        memoryWrite
      });
    }

    if (memoryWrite?.ok && memoryWrite?.code === 'MEMORY_SAVED') {
      let record = memoryWrite.data;
      if ([inputIntentTypes.EXPENSE, inputIntentTypes.INCOME].includes(intent.intent)) {
        const verification = this.verifyTransactionWrite(record, intent, memoryContext);
        if (!verification.ok) return this.transactionWriteFailure(intent, null, record, verification.message);
        record = verification.record;
        return createUnifiedInputResult({
          handled: true,
          status: 'completed',
          intent,
          result: this.transactionSavedText(record),
          sources: [{ type: 'memory', id: record.id, title: sourceTitle(record) }],
          memoryWrite,
          metadata: { memoryId: record.id, actions: ['修改', '撤销', '查看明细'] }
        });
      }
      if ([inputIntentTypes.SCHEDULE, inputIntentTypes.REMINDER, inputIntentTypes.TODO].includes(intent.intent)) {
        return createUnifiedInputResult({
          handled: true,
          status: 'completed',
          intent,
          result: this.scheduleSavedText(record, intent.intent),
          sources: [{ type: 'memory', id: record.id, title: sourceTitle(record) }],
          memoryWrite,
          metadata: { memoryId: record.id, actions: ['修改', '撤销', '查看日程'] }
        });
      }
      const label = this.intentLabel(intent.intent);
      return createUnifiedInputResult({
        handled: true,
        status: 'completed',
        intent,
        result: [`已记录${label}。`, this.recordDetail(record), '来源：长期记忆 1 条'].filter(Boolean).join('\n'),
        sources: [{ type: 'memory', id: record.id, title: sourceTitle(record) }],
        memoryWrite,
        metadata: { memoryId: record.id }
      });
    }

    if (memoryWrite?.code === 'MEMORY_DUPLICATE_FOUND') {
      return createUnifiedInputResult({
        handled: true,
        status: 'ignored',
        intent,
        result: '这条内容已经记录过，未重复保存。',
        memoryWrite,
        metadata: memoryWrite.data || {}
      });
    }

    if ([inputIntentTypes.EXPENSE, inputIntentTypes.INCOME].includes(intent.intent)) {
      return this.transactionWriteFailure(intent, null, null, '这笔记录未保存，请稍后重试。');
    }

    return createUnifiedInputResult({
      handled: false,
      status: 'pass_through',
      intent,
      memoryWrite,
      memoryContext: this.selectMemoryContext(input)
    });
  }

  verifyTransactionWrite(record = {}, intent = {}, context = {}) {
    try {
      const readback = this.memoryService.getMemory(record.id);
      const saved = readback?.ok ? readback.data : null;
      const expectedMinor = record.metadata?.amountMinor ?? Math.round(Number(record.amount) * 100);
      const savedMinor = saved?.metadata?.amountMinor ?? Math.round(Number(saved?.amount) * 100);
      const scopeMatches = (!context.userId || saved?.metadata?.userId === context.userId)
        && (!context.workspaceId || saved?.metadata?.workspaceId === context.workspaceId);
      if (!saved || saved.id !== record.id || savedMinor !== expectedMinor || saved.direction !== intent.intent || saved.eventDate !== record.eventDate || !scopeMatches) {
        throw new Error('readback_mismatch');
      }
      return { ok: true, record: saved };
    } catch {
      try {
        if (record.id) this.memoryService.deleteMemory(record.id);
      } catch {
        // The failed user response remains authoritative when cleanup is unavailable.
      }
      return { ok: false, message: '保存后核对失败，这笔记录未保存，请重试。' };
    }
  }

  transactionWriteFailure(intent, action, record, message) {
    return createUnifiedInputResult({
      handled: true,
      status: 'failed',
      intent,
      result: message || '这笔记录未保存，请稍后重试。',
      error: message || '这笔记录未保存，请稍后重试。',
      metadata: { ...(action ? { action } : {}), ...(record?.id ? { failedMemoryId: record.id } : {}) }
    });
  }

  queryMemory(input, intent, context = {}) {
    const text = String(input || '').trim();
    if ([inputIntentTypes.EXPLANATION_QUERY, inputIntentTypes.PROVENANCE_QUERY, inputIntentTypes.CALCULATION_QUERY].includes(intent.intent)) {
      const previous = this.lastFinanceResults.get(financeCacheKey(context));
      if (previous) {
        return createUnifiedInputResult({
          handled: true,
          status: 'completed',
          intent,
          result: formatTrustedFinanceReply(previous, { includeSteps: true }),
          sources: previous.includedRecords.map((item) => ({ type: 'memory', id: item.recordId, title: item.summary })),
          metadata: { finance: previous }
        });
      }
    }
    const now = context.currentTime || context.now || this.now();
    const range = resolveDateRange(text, {
      ...context,
      now,
      timezone: context.timezone || context.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    });
    const people = extractPeople(text);
    const organizations = extractOrganizations(text);
    const query = /最近|和.*安排/.test(text) || range.requiresConfirmation
      ? {}
      : { dateFrom: range.startDate, dateTo: range.endDateInclusive };
    let records = [];
    try {
      records = this.memoryService.searchMemories(query).data || [];
    } catch {
      records = [];
    }

    if (/报价/.test(text) && organizations.length) {
      const quote = records
        .filter((item) => item.organizations?.includes(organizations[0]) && ['quote', 'customer_fact'].includes(item.memoryType))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      if (!quote) return createUnifiedInputResult({ handled: true, status: 'completed', intent, result: '没有找到相关记忆。' });
      return createUnifiedInputResult({
        handled: true,
        status: 'completed',
        intent,
        result: `${organizations[0]}报价：${money(quote.amount)}\n来源：${organizations[0]}报价记录（${quote.eventDate || String(quote.createdAt || '').slice(0, 10)}）\n来源：长期记忆 1 条`,
        sources: [{ type: 'memory', id: quote.id, title: sourceTitle(quote) }]
      });
    }

    if (/安排|日程|待办|提醒/.test(text)) {
      const schedules = records
        .filter((item) => ['schedule', 'todo', 'reminder'].includes(item.memoryType) && (!people.length || item.people?.includes(people[0])))
        .sort((a, b) => `${a.eventDate}${a.eventTime}`.localeCompare(`${b.eventDate}${b.eventTime}`));
      if (!schedules.length) return createUnifiedInputResult({ handled: true, status: 'completed', intent, result: '没有找到相关记忆。' });
      return createUnifiedInputResult({
        handled: true,
        status: 'completed',
        intent,
        result: [`来源：长期记忆 ${schedules.length} 条`, ...schedules.map((item) => `${item.eventDate} ${item.eventTime}：${sourceTitle(item)}`)].join('\n'),
        sources: schedules.map((item) => ({ type: 'memory', id: item.id, title: sourceTitle(item) }))
      });
    }

    const onlyIncome = /收入|赚了|收到/.test(text) && !/收支|结余/.test(text);
    const onlyExpense = /支出|花了|花费|多少钱/.test(text) && !/收支|结余/.test(text);
    if (range.requiresConfirmation) {
      return createUnifiedInputResult({
        handled: true,
        status: 'needs_input',
        intent,
        result: '请确认要统计的时间范围，例如今天、昨天、本周或本月。',
        error: '请确认要统计的时间范围，例如今天、昨天、本周或本月。'
      });
    }
    const trustQuery = {
      userId: context.userId || '',
      workspaceId: context.workspaceId || '',
      dateRange: range,
      keyword: this.financeKeyword(text),
      currency: 'CNY'
    };
    const financeResult = onlyIncome
      ? this.dataTrustService.calculateIncome(trustQuery)
      : onlyExpense
        ? this.dataTrustService.calculateExpenses(trustQuery)
        : this.dataTrustService.calculateBalance(trustQuery);
    this.lastFinanceResults.set(financeCacheKey(context), financeResult);
    return createUnifiedInputResult({
      handled: true,
      status: 'completed',
      intent,
      result: formatTrustedFinanceReply(financeResult),
      sources: financeResult.includedRecords.map((item) => ({ type: 'memory', id: item.recordId, title: item.summary })),
      metadata: { finance: financeResult }
    });
  }

  financeKeyword(input = '') {
    const match = String(input || '').match(/今天(.+?)(?:花了|花费|支出|多少钱)/);
    if (match?.[1]) return match[1].replace(/我|一共|总共/g, '').trim();
    return '';
  }

  selectMemoryContext(input) {
    try {
      const results = this.memoryService.searchMemories({ keyword: String(input || '').trim(), limit: 3 }).data || [];
      return { items: results.filter((item) => item.sensitivity !== 'high').map(safeMemoryItem).slice(0, 3) };
    } catch {
      return { items: [] };
    }
  }

  followupMessage(intent) {
    if (intent.warnings?.some((item) => item.startsWith('sensitive:'))) return '这条内容可能包含敏感信息，请确认是否需要保存。';
    if (intent.reason === 'transaction_direction_missing') return '这是收入还是支出？';
    if (intent.reason === 'transaction_amount_missing') return '金额是多少？';
    if (intent.reason === 'transaction_date_ambiguous') return '请确认这笔记录的具体日期（哪一天）。';
    if (intent.intent === inputIntentTypes.AMBIGUOUS) return '已识别到时间，请补充要记录或提醒的具体事项。';
    return '请补充要记录的具体内容。';
  }

  transactionSavedText(record = {}) {
    const label = record.direction === 'income' ? '收入' : `${this.transactionCategoryLabel(record)}支出`;
    return [
      `已记录：${label} ${transactionMoney(record.amount)}。`,
      `${this.transactionDateLabel(record)} · 个人账本 · 可修改`
    ].join('\n');
  }

  transactionCategoryLabel(record = {}) {
    const text = `${record.originalText || ''} ${record.normalizedText || ''} ${record.summary || ''}`;
    if (/吃饭|午饭|晚饭|早饭|早餐|午餐|晚餐|饭钱|餐饮|外卖/.test(text)) return '餐饮';
    if (/打车|车费|停车费|地铁|公交/.test(text)) return '交通';
    if (/买菜|超市|购物|买/.test(text)) return '购物';
    return '未分类';
  }

  transactionDateLabel(record = {}) {
    const today = resolveDateRange('今天', {
      now: this.now(),
      timezone: record.metadata?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    }).startDate;
    if (!record.eventDate || record.eventDate === today) return '今天';
    return record.eventDate;
  }

  scheduleSavedText(record = {}, intent = inputIntentTypes.SCHEDULE) {
    const action = intent === inputIntentTypes.TODO ? '已创建待办' : intent === inputIntentTypes.REMINDER ? '已提醒' : '已安排';
    const time = this.localizedScheduleTime(record);
    const content = String(record.summary || record.title || record.normalizedText || record.originalText || '').trim();
    return `${action}：${[time, content].filter(Boolean).join('')}。`;
  }

  localizedScheduleTime(record = {}) {
    const eventDate = record.eventDate || '';
    const eventTime = record.eventTime || '';
    if (!eventDate && !eventTime) return '';
    const nowDate = new Date(this.now());
    const today = localDateKey(nowDate);
    const tomorrowDate = new Date(nowDate);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = localDateKey(tomorrowDate);
    const date = eventDate ? new Date(`${eventDate}T00:00:00`) : nowDate;
    const [hourSource = '0', minuteSource = '0'] = String(eventTime || '00:00').split(':');
    const hour = Number(hourSource);
    const minute = Number(minuteSource);
    const timeText = Number.isFinite(hour) ? shortChineseTime(hour, Number.isFinite(minute) ? minute : 0) : '';
    if (!eventDate) return timeText;
    if (eventDate === today) return `今天${timeText}`;
    if (eventDate === tomorrow) return `明天${timeText}`;
    const daysAway = Math.round((date.getTime() - new Date(`${today}T00:00:00`).getTime()) / (24 * 60 * 60 * 1000));
    if (daysAway > 1 && daysAway <= 7) return `${weekdayLabel(date)}${timeText}`;
    return `${date.getMonth() + 1}月${date.getDate()}日${timeText}`;
  }

  intentLabel(intent) {
    const map = {
      [inputIntentTypes.EXPENSE]: '支出',
      [inputIntentTypes.INCOME]: '收入',
      [inputIntentTypes.SCHEDULE]: '日程',
      [inputIntentTypes.TODO]: '待办',
      [inputIntentTypes.REMINDER]: '提醒',
      [inputIntentTypes.QUOTE]: '报价',
      [inputIntentTypes.CUSTOMER_FACT]: '客户信息',
      [inputIntentTypes.PROJECT_FACT]: '项目信息',
      [inputIntentTypes.MEMORY_RECORD]: '记忆'
    };
    return map[intent] || '内容';
  }

  recordDetail(record = {}) {
    if (!record) return '';
    const parts = [];
    if (['expense', 'income', 'quote', 'budget'].includes(record.memoryType) && record.amount !== null && record.amount !== undefined) parts.push(`金额：${money(record.amount)}`);
    if (record.eventDate || record.eventTime) parts.push(`时间：${[record.eventDate, record.eventTime].filter(Boolean).join(' ')}`);
    if (record.summary) parts.push(`内容：${record.summary}`);
    return parts.join('\n');
  }
}

export const unifiedInputRouter = new UnifiedInputRouter();
