import { categoriesForType } from './constants.js';
import { resolveDateRange } from '../../core/trust/dateRangeResolver.js';

const ACTIONS = new Set(['query', 'create', 'update', 'delete', 'classify', 'ambiguous']);
const METRICS = new Set(['expense', 'income', 'net', 'entries']);
const PERIODS = new Set([
  'today', 'yesterday', 'day_before_yesterday', 'this_week', 'last_week',
  'this_month', 'last_month', 'this_year', 'last_year', 'last_7_days',
  'last_30_days', 'explicit_day', 'explicit_range', 'all_time'
]);
const PLAN_FIELDS = new Set([
  'domain', 'action', 'metrics', 'period_type', 'period_expression', 'label', 'start_at', 'end_at',
  'timezone', 'category', 'merchant_or_counterparty', 'keyword', 'group_by', 'limit', 'confidence',
  'source_spans', 'inherited_context', 'requires_confirmation', 'transaction_candidate',
  'entry_reference', 'changes'
]);
const QUERY_LANGUAGE = /(?:多少(?:钱)?|多少钱|几笔|哪些|明细|情况|怎么样|结余|合计|一共|分别|呢)/;
const FINANCE_LANGUAGE = /(?:花|支出|消费|用了|收入|收了|收到|赚|结余|收支|账|房租|餐饮|交通|购物|居家|娱乐|医疗|教育|人情|宠物|旅行)/;
const CONCRETE_AMOUNT = /\d+(?:\.\d{1,2})?\s*(?:元|块)/;
const UNIT_LESS_AMOUNT = /(?:收入|支出|花了?|收到)\s*\d+(?:\.\d{1,2})?\s*[。！!，,；;]?$/;

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function periodName(rangeType) {
  if (rangeType === 'explicit_date') return 'explicit_day';
  if (rangeType === 'explicit_date_range') return 'explicit_range';
  return rangeType;
}

function uniqueMetrics(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).filter(Boolean))];
}

function metricsFor(text, previousPlan) {
  if (/(?:几笔|哪些|明细)/.test(text)) return ['entries'];
  const metrics = [];
  if (/收支/.test(text)) metrics.push('income', 'expense');
  else {
    if (/(?:收入|收了|收到|赚)/.test(text)) metrics.push('income');
    if (/(?:花|支出|消费|用了|房租)/.test(text)) metrics.push('expense');
  }
  if (/结余/.test(text)) metrics.push('net');
  return uniqueMetrics(metrics.length ? metrics : previousPlan?.metrics || []);
}

function categoryFor(text, metrics) {
  const type = metrics.length === 1 && metrics[0] === 'income' ? 'income' : 'expense';
  const exact = categoriesForType(type).find((category) => text.includes(category));
  if (exact) return exact;
  if (type === 'expense') {
    if (/早餐|午餐|晚餐|吃饭|外卖|咖啡|奶茶/.test(text)) return '餐饮';
    if (/打车|公交|地铁|停车|加油|高铁|机票/.test(text)) return '交通';
    if (/房租|水电|物业|家居|日用品/.test(text)) return '居家';
  }
  if (type === 'income' && /客户(?:款|回款)/.test(text)) return '客户回款';
  return null;
}

function sourceSpans(text) {
  const spans = [];
  const patterns = [FINANCE_LANGUAGE, QUERY_LANGUAGE, /(?:今天|昨天|前天|本周|上周|本月|这个月|上月|上个月|今年|去年|最近\s*\d+\s*天|\d{1,2}月\d{1,2}日)/];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && !spans.includes(match[0])) spans.push(match[0]);
  }
  return spans;
}

function basePlan({ action, metrics = [], periodType = null, periodExpression = null, timezone, range = null,
  text, previousPlan = null, requiresConfirmation = false, confidence = 1 }) {
  const normalizedMetrics = uniqueMetrics(metrics);
  return {
    domain: 'finance',
    action,
    metrics: normalizedMetrics,
    period_type: periodType,
    period_expression: periodExpression,
    label: range?.label || null,
    start_at: range?.startAt || null,
    end_at: range?.endAt || null,
    timezone,
    category: normalizedMetrics.length ? categoryFor(text, normalizedMetrics) : null,
    merchant_or_counterparty: null,
    keyword: null,
    group_by: normalizedMetrics.length > 1 ? 'type' : null,
    limit: normalizedMetrics.includes('entries') ? 100 : null,
    confidence,
    source_spans: sourceSpans(text),
    inherited_context: previousPlan ? {
      previous_action: previousPlan.action,
      previous_metrics: [...(previousPlan.metrics || [])],
      previous_period_type: previousPlan.period_type,
      previous_start_at: previousPlan.start_at,
      previous_end_at: previousPlan.end_at
    } : {},
    requires_confirmation: requiresConfirmation,
    transaction_candidate: { direction: null, amount_text: null, occurred_expression: null },
    entry_reference: null,
    changes: {}
  };
}

export function validateFinanceQueryPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['plan_object_required'] };
  if (Object.keys(plan).some((field) => field !== 'owner_id' && !PLAN_FIELDS.has(field))) errors.push('unknown_fields');
  if (!ACTIONS.has(plan.action)) errors.push('action_invalid');
  if (plan.action === 'query') {
    if (!Array.isArray(plan.metrics) || plan.metrics.length === 0 ||
        plan.metrics.some((metric) => !METRICS.has(metric)) || new Set(plan.metrics).size !== plan.metrics.length) {
      errors.push('metrics_invalid');
    }
    if (!PERIODS.has(plan.period_type)) errors.push('period_invalid');
    if (!validTimezone(plan.timezone)) errors.push('timezone_invalid');
    if (!plan.start_at || !plan.end_at) errors.push('range_required');
    const start = Date.parse(plan.start_at);
    const end = Date.parse(plan.end_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) errors.push('range_invalid');
    if (!Array.isArray(plan.source_spans) || plan.source_spans.length === 0) errors.push('source_spans_required');
    if (plan.category && ![...categoriesForType('expense'), ...categoriesForType('income')].includes(plan.category)) errors.push('category_invalid');
    if (!Number.isFinite(plan.confidence) || plan.confidence < 0 || plan.confidence > 1) errors.push('confidence_invalid');
    if (plan.owner_id !== undefined) errors.push('owner_forbidden');
  }
  return { ok: errors.length === 0, errors };
}

export function buildFinanceQueryPlan({ metrics, metric, periodExpression, timezone = 'Asia/Shanghai', now = new Date(), previousPlan = null, text = periodExpression } = {}) {
  const normalizedMetrics = uniqueMetrics(metrics || metric);
  const range = resolveDateRange(periodExpression, { timezone, now });
  if (range.requiresConfirmation) {
    return basePlan({ action: 'ambiguous', metrics: normalizedMetrics, timezone, text, previousPlan, requiresConfirmation: true, confidence: 0.6 });
  }
  const plan = basePlan({
    action: 'query', metrics: normalizedMetrics, periodType: periodName(range.rangeType), periodExpression,
    timezone, range, text, previousPlan
  });
  const validation = validateFinanceQueryPlan(plan);
  return validation.ok ? plan : { ...plan, action: 'ambiguous', requires_confirmation: true, confidence: 0 };
}

// Deterministic compatibility fallback. Production natural-language routing is owned by AssistantAgentOrchestrator.
export function planFinanceMessage(message, { timezone = 'Asia/Shanghai', now = new Date(), previousPlan = null } = {}) {
  const text = String(message || '').trim();
  if (!text) return null;
  if (/最近(?:十|10)笔账/.test(text)) {
    const plan = basePlan({
      action: 'query', metrics: ['entries'], periodType: 'all_time', periodExpression: null, timezone, text,
      range: { label: '最近账目', startAt: '0001-01-01T00:00:00.000Z', endAt: '9999-12-31T23:59:59.999Z' }
    });
    plan.limit = 10;
    return plan;
  }
  if (/\d{1,2}月\d{1,2}日.*账目/.test(text)) {
    const range = resolveDateRange(text, { timezone, now });
    if (!range.requiresConfirmation) {
      return basePlan({
        action: 'query', metrics: ['entries'], periodType: periodName(range.rangeType), periodExpression: text,
        timezone, text, range
      });
    }
  }
  if (/(?:删除|撤销)/.test(text)) return basePlan({ action: 'delete', timezone, text });
  if (/(?:改成|修改|不是|改为)/.test(text)) return basePlan({ action: 'update', timezone, text });
  if (/(?:刚才|那笔|上一笔).*(?:是|属于).*(?:工资|经营|客户回款|退款|转入|其他收入)/.test(text)) {
    return basePlan({ action: 'classify', timezone, text });
  }

  const hasConcreteAmount = CONCRETE_AMOUNT.test(text) || UNIT_LESS_AMOUNT.test(text);
  const hasQueryLanguage = QUERY_LANGUAGE.test(text);
  const hasFinanceLanguage = FINANCE_LANGUAGE.test(text);
  const followUp = Boolean(previousPlan) && !hasConcreteAmount && (hasFinanceLanguage || hasQueryLanguage);

  if (hasConcreteAmount && !hasQueryLanguage) return basePlan({ action: 'create', timezone, text });
  if (!(hasQueryLanguage && hasFinanceLanguage) && !followUp) return null;

  const metrics = metricsFor(text, previousPlan);
  if (!metrics.length) return basePlan({ action: 'ambiguous', timezone, text, requiresConfirmation: true, confidence: 0.5 });

  let range = resolveDateRange(text, { timezone, now });
  let periodType = periodName(range.rangeType);
  if (range.requiresConfirmation && previousPlan?.start_at && previousPlan?.end_at) {
    range = { startAt: previousPlan.start_at, endAt: previousPlan.end_at, label: previousPlan.label };
    periodType = previousPlan.period_type;
  }
  if (range.requiresConfirmation) {
    return basePlan({ action: 'ambiguous', metrics, timezone, text, previousPlan, requiresConfirmation: true, confidence: 0.7 });
  }

  const plan = basePlan({ action: 'query', metrics, periodType, periodExpression: text, timezone, range, text, previousPlan });
  const validation = validateFinanceQueryPlan(plan);
  return validation.ok ? plan : { ...plan, action: 'ambiguous', requires_confirmation: true, confidence: 0 };
}
