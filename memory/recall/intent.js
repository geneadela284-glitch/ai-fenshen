import { MemoryType } from '../kernel/index.js';
import { MemoryRecallIntent, RecallReasonCode, deepFreezeRecall } from './contracts.js';
import { parseRelationshipEntityQuery } from './entity.js';

const RULES = Object.freeze([
  [MemoryRecallIntent.SENSITIVE_CONTEXT, RecallReasonCode.SENSITIVE_SIGNAL, /(?:健康|病历|过敏|收入|财务|详细家庭地址|精确位置|私密)/],
  [MemoryRecallIntent.PRIOR_DECISION, RecallReasonCode.DECISION_SIGNAL, /(?:决定|为什么.*(?:搬家|选择)|作过什么决定)/],
  [MemoryRecallIntent.HISTORICAL_CONTEXT, RecallReasonCode.HISTORICAL_SIGNAL, /(?:以前|过去|历史|回顾|曾经).*(?:住|记录|哪里|城市)|以前住在哪里/],
  [MemoryRecallIntent.RELATIONSHIP_CONTEXT, RecallReasonCode.RELATIONSHIP_SIGNAL, /(?:女儿|儿子|父亲|母亲|爸爸|妈妈|妈|爸|妻子|老婆|丈夫|老公|家人|朋友|同事|关系)/],
  [MemoryRecallIntent.GOAL_CONTEXT, RecallReasonCode.GOAL_SIGNAL, /(?:长期目标|正在追求的目标|我的目标)/],
  [MemoryRecallIntent.HABIT_OR_ROUTINE, RecallReasonCode.ROUTINE_SIGNAL, /(?:作息|习惯|通常几点|平时几点)/],
  [MemoryRecallIntent.LIFE_EVENT_CONTEXT, RecallReasonCode.LIFE_EVENT_SIGNAL, /(?:重要事件|什么时候毕业|什么时候结婚|人生事件|经历过)/],
  [MemoryRecallIntent.COMMITMENT_OR_CONSTRAINT, RecallReasonCode.COMMITMENT_SIGNAL, /(?:答应过|承诺|限制|禁忌|不能吃|饮食限制)/],
  [MemoryRecallIntent.RECENT_CONTEXT, RecallReasonCode.RECENT_SIGNAL, /(?:最近|刚才|当前阶段).*(?:关注|要求|重点|上下文)/],
  [MemoryRecallIntent.PERSONAL_PREFERENCE, RecallReasonCode.PREFERENCE_SIGNAL, /(?:我的偏好|按我的偏好|我平时喜欢|我不喜欢|喜欢(?:吃|喝)?什么|不喜欢什么)/],
  [MemoryRecallIntent.PERSONAL_FACT, RecallReasonCode.FACT_SIGNAL, /(?:我的名字|基本信息|我现在住|我住在哪|关于我|你记得我)/],
  [MemoryRecallIntent.AMBIGUOUS, RecallReasonCode.AMBIGUOUS_SIGNAL, /(?:那件事|以前那个|你还记得吗|那个是什么)/]
]);

export const INTENT_MEMORY_TYPES = Object.freeze({
  [MemoryRecallIntent.NO_MEMORY_NEEDED]: Object.freeze([]),
  [MemoryRecallIntent.PERSONAL_PREFERENCE]: Object.freeze([MemoryType.PREFERENCE]),
  [MemoryRecallIntent.PERSONAL_FACT]: Object.freeze([MemoryType.FACT]),
  [MemoryRecallIntent.RELATIONSHIP_CONTEXT]: Object.freeze([MemoryType.RELATIONSHIP]),
  [MemoryRecallIntent.GOAL_CONTEXT]: Object.freeze([MemoryType.GOAL]),
  [MemoryRecallIntent.HABIT_OR_ROUTINE]: Object.freeze([MemoryType.HABIT_ROUTINE]),
  [MemoryRecallIntent.PRIOR_DECISION]: Object.freeze([MemoryType.DECISION]),
  [MemoryRecallIntent.LIFE_EVENT_CONTEXT]: Object.freeze([MemoryType.LIFE_EVENT]),
  [MemoryRecallIntent.COMMITMENT_OR_CONSTRAINT]: Object.freeze([MemoryType.COMMITMENT, MemoryType.CONSTRAINT]),
  [MemoryRecallIntent.RECENT_CONTEXT]: Object.freeze([MemoryType.CONTEXT, MemoryType.GOAL, MemoryType.COMMITMENT]),
  [MemoryRecallIntent.HISTORICAL_CONTEXT]: Object.freeze([MemoryType.FACT, MemoryType.RELATIONSHIP, MemoryType.PREFERENCE, MemoryType.GOAL, MemoryType.LIFE_EVENT]),
  [MemoryRecallIntent.SENSITIVE_CONTEXT]: Object.freeze([MemoryType.FACT, MemoryType.RELATIONSHIP, MemoryType.CONSTRAINT, MemoryType.SENSITIVE_MEMORY]),
  [MemoryRecallIntent.AMBIGUOUS]: Object.freeze([])
});

function normalize(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function noMemoryNeeded(text) {
  return !text || /^(?:你好|您好|谢谢)/.test(text) || /(?:今天几号|天气|量子计算|帮我计算|\d+\s*[加减乘除+\-*/]\s*\d+)/.test(text);
}

export class MemoryRecallIntentAnalyzer {
  constructor({ assistant = null } = {}) {
    this.assistant = assistant;
  }

  async analyze(_context, request = {}) {
    const text = normalize(request.text);
    if (noMemoryNeeded(text)) return deepFreezeRecall({ intent: MemoryRecallIntent.NO_MEMORY_NEEDED, reasonCode: RecallReasonCode.NO_PERSONAL_MEMORY_NEEDED, needsClarification: false, clarificationQuestion: null });
    const entityQuery = parseRelationshipEntityQuery({
      authenticatedUserId: _context?.authenticatedUserId,
      text,
      conversationEntity: request.conversationEntity
    });
    if (entityQuery?.status === 'ambiguous') {
      return deepFreezeRecall({
        intent: MemoryRecallIntent.AMBIGUOUS,
        reasonCode: RecallReasonCode.AMBIGUOUS_SIGNAL,
        needsClarification: true,
        clarificationQuestion: entityQuery.clarificationQuestion,
        entityQuery
      });
    }
    if (entityQuery?.status === 'exact') {
      return deepFreezeRecall({
        intent: MemoryRecallIntent.RELATIONSHIP_CONTEXT,
        reasonCode: RecallReasonCode.RELATIONSHIP_SIGNAL,
        needsClarification: false,
        clarificationQuestion: null,
        entityQuery
      });
    }
    for (const [intent, reasonCode, pattern] of RULES) {
      if (pattern.test(text)) {
        if (intent === MemoryRecallIntent.AMBIGUOUS && this.assistant?.suggestIntent) {
          try {
            const suggestion = await this.assistant.suggestIntent({ text });
            if (Object.values(MemoryRecallIntent).includes(suggestion?.intent) && ![
              MemoryRecallIntent.AMBIGUOUS,
              MemoryRecallIntent.NO_MEMORY_NEEDED
            ].includes(suggestion.intent)) {
              return deepFreezeRecall({ intent: suggestion.intent, reasonCode: RecallReasonCode.ASSISTANT_SUGGESTION, needsClarification: false, clarificationQuestion: null });
            }
          } catch { /* deterministic rule fallback */ }
        }
        return deepFreezeRecall({
          intent,
          reasonCode,
          needsClarification: intent === MemoryRecallIntent.AMBIGUOUS,
          clarificationQuestion: intent === MemoryRecallIntent.AMBIGUOUS ? '你想回忆的是哪件事？' : null
        });
      }
    }
    return deepFreezeRecall({ intent: MemoryRecallIntent.NO_MEMORY_NEEDED, reasonCode: RecallReasonCode.NO_PERSONAL_MEMORY_NEEDED, needsClarification: false, clarificationQuestion: null });
  }
}
