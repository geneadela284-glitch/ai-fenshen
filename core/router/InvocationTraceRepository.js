import { createDefaultRepositoryStorage } from '../repositories/jsonStorage.js';

const TRACE_STORAGE_KEY = 'ai-invocation-traces';
const MAX_TRACE_COUNT = 200;

function text(value = '') {
  return String(value || '').slice(0, 160);
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return Object.fromEntries(
    Object.entries(usage)
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
      .slice(0, 12)
  );
}

function normalizeTrace(trace = {}) {
  const createdAt = trace.createdAt || new Date().toISOString();
  return {
    requestId: text(trace.requestId),
    executionId: text(trace.executionId),
    attemptId: text(trace.attemptId),
    attemptNumber: Math.max(0, Number(trace.attemptNumber || 0)),
    attemptType: text(trace.attemptType),
    domain: text(trace.domain),
    taskType: text(trace.taskType),
    capability: text(trace.capability),
    providerId: text(trace.providerId),
    modelId: text(trace.modelId),
    routeReason: text(trace.routeReason),
    fallbackFrom: text(trace.fallbackFrom),
    fallbackTo: text(trace.fallbackTo),
    startedAt: text(trace.startedAt || createdAt),
    durationMs: Math.max(0, Number(trace.durationMs || 0)),
    success: Boolean(trace.success),
    errorCode: text(trace.errorCode),
    errorClass: text(trace.errorClass),
    fallbackReason: text(trace.fallbackReason),
    finalProvider: text(trace.finalProvider),
    businessWriteStarted: Boolean(trace.businessWriteStarted),
    businessWriteOccurred: Boolean(trace.businessWriteOccurred),
    tokenUsage: safeUsage(trace.tokenUsage),
    estimatedCost: Number.isFinite(trace.estimatedCost) ? trace.estimatedCost : null,
    createdAt: text(createdAt)
  };
}

export class InvocationTraceRepository {
  constructor({ storage = createDefaultRepositoryStorage(), key = TRACE_STORAGE_KEY } = {}) {
    this.storage = storage;
    this.key = key;
  }

  record(trace = {}) {
    const next = normalizeTrace(trace);
    const records = this.listRecent(MAX_TRACE_COUNT - 1);
    this.storage.set(this.key, [next, ...records].slice(0, MAX_TRACE_COUNT));
    return next;
  }

  listRecent(limit = 20) {
    const stored = this.storage.get(this.key);
    if (!Array.isArray(stored)) return [];
    return stored.slice(0, Math.max(0, Number(limit || 0))).map(normalizeTrace);
  }

  markExecution({
    requestId,
    executionId,
    finalProvider = '',
    businessWriteStarted = false,
    businessWriteOccurred = false
  } = {}) {
    const request = text(requestId);
    const execution = text(executionId);
    if (!request || !execution) return 0;
    const stored = this.storage.get(this.key);
    if (!Array.isArray(stored)) return 0;
    let changed = 0;
    const next = stored.map((trace) => {
      if (text(trace?.requestId) !== request || text(trace?.executionId) !== execution) return trace;
      changed += 1;
      return {
        ...trace,
        finalProvider: text(finalProvider || trace.finalProvider),
        businessWriteStarted: Boolean(businessWriteStarted || trace.businessWriteStarted),
        businessWriteOccurred: Boolean(businessWriteOccurred || trace.businessWriteOccurred)
      };
    });
    if (changed) this.storage.set(this.key, next.slice(0, MAX_TRACE_COUNT));
    return changed;
  }
}

export const invocationTraceRepository = new InvocationTraceRepository();
export default invocationTraceRepository;
