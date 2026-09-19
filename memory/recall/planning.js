import { MemorySensitivity } from '../kernel/index.js';
import { MemoryRecallIntent, deepFreezeRecall, normalizeMemoryContextBudget, validateMemoryRecallPlan } from './contracts.js';
import { INTENT_MEMORY_TYPES } from './intent.js';

export const DEFAULT_RANKING_WEIGHTS = Object.freeze({
  relevance: 0.3,
  recency: 0.1,
  effectiveTimeMatch: 0.1,
  confidence: 0.15,
  importance: 0.15,
  sourceTrust: 0.1,
  confirmationStrength: 0.1,
  sensitivityPenalty: 0.2,
  redundancyPenalty: 0.2,
  conflictPenalty: 0.3
});

const SENSITIVITY_RANK = Object.freeze({ public: 0, low: 1, medium: 2, high: 3 });

function boundedBudget(contextBudget, requestedBudget = {}) {
  const trusted = normalizeMemoryContextBudget(contextBudget);
  const requested = normalizeMemoryContextBudget({ ...trusted, ...requestedBudget });
  return Object.freeze(Object.fromEntries(Object.keys(trusted).map((key) => [key, Math.min(trusted[key], requested[key])])));
}

function sensitivityMax(context) {
  const requested = context.sensitivityAllowance;
  if (requested === MemorySensitivity.HIGH && !(
    context.purpose === 'sensitive_assistance' && context.metadata?.sensitiveAccessApproved === true
  )) return MemorySensitivity.MEDIUM;
  return SENSITIVITY_RANK[requested] === undefined ? MemorySensitivity.LOW : requested;
}

function predicateHints(request = {}) {
  const text = String(request.text ?? '');
  const hints = [];
  if (/(?:住|城市|地址|位置)/.test(text)) hints.push('city', 'address', 'resid', 'location', 'live');
  if (/(?:喝|咖啡|茶|偏好|喜欢|不喜欢)/.test(text)) hints.push('prefer', 'dislike', 'drink');
  if (/(?:名字|姓名)/.test(text)) hints.push('name');
  if (/(?:目标)/.test(text)) hints.push('goal');
  if (/(?:家人|关系|女儿|儿子|父亲|母亲|爸爸|妈妈|妈|爸|妻子|老婆|丈夫|老公|朋友|同事)/.test(text)) hints.push('relation', 'family');
  if (/(?:生日|诞辰)/.test(text)) hints.push('birthday');
  if (/(?:健康|病历|过敏)/.test(text)) hints.push('health', 'allergy');
  return [...new Set(hints)];
}

export class MemoryRecallPlanner {
  build(context, request, intentResult, options = {}) {
    const intent = intentResult.intent;
    const noMemory = intent === MemoryRecallIntent.NO_MEMORY_NEEDED || intent === MemoryRecallIntent.AMBIGUOUS;
    const entityQuery = intentResult.entityQuery?.status === 'exact' ? intentResult.entityQuery : null;
    const plan = {
      userId: context.authenticatedUserId,
      intent,
      memoryTypes: [...(INTENT_MEMORY_TYPES[intent] || [])],
      subjects: entityQuery ? [entityQuery.subjectCanonical] : [],
      predicates: entityQuery ? [entityQuery.predicate] : predicateHints(request),
      timeRange: null,
      effectiveAt: context.timestamp,
      includeHistorical: intent === MemoryRecallIntent.HISTORICAL_CONTEXT,
      includeCandidates: false,
      sensitivityMax: sensitivityMax(context),
      limit: noMemory ? 0 : Math.min(Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : 24, 50),
      sort: 'updatedAt:desc',
      budget: boundedBudget(context.contextBudget, options.budget),
      rankingWeights: { ...DEFAULT_RANKING_WEIGHTS },
      conflictPolicy: 'safe_unresolved',
      reasonCodes: [intentResult.reasonCode]
    };
    const validation = validateMemoryRecallPlan(plan, { trustedUserId: context.authenticatedUserId });
    if (!validation.valid) {
      const error = new Error('Memory recall plan is invalid.');
      error.code = validation.errors[0].code;
      throw error;
    }
    return deepFreezeRecall(plan);
  }
}
