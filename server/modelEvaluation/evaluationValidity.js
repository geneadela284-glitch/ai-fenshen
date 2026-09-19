import { bindAssistantSemanticEvidence } from '../agent/assistantSemanticEvidenceBinder.js';
import { bindAssistantToolEvidence } from '../agent/assistantEvidenceBinder.js';
import {
  adaptUnifiedPlanToMemory,
  adaptUnifiedPlanToTool
} from '../agent/domainPlanAdapters.js';
import { validateProviderPlanCandidate } from '../agent/providerPlanCandidateSchema.js';
import { canonicalizeUnifiedProviderPlan } from '../agent/unifiedProviderPlanCanonicalizer.js';
import { evaluateSemanticMemoryContract } from '../memory/semanticMemoryContract.js';
import { validateSemanticMemoryPlan } from '../memory/semanticMemoryPlanSchema.js';
import { createCalendarTool } from '../tools/calendar/calendarTool.js';
import { EVALUATION_PARAMETERS } from './evaluationContract.js';

function trustedContext(definition, ownerId, conversationId) {
  if (!definition.context?.previous_turn) return null;
  return {
    owner_id: ownerId,
    conversation_id: conversationId,
    values: {
      relation_to_owner: definition.expected.relation_to_owner,
      'entity.relation_to_owner': definition.expected.relation_to_owner,
      predicate: definition.expected.predicate,
      tool: 'calendar.convert'
    },
    active_entity: {
      type: 'person',
      reference: definition.expected.relation_to_owner,
      relation_to_owner: definition.expected.relation_to_owner
    },
    active_predicate: definition.expected.predicate,
    active_tool: 'calendar.convert',
    active_arguments: {
      source_calendar: definition.context.confirmed_memory?.value?.calendar_type,
      target_calendar: 'gregorian',
      target_year_reference: 'next_occurrence',
      occurrence: 'next_occurrence'
    }
  };
}

function evidenceBundle(definition, ownerId) {
  const memory = definition.context?.confirmed_memory;
  if (!memory) return { owner_id: ownerId, evidence: [] };
  const value = memory.value || {};
  return {
    owner_id: ownerId,
    evidence: [{
      evidence_id: `validity-${definition.id}-birthday`,
      owner_id: ownerId,
      entity_id: `validity-${memory.relation_to_owner}`,
      predicate: memory.predicate,
      value: {
        kind: 'calendar_date',
        calendar_type: value.calendar_type,
        date: {
          year: value.year ?? null,
          month: value.month,
          day: value.day
        },
        lunar_leap_month: value.lunar_leap_month ?? 'unknown',
        recurrence: value.recurrence || 'yearly'
      },
      qualifiers: {
        calendar_type: value.calendar_type,
        year: value.year ?? null,
        month: value.month,
        day: value.day,
        lunar_leap_month: value.lunar_leap_month ?? 'unknown',
        recurrence: value.recurrence || 'yearly'
      },
      confidence: 1,
      source_message_id: `validity-${definition.id}`,
      version: 1,
      status: 'confirmed'
    }]
  };
}

function failed(layers, layer, code, classification) {
  return {
    layers,
    first_failure: { layer, code },
    classification
  };
}

function expectedAction(definition) {
  const action = String(definition.expected.action || '').split('.').at(-1);
  return action === 'convert' ? 'convert_calendar_date' : action;
}

export async function traceProductionPlan(plan, definition) {
  const ownerId = 'validity-owner';
  const conversationId = `validity-${definition.id}`;
  const sourceMessageId = `validity-source-${definition.id}`;
  const layers = {
    provider_raw_response: { status: 'present' },
    raw_plan: null,
    raw_to_canonical: null,
    canonical_schema: null,
    semantic_evidence_binder: null,
    domain_adapter: null,
    memory_evidence_binder: null,
    domain_contract: null,
    deterministic_tool: { status: 'not_run' },
    scorer: { status: 'not_run' }
  };

  const raw = validateProviderPlanCandidate(plan);
  layers.raw_plan = { valid: raw.valid, errors: raw.errors };
  if (!raw.valid) return failed(layers, 'raw_plan', 'RAW_PLAN_SCHEMA_INVALID', 'raw_schema_incompatible');

  const context = trustedContext(definition, ownerId, conversationId);
  const canonical = canonicalizeUnifiedProviderPlan(raw.value, {
    ownerId,
    conversationId,
    trustedContext: context,
    message: definition.message,
    timezone: EVALUATION_PARAMETERS.timezone,
    now: new Date(EVALUATION_PARAMETERS.now)
  });
  layers.raw_to_canonical = canonical.ok
    ? { ok: true, audit: canonical.audit }
    : { ok: false, code: canonical.code, errors: canonical.errors || [] };
  layers.canonical_schema = canonical.ok
    ? { valid: true, plan: canonical.plan }
    : { valid: false, errors: canonical.errors || [] };
  if (!canonical.ok) {
    return failed(
      layers,
      'raw_to_canonical',
      canonical.code || 'CANONICAL_PLAN_INVALID',
      'canonical_normalization_missing'
    );
  }

  const bound = bindAssistantSemanticEvidence(canonical.plan, {
    message: definition.message,
    sourceMessageId,
    ownerId,
    conversationId,
    trustedContext: context
  });
  layers.semantic_evidence_binder = bound.ok
    ? { ok: true, evidence: bound.evidence, audit: bound.auditReasons }
    : { ok: false, code: bound.code };
  if (!bound.ok) {
    return failed(layers, 'semantic_evidence_binder', bound.code, 'fixture_or_evidence_error');
  }
  if (bound.plan.domain !== definition.expected.domain) {
    return failed(
      layers,
      'semantic_expectation',
      'domain_mismatch',
      'provider_semantic_plan_invalid'
    );
  }

  if (bound.plan.domain === 'memory') {
    const adapted = adaptUnifiedPlanToMemory(bound.plan, { message: definition.message });
    layers.domain_adapter = adapted;
    if (!adapted.ok) {
      return failed(layers, 'domain_adapter', adapted.code, 'canonical_normalization_missing');
    }
    const schema = validateSemanticMemoryPlan(adapted.plan, { text: definition.message });
    layers.memory_evidence_binder = {
      status: adapted.plan.intent === 'memory_query'
        ? 'deferred_to_owner_scoped_query_v2'
        : 'not_required_before_safe_write'
    };
    layers.domain_contract = schema.valid
      ? evaluateSemanticMemoryContract({
          plan: adapted.plan,
          existingRecords: [],
          sourceText: definition.message
        })
      : { decision: 'REJECT', code: 'MEMORY_PLAN_SCHEMA_INVALID', errors: schema.errors };
    if (!schema.valid) {
      return failed(layers, 'domain_contract', 'MEMORY_PLAN_SCHEMA_INVALID', 'domain_contract_failure');
    }
    if (!['ACCEPT', 'NO_OP', 'MERGE', 'SUPERSEDE', 'UPDATE', 'DELETE'].includes(
      layers.domain_contract.decision
    )) {
      return failed(
        layers,
        'domain_contract',
        layers.domain_contract.reasonCodes?.[0] || layers.domain_contract.decision,
        'domain_contract_failure'
      );
    }
    if (definition.expected.predicate && adapted.plan.predicate !== definition.expected.predicate) {
      return failed(layers, 'semantic_expectation', 'predicate_mismatch', 'provider_semantic_plan_invalid');
    }
    if (definition.expected.calendar_type &&
        layers.domain_contract.structuredValue?.calendarType !== definition.expected.calendar_type) {
      const rawCalendar = plan.value && typeof plan.value === 'object'
        ? plan.value.calendar_type
        : null;
      return failed(
        layers,
        'semantic_expectation',
        'calendar_type_not_preserved',
        rawCalendar === definition.expected.calendar_type
          ? 'canonical_normalization_missing'
          : 'provider_semantic_plan_invalid'
      );
    }
    layers.scorer = { status: 'pass' };
    return { layers, first_failure: null, classification: 'production_chain_pass' };
  }

  if (bound.plan.domain === 'tool') {
    const adapted = adaptUnifiedPlanToTool(bound.plan, { sourceMessageId });
    layers.domain_adapter = adapted;
    if (!adapted.ok) {
      return failed(layers, 'domain_adapter', adapted.code, 'canonical_normalization_missing');
    }
    const bundle = evidenceBundle(definition, ownerId);
    const toolBound = await bindAssistantToolEvidence(adapted.plan, {
      ownerId,
      conversationId,
      sourceMessageId,
      memoryIntegration: {
        async resolveToolEvidence() {
          return bundle;
        }
      }
    });
    layers.memory_evidence_binder = toolBound.ok
      ? { ok: true, evidence_count: toolBound.evidenceBundle.evidence.length }
      : { ok: false, code: toolBound.code };
    if (!toolBound.ok) {
      return failed(layers, 'memory_evidence_binder', toolBound.code, 'fixture_or_evidence_error');
    }
    const toolResult = await createCalendarTool().run({
      plan: toolBound.plan,
      evidenceBundle: toolBound.evidenceBundle,
      ownerId,
      timezone: EVALUATION_PARAMETERS.timezone,
      now: new Date(EVALUATION_PARAMETERS.now),
      semanticContext: context?.memory_context || null
    });
    layers.domain_contract = toolResult.decision === 'ACCEPT'
      ? { decision: 'ACCEPT' }
      : { decision: toolResult.decision, code: toolResult.code || 'CALENDAR_REJECTED' };
    if (toolResult.decision !== 'ACCEPT') {
      return failed(
        layers,
        'domain_contract',
        toolResult.code || 'CALENDAR_REJECTED',
        ['CALENDAR_EVIDENCE_REQUIRED', 'CALENDAR_OWNER_MISMATCH'].includes(toolResult.code)
          ? 'fixture_or_evidence_error'
          : 'provider_semantic_plan_invalid'
      );
    }
    layers.deterministic_tool = { status: 'pass', result: toolResult.result.data };
    if (adapted.plan.action !== expectedAction(definition)) {
      return failed(layers, 'semantic_expectation', 'action_mismatch', 'provider_semantic_plan_invalid');
    }
    for (const [field, value] of Object.entries(definition.expected.deterministic_result || {})) {
      const actual = field === 'date'
        ? toolResult.result.data.gregorian_date
        : toolResult.result.data.days_until;
      if (actual !== value) {
        return failed(
          layers,
          'semantic_expectation',
          `calendar_${field}_mismatch`,
          'provider_semantic_plan_invalid'
        );
      }
    }
    layers.scorer = { status: 'pass' };
    return { layers, first_failure: null, classification: 'production_chain_pass' };
  }

  return failed(layers, 'domain_adapter', 'DOMAIN_NOT_MEMORY_OR_CALENDAR', 'provider_semantic_plan_invalid');
}
