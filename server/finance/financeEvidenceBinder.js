import { resolveDateRange } from '../../core/trust/dateRangeResolver.js';
import { parseAmountMinor } from './service.js';

function validHint(span, message) {
  return Boolean(span) && typeof span === 'object' && !Array.isArray(span)
    && typeof span.text === 'string'
    && Number.isInteger(span.start) && Number.isInteger(span.end)
    && span.start >= 0 && span.end > span.start
    && message.slice(span.start, span.end) === span.text;
}

function amountValues(message) {
  const values = [];
  for (const match of String(message || '').matchAll(/\d+(?:\.\d{1,2})?\s*(?:元|块)?/g)) {
    const before = match.index > 0 ? message[match.index - 1] : '';
    const after = message[match.index + match[0].length] || '';
    if (/[\d年月日.]/.test(before) || /[\d年月日.]/.test(after)) continue;
    const amount = parseAmountMinor(match[0].trim(), { allowUnitless: true });
    if (amount) values.push(amount);
  }
  return values;
}

export function bindFinancePlanEvidence(plan, { message = '', timezone = 'Asia/Shanghai', now = new Date() } = {}) {
  const text = String(message || '').trim();
  const hints = Array.isArray(plan?.source_spans) ? plan.source_spans : [];
  const auditReasons = hints.length === 0
    ? ['source_spans_missing']
    : hints.every((span) => validHint(span, text)) ? [] : ['source_span_mismatch'];
  const bound = structuredClone(plan);
  bound.source_spans = [{ text, start: 0, end: text.length }];

  if (bound.action === 'create') {
    const candidate = bound.transaction_candidate || {};
    if (candidate.amount_text !== null && candidate.amount_text !== undefined) {
      const amount = parseAmountMinor(candidate.amount_text, { allowUnitless: true });
      if (!amount || !amountValues(text).includes(amount)) {
        return { ok: false, reasonCode: 'amount_source_mismatch', auditReasons };
      }
    }
    const date = resolveDateRange(text, { timezone, now });
    if (Object.keys(candidate).length > 0) {
      bound.transaction_candidate = {
        ...candidate,
        occurred_expression: date.dateStatus === 'ABSENT' ? null : text
      };
    }
  }

  return { ok: true, plan: bound, auditReasons };
}
