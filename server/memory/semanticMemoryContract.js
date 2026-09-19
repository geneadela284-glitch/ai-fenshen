import { SensitivePolicy } from '../../memory/capture/policies.js';
import { canonicalizeMemoryValue } from './canonicalMemoryValueAdapter.js';

const UNKNOWN_YEAR_SENTINEL = 2000;
const sensitivePolicy = new SensitivePolicy();

function pad(value) {
  return String(value).padStart(2, '0');
}

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function predicateFor(value) {
  if (value === 'birthday') return 'birthday';
  if (typeof value === 'string' && value.startsWith('favorite_')) {
    return 'favorite_preference_statement';
  }
  if (typeof value === 'string' && value.startsWith('likes_')) return 'preference_statement';
  return value;
}

function semanticSensitivity(plan, sourceText, predicate) {
  const evaluated = sensitivePolicy.evaluate(sourceText);
  if (evaluated.prohibited || evaluated.sensitivity !== 'high') return evaluated;
  const nonRelationshipCategories = evaluated.categories.filter((item) => item !== 'family_relationship');
  const lowRiskFamilyFact = ['birthday', 'preference_statement', 'favorite_preference_statement'].includes(predicate) &&
    ['mother', 'father', 'daughter', 'son', 'spouse'].includes(plan.subject?.relation_to_owner);
  return lowRiskFamilyFact && nonRelationshipCategories.length === 0
    ? Object.freeze({ sensitivity: 'low', prohibited: false, categories: Object.freeze([]) })
    : evaluated;
}

function birthdayValue(plan, existingRecords) {
  const current = existingRecords[0]?.structuredValue || {};
  const year = plan.qualifiers.year ?? plan.value?.year ?? current.year ?? null;
  const month = plan.qualifiers.month ?? plan.value?.month ?? current.month ?? Number(String(current.date || '').slice(5, 7));
  const day = plan.qualifiers.day ?? plan.value?.day ?? current.day ?? Number(String(current.date || '').slice(8, 10));
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  const calendarType = plan.qualifiers.calendar_type === 'unknown'
    ? (current.calendarType || 'unknown')
    : plan.qualifiers.calendar_type;
  return Object.freeze({
    date: `${year || UNKNOWN_YEAR_SENTINEL}-${pad(month)}-${pad(day)}`,
    calendarType,
    year,
    month,
    day,
    lunarLeapMonth: plan.qualifiers.lunar_leap_month === 'unknown'
      ? (current.lunarLeapMonth ?? 'unknown')
      : plan.qualifiers.lunar_leap_month,
    recurrence: plan.qualifiers.recurrence === 'unknown'
      ? (current.recurrence || 'yearly')
      : plan.qualifiers.recurrence
  });
}

function preferenceValue(plan, predicate, existingRecords) {
  const incoming = uniqueStrings(plan.value);
  if (!incoming.length) return null;
  if (predicate === 'favorite_preference_statement') return Object.freeze({ value: incoming[0] });
  const adapted = canonicalizeMemoryValue({ predicate, structuredValue: existingRecords[0]?.structuredValue });
  const current = adapted.ok && adapted.value.kind === 'string_set'
    ? adapted.value.items
    : uniqueStrings(existingRecords[0]?.structuredValue?.values || existingRecords[0]?.structuredValue?.value);
  const values = [...new Set([...current, ...incoming])];
  return Object.freeze({ value: values.join('、'), values: Object.freeze(values) });
}

function canonicalValue(predicate, structuredValue) {
  const adapted = canonicalizeMemoryValue({ predicate, structuredValue });
  return adapted.ok ? adapted.value : null;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function birthdayDate(value) {
  return value?.kind === 'calendar_date' ? value.date : null;
}

function sameBirthdayDate(left, right) {
  const a = birthdayDate(left);
  const b = birthdayDate(right);
  return a && b && a.year === b.year && a.month === b.month && a.day === b.day;
}

export function evaluateSemanticMemoryContract({ plan, existingRecords = [], sourceText = '' } = {}) {
  if (!plan || typeof plan !== 'object') return Object.freeze({ decision: 'REJECT', reasonCodes: Object.freeze(['plan_missing']) });
  if (plan.intent === 'ambiguous' || plan.requires_confirmation) {
    return Object.freeze({ decision: 'ASK', question: '请补充一个最必要的明确信息。', reasonCodes: Object.freeze(['semantic_ambiguity']) });
  }
  if (plan.intent === 'ordinary_chat') return Object.freeze({ decision: 'REJECT', reasonCodes: Object.freeze(['ordinary_chat']) });
  const predicate = predicateFor(plan.predicate);
  if (!predicate) return Object.freeze({ decision: 'ASK', question: '你想让我记住哪一项信息？', reasonCodes: Object.freeze(['predicate_missing']) });
  if (['memory_candidate', 'memory_correction'].includes(plan.intent)) {
    const sensitivity = semanticSensitivity(plan, sourceText, predicate);
    if (sensitivity.prohibited) {
      return Object.freeze({
        decision: 'REJECT', sensitivity: sensitivity.sensitivity,
        reasonCodes: Object.freeze(['prohibited_secret'])
      });
    }
    if (sensitivity.sensitivity === 'high') {
      return Object.freeze({
        decision: 'ASK', sensitivity: sensitivity.sensitivity,
        question: '这条信息比较敏感，请确认是否需要长期保存。',
        reasonCodes: Object.freeze(['sensitive_information'])
      });
    }
  }
  if (plan.intent === 'memory_query') return Object.freeze({ decision: 'ACCEPT', operation: 'query', predicate, reasonCodes: Object.freeze(['query']) });
  if (plan.intent === 'memory_delete') return Object.freeze({ decision: 'DELETE', operation: 'delete', predicate, reasonCodes: Object.freeze(['explicit_delete']) });
  if (plan.intent === 'memory_negation') {
    return Object.freeze({
      decision: existingRecords.length ? 'UPDATE' : 'REJECT', operation: 'negate', predicate,
      removeValues: Object.freeze(uniqueStrings(plan.value)), reasonCodes: Object.freeze(['explicit_negation'])
    });
  }
  if (['memory_candidate', 'memory_correction'].includes(plan.intent) &&
      existingRecords.length === 0 &&
      (plan.value === null || plan.value === undefined) &&
      (!Number.isInteger(plan.qualifiers?.month) || !Number.isInteger(plan.qualifiers?.day))) {
    return Object.freeze({
      decision: 'ASK',
      predicate,
      question: '请补充这条信息的具体内容。',
      reasonCodes: Object.freeze(['value_incomplete'])
    });
  }
  const structuredValue = predicate === 'birthday'
    ? birthdayValue(plan, existingRecords)
    : preferenceValue(plan, predicate, existingRecords);
  if (!structuredValue) return Object.freeze({ decision: 'ASK', question: '请补充这条信息的具体内容。', reasonCodes: Object.freeze(['value_incomplete']) });
  let decision = 'ACCEPT';
  let operation = 'capture';
  const currentValue = existingRecords.length
    ? canonicalValue(predicate, existingRecords[0]?.structuredValue)
    : null;
  const nextValue = canonicalValue(predicate, structuredValue);
  if (existingRecords.length && currentValue && nextValue && sameValue(currentValue, nextValue)) {
    decision = 'NO_OP';
    operation = 'duplicate';
  } else if (predicate === 'birthday' && existingRecords.length &&
      currentValue && nextValue && sameBirthdayDate(currentValue, nextValue)) {
    decision = 'UPDATE';
    operation = 'enrich';
  } else if (plan.intent === 'memory_correction') {
    decision = existingRecords.length ? 'SUPERSEDE' : 'ACCEPT';
    operation = decision === 'SUPERSEDE' ? 'correct' : 'capture';
  } else if (predicate === 'preference_statement' && existingRecords.length) {
    decision = 'MERGE';
    operation = 'merge';
  } else if (existingRecords.length) {
    decision = 'ASK';
    operation = 'ask';
  }
  return Object.freeze({
    decision,
    operation,
    predicate,
    structuredValue,
    sensitivity: 'low',
    reasonCodes: Object.freeze([`semantic_${plan.intent}`])
  });
}
