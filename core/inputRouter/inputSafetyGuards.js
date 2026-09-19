import { inputIntentTypes } from './inputIntentTypes.js';

export const explanationQueryPattern = /(解释一下|说明一下|怎么得出|怎么得来的|怎么来的|怎么算|如何计算|为什么是|合计为什么是|这笔钱从哪里来|从哪里来|依据是什么|明细是什么|哪几条|来源是什么|来源是哪几条|依据是哪几条|组成明细|计算明细)/;
export const aiResultTextPattern = /^(?:[-•\s]*)?(?:支出|收入|合计|结余)[:：]\s*\d+(?:\.\d+)?\s*(?:元|块|万|万元)?(?:[，,\s。；;]*(?:来源|长期记忆|明细).*)?$/;
export const correctionRequestPattern = /(更正|修正|改成|改为|不是|不对|错了|删除这条|忘记这条|撤销).*(?:记忆|记录|金额|支出|收入|这条)?/;
export const explicitSaveResultPattern = /(?:请|帮我)?把这条(?:作为|当作)?新的?真实记录保存|明确保存为(?:支出|收入|事实|记忆)/;

export function isQuestionLikeInput(input = '') {
  return /[?？]$|吗[?？。]*$|多少|怎么样|如何|为什么|是否|能不能|可以吗|怎么看|你觉得|怎么|哪几条|来源|依据|明细/.test(String(input || ''));
}

export function isExplanationQuery(input = '') {
  return explanationQueryPattern.test(String(input || ''));
}

export function isProvenanceQuery(input = '') {
  return /(来源是什么|来源是哪几条|哪几条|依据是什么|依据是哪几条|明细是什么|明细|出处|从哪里来)/.test(String(input || ''));
}

export function isCalculationQuery(input = '') {
  return /(怎么得出|怎么得来的|怎么来的|怎么算|如何计算|为什么是|合计为什么是|这笔钱从哪里来|计算明细|组成明细)/.test(String(input || ''));
}

export function isCorrectionRequest(input = '') {
  return correctionRequestPattern.test(String(input || ''));
}

export function isAiResultText(input = '') {
  const text = String(input || '').trim();
  if (explicitSaveResultPattern.test(text)) return false;
  return aiResultTextPattern.test(text) || (/来源[:：]?\s*长期记忆\s*\d+\s*条/.test(text) && /(?:支出|收入|合计|结余)[:：]/.test(text));
}

export function isQueryLikeInput(input = '') {
  const text = String(input || '');
  return isQuestionLikeInput(text) || isExplanationQuery(text) || isProvenanceQuery(text) || isCalculationQuery(text);
}

export function queryIntentForInput(input = '') {
  const text = String(input || '');
  if (isAiResultText(text)) return inputIntentTypes.PROVENANCE_QUERY;
  if (isProvenanceQuery(text)) return inputIntentTypes.PROVENANCE_QUERY;
  if (isCalculationQuery(text)) return inputIntentTypes.CALCULATION_QUERY;
  if (isExplanationQuery(text)) return inputIntentTypes.EXPLANATION_QUERY;
  return inputIntentTypes.MEMORY_QUERY;
}

export function isEligibleBusinessFact(input = '', intentResult = {}, candidate = null, context = {}) {
  const text = String(input || '').trim();
  const intent = typeof intentResult === 'string' ? intentResult : intentResult.intent;
  const explicitSave = explicitSaveResultPattern.test(text) || /记住|记一下|记录一下|保存一下|帮我保存/.test(text);

  if (!text) return false;
  if (context.historyLoad || context.isHistoryLoad || context.sourceType === 'history') return false;
  if (context.isAiOutput || context.role === 'assistant' || context.sourceType === 'ai') return false;
  if (context.sourceAlreadyProcessed || context.submissionAlreadyProcessed) return false;
  if (isQueryLikeInput(text) || isCorrectionRequest(text)) return false;
  if (isAiResultText(text) && !explicitSave) return false;
  if (!candidate) return false;
  if (candidate.sensitivity === 'high' && candidate.needsConfirmation) return false;
  if (candidate.needsConfirmation || ['pending_confirmation', 'needs_confirmation'].includes(candidate.status)) return false;

  if (['expense', 'income'].includes(intent)) {
    return candidate.memoryType === intent
      && candidate.category === intent
      && candidate.direction === intent
      && Number.isFinite(Number(candidate.amount));
  }
  if (intent === 'quote') return candidate.memoryType === 'quote' && Number.isFinite(Number(candidate.amount));
  if (['schedule', 'todo', 'reminder'].includes(intent)) return candidate.memoryType === intent;
  return explicitSave;
}

export function isEligibleTransactionFact(input = '', intentResult = {}, candidate = null, context = {}) {
  const intent = typeof intentResult === 'string' ? intentResult : intentResult.intent;
  const amountMinor = Number.isSafeInteger(candidate?.metadata?.amountMinor)
    ? candidate.metadata.amountMinor
    : Math.round(Number(candidate?.amount) * 100);
  if (!['expense', 'income'].includes(intent)) return false;
  if (!isEligibleBusinessFact(input, intentResult, candidate, context)) return false;
  return candidate.direction === intent
    && candidate.memoryType === intent
    && candidate.category === intent
    && candidate.amount !== null
    && Number.isSafeInteger(amountMinor)
    && amountMinor > 0;
}
