import { MemorySensitivity } from '../kernel/index.js';
import { deepFreezeRecall, normalizeMemoryContextBudget } from './contracts.js';

const UNSAFE_TEXT = /(?:\bSELECT\s+.+\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+.+\bSET\b|\bDELETE\s+FROM\b|(?:^|\s)\/(?:Users|private|var|etc|home)\/|password|api[ _-]*key|cookie|(?:access|refresh|session)[ _-]*token|private[ _-]*key|密码|私钥|恢复码)/i;

function budget(contextBudget, override = {}) {
  const trusted = normalizeMemoryContextBudget(contextBudget);
  const requested = normalizeMemoryContextBudget({ ...trusted, ...override });
  return Object.freeze(Object.fromEntries(Object.keys(trusted).map((key) => [key, Math.min(trusted[key], requested[key])])));
}

function valueText(record) {
  if (typeof record.value === 'string') return record.value.trim();
  try { return JSON.stringify(record.value); } catch { return ''; }
}

function safeText(record) {
  if (record.sensitivity === MemorySensitivity.HIGH) return { text: '存在一条相关敏感记忆，正文已省略。', derived: true };
  const raw = valueText(record);
  if (!raw || UNSAFE_TEXT.test(raw)) return { text: `存在一条${record.memoryType}记忆，正文已安全省略。`, derived: true };
  return { text: raw, derived: false };
}

function fallback(record) {
  return { text: '存在相关记忆，详情已省略。', derived: true };
}

function tokens(text) {
  return Math.ceil(text.length / 4);
}

function exclusionCounts(excluded, budgetCount) {
  const summary = { budget: budgetCount };
  for (const item of excluded || []) summary[item.exclusionReason] = (summary[item.exclusionReason] || 0) + 1;
  return summary;
}

export function buildMemoryContextPack(context, recallResult, override = {}) {
  const limits = budget(context.contextBudget, override);
  const memoryItems = [];
  const provenance = [];
  const typeCounts = new Map();
  let characters = 0;
  let estimatedTokens = 0;
  let sensitiveItems = 0;
  let budgetExcluded = 0;
  for (const selected of recallResult.selected || []) {
    const record = selected.record;
    if (memoryItems.length >= limits.maxItems || (typeCounts.get(record.memoryType) || 0) >= limits.perTypeLimit) { budgetExcluded += 1; continue; }
    if (record.sensitivity === MemorySensitivity.HIGH && sensitiveItems >= limits.maxSensitiveItems) { budgetExcluded += 1; continue; }
    let content = safeText(record);
    if (characters + content.text.length > limits.maxCharacters || estimatedTokens + tokens(content.text) > limits.maxEstimatedTokens) content = fallback(record);
    const itemTokens = tokens(content.text);
    if (characters + content.text.length > limits.maxCharacters || estimatedTokens + itemTokens > limits.maxEstimatedTokens) { budgetExcluded += 1; continue; }
    const item = {
      memoryId: record.id,
      memoryType: record.memoryType,
      safeText: content.text,
      sourceType: record.source.type,
      sourceTimestamp: record.sourceTimestamp,
      effectiveFrom: record.effectiveFrom,
      effectiveTo: record.effectiveTo,
      confidence: record.confidence,
      importance: record.importance,
      sensitivity: record.sensitivity,
      reasonSelected: selected.reasonSelected,
      rankScore: selected.score,
      version: record.version,
      isDerivedSummary: content.derived
    };
    memoryItems.push(item);
    provenance.push({ memoryId: record.id, sourceType: record.source.type, sourceTimestamp: record.sourceTimestamp, version: record.version });
    characters += content.text.length;
    estimatedTokens += itemTokens;
    typeCounts.set(record.memoryType, (typeCounts.get(record.memoryType) || 0) + 1);
    if (record.sensitivity === MemorySensitivity.HIGH) sensitiveItems += 1;
  }
  return deepFreezeRecall({
    userId: context.authenticatedUserId,
    purpose: context.purpose,
    generatedAt: context.timestamp,
    memoryItems,
    conflictNotices: recallResult.conflictNotices || [],
    warnings: budgetExcluded ? ['memory_budget_trimmed'] : [],
    excludedSummary: exclusionCounts(recallResult.excluded, budgetExcluded),
    budgetUsage: { selectedCount: memoryItems.length, characters, estimatedTokens, sensitiveItems, limits },
    provenance,
    policyVersion: context.policyVersion,
    auditEvents: [
      ...(budgetExcluded ? [{ userId: context.authenticatedUserId, action: 'recall_budget_trimmed', purpose: context.purpose, timestamp: context.timestamp, result: 'trimmed', reasonCode: 'RECALL_BUDGET_TRIMMED', selectedCount: memoryItems.length, excludedCount: budgetExcluded, budgetUsage: { characters, estimatedTokens }, metadata: {} }] : []),
      { userId: context.authenticatedUserId, action: 'context_pack_created', purpose: context.purpose, timestamp: context.timestamp, result: 'ok', reasonCode: 'RECALL_CONTEXT_PACK_CREATED', selectedCount: memoryItems.length, excludedCount: budgetExcluded, budgetUsage: { characters, estimatedTokens }, metadata: {} }
    ]
  });
}

export function explainMemoryRecall(_context, recallResult) {
  const exclusions = recallResult.excluded || [];
  return deepFreezeRecall({
    memoryNeeded: recallResult.intent?.intent !== 'no_memory_needed',
    reasonCode: recallResult.intent?.reasonCode || null,
    selectedCount: recallResult.selected?.length || 0,
    excludedCount: exclusions.length,
    hasConflict: Boolean(recallResult.conflictNotices?.length),
    usedHistorical: recallResult.plan?.includeHistorical === true,
    sensitiveOmitted: exclusions.some((item) => ['sensitivity', 'prohibited'].includes(item.exclusionReason)),
    budgetTrimmed: exclusions.some((item) => item.exclusionReason === 'budget'),
    usedDerivedSummary: Boolean(recallResult.selected?.some((item) => item.isDerivedSummary)),
    userMessage: recallResult.selected?.length ? '已使用与当前任务相关的记忆。' : '没有使用可安全召回的相关记忆。'
  });
}
