function ambiguityCodes(plan) {
  return (plan.ambiguity_reasons || []).map((item) =>
    typeof item === 'string' ? item : `${item.field || 'plan'}:${item.code || 'ambiguous'}`);
}

function memoryIntent(plan) {
  const value = `${plan.intent}:${plan.action}`;
  if (plan.domain === 'ambiguous' || value.includes('ambiguous')) return 'ambiguous';
  if (value.includes('query')) return 'memory_query';
  if (value.includes('delete')) return 'memory_delete';
  if (value.includes('negate')) return 'memory_negation';
  if (value.includes('correct') || value.includes('enrich') || value.includes('update') || value.includes('supersede')) {
    return 'memory_correction';
  }
  if (value.includes('ordinary')) return 'ordinary_chat';
  return 'memory_candidate';
}

function integer(value, fallback = null) {
  return Number.isInteger(value) ? value : fallback;
}

function materializeCanonicalValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.type === 'date') {
    return { year: value.year, month: value.month, day: value.day };
  }
  if (value.type === 'date_without_year') {
    return { year: null, month: value.month, day: value.day };
  }
  if (value.type === 'scalar') return value.value;
  if (value.type === 'list') return (value.items || []).map(materializeCanonicalValue);
  if (value.type === 'object') return structuredClone(value.fields || {});
  if (value.type === 'entity_reference') {
    return {
      type: value.entity_type ?? null,
      reference: value.reference ?? null,
      relation_to_owner: value.relation_to_owner ?? null
    };
  }
  if (value.type === 'tool_arguments') return structuredClone(value.arguments || {});
  return undefined;
}

function domainAction(action, domain) {
  const prefix = `${domain}.`;
  return typeof action === 'string' && action.startsWith(prefix)
    ? action.slice(prefix.length)
    : action;
}

export function adaptUnifiedPlanToMemory(plan, { message = '' } = {}) {
  if (!plan || !['memory', 'ambiguous', 'ordinary_chat'].includes(plan.domain)) {
    return { ok: false, code: 'MEMORY_ADAPTER_DOMAIN_INVALID' };
  }
  const materialized = materializeCanonicalValue(plan.canonical_value);
  const rawValue = materialized === undefined ? plan.value : materialized;
  const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
  const qualifiers = plan.qualifiers || {};
  const predicate = plan.predicate === 'birth_date' ? 'birthday' : plan.predicate;
  const intent = memoryIntent(plan);
  const month = integer(value.month, integer(qualifiers.month));
  const day = integer(value.day, integer(qualifiers.day));
  const year = integer(value.year, integer(qualifiers.year));
  const calendarType = ['gregorian', 'lunar', 'unknown'].includes(qualifiers.calendar_type)
    ? qualifiers.calendar_type
    : 'unknown';
  const inherited = new Set(plan.inherited_fields || []);
  const source = String(message || '');
  const hasCanonicalValue = rawValue !== undefined && rawValue !== null;
  return {
    ok: true,
    plan: {
      intent,
      subject: {
        entity_type: plan.entity?.type || 'person',
        relation_to_owner: plan.relation_to_owner || plan.entity?.relation_to_owner || 'unknown',
        normalized_reference: plan.entity?.reference || plan.relation_to_owner || '',
        resolved_entity_hint: null
      },
      predicate,
      value: predicate === 'birthday'
        ? (hasCanonicalValue ? { year, month, day } : null)
        : rawValue,
      qualifiers: {
        calendar_type: calendarType,
        year,
        month,
        day,
        lunar_leap_month: [true, false, 'unknown'].includes(qualifiers.lunar_leap_month)
          ? qualifiers.lunar_leap_month
          : 'unknown',
        temporal_scope: qualifiers.temporal_scope || 'stable',
        recurrence: qualifiers.recurrence ||
          (plan.predicate === 'birth_date' ? 'one_time' : predicate === 'birthday' ? 'yearly' : 'unknown'),
        degree: qualifiers.degree || 'normal',
        cardinality: qualifiers.cardinality || (predicate?.startsWith('likes_') ? 'multiple' : 'single'),
        negation: intent === 'memory_negation' || qualifiers.negation === true,
        uncertainty: qualifiers.uncertainty === true
      },
      confidence: Number.isFinite(plan.confidence) ? plan.confidence : 0,
      source_spans: source ? [{ text: source, start: 0, end: source.length }] : [],
      ambiguity_reasons: ambiguityCodes(plan),
      requires_confirmation: intent === 'ambiguous',
      inherited_context: {
        previous_entity: inherited.has('relation_to_owner') || inherited.has('entity.relation_to_owner')
          ? plan.relation_to_owner || plan.entity?.relation_to_owner || null
          : null,
        previous_predicate: inherited.has('predicate') ? predicate || null : null,
        previously_returned_values: []
      }
    }
  };
}

export function adaptUnifiedPlanToFinance(plan, { message = '' } = {}) {
  if (!plan || plan.domain !== 'finance') return { ok: false, code: 'FINANCE_ADAPTER_DOMAIN_INVALID' };
  const args = plan.canonical_arguments || plan.arguments || {};
  const materialized = materializeCanonicalValue(plan.canonical_value);
  const rawValue = materialized === undefined ? plan.value : materialized;
  const value = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
  const qualifiers = plan.qualifiers || {};
  const transaction = args.transaction_candidate || {
    direction: value.direction || null,
    amount_text: value.amount_text || null,
    occurred_expression: value.occurred_expression || null
  };
  const source = String(message || '');
  return {
    ok: true,
    plan: {
      domain: 'finance',
      action: domainAction(plan.action, 'finance'),
      metrics: Array.isArray(args.metrics) ? args.metrics : [],
      period_type: qualifiers.period_type ?? args.period_type ?? null,
      period_expression: qualifiers.period_expression ?? args.period_expression ?? null,
      category: qualifiers.category ?? args.category ?? null,
      counterparty: args.counterparty ?? null,
      keyword: args.keyword ?? null,
      transaction_candidate: transaction,
      entry_reference: args.entry_reference ?? null,
      changes: args.changes && typeof args.changes === 'object' && !Array.isArray(args.changes) ? args.changes : {},
      inherited_context: {
        previous_action: null,
        previous_metrics: [],
        previous_period_type: null
      },
      confidence: Number.isFinite(plan.confidence) ? plan.confidence : 0,
      source_spans: source ? [{ text: source, start: 0, end: source.length }] : [],
      requires_confirmation: false
    }
  };
}

export function adaptUnifiedPlanToTool(plan, { sourceMessageId = null } = {}) {
  if (!plan || plan.domain !== 'tool') return { ok: false, code: 'TOOL_ADAPTER_DOMAIN_INVALID' };
  const taskAction = plan.tool === 'tasks.create' || String(plan.action).startsWith('tasks.');
  const action = domainAction(plan.action, taskAction ? 'tasks' : 'calendar');
  return {
    ok: true,
    plan: {
      domain: 'tool',
      action: taskAction
        ? 'create_task'
        : action === 'convert' ? 'convert_calendar_date' : action,
      tool: plan.tool,
      arguments: structuredClone(plan.canonical_arguments || plan.arguments || {}),
      required_evidence: structuredClone(plan.required_evidence || []),
      inherited_context: {
        previous_entity: plan.relation_to_owner || plan.entity?.relation_to_owner || null,
        previous_predicate: plan.predicate || null,
        previous_tool: null
      },
      confidence: Number.isFinite(plan.confidence) ? plan.confidence : 0,
      ambiguity: ambiguityCodes(plan),
      requires_confirmation: false,
      source_message_id: sourceMessageId || plan.source_message_id || null
    }
  };
}
