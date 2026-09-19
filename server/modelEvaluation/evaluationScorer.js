import { parseAmountMinor, resolveOccurredAt } from '../finance/service.js';
import { localDateKey } from '../finance/time.js';
import { validateProviderPlanCandidate } from '../agent/providerPlanCandidateSchema.js';
import { canonicalizeUnifiedProviderPlan } from '../agent/unifiedProviderPlanCanonicalizer.js';
import { createCalendarTool } from '../tools/calendar/calendarTool.js';
import {
  EVALUATION_PARAMETERS,
  EVALUATION_VERSION,
  FORMAL_INITIAL_CALLS
} from './evaluationContract.js';

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function parseEnvelope(content) {
  const raw = String(content || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { valid: false, code: 'strict_json_invalid' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'assistant_text,plan' ||
      !Object.hasOwn(value, 'plan') || !Object.hasOwn(value, 'assistant_text') ||
      !(value.assistant_text === null || typeof value.assistant_text === 'string')) {
    return { valid: false, code: 'evaluation_envelope_invalid' };
  }
  return { valid: true, value };
}

function scalar(canonicalValue) {
  if (!canonicalValue) return null;
  if (canonicalValue.type === 'scalar') return canonicalValue.value;
  if (canonicalValue.type === 'object') return canonicalValue.fields;
  if (canonicalValue.type === 'list') return canonicalValue.items;
  return canonicalValue;
}

function normalizedList(value) {
  const list = Array.isArray(value) ? value : value?.items || value?.values || [];
  return list.map((item) => scalar(item) ?? item).map(String);
}

function calendarEvidence(caseDefinition, ownerId) {
  const memory = caseDefinition.context?.confirmed_memory;
  if (!memory) return null;
  const qualifiers = memory.value || {};
  return {
    source: 'synthetic_evaluation_fixture',
    owner_id: ownerId,
    evidence: [{
      evidence_id: `evaluation-${caseDefinition.id}-birthday`,
      owner_id: ownerId,
      entity_id: `evaluation-${memory.relation_to_owner}`,
      predicate: memory.predicate,
      value: {
        kind: 'calendar_date',
        calendar_type: qualifiers.calendar_type,
        date: {
          year: qualifiers.year ?? null,
          month: qualifiers.month,
          day: qualifiers.day
        },
        lunar_leap_month: qualifiers.lunar_leap_month ?? 'unknown',
        recurrence: qualifiers.recurrence || 'yearly'
      },
      qualifiers: {
        calendar_type: qualifiers.calendar_type,
        year: qualifiers.year ?? null,
        month: qualifiers.month,
        day: qualifiers.day,
        lunar_leap_month: qualifiers.lunar_leap_month ?? 'unknown',
        recurrence: qualifiers.recurrence || 'yearly'
      },
      confidence: 1,
      source_message_id: `evaluation-${caseDefinition.id}`,
      version: 1,
      status: 'confirmed'
    }]
  };
}

async function deterministicCalendar(caseDefinition, canonicalPlan) {
  const ownerId = 'evaluation-owner';
  const evidenceBundle = calendarEvidence(caseDefinition, ownerId);
  if (!evidenceBundle) return { ok: false, code: 'calendar_fixture_missing' };
  const action = {
    'calendar.convert': 'convert_calendar_date',
    'calendar.next_occurrence': 'next_occurrence',
    'calendar.days_until': 'days_until'
  }[canonicalPlan.action];
  const tool = createCalendarTool();
  const result = await tool.run({
    plan: {
      domain: 'tool',
      action,
      tool: 'calendar.convert',
      arguments: canonicalPlan.canonical_arguments,
      required_evidence: canonicalPlan.required_evidence,
      inherited_context: {
        previous_entity: canonicalPlan.relation_to_owner,
        previous_predicate: canonicalPlan.predicate,
        previous_tool: caseDefinition.context?.previous_turn ? 'calendar.convert' : null
      },
      confidence: canonicalPlan.confidence,
      ambiguity: canonicalPlan.ambiguity_reasons,
      requires_confirmation: canonicalPlan.provider_advisory.requires_confirmation,
      source_message_id: `evaluation-${caseDefinition.id}`
    },
    evidenceBundle,
    ownerId,
    timezone: EVALUATION_PARAMETERS.timezone,
    now: new Date(EVALUATION_PARAMETERS.now)
  });
  if (result.decision !== 'ACCEPT') return { ok: false, code: result.code || 'calendar_rejected' };
  return {
    ok: true,
    value: {
      date: result.result.data.gregorian_date,
      ...(result.result.data.days_until === null
        ? {}
        : { remaining_days: result.result.data.days_until })
    }
  };
}

function expectedMatches(caseDefinition, canonicalPlan, assistantText) {
  const expected = caseDefinition.expected;
  const failures = [];
  const deterministic = {};
  if (canonicalPlan.domain !== expected.domain) failures.push('domain_mismatch');
  if (canonicalPlan.action !== expected.action) failures.push('action_mismatch');
  if (expected.relation_to_owner &&
      canonicalPlan.relation_to_owner !== expected.relation_to_owner) {
    failures.push('relation_mismatch');
  }
  if (expected.predicate && canonicalPlan.predicate !== expected.predicate) {
    failures.push('predicate_mismatch');
  }
  if (expected.ambiguity_required) {
    if (canonicalPlan.domain !== 'ambiguous' ||
        !canonicalPlan.ambiguity_reasons.length ||
        canonicalPlan.provider_advisory.requires_confirmation !== true) {
      failures.push('ambiguity_not_recognized');
    }
  }
  if (expected.no_clarification &&
      (canonicalPlan.domain === 'ambiguous' ||
       canonicalPlan.provider_advisory.requires_confirmation === true)) {
    failures.push('ordinary_chat_wrongly_clarified');
  }
  if (expected.domain === 'ordinary_chat' && !String(assistantText || '').trim()) {
    failures.push('ordinary_chat_text_missing');
  }
  return { failures, deterministic };
}

async function scoreSuccessfulRecord(record, caseDefinition, manualReviews) {
  const envelope = parseEnvelope(record.content);
  if (!envelope.valid) {
    return {
      json_parse_success: false,
      raw_schema_success: false,
      canonical_schema_success: false,
      success: false,
      failures: [envelope.code],
      deterministic: {},
      manual_review: null
    };
  }
  const manualKey = `${record.provider_id}:${record.case_id}`;
  const manualReview = caseDefinition.expected.manual_review
    ? {
        criteria: caseDefinition.expected.manual_review,
        status: manualReviews?.[manualKey]?.status || 'pending',
        notes: manualReviews?.[manualKey]?.notes || null
      }
    : null;
  const raw = validateProviderPlanCandidate(envelope.value.plan);
  if (!raw.valid) {
    return {
      json_parse_success: true,
      raw_schema_success: false,
      canonical_schema_success: false,
      success: false,
      failures: ['raw_plan_schema_invalid'],
      schema_errors: raw.errors,
      deterministic: {},
      assistant_text: envelope.value.assistant_text,
      manual_review: manualReview
    };
  }
  const canonical = canonicalizeUnifiedProviderPlan(raw.value, {
    ownerId: 'evaluation-owner',
    conversationId: `evaluation-${caseDefinition.id}`,
    trustedContext: null,
    message: caseDefinition.message,
    timezone: EVALUATION_PARAMETERS.timezone,
    now: new Date(EVALUATION_PARAMETERS.now)
  });
  if (!canonical.ok) {
    return {
      json_parse_success: true,
      raw_schema_success: true,
      canonical_schema_success: false,
      success: false,
      failures: [canonical.code || 'canonical_schema_invalid'],
      schema_errors: canonical.errors || [],
      deterministic: {},
      assistant_text: envelope.value.assistant_text,
      manual_review: manualReview
    };
  }

  const checked = expectedMatches(
    caseDefinition,
    canonical.plan,
    envelope.value.assistant_text
  );
  const expected = caseDefinition.expected;
  if (expected.amount_minor !== undefined) {
    const candidate = canonical.plan.canonical_arguments?.transaction_candidate || {};
    const amount = parseAmountMinor(String(candidate.amount_text ?? ''), { allowUnitless: true });
    const occurredAt = resolveOccurredAt(
      caseDefinition.message,
      new Date(EVALUATION_PARAMETERS.now),
      EVALUATION_PARAMETERS.timezone
    );
    checked.deterministic.finance = {
      direction: candidate.direction || null,
      amount_minor: amount,
      local_date: occurredAt
        ? localDateKey(new Date(occurredAt), EVALUATION_PARAMETERS.timezone)
        : null
    };
    if (candidate.direction !== expected.direction) checked.failures.push('finance_direction_mismatch');
    if (amount !== expected.amount_minor) checked.failures.push('finance_amount_mismatch');
    if (expected.local_date &&
        checked.deterministic.finance.local_date !== expected.local_date) {
      checked.failures.push('finance_date_mismatch');
    }
    if (Object.hasOwn(expected, 'category') &&
        (canonical.plan.canonical_arguments?.category ?? null) !== expected.category) {
      checked.failures.push('finance_category_mismatch');
    }
  }
  if (expected.calendar_type) {
    const value = scalar(canonical.plan.canonical_value);
    const qualifiers = canonical.plan.qualifiers || {};
    if ((qualifiers.calendar_type ?? value?.calendar_type) !== expected.calendar_type) {
      checked.failures.push('memory_calendar_mismatch');
    }
    if (Number(qualifiers.month ?? value?.month) !== expected.month ||
        Number(qualifiers.day ?? value?.day) !== expected.day) {
      checked.failures.push('memory_date_mismatch');
    }
  }
  if (expected.scalar_value !== undefined &&
      scalar(canonical.plan.canonical_value) !== expected.scalar_value) {
    checked.failures.push('memory_value_mismatch');
  }
  if (expected.unique_values) {
    const values = normalizedList(scalar(canonical.plan.canonical_value));
    if (new Set(values).size !== values.length ||
        JSON.stringify([...new Set(values)].sort()) !==
          JSON.stringify([...expected.unique_values].sort())) {
      checked.failures.push('memory_dedup_mismatch');
    }
  }
  if (expected.inherited_fields &&
      expected.inherited_fields.some((field) => !canonical.plan.inherited_fields.includes(field))) {
    checked.failures.push('continuation_inheritance_missing');
  }
  if (expected.no_inherited_context && canonical.plan.inherited_fields.length) {
    checked.failures.push('unexpected_inherited_context');
  }
  if (expected.deterministic_result) {
    const calendar = await deterministicCalendar(caseDefinition, canonical.plan);
    if (!calendar.ok) {
      checked.failures.push(calendar.code);
    } else {
      checked.deterministic.calendar = calendar.value;
      for (const [field, value] of Object.entries(expected.deterministic_result)) {
        if (calendar.value[field] !== value) checked.failures.push(`calendar_${field}_mismatch`);
      }
    }
  }
  return {
    json_parse_success: true,
    raw_schema_success: true,
    canonical_schema_success: true,
    success: checked.failures.length === 0,
    failures: checked.failures,
    deterministic: checked.deterministic,
    assistant_text: envelope.value.assistant_text,
    canonical_plan: canonical.plan,
    manual_review: manualReview
  };
}

function providerMetrics(providerRecords, caseScores, pricingByModel) {
  const finalScores = caseScores;
  const successfulLatencies = finalScores
    .filter(({ http_success: success }) => success)
    .map(({ latency_ms: latency }) => latency);
  const inputTokens = providerRecords.reduce((sum, item) => sum + Number(item.usage?.input_tokens || 0), 0);
  const outputTokens = providerRecords.reduce((sum, item) => sum + Number(item.usage?.output_tokens || 0), 0);
  const modelId = finalScores[0]?.model_id || providerRecords[0]?.model_id || null;
  const providerId = finalScores[0]?.provider_id || providerRecords[0]?.provider_id || null;
  const pricing = pricingByModel[`${providerId}:${modelId}`];
  const estimatedCost = pricing?.version &&
    Number.isFinite(pricing.input_per_million) &&
    Number.isFinite(pricing.output_per_million)
    ? {
        amount: (
          inputTokens * pricing.input_per_million +
          outputTokens * pricing.output_per_million
        ) / 1_000_000,
        currency: pricing.currency || 'CNY',
        version: pricing.version
      }
    : null;
  const categoryRate = (category) => {
    const entries = finalScores.filter((item) => item.category === category);
    return ratio(entries.filter(({ success }) => success).length, entries.length);
  };
  const ambiguity = finalScores.filter((item) => item.expected_ambiguity);
  const ordinary = finalScores.filter((item) => item.expected_ordinary_no_clarification);
  return {
    http_success_rate: ratio(
      providerRecords.filter(({ http_success: success }) => success).length,
      providerRecords.length
    ),
    average_latency_ms: successfulLatencies.length
      ? Math.round(successfulLatencies.reduce((sum, value) => sum + value, 0) / successfulLatencies.length)
      : null,
    p50_latency_ms: percentile(successfulLatencies, 0.5),
    p95_latency_ms: percentile(successfulLatencies, 0.95),
    timeout_rate: ratio(providerRecords.filter(({ error_type: type }) => type === 'timeout').length, providerRecords.length),
    rate_limit_rate: ratio(providerRecords.filter(({ error_type: type }) => type === 'rate_limit').length, providerRecords.length),
    strict_json_parse_rate: ratio(finalScores.filter(({ json_parse_success: ok }) => ok).length, finalScores.length),
    raw_plan_schema_pass_rate: ratio(finalScores.filter(({ raw_schema_success: ok }) => ok).length, finalScores.length),
    canonical_schema_pass_rate: ratio(finalScores.filter(({ canonical_schema_success: ok }) => ok).length, finalScores.length),
    ordinary_chat_success_rate: categoryRate('ordinary_chat'),
    semantic_success_rate: categoryRate('semantic'),
    finance_success_rate: categoryRate('finance'),
    memory_plan_success_rate: categoryRate('memory'),
    calendar_plan_success_rate: categoryRate('calendar'),
    memory_success_rate: null,
    calendar_success_rate: null,
    domain_execution_evidence: {
      memory: 'not_executed_through_production_chain',
      calendar: 'synthetic_tool_only_without_production_binders'
    },
    stability_success_rate: categoryRate('stability'),
    true_ambiguity_accuracy: ratio(ambiguity.filter(({ success }) => success).length, ambiguity.length),
    ordinary_chat_not_wrongly_clarified_rate: ratio(
      ordinary.filter(({ failures }) => !failures.includes('ordinary_chat_wrongly_clarified')).length,
      ordinary.length
    ),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated_cost: estimatedCost
  };
}

function recommendations(providers) {
  const withMetric = providers.filter(({ case_count: count }) => count > 0);
  const sortItemsBy = (items, score) => [...items].sort((left, right) =>
    score(right) - score(left) ||
    (left.metrics.average_latency_ms ?? Infinity) - (right.metrics.average_latency_ms ?? Infinity)
  );
  const sortBy = (score) => sortItemsBy(withMetric, score);
  const safe = (value) => value ?? 0;
  const chat = sortBy((item) => safe(item.metrics.ordinary_chat_success_rate) * 0.8 +
    safe(item.metrics.ordinary_chat_not_wrongly_clarified_rate) * 0.2);
  const semantic = sortBy((item) => safe(item.metrics.semantic_success_rate) * 0.6 +
    safe(item.metrics.canonical_schema_pass_rate) * 0.4);
  const strict = sortBy((item) => safe(item.metrics.strict_json_parse_rate) * 0.5 +
    safe(item.metrics.canonical_schema_pass_rate) * 0.5);
  const viableBackups = withMetric.filter(({ metrics }) =>
    safe(metrics.http_success_rate) >= 0.8 &&
    safe(metrics.canonical_schema_pass_rate) >= 0.5
  );
  const overall = sortItemsBy(viableBackups, (item) => [
    item.metrics.ordinary_chat_success_rate,
    item.metrics.semantic_success_rate,
    item.metrics.finance_success_rate,
    item.metrics.memory_success_rate,
    item.metrics.calendar_success_rate,
    item.metrics.stability_success_rate
  ].reduce((sum, value) => sum + safe(value), 0) / 6);
  const manualPending = providers.some(({ manual_review: review }) =>
    review.some(({ status }) => status === 'pending'));
  const completeFormal = providers.length === 4 &&
    providers.every(({ case_count: count }) => count === 24);
  const coreDomainEvidence = [
    'semantic_success_rate',
    'finance_success_rate',
    'memory_success_rate',
    'calendar_success_rate'
  ].every((metric) => providers.some(({ metrics }) => safe(metrics[metric]) > 0)) &&
    viableBackups.length >= 2;
  const evidenceSufficient = completeFormal && !manualPending && coreDomainEvidence;
  return {
    default_ordinary_chat: chat[0]?.model_id || null,
    semantic_planner: semantic[0]?.model_id || null,
    strict_json: strict[0]?.model_id || null,
    first_backup: overall[1]?.model_id || null,
    second_backup: overall[2]?.model_id || null,
    switch_on: ['timeout', 'network_error', 'http_502', 'http_503', 'http_504', 'rate_limit', 'provider_unavailable'],
    do_not_switch_on: ['invalid_user_input', 'true_ambiguity', 'schema_invalid_after_http_success', 'business_contract_rejection'],
    evidence_sufficient_for_router_core: evidenceSufficient,
    evidence_note: manualPending
      ? 'ordinary_chat_manual_review_pending'
      : !completeFormal
        ? 'formal_evidence_incomplete'
        : coreDomainEvidence
          ? 'formal_evidence_complete'
          : 'core_domain_evidence_insufficient'
  };
}

export async function scoreCachedEvaluation(records, {
  cases,
  pricingByModel = {},
  manualReviews = {}
} = {}) {
  const caseMap = new Map(cases.map((entry) => [entry.id, entry]));
  const groups = Object.groupBy(records, (record) => `${record.provider_id}:${record.case_id}`);
  const finalRecords = Object.values(groups).map((entries) =>
    [...entries].sort((left, right) => left.attempt - right.attempt).at(-1)
  );
  const caseScores = [];
  for (const record of finalRecords) {
    const definition = caseMap.get(record.case_id);
    if (!definition) continue;
    const base = {
      provider_id: record.provider_id,
      model_id: record.model_id,
      case_id: record.case_id,
      category: definition.category,
      title: definition.title,
      attempt: record.attempt,
      http_success: record.http_success === true,
      http_status: record.http_status,
      latency_ms: record.latency_ms,
      expected_ambiguity: definition.expected.ambiguity_required === true,
      expected_ordinary_no_clarification: definition.expected.no_clarification === true
    };
    if (!base.http_success) {
      caseScores.push({
        ...base,
        json_parse_success: false,
        raw_schema_success: false,
        canonical_schema_success: false,
        success: false,
        failures: [record.error_type || 'provider_error'],
        deterministic: {},
        manual_review: null
      });
      continue;
    }
    caseScores.push({
      ...base,
      ...(await scoreSuccessfulRecord(record, definition, manualReviews))
    });
  }
  const errors = {};
  for (const score of caseScores) {
    for (const failure of score.failures) errors[failure] = (errors[failure] || 0) + 1;
  }
  for (const record of records.filter(({ http_success: success }) => !success)) {
    const type = record.error_type || 'provider_error';
    if (!caseScores.some((score) =>
      score.provider_id === record.provider_id &&
      score.case_id === record.case_id &&
      score.failures.includes(type))) {
      errors[type] = (errors[type] || 0) + 1;
    }
  }
  const providerGroups = Object.groupBy(records, ({ provider_id: providerId }) => providerId);
  const providers = Object.entries(providerGroups).map(([providerId, providerRecords]) => {
    const scores = caseScores.filter(({ provider_id: id }) => id === providerId);
    const modelId = scores[0]?.model_id || providerRecords[0]?.model_id || null;
    return {
      provider_id: providerId,
      model_id: modelId,
      call_count: providerRecords.length,
      case_count: scores.length,
      successful_cases: scores.filter(({ success }) => success).length,
      metrics: providerMetrics(providerRecords, scores, pricingByModel),
      error_distribution: Object.fromEntries(
        Object.entries(Object.groupBy(
          scores.flatMap(({ failures }) => failures),
          (value) => value
        )).map(([type, values]) => [type, values.length])
      ),
      manual_review: scores
        .filter(({ manual_review: review }) => review)
        .map(({ case_id: caseId, manual_review: review }) => ({ case_id: caseId, ...review }))
    };
  });
  return {
    evaluation_version: EVALUATION_VERSION,
    records,
    case_scores: caseScores,
    providers,
    error_distribution: errors
  };
}

export function buildMachineResult(scored) {
  const callCount = scored.records.length;
  const generatedAt = scored.records
    .map(({ recorded_at: recordedAt }) => recordedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || '1970-01-01T00:00:00.000Z';
  return {
    schema_version: 1,
    evaluation_version: scored.evaluation_version,
    generated_at: generatedAt,
    call_count: callCount,
    formal_initial_call_limit: FORMAL_INITIAL_CALLS,
    hard_call_limit: 120,
    exceeded_call_limit: callCount > 120,
    providers: scored.providers,
    error_distribution: scored.error_distribution,
    routing_recommendation: recommendations(scored.providers),
    case_scores: scored.case_scores
  };
}
