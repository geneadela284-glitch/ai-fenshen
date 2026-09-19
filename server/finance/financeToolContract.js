import { resolveDateRange } from '../../core/trust/dateRangeResolver.js';
import { categoriesForType } from './constants.js';
import { validateFinanceQueryPlan } from './queryPlan.js';
import {
  classifyFinanceType,
  extractAmountMinorEvidence,
  resolveOccurredAt
} from './service.js';

const DOMAINS = new Set(['finance', 'memory', 'ordinary_chat', 'ambiguous']);
const ACTIONS = new Set(['query', 'create', 'update', 'delete', 'ambiguous', 'ordinary_chat']);
const METRICS = new Set(['income', 'expense', 'net', 'entries']);
const PERIODS = new Set([
  'today', 'yesterday', 'day_before_yesterday', 'this_week', 'last_week',
  'this_month', 'last_month', 'last_7_days', 'last_30_days', 'explicit_day', 'explicit_range', 'all_time'
]);
const FIELDS = [
  'domain', 'action', 'metrics', 'period_type', 'period_expression', 'category', 'counterparty',
  'keyword', 'transaction_candidate', 'entry_reference', 'changes', 'inherited_context',
  'confidence', 'source_spans', 'requires_confirmation'
];
const TRANSACTION_FIELDS = ['direction', 'amount_text', 'occurred_expression'];
const CONTEXT_FIELDS = ['previous_action', 'previous_metrics', 'previous_period_type'];
const SPAN_FIELDS = ['text', 'start', 'end'];
const PERIOD_EXPRESSIONS = Object.freeze({
  today: '今天', yesterday: '昨天', day_before_yesterday: '前天',
  this_week: '本周', last_week: '上周', this_month: '本月', last_month: '上月',
  last_7_days: '最近7天', last_30_days: '最近30天'
});
const RANGE_TYPES = Object.freeze({ explicit_day: 'explicit_date', explicit_range: 'explicit_date_range' });
const PERIOD_TYPES_BY_RANGE = Object.freeze({
  explicit_date: 'explicit_day',
  explicit_date_range: 'explicit_range'
});

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, fields, path, errors) {
  if (!object(value)) {
    errors.push(`${path}:invalid_type`);
    return false;
  }
  for (const field of fields) if (!Object.hasOwn(value, field)) errors.push(`${path}.${field}:required`);
  for (const field of Object.keys(value)) if (!fields.includes(field)) errors.push(`${path}.${field}:unknown`);
  return true;
}

function forbiddenOwner(value) {
  if (Array.isArray(value)) return value.some(forbiddenOwner);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    ['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id'].includes(key) || forbiddenOwner(child));
}

function validateSpans(spans, message, errors, { hintsOnly = false } = {}) {
  if (hintsOnly) {
    if (!Array.isArray(spans)) errors.push('source_spans:invalid_type');
    return;
  }
  if (!Array.isArray(spans) || spans.length === 0) {
    errors.push('source_spans:required');
    return;
  }
  for (const [index, span] of spans.entries()) {
    if (!exactFields(span, SPAN_FIELDS, `source_spans.${index}`, errors)) continue;
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start ||
        String(message).slice(span.start, span.end) !== span.text) errors.push(`source_spans.${index}:source_mismatch`);
  }
}

export function validateSemanticFinancePlan(plan, { message = '', sourceSpansAsHints = false } = {}) {
  const errors = [];
  if (!exactFields(plan, FIELDS, 'plan', errors)) return { ok: false, errors };
  if (forbiddenOwner(plan)) errors.push('owner_forbidden');
  if (!DOMAINS.has(plan.domain)) errors.push('domain_invalid');
  if (!ACTIONS.has(plan.action)) errors.push('action_invalid');
  if (!Array.isArray(plan.metrics) || plan.metrics.some((metric) => !METRICS.has(metric)) ||
      new Set(plan.metrics).size !== plan.metrics.length) errors.push('metrics_invalid');
  if (plan.domain === 'finance' && plan.action === 'query' && plan.metrics.length === 0) errors.push('metrics_required');
  if (plan.period_type !== null && !PERIODS.has(plan.period_type)) errors.push('period_invalid');
  if (plan.period_expression !== null && typeof plan.period_expression !== 'string') errors.push('period_expression_invalid');
  if (plan.category !== null && ![...categoriesForType('income'), ...categoriesForType('expense')].includes(plan.category)) errors.push('category_invalid');
  if (![plan.counterparty, plan.keyword, plan.entry_reference].every((value) => value === null || typeof value === 'string')) errors.push('text_field_invalid');
  const emptyTransactionCandidate = object(plan.transaction_candidate) && Object.keys(plan.transaction_candidate).length === 0;
  if (!emptyTransactionCandidate && exactFields(plan.transaction_candidate, TRANSACTION_FIELDS, 'transaction_candidate', errors)) {
    if (![null, 'income', 'expense'].includes(plan.transaction_candidate.direction)) errors.push('transaction_candidate.direction:invalid');
    for (const field of ['amount_text', 'occurred_expression']) {
      if (plan.transaction_candidate[field] !== null && typeof plan.transaction_candidate[field] !== 'string') errors.push(`transaction_candidate.${field}:invalid`);
    }
  }
  if (!object(plan.changes)) errors.push('changes:invalid');
  if (exactFields(plan.inherited_context, CONTEXT_FIELDS, 'inherited_context', errors)) {
    if (plan.inherited_context.previous_action !== null && !ACTIONS.has(plan.inherited_context.previous_action)) errors.push('inherited_context.previous_action:invalid');
    if (!Array.isArray(plan.inherited_context.previous_metrics) || plan.inherited_context.previous_metrics.some((metric) => !METRICS.has(metric))) errors.push('inherited_context.previous_metrics:invalid');
    if (plan.inherited_context.previous_period_type !== null && !PERIODS.has(plan.inherited_context.previous_period_type)) errors.push('inherited_context.previous_period_type:invalid');
  }
  if (!Number.isFinite(plan.confidence) || plan.confidence < 0 || plan.confidence > 1) errors.push('confidence_invalid');
  if (plan.domain === 'finance' && plan.confidence < 0.78) errors.push('confidence_below_threshold');
  if (typeof plan.requires_confirmation !== 'boolean') errors.push('requires_confirmation_invalid');
  validateSpans(plan.source_spans, message, errors, { hintsOnly: sourceSpansAsHints });
  return { ok: errors.length === 0, errors };
}

export function evaluateFinanceToolPlan(plan, { message = '', timezone = 'Asia/Shanghai', now = new Date(), trustedContext = null, ownerId = null } = {}) {
  const validation = validateSemanticFinancePlan(plan, { message });
  if (!validation.ok || plan.domain !== 'finance') return { decision: 'REJECT', errors: validation.errors };
  if (plan.action === 'ambiguous') {
    return { decision: 'ASK', reasonCode: 'plan_ambiguous', question: '请补充一个最必要的财务信息。' };
  }
  if (['create', 'update', 'delete'].includes(plan.action) && !String(ownerId || '').trim()) {
    return { decision: 'REJECT', errors: ['authenticated_owner_required'] };
  }
  if (plan.action === 'create') {
    if (plan.changes?.ambiguity_reason) {
      if (plan.changes.ambiguity_reason === 'loan_direction_ambiguous') {
        const counterparty = plan.counterparty || '对方';
        return {
          decision: 'ASK',
          reasonCode: 'loan_direction_ambiguous',
          question: `请确认是${counterparty}借给你，还是你借给${counterparty}？`
        };
      }
      return { decision: 'ASK', reasonCode: 'create_amount_ambiguous', question: '你说的金额有歧义，请确认具体金额。' };
    }
    const candidate = plan.transaction_candidate;
    const completeCandidate = TRANSACTION_FIELDS.every((field) => Object.hasOwn(candidate, field));
    const messageDirection = completeCandidate ? classifyFinanceType(String(message || '')) : null;
    const direction = messageDirection || candidate.direction;
    const providerConflicts = [];
    if (candidate.direction && messageDirection && candidate.direction !== messageDirection) {
      providerConflicts.push({
        field: 'direction',
        providerValue: candidate.direction,
        userValue: messageDirection,
        resolution: 'user_message'
      });
    }
    if (!['income', 'expense'].includes(direction)) {
      return { decision: 'ASK', reasonCode: 'create_direction_required', question: '这是收入还是支出？' };
    }
    const candidateAmount = extractAmountMinorEvidence(candidate.amount_text, { allowUnitless: true });
    const amountMessage = plan.counterparty ? String(message || '').replace(plan.counterparty, '') : message;
    const messageAmount = completeCandidate
      ? extractAmountMinorEvidence(amountMessage, { allowUnitless: true, preferredAmountText: candidate.amount_text })
      : { status: 'absent', amountMinor: null, amountText: null };
    if (messageAmount.status === 'ambiguous') {
      return { decision: 'ASK', reasonCode: 'create_amount_ambiguous', question: '这笔账有多个金额，请确认要记录哪一个。' };
    }
    if (messageAmount.status === 'invalid') {
      return { decision: 'ASK', reasonCode: 'create_amount_invalid', question: '金额无效，请提供大于0的有效金额。' };
    }
    if (candidateAmount.status === 'resolved' && messageAmount.status === 'resolved' &&
        candidateAmount.amountMinor !== messageAmount.amountMinor) {
      providerConflicts.push({
        field: 'amount_text',
        providerValue: candidate.amount_text,
        userValue: messageAmount.amountText,
        resolution: 'user_message'
      });
    }
    const resolvedAmount = messageAmount.status === 'resolved' ? messageAmount : candidateAmount;
    const amountMinor = resolvedAmount.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      return { decision: 'ASK', reasonCode: 'create_amount_required', question: '金额是多少？' };
    }
    const conflictingMetrics = plan.metrics.filter((metric) => metric !== direction);
    if (conflictingMetrics.length) {
      if (!messageDirection) {
        return { decision: 'ASK', reasonCode: 'create_critical_field_conflict', question: '这笔账的关键信息存在冲突，请确认。' };
      }
      providerConflicts.push({
        field: 'metrics',
        providerValue: [...conflictingMetrics],
        userValue: [messageDirection],
        resolution: 'user_message'
      });
    }
    const changes = plan.changes || {};
    const conflictingChangeDirection = [changes.type, changes.direction]
      .find((value) => value !== undefined && value !== null && value !== direction);
    if (conflictingChangeDirection !== undefined) {
      if (!messageDirection) {
        return { decision: 'ASK', reasonCode: 'create_critical_field_conflict', question: '这笔账的关键信息存在冲突，请确认。' };
      }
      providerConflicts.push({
        field: 'changes.direction',
        providerValue: conflictingChangeDirection,
        userValue: messageDirection,
        resolution: 'user_message'
      });
    }
    if (changes.amount_text !== undefined && changes.amount_text !== null &&
        changes.amount_text !== candidate.amount_text) {
      if (messageAmount.status !== 'resolved') {
        return { decision: 'ASK', reasonCode: 'create_critical_field_conflict', question: '这笔账的关键信息存在冲突，请确认。' };
      }
      providerConflicts.push({
        field: 'changes.amount_text',
        providerValue: changes.amount_text,
        userValue: messageAmount.amountText,
        resolution: 'user_message'
      });
    }
    if (changes.occurred_expression !== undefined && changes.occurred_expression !== null &&
        changes.occurred_expression !== candidate.occurred_expression) {
      const messageRange = resolveDateRange(String(message || ''), { timezone, now });
      if (messageRange.dateStatus !== 'RESOLVED') {
        return { decision: 'ASK', reasonCode: 'create_critical_field_conflict', question: '这笔账的关键信息存在冲突，请确认。' };
      }
      providerConflicts.push({
        field: 'changes.occurred_expression',
        providerValue: changes.occurred_expression,
        userValue: String(message || '').trim(),
        resolution: 'user_message'
      });
    }
    const dateExpression = String(candidate.occurred_expression || '').trim();
    const range = resolveDateRange(dateExpression, { timezone, now });
    if (range.dateStatus !== 'ABSENT') {
      const start = Date.parse(`${range.startDate}T00:00:00.000Z`);
      const end = Date.parse(`${range.endDateExclusive}T00:00:00.000Z`);
      if (range.dateStatus !== 'RESOLVED' || range.requiresConfirmation || !Number.isFinite(start) ||
          !Number.isFinite(end) || end - start !== 86_400_000) {
        return { decision: 'ASK', reasonCode: 'create_date_ambiguous', question: '这笔账发生在哪一天？' };
      }
    }
    const accepted = {
      decision: 'ACCEPT',
      plan: {
        ...structuredClone(plan),
        metrics: [direction],
        transaction_candidate: {
          ...structuredClone(candidate),
          direction,
          amount_text: resolvedAmount.amountText
        },
        type: direction,
        amount_minor: amountMinor,
        currency: 'CNY',
        ...(plan.changes?.subtype ? { subtype: plan.changes.subtype } : {}),
        ...(plan.changes?.subtype ? { intent: plan.changes.subtype } : {}),
        ...(plan.changes?.cash_direction ? { cash_direction: plan.changes.cash_direction } : {}),
        occurred_at: range.dateStatus === 'RESOLVED'
          ? resolveOccurredAt(dateExpression, now, timezone)
          : new Date(now).toISOString(),
        timezone
      }
    };
    if (providerConflicts.length) {
      accepted.audit = Object.freeze({
        code: 'PROVIDER_FIELD_CONFLICT_OVERRIDDEN',
        source: 'user_message',
        conflicts: Object.freeze(providerConflicts.map((conflict) => Object.freeze(conflict)))
      });
    }
    return accepted;
  }
  if (plan.action !== 'query') return { decision: 'ACCEPT', plan: structuredClone(plan) };

  const metrics = plan.metrics.length ? [...plan.metrics] : [...(trustedContext?.previous_metrics || [])];
  const currentMessageRange = resolveDateRange(message, { timezone, now });
  if (currentMessageRange.dateStatus === 'INVALID') {
    return { decision: 'REJECT', errors: ['period_resolution_mismatch'] };
  }
  const explicitPeriodType = currentMessageRange.dateStatus === 'RESOLVED'
    ? PERIOD_TYPES_BY_RANGE[currentMessageRange.rangeType] || currentMessageRange.rangeType
    : null;
  const supportedExplicitPeriod = PERIODS.has(explicitPeriodType) ? explicitPeriodType : null;
  const periodType = supportedExplicitPeriod || plan.period_type || trustedContext?.previous_period_type || null;
  if (!metrics.length || !periodType) return { decision: 'ASK', question: '想查询哪个时间范围？' };
  const periodExpression = ['explicit_day', 'explicit_range'].includes(periodType)
    ? (supportedExplicitPeriod ? message : plan.period_expression)
    : PERIOD_EXPRESSIONS[periodType];
  if (periodType === 'all_time') {
    const resolved = {
      ...structuredClone(plan), metrics, period_type: periodType, period_expression: null,
      label: '最近账目', start_at: '0001-01-01T00:00:00.000Z', end_at: '9999-12-31T23:59:59.999Z',
      timezone, merchant_or_counterparty: plan.counterparty, group_by: null, limit: 10
    };
    delete resolved.counterparty;
    const queryValidation = validateFinanceQueryPlan(resolved);
    return queryValidation.ok ? { decision: 'ACCEPT', plan: resolved } : { decision: 'REJECT', errors: queryValidation.errors };
  }
  if (!periodExpression) return { decision: 'ASK', question: '想查询哪个时间范围？' };
  const range = supportedExplicitPeriod ? currentMessageRange : resolveDateRange(periodExpression, { timezone, now });
  const expectedRangeType = RANGE_TYPES[periodType] || periodType;
  if (range.requiresConfirmation || range.rangeType !== expectedRangeType) return { decision: 'REJECT', errors: ['period_resolution_mismatch'] };
  const resolved = {
    ...structuredClone(plan),
    metrics,
    period_type: periodType,
    period_expression: periodExpression,
    label: range.label,
    start_at: range.startAt,
    end_at: range.endAt,
    timezone,
    merchant_or_counterparty: plan.counterparty,
    group_by: metrics.length > 1 ? 'type' : null,
    limit: metrics.includes('entries') ? 100 : null
  };
  delete resolved.counterparty;
  const queryValidation = validateFinanceQueryPlan(resolved);
  return queryValidation.ok ? { decision: 'ACCEPT', plan: resolved } : { decision: 'REJECT', errors: queryValidation.errors };
}
