import {
  MemoryConfirmation,
  MemorySensitivity,
  MemoryStatus,
  MemoryType,
  validateMemoryRecord,
  validateMemoryRepositoryInterface
} from '../kernel/index.js';
import {
  MemoryRecallIntent,
  RecallAuditAction,
  RecallConflictClassification,
  RecallReasonCode,
  deepFreezeRecall,
  validateMemoryRecallContext,
  toRepositoryContext
} from './contracts.js';
import { MemoryRecallIntentAnalyzer } from './intent.js';
import { MemoryRecallPlanner } from './planning.js';
import { MemoryRankingEngine } from './ranking.js';
import { buildMemoryContextPack, explainMemoryRecall } from './context.js';

const CURRENT_STATUS = new Set([MemoryStatus.CONFIRMED]);
const HISTORICAL_STATUS = new Set([MemoryStatus.SUPERSEDED, MemoryStatus.EXPIRED, MemoryStatus.ARCHIVED]);
const EXCLUSIVE_PREDICATES = new Set(['resides_in_city', 'birthday']);
const ALLOWED_CONFIRMATION = new Set([MemoryConfirmation.USER_CONFIRMED, MemoryConfirmation.SYSTEM_VERIFIED, MemoryConfirmation.NOT_REQUIRED]);
const SENSITIVITY_RANK = Object.freeze({ public: 0, low: 1, medium: 2, high: 3, restricted: 4 });
const PROHIBITED_TEXT = /(?:password|api[ _-]*key|cookie|session[ _-]*token|access[ _-]*token|refresh[ _-]*token|private[ _-]*key|recovery[ _-]*code|密码|私钥|恢复码|完整银行卡号|完整身份证)/i;

function audit(context, action, result, reasonCode, values = {}) {
  return deepFreezeRecall({
    userId: context.authenticatedUserId,
    action,
    purpose: context.purpose,
    timestamp: context.timestamp,
    result,
    reasonCode,
    selectedCount: values.selectedCount || 0,
    excludedCount: values.excludedCount || 0,
    budgetUsage: values.budgetUsage || null,
    metadata: {}
  });
}

function excluded(record, exclusionReason, extra = {}) {
  return { memoryId: record?.id || null, exclusionReason, ...extra };
}

function accessAllowed(record, context) {
  const policy = record.accessPolicy;
  if (!policy || !['private', 'owner'].includes(policy.scope)) return false;
  if (policy.allowRecall === false) return false;
  if (Array.isArray(policy.allowedPurposes) && !policy.allowedPurposes.includes(context.purpose)) return false;
  return true;
}

function prohibited(record) {
  const text = typeof record.value === 'string' ? record.value : JSON.stringify(record.value);
  return record.sensitivity === MemorySensitivity.RESTRICTED || PROHIBITED_TEXT.test(text || '');
}

function filterRecords(records, context, plan) {
  const selected = [];
  const rejected = [];
  const now = Date.parse(plan.effectiveAt);
  for (const record of records) {
    if (record?.userId !== context.authenticatedUserId) { rejected.push(excluded(record, 'user_scope')); continue; }
    if (plan.subjects.length && !plan.subjects.includes(record.subject)) { rejected.push(excluded(record, 'subject')); continue; }
    if (plan.subjects.length && plan.predicates.length && !plan.predicates.includes(record.predicate)) { rejected.push(excluded(record, 'predicate')); continue; }
    const statusAllowed = CURRENT_STATUS.has(record.status) || (plan.includeHistorical && HISTORICAL_STATUS.has(record.status));
    if (!statusAllowed) { rejected.push(excluded(record, `status_${record.status}`)); continue; }
    if (!ALLOWED_CONFIRMATION.has(record.confirmationStatus)) { rejected.push(excluded(record, `confirmation_${record.confirmationStatus}`)); continue; }
    if (prohibited(record)) { rejected.push(excluded(record, 'prohibited')); continue; }
    const validation = validateMemoryRecord(record, { trustedUserId: context.authenticatedUserId });
    if (!validation.valid) { rejected.push(excluded(record, 'invalid_record')); continue; }
    if (!plan.memoryTypes.includes(record.memoryType)) { rejected.push(excluded(record, 'memory_type')); continue; }
    if (!accessAllowed(record, context)) { rejected.push(excluded(record, 'access_policy')); continue; }
    if (SENSITIVITY_RANK[record.sensitivity] > SENSITIVITY_RANK[plan.sensitivityMax]) { rejected.push(excluded(record, 'sensitivity')); continue; }
    if (!plan.subjects.length && plan.predicates.length && !plan.predicates.some((hint) => String(record.predicate).toLowerCase().includes(hint))) {
      rejected.push(excluded(record, 'predicate')); continue;
    }
    if (!plan.includeHistorical && (Date.parse(record.effectiveFrom) > now || (record.effectiveTo && now >= Date.parse(record.effectiveTo)))) {
      rejected.push(excluded(record, 'not_effective')); continue;
    }
    if (!plan.includeHistorical && record.expiresAt && now >= Date.parse(record.expiresAt)) { rejected.push(excluded(record, 'expired')); continue; }
    selected.push(record);
  }
  return { selected, excluded: rejected };
}

function groundEvidence(items, context, plan) {
  const selected = [];
  const rejected = [];
  for (const item of items) {
    const record = item.record;
    if (record.userId !== context.authenticatedUserId) { rejected.push(excluded(record, 'evidence_user_mismatch')); continue; }
    if (plan.subjects.length && !plan.subjects.includes(record.subject)) { rejected.push(excluded(record, 'evidence_subject_mismatch')); continue; }
    if (plan.subjects.length && plan.predicates.length && !plan.predicates.includes(record.predicate)) { rejected.push(excluded(record, 'evidence_predicate_mismatch')); continue; }
    const statusAllowed = CURRENT_STATUS.has(record.status) || (plan.includeHistorical && HISTORICAL_STATUS.has(record.status));
    if (!statusAllowed) { rejected.push(excluded(record, 'evidence_not_current')); continue; }
    selected.push(item);
  }
  return { selected, excluded: rejected };
}

function groupRanked(ranked, includeHistorical) {
  const selected = [];
  const excludedItems = [];
  const conflictNotices = [];
  const seenIds = new Set();
  const unique = [];
  for (const item of ranked) {
    if (seenIds.has(item.record.id)) excludedItems.push(excluded(item.record, 'duplicate_id'));
    else { seenIds.add(item.record.id); unique.push(item); }
  }
  const groups = new Map();
  for (const item of unique) {
    const key = `${item.record.subject}\u0000${item.record.predicate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [key, group] of groups) {
    if (group[0].record.memoryType === MemoryType.LIFE_EVENT) {
      selected.push(...group.map((item) => ({ ...item, classification: RecallConflictClassification.INDEPENDENT_EVENT, reasonSelected: 'independent_life_event', chainSummary: null })));
      continue;
    }
    const linked = includeHistorical && group.length > 1 &&
      group.some((item) => item.record.supersedesId || item.record.supersededById) &&
      group.every((item) => item.record.supersedesId || item.record.supersededById || item.record.status === MemoryStatus.CONFIRMED);
    if (linked) {
      const chainSummary = group.map((item) => item.record.id).sort();
      selected.push(...group.map((item) => ({
        ...item,
        classification: item.record.status === MemoryStatus.CONFIRMED ? RecallConflictClassification.RESOLVED_CURRENT : RecallConflictClassification.HISTORICAL_ONLY,
        reasonSelected: item.record.status === MemoryStatus.CONFIRMED ? 'current_version' : 'historical_version',
        chainSummary
      })));
      continue;
    }
    const values = new Map();
    for (const item of group) {
      const value = JSON.stringify(item.record.normalizedValue);
      if (!values.has(value)) values.set(value, []);
      values.get(value).push(item);
    }
    const deduplicated = [];
    for (const duplicates of values.values()) {
      deduplicated.push(duplicates[0]);
      for (const duplicate of duplicates.slice(1)) excludedItems.push(excluded(duplicate.record, 'duplicate', { duplicateGroupId: key }));
    }
    const explicitConflictGroups = new Map();
    for (const item of deduplicated) {
      if (!item.record.conflictGroupId) continue;
      if (!explicitConflictGroups.has(item.record.conflictGroupId)) explicitConflictGroups.set(item.record.conflictGroupId, []);
      explicitConflictGroups.get(item.record.conflictGroupId).push(item);
    }
    const conflictedIds = new Set();
    for (const conflictGroup of explicitConflictGroups.values()) {
      if (conflictGroup.length < 2) continue;
      const memoryIds = conflictGroup.map((item) => item.record.id).sort();
      memoryIds.forEach((id) => conflictedIds.add(id));
      conflictNotices.push({ classification: RecallConflictClassification.UNRESOLVED_CONFLICT, memoryIds, reasonCode: RecallReasonCode.CONFLICT_FOUND });
      for (const item of conflictGroup) excludedItems.push(excluded(item.record, 'unresolved_conflict'));
    }
    const independent = deduplicated.filter((item) => !conflictedIds.has(item.record.id));
    if (independent.length > 1 && EXCLUSIVE_PREDICATES.has(independent[0].record.predicate)) {
      const memoryIds = independent.map((item) => item.record.id).sort();
      conflictNotices.push({ classification: RecallConflictClassification.UNRESOLVED_CONFLICT, memoryIds, reasonCode: RecallReasonCode.CONFLICT_FOUND });
      for (const item of independent) excludedItems.push(excluded(item.record, 'unresolved_conflict'));
      continue;
    }
    selected.push(...independent.map((item) => ({
      ...item,
      classification: item.record.status === MemoryStatus.CONFIRMED
        ? RecallConflictClassification.RESOLVED_CURRENT
        : RecallConflictClassification.HISTORICAL_ONLY,
      reasonSelected: independent.length > 1 ? 'independent_current_fact' : 'best_current_fact',
      chainSummary: null
    })));
  }
  selected.sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id));
  return { selected, excluded: excludedItems, conflictNotices };
}

function safeFailure(context, code, reasonCode, { intent = null, plan = null } = {}) {
  return deepFreezeRecall({
    ok: false,
    intent,
    plan,
    selected: [],
    excluded: [],
    conflictNotices: [],
    warnings: [],
    auditEvents: [audit(context, RecallAuditAction.FAILED, 'failed', reasonCode)],
    error: { code }
  });
}

export class MemoryRecallEngine {
  constructor({ repository, assistant = null, rankingEngine = new MemoryRankingEngine() } = {}) {
    if (!repository || !validateMemoryRepositoryInterface(repository).valid) throw new TypeError('MemoryRecallEngine requires a MemoryRepository.');
    this.repository = repository;
    this.intentAnalyzer = new MemoryRecallIntentAnalyzer({ assistant });
    this.planner = new MemoryRecallPlanner();
    this.rankingEngine = rankingEngine;
  }

  analyzeRecallIntent(context, request) {
    return this.intentAnalyzer.analyze(context, request);
  }

  async buildRecallPlan(context, request, options = {}) {
    const intent = await this.analyzeRecallIntent(context, request);
    return this.planner.build(context, request, intent, options);
  }

  async recall(context, request = {}, options = {}) {
    const contextValidation = validateMemoryRecallContext(context);
    if (!contextValidation.valid) return safeFailure({ ...context, authenticatedUserId: context?.authenticatedUserId || '', purpose: context?.purpose || 'invalid', timestamp: context?.timestamp || new Date(0).toISOString() }, 'MEMORY_RECALL_INVALID_CONTEXT', RecallReasonCode.INVALID_CONTEXT);
    const intent = await this.analyzeRecallIntent(context, request);
    const plan = this.planner.build(context, request, intent, options);
    const events = [audit(context, RecallAuditAction.INTENT_ANALYZED, 'ok', intent.reasonCode), audit(context, RecallAuditAction.PLAN_CREATED, 'ok', RecallReasonCode.PLAN_CREATED)];
    if (plan.limit === 0) {
      events.push(audit(context, RecallAuditAction.EMPTY, 'empty', RecallReasonCode.EMPTY));
      return deepFreezeRecall({ ok: true, intent, plan, selected: [], excluded: [], conflictNotices: [], warnings: intent.needsClarification ? [intent.clarificationQuestion] : [], auditEvents: events, error: null });
    }
    let page;
    try {
      page = await this.repository.query(toRepositoryContext(context), {
        userId: context.authenticatedUserId,
        memoryTypes: plan.memoryTypes,
        includeHistorical: plan.includeHistorical,
        includeCandidates: false,
        sensitivityMax: plan.sensitivityMax,
        limit: plan.limit,
        sort: plan.sort,
        ...(plan.subjects.length === 1 ? { subject: plan.subjects[0] } : {}),
        ...(plan.subjects.length === 1 && plan.predicates.length === 1 ? { predicate: plan.predicates[0] } : {}),
        ...(plan.includeHistorical ? {} : { effectiveAt: plan.effectiveAt })
      });
    } catch {
      return safeFailure(context, 'MEMORY_RECALL_UNAVAILABLE', RecallReasonCode.REPOSITORY_UNAVAILABLE, { intent, plan });
    }
    const filtered = filterRecords(page.items, context, plan);
    let ranked;
    try {
      ranked = this.rankingEngine.rank(filtered.selected, { text: request.text, timestamp: context.timestamp, intent: intent.intent });
    } catch {
      return safeFailure(context, 'MEMORY_RECALL_RANKING_FAILED', RecallReasonCode.RANKING_FAILED, { intent, plan });
    }
    const grouped = groupRanked(ranked, plan.includeHistorical);
    const grounded = groundEvidence(grouped.selected, context, plan);
    const excludedItems = [...filtered.excluded, ...grouped.excluded, ...grounded.excluded];
    if (excludedItems.some((item) => item.exclusionReason === 'sensitivity' || item.exclusionReason === 'prohibited')) events.push(audit(context, RecallAuditAction.SENSITIVE_FILTERED, 'filtered', RecallReasonCode.FILTERED, { excludedCount: excludedItems.length }));
    if (grouped.conflictNotices.length) events.push(audit(context, RecallAuditAction.CONFLICT_FOUND, 'conflict', RecallReasonCode.CONFLICT_FOUND, { excludedCount: excludedItems.length }));
    events.push(audit(context, grounded.selected.length ? RecallAuditAction.EXECUTED : RecallAuditAction.EMPTY, grounded.selected.length ? 'ok' : 'empty', grounded.selected.length ? RecallReasonCode.SELECTED : RecallReasonCode.EMPTY, { selectedCount: grounded.selected.length, excludedCount: excludedItems.length }));
    return deepFreezeRecall({ ok: true, intent, plan, selected: grounded.selected, excluded: excludedItems, conflictNotices: grouped.conflictNotices, warnings: [], auditEvents: events, error: null });
  }

  explainRecall(context, recallResult) {
    return explainMemoryRecall(context, recallResult);
  }

  buildContextPack(context, recallResult, budget) {
    return buildMemoryContextPack(context, recallResult, budget);
  }
}
