import { isAiResultText, isQueryLikeInput } from '../inputRouter/inputSafetyGuards.js';
import { persistentMemoryService } from './memoryRuntime.js';

function compactRecord(record = {}, reason = '') {
  return {
    id: record.id,
    originalText: record.originalText,
    memoryType: record.memoryType,
    category: record.category,
    amount: record.amount,
    direction: record.direction,
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    createdAt: record.createdAt,
    status: record.status,
    reason
  };
}

function suspiciousReason(record = {}) {
  const text = [record.originalText, record.normalizedText, record.summary].filter(Boolean).join(' ');
  if (isAiResultText(text)) return 'ai_result_text';
  if (isQueryLikeInput(text)) return 'query_or_explanation_text';
  if (record.memoryType === 'generic_memory' && Number.isFinite(Number(record.amount))) return 'generic_amount_memory';
  return '';
}

export function listSuspiciousQueryMemories({ memoryService = persistentMemoryService, includeDeleted = false, includeForgotten = false } = {}) {
  const result = memoryService.searchMemories({ includeDeleted, includeForgotten });
  const records = result?.data || [];
  return records
    .map((record) => ({ record, reason: suspiciousReason(record) }))
    .filter((item) => item.reason)
    .map((item) => compactRecord(item.record, item.reason));
}

export function forgetSuspiciousQueryMemories(ids = [], { memoryService = persistentMemoryService, confirmed = false } = {}) {
  if (!confirmed) {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Pass confirmed=true after user review. No data was changed.' };
  }
  const safeIds = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  return {
    ok: true,
    action: 'forgotten',
    results: safeIds.map((id) => memoryService.forgetMemory(id))
  };
}

export function deleteSuspiciousQueryMemories(ids = [], { memoryService = persistentMemoryService, confirmed = false } = {}) {
  if (!confirmed) {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Pass confirmed=true after user review. No data was changed.' };
  }
  const safeIds = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  return {
    ok: true,
    action: 'deleted',
    results: safeIds.map((id) => memoryService.deleteMemory(id))
  };
}
