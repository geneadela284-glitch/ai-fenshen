import { analyzeMemoryCandidate } from '../memory/memoryEngine.js';
import { detectSensitivity } from '../memory/memoryPolicy.js';
import { extractAmount, extractMemoryFields, extractOrganizations, extractPeople, extractProjects, extractTime } from '../memory/memoryExtractor.js';
import { normalizeMemoryInput } from '../memory/memoryNormalizer.js';
import {
  isAiResultText,
  isCalculationQuery,
  isCorrectionRequest,
  isExplanationQuery,
  isProvenanceQuery,
  queryIntentForInput
} from './inputSafetyGuards.js';
import { inputIntentTypes } from './inputIntentTypes.js';
import { createInputIntentResult } from './unifiedInputResult.js';
import { resolveDateRange } from '../trust/dateRangeResolver.js';

function isQuestion(text = '') {
  return /[?？]$|吗[?？。]*$|多少|怎么样|如何|为什么|是否|能不能|可以吗|怎么看|你觉得|怎么|哪几条|来源|依据|明细/.test(text);
}

function isMemoryQuery(text = '') {
  return /(花了多少(?:钱)?|多少钱|收支|收入|支出|结余|有什么安排|安排|日程|待办|提醒|报价是多少|报了多少钱|查.*记忆|记得.*什么)/.test(text)
    && isQuestion(text);
}

function isCasualChat(text = '') {
  return /^(你好|您好|谢谢|哈哈+|早上好|晚上好)[。！!]*$/.test(text);
}

function isExplicitReject(text = '') {
  return /不要记住|别记住|不用记|不要保存|别保存/.test(text);
}

function isWorkTask(text = '') {
  return /帮我|请|生成|写一篇|写一份|整理|总结|分析|做一份|制作|改写|翻译|起草|润色|检查/.test(text)
    && !/记一下|记住|记录一下|保存一下|提醒我|别忘|记得/.test(text);
}

function isPlainQuestion(text = '') {
  return isQuestion(text) && !isMemoryQuery(text);
}

function onlyTime(text = '', context = {}) {
  const time = extractTime(text, context);
  if (!time) return false;
  const withoutTime = text.replace(time.raw, '').replace(/[，,。.\s]/g, '');
  return !withoutTime;
}

function isAmountOnly(text = '') {
  const amount = extractAmount(text);
  if (!amount) return false;
  return text.replace(amount.raw, '').replace(/[元块万元万，,。.\s]/g, '') === '';
}

function isExpenseWithoutAmount(text = '') {
  return /(?:记一笔|记一下|记录一下)?(?:饭钱|餐饮|午饭|晚饭|早饭|早餐|午餐|晚餐|外卖|打车|车费)(?!.*(?:\d|[一二两三四五六七八九十百千万零〇点]+)\s*(?:元|块|万|万元)?)/.test(text);
}

function proposedActionFor(intent) {
  const map = {
    [inputIntentTypes.QUESTION]: 'answer',
    [inputIntentTypes.CASUAL_CHAT]: 'answer',
    [inputIntentTypes.WORK_TASK]: 'work_task',
    [inputIntentTypes.MEMORY_QUERY]: 'query_memory',
    [inputIntentTypes.AMBIGUOUS]: 'ask_followup',
    [inputIntentTypes.REJECTED]: 'ignore'
  };
  return map[intent] || 'remember';
}

function intentFromMemoryType(memoryType = '') {
  const map = {
    expense: inputIntentTypes.EXPENSE,
    income: inputIntentTypes.INCOME,
    schedule: inputIntentTypes.SCHEDULE,
    todo: inputIntentTypes.TODO,
    reminder: inputIntentTypes.REMINDER,
    customer_fact: inputIntentTypes.CUSTOMER_FACT,
    project_fact: inputIntentTypes.PROJECT_FACT,
    quote: inputIntentTypes.QUOTE,
    preference: inputIntentTypes.MEMORY_RECORD,
    generic_memory: inputIntentTypes.MEMORY_RECORD
  };
  return map[memoryType] || inputIntentTypes.MEMORY_RECORD;
}

function buildEntities(text = '', context = {}, memoryCandidate = null) {
  const fields = memoryCandidate || extractMemoryFields(text, context);
  return {
    amount: fields.amount ?? null,
    currency: fields.currency || '',
    direction: fields.direction || 'neutral',
    eventDate: fields.eventDate || '',
    eventTime: fields.eventTime || '',
    startAt: fields.startAt || '',
    people: fields.people || extractPeople(text),
    organizations: fields.organizations || extractOrganizations(text),
    projects: fields.projects || extractProjects(text),
    memoryType: fields.memoryType || '',
    category: fields.category || '',
    summary: fields.summary || '',
    hasAmount: Boolean(extractAmount(text)),
    hasTime: Boolean(extractTime(text, context))
  };
}

export class InputIntentClassifier {
  constructor({ engine = analyzeMemoryCandidate, now = () => new Date() } = {}) {
    this.engine = engine;
    this.now = now;
  }

  normalizeContext(context = {}) {
    return {
      sourceType: context.sourceType || 'unknown',
      sourceId: context.sourceId || context.conversationId || '',
      conversationId: context.conversationId || '',
      workspaceId: context.workspaceId || '',
      userId: context.userId || '',
      currentTime: context.currentTime || context.now || this.now().toISOString(),
      locale: context.locale || 'zh-CN',
      timezone: context.timezone || context.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      submissionId: context.submissionId || '',
      role: context.role || '',
      isAiOutput: Boolean(context.isAiOutput),
      now: context.currentTime || context.now || this.now().toISOString()
    };
  }

  classify(input = '', context = {}) {
    const normalizedInput = normalizeMemoryInput(input);
    const normalizedContext = this.normalizeContext(context);

    if (!normalizedInput) {
      return createInputIntentResult({
        intent: inputIntentTypes.REJECTED,
        confidence: 1,
        reason: 'empty_input',
        proposedAction: 'ignore',
        normalizedInput
      });
    }

    if (isExplicitReject(normalizedInput)) {
      return createInputIntentResult({
        intent: inputIntentTypes.REJECTED,
        confidence: 0.96,
        reason: 'user_rejected_memory',
        proposedAction: 'ignore',
        normalizedInput,
        shouldRemember: false
      });
    }

    const sensitivity = detectSensitivity(normalizedInput);
    const analysis = this.engine(normalizedInput, normalizedContext);
    const candidate = analysis.memoryCandidate;
    const warnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];

    if (sensitivity.sensitivity === 'high') {
      return createInputIntentResult({
        intent: inputIntentTypes.MEMORY_RECORD,
        confidence: 0.9,
        reason: 'sensitive_information_requires_confirmation',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        requiresConfirmation: true,
        shouldRemember: false,
        proposedAction: 'ask_followup',
        normalizedInput,
        warnings,
        memoryCandidate: candidate
      });
    }

    if (isMemoryQuery(normalizedInput)) {
      const queryIntent = queryIntentForInput(normalizedInput);
      return createInputIntentResult({
        intent: queryIntent,
        confidence: 0.9,
        reason: 'question_requests_stored_facts',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        proposedAction: 'query_memory',
        normalizedInput,
        warnings
      });
    }

    if (isExplanationQuery(normalizedInput) || isProvenanceQuery(normalizedInput) || isCalculationQuery(normalizedInput) || isAiResultText(normalizedInput)) {
      const queryIntent = queryIntentForInput(normalizedInput);
      return createInputIntentResult({
        intent: queryIntent,
        confidence: 0.92,
        reason: isAiResultText(normalizedInput) ? 'ai_result_text_not_a_new_fact' : 'amount_explanation_or_provenance_query',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        proposedAction: 'query_memory',
        normalizedInput,
        warnings
      });
    }

    if (isCorrectionRequest(normalizedInput)) {
      return createInputIntentResult({
        intent: inputIntentTypes.CORRECTION_REQUEST,
        confidence: 0.86,
        reason: 'correction_request_requires_target',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        requiresConfirmation: true,
        shouldRemember: false,
        proposedAction: 'ask_followup',
        normalizedInput,
        warnings
      });
    }

    if (['expense', 'income'].includes(candidate?.memoryType)) {
      const dateRange = resolveDateRange(normalizedInput, normalizedContext);
      const invalidExplicitDate = dateRange.warnings?.some((warning) => warning.startsWith('explicit_date_'));
      if (dateRange.rangeType === 'explicit_date_range' || invalidExplicitDate) {
        return createInputIntentResult({
          intent: inputIntentTypes.AMBIGUOUS,
          confidence: 0.92,
          reason: 'transaction_date_ambiguous',
          entities: buildEntities(normalizedInput, normalizedContext, candidate),
          requiresConfirmation: true,
          shouldRemember: false,
          proposedAction: 'ask_followup',
          normalizedInput,
          warnings: [...warnings, 'transaction_date_requires_one_day'],
          memoryCandidate: candidate
        });
      }
    }

    if (isAmountOnly(normalizedInput)) {
      return createInputIntentResult({
        intent: inputIntentTypes.AMBIGUOUS,
        confidence: 0.88,
        reason: 'transaction_direction_missing',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        requiresConfirmation: true,
        shouldRemember: false,
        proposedAction: 'ask_followup',
        normalizedInput,
        warnings
      });
    }

    if (isExpenseWithoutAmount(normalizedInput)) {
      return createInputIntentResult({
        intent: inputIntentTypes.EXPENSE,
        confidence: 0.84,
        reason: 'transaction_amount_missing',
        entities: { ...buildEntities(normalizedInput, normalizedContext, candidate), direction: 'expense', memoryType: 'expense', category: 'expense' },
        requiresConfirmation: true,
        shouldRemember: false,
        proposedAction: 'ask_followup',
        normalizedInput,
        warnings
      });
    }

    if (onlyTime(normalizedInput, normalizedContext)) {
      return createInputIntentResult({
        intent: inputIntentTypes.AMBIGUOUS,
        confidence: 0.86,
        reason: 'time_without_action',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        requiresConfirmation: true,
        proposedAction: 'ask_followup',
        normalizedInput,
        warnings,
        memoryCandidate: candidate
      });
    }

    if (candidate && analysis.validation?.valid && analysis.decision?.remember) {
      const intent = intentFromMemoryType(candidate.memoryType);
      return createInputIntentResult({
        intent,
        confidence: analysis.decision.confidence || candidate.confidence || 0.82,
        reason: analysis.decision.reason || 'matches_memory_policy',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        requiresConfirmation: Boolean(analysis.decision.needsConfirmation || candidate.needsConfirmation),
        shouldRemember: true,
        proposedAction: proposedActionFor(intent),
        normalizedInput,
        warnings,
        memoryCandidate: candidate
      });
    }

    if (isWorkTask(normalizedInput)) {
      return createInputIntentResult({
        intent: inputIntentTypes.WORK_TASK,
        confidence: 0.82,
        reason: 'work_task_request',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        proposedAction: 'work_task',
        normalizedInput,
        warnings
      });
    }

    if (isPlainQuestion(normalizedInput)) {
      return createInputIntentResult({
        intent: inputIntentTypes.QUESTION,
        confidence: 0.78,
        reason: 'general_question',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        proposedAction: 'answer',
        normalizedInput,
        warnings
      });
    }

    if (isCasualChat(normalizedInput)) {
      return createInputIntentResult({
        intent: inputIntentTypes.CASUAL_CHAT,
        confidence: 0.92,
        reason: 'casual_chat',
        entities: buildEntities(normalizedInput, normalizedContext, candidate),
        proposedAction: 'answer',
        normalizedInput,
        warnings
      });
    }

    return createInputIntentResult({
      intent: inputIntentTypes.WORK_TASK,
      confidence: 0.55,
      reason: 'default_to_work_task',
      entities: buildEntities(normalizedInput, normalizedContext, candidate),
      proposedAction: 'work_task',
      normalizedInput,
      warnings
    });
  }
}

export const inputIntentClassifier = new InputIntentClassifier();
