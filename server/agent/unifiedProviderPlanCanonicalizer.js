import {
  canonicalizeAssistantValue,
  rawValueAudit
} from './canonicalValue.js';
import { createAssistantContextStateStore } from './assistantContextState.js';
import { canonicalizeEntityRelation } from './entityRelationCanonicalizer.js';
import { validateCanonicalAssistantPlan } from './canonicalAssistantPlanSchema.js';
import { classifyFinanceType } from '../finance/service.js';
import { planFinanceMessage } from '../finance/queryPlan.js';
import { isAllowedCategory } from '../finance/constants.js';
import { localDateKey, shiftLocalDays } from '../finance/time.js';
import { resolveDateRange } from '../../core/trust/dateRangeResolver.js';

const ACTIONS = Object.freeze({
  memory: Object.freeze({
    add: 'memory.capture',
    capture: 'memory.capture',
    merge: 'memory.capture',
    query: 'memory.query',
    enrich: 'memory.enrich',
    update: 'memory.enrich',
    correct: 'memory.supersede',
    supersede: 'memory.supersede',
    negate: 'memory.negate',
    delete: 'memory.delete'
  }),
  finance: Object.freeze({
    create: 'finance.create',
    query: 'finance.query',
    update: 'finance.update',
    delete: 'finance.delete'
  }),
  tool: Object.freeze({
    convert_calendar_date: 'calendar.convert',
    next_occurrence: 'calendar.next_occurrence',
    days_until: 'calendar.days_until',
    create_task: 'tasks.create',
    'tasks.create': 'tasks.create'
  }),
  ordinary_chat: Object.freeze({ ordinary_chat: 'ordinary_chat' }),
  ambiguous: Object.freeze({ ambiguous: 'ambiguous' })
});

const MEMORY_OPERATIONS = Object.freeze({
  create_fact: 'memory.capture',
  query_fact: 'memory.query',
  update_fact: 'memory.update',
  negate_fact: 'memory.negate',
  delete_fact: 'memory.delete'
});

const FINANCE_METRICS = new Set(['income', 'expense', 'net', 'entries']);
const FINANCE_PERIODS = new Set([
  'today', 'yesterday', 'day_before_yesterday', 'this_week', 'last_week',
  'this_month', 'last_month', 'last_7_days', 'last_30_days',
  'explicit_day', 'explicit_range', 'all_time'
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function projectsToOrdinaryChat(plan) {
  if (plan.domain === 'ordinary_chat') return true;
  if (plan.domain !== 'ambiguous') return false;
  return plan.intent !== 'ambiguous' &&
    plan.action !== 'ambiguous' &&
    plan.tool === null &&
    plan.requires_confirmation !== true &&
    Array.isArray(plan.ambiguity_reasons) &&
    plan.ambiguity_reasons.length === 0 &&
    Array.isArray(plan.required_evidence) &&
    plan.required_evidence.length === 0;
}

function projectDomainContract(plan) {
  if (plan.domain === 'finance') {
    return {
      ...plan,
      entity: {
        ...plan.entity,
        relation_to_owner: null
      },
      relation_to_owner: null
    };
  }
  if (plan.domain === 'tool') {
    return {
      ...plan,
      value: null
    };
  }
  if (plan.domain === 'memory') {
    const valueBound = [...(plan.explicit_fields || []), ...(plan.inherited_fields || [])]
      .some((field) => field === 'value' || field.startsWith('value.'));
    const qualifierUpdateSentinel = plainObject(plan.value) &&
      Object.keys(plan.value).length === 0;
    if (!valueBound && !qualifierUpdateSentinel) {
      return {
        ...plan,
        value: null
      };
    }
  }
  if (!projectsToOrdinaryChat(plan)) return plan;
  return {
    ...plan,
    domain: 'ordinary_chat',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    tool: null,
    arguments: {},
    required_evidence: []
  };
}

function canonicalConfidence(rawConfidence) {
  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) &&
      rawConfidence >= 0 && rawConfidence <= 1) {
    return {
      score: rawConfidence,
      band: rawConfidence >= 0.8 ? 'high' : rawConfidence >= 0.5 ? 'medium' : 'low'
    };
  }
  if (rawConfidence === 'high') return { score: 1, band: 'high' };
  if (rawConfidence === 'medium') return { score: 0.5, band: 'medium' };
  if (rawConfidence === 'low') return { score: 0.25, band: 'low' };
  if (rawConfidence === null || rawConfidence === undefined) {
    return { score: 0, band: 'unknown' };
  }
  return null;
}

function hasExplicit(plan, field) {
  const explicit = new Set(plan.explicit_fields || []);
  return explicit.has(field) || [...explicit].some((item) => item.startsWith(`${field}.`));
}

function scopedContext(context, ownerId, conversationId) {
  if (!context) return { ok: true, value: null };
  const owner = String(context.owner ?? context.owner_id ?? '').trim();
  const conversation = String(context.conversation ?? context.conversation_id ?? '').trim();
  if (owner !== String(ownerId || '').trim() || conversation !== String(conversationId || '').trim()) {
    return { ok: false, code: 'CANONICAL_CONTEXT_SCOPE_MISMATCH' };
  }
  return { ok: true, value: context };
}

function normalizedAction(domain, action, intent = null) {
  if (typeof action !== 'string' || !action.trim()) return null;
  if (domain === 'ordinary_chat') return ACTIONS.ordinary_chat.ordinary_chat;
  if (domain === 'finance') {
    return ACTIONS.finance[intent] || ACTIONS.finance[action] || null;
  }
  if (action.includes('.')) {
    const known = Object.values(ACTIONS).some((actions) => Object.values(actions).includes(action));
    return known ? action : null;
  }
  return ACTIONS[domain]?.[action] || null;
}

function canonicalScalarValue(canonicalValue) {
  if (canonicalValue?.type === 'scalar') return canonicalValue.value;
  if (canonicalValue?.type === 'object') return canonicalValue.fields;
  return null;
}

function financeSemanticTokens(plan, argumentsValue, canonicalValue) {
  const rawValue = canonicalScalarValue(canonicalValue);
  const candidates = [
    plan.intent,
    plan.action,
    plan.entity?.type,
    plan.predicate,
    argumentsValue.direction,
    argumentsValue.transaction_candidate?.direction,
    plainObject(rawValue) ? rawValue.direction : null
  ];
  return candidates.flatMap((value) =>
    typeof value === 'string' ? value.toLowerCase().split(/[^a-z]+/).filter(Boolean) : []);
}

function financeMetrics(plan, argumentsValue, canonicalValue) {
  const supplied = Array.isArray(argumentsValue.metrics)
    ? argumentsValue.metrics.filter((metric) => FINANCE_METRICS.has(metric))
    : [];
  if (supplied.length) return [...new Set(supplied)];
  return [...new Set(financeSemanticTokens(plan, argumentsValue, canonicalValue)
    .filter((token) => FINANCE_METRICS.has(token)))];
}

function financeAmountText(plan, argumentsValue, canonicalValue, message) {
  const rawValue = canonicalScalarValue(canonicalValue);
  const candidate = argumentsValue.transaction_candidate?.amount_text ??
    (plainObject(rawValue) ? rawValue.amount_text ?? rawValue.amount : rawValue) ??
    argumentsValue.amount ??
    plan.qualifiers?.amount ??
    null;
  if (!['string', 'number'].includes(typeof candidate)) return null;
  const amountText = String(candidate).trim();
  if (!amountText) return null;
  const numericEvidence = amountText.match(/\d+(?:\.\d+)?/)?.[0] || amountText;
  return String(message || '').includes(numericEvidence) ? amountText : null;
}

function canonicalFinanceCategory(value, direction) {
  if (value === null || value === undefined || value === '') return null;
  return isAllowedCategory(direction, value) ? value : null;
}

function canonicalFinanceOccurrence(plan, argumentsValue, message, { timezone, now } = {}) {
  const sourceRange = resolveDateRange(String(message || ''), { timezone, now });
  if (sourceRange.dateStatus === 'RESOLVED') return String(message || '').trim();

  const relativeDayOffset = argumentsValue.relative_day_offset ??
    plan.qualifiers?.relative_day_offset ??
    null;
  const currentTime = new Date(now);
  if (Number.isInteger(relativeDayOffset) &&
      Math.abs(relativeDayOffset) <= 36600 &&
      Number.isFinite(currentTime.getTime())) {
    const date = localDateKey(shiftLocalDays(currentTime, timezone, relativeDayOffset), timezone);
    const [year, month, day] = date.split('-').map(Number);
    return `${year}年${month}月${day}日`;
  }

  const structuralDate = argumentsValue.date ?? plan.qualifiers?.date ?? null;
  const canonicalDate = canonicalizeAssistantValue(structuralDate);
  if (canonicalDate.ok && canonicalDate.value?.type === 'date') {
    const { year, month, day } = canonicalDate.value;
    return `${year}年${month}月${day}日`;
  }

  const direct = argumentsValue.transaction_candidate?.occurred_expression ??
    argumentsValue.occurred_expression ??
    plan.qualifiers?.occurred_expression ??
    null;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return null;
}

function canonicalFinanceArguments(plan, canonicalValue, argumentsValue, action, message, context = {}) {
  const metrics = financeMetrics(plan, argumentsValue, canonicalValue);
  const operation = String(action || '').split('.').at(-1);
  if (operation === 'create') {
    const directions = metrics.filter((metric) => ['income', 'expense'].includes(metric));
    const direction = directions.length === 1
      ? directions[0]
      : classifyFinanceType(String(message || ''));
    const category = canonicalFinanceCategory(
      plan.qualifiers?.category ?? argumentsValue.category ?? null,
      direction
    );
    return {
      ...argumentsValue,
      category,
      metrics: direction ? [direction] : [],
      transaction_candidate: {
        direction,
        amount_text: financeAmountText(plan, argumentsValue, canonicalValue, message),
        occurred_expression: canonicalFinanceOccurrence(plan, argumentsValue, message, context)
      }
    };
  }
  if (operation === 'query') {
    const deterministic = planFinanceMessage(String(message || ''));
    const fallbackQuery = deterministic?.action === 'query' ? deterministic : null;
    const resolvedMetrics = metrics.length ? metrics : [...(fallbackQuery?.metrics || [])];
    const periodCandidates = [
      argumentsValue.period_type,
      argumentsValue.period,
      plan.qualifiers?.period_type,
      plan.qualifiers?.period,
      plan.entity?.reference
    ];
    const periodType = periodCandidates.find((value) => FINANCE_PERIODS.has(value)) ||
      (FINANCE_PERIODS.has(fallbackQuery?.period_type) ? fallbackQuery.period_type : null);
    return {
      ...argumentsValue,
      metrics: resolvedMetrics,
      period_type: periodType,
      period_expression: argumentsValue.period_expression ??
        plan.qualifiers?.period_expression ??
        fallbackQuery?.period_expression ??
        null,
      transaction_candidate: plainObject(argumentsValue.transaction_candidate)
        ? argumentsValue.transaction_candidate
        : {}
    };
  }
  return argumentsValue;
}

function canonicalTaskTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return value;
  const hour = Number(match[1]);
  if (hour > 23) return value;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function canonicalTaskOffset(value) {
  if (Number.isInteger(value)) return value;
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) return value ?? null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function canonicalTasksArguments(plan, argumentsValue, { timezone, now } = {}) {
  const relativeDayOffset = canonicalTaskOffset(
    argumentsValue.relative_day_offset ?? plan.qualifiers?.relative_day_offset
  );
  let date = argumentsValue.date ?? plan.qualifiers?.date ?? null;
  const currentTime = new Date(now);
  if (Number.isInteger(relativeDayOffset) && date &&
      Number.isFinite(currentTime.getTime())) {
    const expectedDate = localDateKey(
      shiftLocalDays(currentTime, timezone, relativeDayOffset),
      timezone
    );
    if (date === expectedDate) date = null;
  }
  return {
    title: argumentsValue.title,
    ...(Object.hasOwn(argumentsValue, 'description')
      ? { description: argumentsValue.description }
      : {}),
    ...(date === null || date === undefined ? {} : { date }),
    ...(relativeDayOffset === null || relativeDayOffset === undefined
      ? {}
      : { relative_day_offset: relativeDayOffset }),
    ...((argumentsValue.local_time ?? plan.qualifiers?.local_time) === undefined
      ? {}
      : { local_time: canonicalTaskTime(argumentsValue.local_time ?? plan.qualifiers?.local_time) })
  };
}

function targetMatches(target, relation, predicate) {
  if (!plainObject(target)) return false;
  if (target.entity_relation && relation && target.entity_relation !== relation) return false;
  if (target.predicate && predicate && target.predicate !== predicate) return false;
  return Boolean(target.entity_relation || target.predicate);
}

function hasExplicitQualifier(plan) {
  return (plan.explicit_fields || []).some((field) => field === 'qualifiers' || field.startsWith('qualifiers.'));
}

function resolveMemoryOperation(plan, {
  canonicalValue,
  canonicalArguments,
  relation,
  predicate
} = {}) {
  if (!relation || !predicate) return { ok: false, code: 'CANONICAL_INTENT_INCOMPLETE' };
  const queryTarget = plainObject(canonicalArguments.query_target)
    ? canonicalArguments.query_target
    : null;
  const mutationTarget = plainObject(canonicalArguments.mutation_target)
    ? canonicalArguments.mutation_target
    : null;
  const hasValue = canonicalValue !== null;
  const explicitValue = hasExplicit(plan, 'value');

  if (queryTarget && (mutationTarget || hasValue)) {
    return { ok: false, code: 'CANONICAL_INTENT_CONFLICT' };
  }
  if (queryTarget && !targetMatches(queryTarget, relation, predicate)) {
    return { ok: false, code: 'CANONICAL_INTENT_CONFLICT' };
  }
  if (mutationTarget && !targetMatches(mutationTarget, relation, predicate)) {
    return { ok: false, code: 'CANONICAL_INTENT_CONFLICT' };
  }
  if (mutationTarget) {
    const operation = mutationTarget.operation;
    if (operation === 'correction' && (hasValue || hasExplicitQualifier(plan))) {
      return { ok: true, intent: 'update_fact', action: MEMORY_OPERATIONS.update_fact };
    }
    if (operation === 'negation' && plan.qualifiers?.negation === true && hasValue) {
      return { ok: true, intent: 'negate_fact', action: MEMORY_OPERATIONS.negate_fact };
    }
    if (operation === 'delete' && !hasValue) {
      return { ok: true, intent: 'delete_fact', action: MEMORY_OPERATIONS.delete_fact };
    }
    return { ok: false, code: 'CANONICAL_INTENT_CONFLICT' };
  }
  if (plan.qualifiers?.negation === true) {
    return hasValue
      ? { ok: true, intent: 'negate_fact', action: MEMORY_OPERATIONS.negate_fact }
      : { ok: false, code: 'CANONICAL_INTENT_INCOMPLETE' };
  }
  if (queryTarget || (!hasValue && !explicitValue)) {
    return { ok: true, intent: 'query_fact', action: MEMORY_OPERATIONS.query_fact };
  }
  if (!hasValue) return { ok: false, code: 'CANONICAL_INTENT_INCOMPLETE' };
  const inheritedTarget = (plan.inherited_fields || []).some((field) =>
    ['entity', 'entity.relation_to_owner', 'relation_to_owner', 'predicate'].includes(field));
  if (hasExplicitQualifier(plan) && inheritedTarget) {
    return { ok: true, intent: 'update_fact', action: MEMORY_OPERATIONS.update_fact };
  }
  return { ok: true, intent: 'create_fact', action: MEMORY_OPERATIONS.create_fact };
}

function resolveCanonicalOperation(plan, details) {
  if (plan.domain === 'memory') return resolveMemoryOperation(plan, details);
  const action = normalizedAction(plan.domain, plan.action, plan.intent);
  return action
    ? {
        ok: true,
        intent: plan.domain === 'ordinary_chat' ? 'ordinary_chat' : plan.intent,
        action
      }
    : { ok: false, code: 'CANONICAL_ACTION_INVALID' };
}

function domainForAction(domain, action) {
  if (action?.startsWith('calendar.')) return 'tool';
  if (action?.startsWith('tasks.')) return 'tool';
  if (action?.startsWith('memory.')) return 'memory';
  if (action?.startsWith('finance.')) return 'finance';
  return domain;
}

function qualifierConflict(canonicalValue, qualifiers) {
  if (!canonicalValue || !['date', 'date_without_year'].includes(canonicalValue.type)) return false;
  return ['year', 'month', 'day'].some((field) =>
    canonicalValue[field] !== undefined && qualifiers?.[field] !== undefined &&
    qualifiers[field] !== null && canonicalValue[field] !== qualifiers[field]);
}

function canonicalEntity(plan, context, message) {
  const current = structuredClone(plan.entity || {
    type: null, reference: null, relation_to_owner: null
  });
  const relationRequired = plan.domain === 'memory' ||
    (plan.domain === 'tool' && plan.tool !== 'tasks.create' && plan.action !== 'tasks.create');
  if (!relationRequired) {
    return {
      ok: true,
      entity: current,
      relation: plan.relation_to_owner ?? current.relation_to_owner ?? null,
      canonicalRelation: null,
      audit: { raw_relation: plan.relation_to_owner ?? current.relation_to_owner ?? null }
    };
  }
  const inheritedRelation = (plan.inherited_fields || []).some((field) =>
    field === 'entity' || field === 'entity.relation_to_owner' || field === 'relation_to_owner');
  const explicit = !inheritedRelation && (
    hasExplicit(plan, 'entity') || hasExplicit(plan, 'relation_to_owner') ||
    plan.relation_to_owner !== null || current.relation_to_owner !== null
  );
  const canonicalized = canonicalizeEntityRelation({
    entity: current,
    relationToOwner: plan.relation_to_owner ?? null,
    trustedEntity: context?.active_entity || null,
    explicit,
    message
  });
  if (!canonicalized.ok) return canonicalized;
  const inherited = canonicalized.relation.explicitness === 'inherited';
  const selected = inherited && context?.active_entity
    ? structuredClone(context.active_entity)
    : current;
  return {
    ok: true,
    entity: {
      ...selected,
      relation_to_owner: canonicalized.legacyRelation
    },
    relation: canonicalized.legacyRelation,
    canonicalRelation: canonicalized.relation,
    audit: canonicalized.audit
  };
}

function mergeCanonicalArguments(plan, context, action) {
  const domainChanged = hasExplicit(plan, 'domain') &&
    context?.active_domain && domainForAction(plan.domain, action) !== context.active_domain;
  const inherited = domainChanged ? {} : structuredClone(context?.active_arguments || {});
  return { ...inherited, ...structuredClone(plainObject(plan.arguments) ? plan.arguments : {}) };
}

function evidenceFor(plan, context, relation, predicate, action) {
  if (action?.startsWith('tasks.')) return [];
  if (action?.startsWith('calendar.') && relation && predicate) {
    return [{
      entity_relation: relation,
      predicate,
      required_qualifiers: ['calendar_type', 'month', 'day']
    }];
  }
  if (Array.isArray(plan.required_evidence) && plan.required_evidence.length) {
    return structuredClone(plan.required_evidence);
  }
  if (action?.startsWith('calendar.') && Array.isArray(context?.required_evidence) &&
      context.required_evidence.length) {
    return structuredClone(context.required_evidence);
  }
  return [];
}

export function canonicalizeUnifiedProviderPlan(plan, {
  ownerId,
  conversationId,
  trustedContext = null,
  message = '',
  timezone = 'Asia/Shanghai',
  now = new Date()
} = {}) {
  if (!plainObject(plan)) return { ok: false, code: 'CANONICAL_PLAN_REQUIRED' };
  const rawPlan = plan;
  plan = projectDomainContract(plan);
  const confidence = canonicalConfidence(plan.confidence);
  if (!confidence) return { ok: false, code: 'CANONICAL_CONFIDENCE_INVALID' };
  const scoped = scopedContext(trustedContext, ownerId, conversationId);
  if (!scoped.ok) return scoped;
  const context = scoped.value;
  const entity = canonicalEntity(plan, context, message);
  if (!entity.ok) return entity;
  const predicate = plan.predicate ?? context?.active_predicate ?? null;
  const rawAudit = rawValueAudit(rawPlan.value);
  let canonicalValue = null;
  if (plan.value !== null && plan.value !== undefined) {
    const canonicalized = canonicalizeAssistantValue(plan.value);
    if (!canonicalized.ok) return { ok: false, code: canonicalized.code };
    canonicalValue = canonicalized.value;
    if (qualifierConflict(canonicalValue, plan.qualifiers)) {
      return { ok: false, code: 'CANONICAL_VALUE_CONFLICT' };
    }
  }
  const preliminaryAction = plan.domain === 'memory'
    ? MEMORY_OPERATIONS.create_fact
    : normalizedAction(plan.domain, plan.action, plan.intent);
  if (!preliminaryAction) return { ok: false, code: 'CANONICAL_ACTION_INVALID' };
  const preliminaryDomain = domainForAction(plan.domain, preliminaryAction);
  const mergedArguments = mergeCanonicalArguments(plan, context, preliminaryAction);
  const normalizedArguments = plan.domain === 'finance'
    ? canonicalFinanceArguments(plan, canonicalValue, mergedArguments, preliminaryAction, message, {
        timezone,
        now
      })
    : preliminaryAction === 'tasks.create'
      ? canonicalTasksArguments(plan, mergedArguments, { timezone, now })
      : mergedArguments;
  const normalizedQualifiers = plan.domain === 'finance' && preliminaryAction === 'finance.create'
    ? {
        ...plan.qualifiers,
        category: normalizedArguments.category ?? null
      }
    : plan.qualifiers;
  const canonicalArgumentsValue = canonicalizeAssistantValue(
    normalizedArguments,
    { expectedType: 'tool_arguments', tool: plan.tool || context?.active_tool || `${preliminaryDomain}.contract` }
  );
  if (!canonicalArgumentsValue.ok) return canonicalArgumentsValue;
  const canonicalArguments = canonicalArgumentsValue.value.arguments;
  const resolvedOperation = resolveCanonicalOperation(plan, {
    canonicalValue,
    canonicalArguments,
    relation: entity.relation,
    predicate
  });
  if (!resolvedOperation.ok) return resolvedOperation;
  const action = resolvedOperation.action;
  const domain = domainForAction(plan.domain, action);
  const tool = domain === 'tool' ? (plan.tool ?? context?.active_tool ?? null) : null;
  if (domain === 'tool' && !tool) return { ok: false, code: 'CANONICAL_TOOL_REQUIRED' };
  const requiredEvidence = evidenceFor(plan, context, entity.relation, predicate, action);

  const canonicalPlan = {
    domain,
    intent: resolvedOperation.intent,
    action,
    entity: entity.entity,
    relation_to_owner: entity.relation,
    canonical_relation: entity.canonicalRelation,
    predicate,
    canonical_value: canonicalValue,
    qualifiers: structuredClone(normalizedQualifiers || {}),
    tool,
    canonical_arguments: canonicalArguments,
    explicit_fields: [...(plan.explicit_fields || [])],
    inherited_fields: [
      ...(plan.inherited_fields || []),
      ...(entity.relation !== null && plan.relation_to_owner === null ? ['relation_to_owner'] : []),
      ...(predicate !== null && plan.predicate === null ? ['predicate'] : []),
      ...(tool !== null && plan.tool === null ? ['tool'] : [])
    ].filter((item, index, all) => all.indexOf(item) === index),
    required_evidence: requiredEvidence,
    confidence: confidence.score,
    ambiguity_reasons: structuredClone(plan.ambiguity_reasons || []),
    source_message_id: plan.source_message_id ?? null,
    provider_advisory: {
      requires_confirmation: plan.requires_confirmation === true,
      confidence: confidence.score,
      confidence_band: confidence.band,
      source_spans: structuredClone(plan.source_spans || [])
    }
  };
  const validated = validateCanonicalAssistantPlan(canonicalPlan);
  if (!validated.valid) {
    return {
      ok: false,
      code: 'CANONICAL_PLAN_SCHEMA_INVALID',
      errors: validated.errors
    };
  }
  return {
    ok: true,
    plan: validated.value,
    audit: Object.freeze({
      ...rawAudit,
      raw_intent: rawPlan.intent,
      raw_action: rawPlan.action,
      raw_confidence_type: rawPlan.confidence === null
        ? 'null'
        : typeof rawPlan.confidence,
      raw_confidence: typeof rawPlan.confidence === 'string' ||
        typeof rawPlan.confidence === 'number'
        ? rawPlan.confidence
        : null,
      canonical_confidence_band: confidence.band,
      raw_relation: entity.audit.raw_relation,
      canonical_intent: resolvedOperation.intent,
      canonical_action: action,
      canonical_value_type: canonicalValue?.type ?? null
    })
  };
}

export {
  canonicalizeAssistantValue,
  createAssistantContextStateStore
};
