import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemoryConfirmation,
  MemorySensitivity,
  MemoryStatus,
  validateMemoryRecord,
  validateMemoryRepositoryInterface
} from '../kernel/index.js';
import { SensitivePolicy } from '../capture/index.js';
import {
  GovernanceAuditAction,
  GovernanceConflictDecision,
  GovernanceOperation,
  GovernanceStatus,
  createGovernanceResult,
  deepFreezeGovernance,
  governanceSensitivityToKernel,
  kernelSensitivityToGovernance,
  toGovernanceRepositoryContext,
  validateMemoryGovernanceContext
} from './contracts.js';

const SAFE_TEXT = /(?:password|api[ _-]*key|cookie|(?:access|refresh|session)[ _-]*token|private[ _-]*key|密码|私钥|恢复码|\bSELECT\b.+\bFROM\b|\/(?:Users|private|var|etc|home)\/)/i;

function text(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return ''; }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mutationOptions(context, reasonCode) {
  return {
    idempotencyKey: null,
    requestId: context.requestId,
    expectedVersion: context.expectedVersion,
    operationReason: reasonCode
  };
}

function safeMutationRecord(record) {
  const redacted = [MemorySensitivity.HIGH, MemorySensitivity.RESTRICTED].includes(record.sensitivity) || SAFE_TEXT.test(text(record.value));
  return deepFreezeGovernance({
    id: record.id,
    userId: record.userId,
    status: record.status,
    version: record.version,
    sensitivity: record.sensitivity,
    source: { type: record.source.type, id: record.source.id },
    supersedesId: record.supersedesId,
    supersededById: record.supersededById,
    accessPolicy: structuredClone(record.accessPolicy),
    ...(redacted ? {} : { value: structuredClone(record.value) })
  });
}

function accessPolicy(options) {
  const mode = options.mode;
  if (mode === 'archived_only') return { scope: 'private', governanceMode: mode, allowRecall: false };
  if (mode === 'assistant_only') return { scope: 'private', governanceMode: mode, allowRecall: true, allowedPurposes: ['assistant'] };
  if (mode === 'task_scoped') return { scope: 'private', governanceMode: mode, allowRecall: true, allowedPurposes: [...options.taskScopes] };
  if (mode === 'explicitly_shared') return { scope: 'private', governanceMode: mode, allowRecall: true, sharingEnabled: false };
  return { scope: 'private', governanceMode: 'private', allowRecall: true };
}

const SENSITIVITY_RANK = Object.freeze({ public: 0, low: 1, medium: 2, high: 3, restricted: 4 });
const ACCESS_RANK = Object.freeze({ archived_only: 0, private: 1, task_scoped: 2, assistant_only: 3, explicitly_shared: 4 });

function safeSummary(record) {
  if (record.sensitivity === 'high' || record.sensitivity === 'restricted') return '存在一条敏感记忆，正文已省略。';
  const value = text(record.value).trim();
  return !value || SAFE_TEXT.test(value) ? '存在一条记忆，正文已安全省略。' : value;
}

function actions(record, now) {
  if (record.status === MemoryStatus.DELETED) {
    const recoverable = Date.parse(now) < Date.parse(record.metadata?.recycleBin?.purgeAfter || 0);
    return recoverable ? ['restore', 'purge'] : ['purge'];
  }
  if ([MemoryStatus.SUPERSEDED, MemoryStatus.EXPIRED, MemoryStatus.ARCHIVED].includes(record.status)) return ['view_history', 'delete'];
  return ['correct', 'delete', 'change_sensitivity', 'change_access', 'view_history'];
}

function view(record, now) {
  const recallable = record.status === MemoryStatus.CONFIRMED &&
    !['restricted'].includes(record.sensitivity) && record.accessPolicy?.allowRecall !== false;
  return deepFreezeGovernance({
    memoryId: record.id,
    memoryType: record.memoryType,
    safeSummary: safeSummary(record),
    status: record.status,
    confirmationStatus: record.confirmationStatus,
    sensitivity: kernelSensitivityToGovernance(record.sensitivity),
    sourceType: record.source.type,
    sourceTimestamp: record.sourceTimestamp,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    updatedAt: record.updatedAt,
    version: record.version,
    recallEligibility: recallable ? 'eligible' : 'not_recallable',
    availableActions: actions(record, now)
  });
}

export class MemoryGovernanceService {
  constructor({
    repository,
    clock = () => new Date(),
    idFactory = () => crypto.randomUUID(),
    sensitivePolicy = new SensitivePolicy(),
    exportDirectory = join(tmpdir(), 'ai-work-center-memory-exports')
  } = {}) {
    if (!repository || !validateMemoryRepositoryInterface(repository).valid) throw new TypeError('MemoryGovernanceService requires a MemoryRepository.');
    this.repository = repository;
    this.clock = clock;
    this.idFactory = idFactory;
    this.sensitivePolicy = sensitivePolicy;
    this.exportDirectory = exportDirectory;
    this.auditEvents = [];
    this.confirmations = new Map();
  }

  toRepositoryContext(context) { return toGovernanceRepositoryContext(context); }

  _now() { const value = this.clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); }

  _audit(context, action, result, reasonCode, affectedMemoryIds = []) {
    const event = deepFreezeGovernance({
      id: `gov-audit-${this.idFactory()}`,
      userId: context.authenticatedUserId,
      actor: { type: context.actorType, id: context.actorId },
      action,
      result,
      timestamp: this._now(),
      reasonCode,
      affectedMemoryIds: [...affectedMemoryIds],
      metadata: {}
    });
    this.auditEvents.push(event);
    return event;
  }

  _result(context, values) {
    return createGovernanceResult({ createdAt: this._now(), ...values });
  }

  _failure(context, operation, error, memoryId = null) {
    const code = error?.code || 'MEMORY_GOVERNANCE_FAILED';
    const notFound = code === 'MEMORY_RECORD_NOT_FOUND';
    const audit = this._audit(context, GovernanceAuditAction.FAILED, 'failed', code, memoryId ? [memoryId] : []);
    return this._result(context, {
      status: notFound ? GovernanceStatus.NOT_FOUND : GovernanceStatus.FAILED,
      operation,
      memoryId,
      reasonCode: code,
      safeMessage: notFound ? '未找到这条记忆。' : '无法完成此记忆操作。',
      auditEventId: audit.id
    });
  }

  _confirmation(context, operation, resourceId, payload) {
    const payloadHash = hash(payload);
    const existing = context.confirmationToken ? this.confirmations.get(context.confirmationToken) : null;
    if (existing && existing.userId === context.authenticatedUserId && existing.operation === operation &&
      existing.resourceId === resourceId && existing.payloadHash === payloadHash && Date.parse(existing.expiresAt) > Date.parse(this._now())) {
      this.confirmations.delete(context.confirmationToken);
      return null;
    }
    const token = `gov-confirm-${this.idFactory()}`;
    this.confirmations.set(token, {
      userId: context.authenticatedUserId,
      operation,
      resourceId,
      payloadHash,
      expiresAt: new Date(Date.parse(this._now()) + 5 * 60 * 1000).toISOString()
    });
    return this._result(context, {
      status: GovernanceStatus.CONFIRMATION_REQUIRED,
      operation,
      memoryId: resourceId,
      affectedMemoryIds: [resourceId],
      confirmationRequired: true,
      reasonCode: 'MEMORY_GOVERNANCE_CONFIRMATION_REQUIRED',
      safeMessage: '请确认这项高风险操作。',
      data: { confirmationToken: token }
    });
  }

  _replacement(context, current, correction, sensitivity) {
    const now = this._now();
    const id = correction.id || `memory-governance-${this.idFactory()}`;
    const value = structuredClone(correction.value);
    const normalizedValue = correction.normalizedValue ?? structuredClone(correction.value);
    const record = {
      ...structuredClone(current),
      id,
      subject: correction.subject ?? current.subject,
      predicate: correction.predicate ?? current.predicate,
      value,
      normalizedValue,
      source: { type: 'user_confirmed', id: correction.sourceId || `governance-correction-${id}` },
      sourceTimestamp: now,
      createdAt: now,
      updatedAt: now,
      effectiveFrom: correction.effectiveFrom || now,
      effectiveTo: correction.effectiveTo ?? null,
      sensitivity,
      status: MemoryStatus.CONFIRMED,
      confirmationStatus: MemoryConfirmation.USER_CONFIRMED,
      expiresAt: correction.expiresAt ?? current.expiresAt,
      version: 1,
      supersedesId: null,
      supersededById: null,
      checksum: hash({ id, value, normalizedValue, sourceTimestamp: now }),
      metadata: { ...structuredClone(current.metadata), governance: { reasonCode: 'user_correction' } }
    };
    const validation = validateMemoryRecord(record, { trustedUserId: context.authenticatedUserId });
    if (!validation.valid) {
      const error = new Error(validation.errors[0].code);
      error.code = validation.errors[0].code;
      throw error;
    }
    return record;
  }

  _invalid(context, operation, reasonCode = 'MEMORY_GOVERNANCE_INVALID_CONTEXT') {
    return this._result(context || {}, {
      status: GovernanceStatus.FAILED, operation, reasonCode, safeMessage: '无法完成此记忆操作。'
    });
  }

  _validate(context, options) {
    return validateMemoryGovernanceContext(context, options);
  }

  async _record(context, memoryId) {
    const repositoryContext = this.toRepositoryContext(context);
    try { return await this.repository.getById(repositoryContext, memoryId); } catch {
      const page = await this.repository.query(repositoryContext, {
        userId: context.authenticatedUserId,
        id: memoryId,
        statuses: [MemoryStatus.DELETED],
        limit: 1
      });
      return page.items[0] || null;
    }
  }

  async _versionChain(context, memoryId) {
    try { return await this.repository.getVersionChain(this.toRepositoryContext(context), memoryId); } catch {
      const start = await this._record(context, memoryId);
      if (!start) throw Object.assign(new Error('MEMORY_RECORD_NOT_FOUND'), { code: 'MEMORY_RECORD_NOT_FOUND' });
      const previous = [];
      const next = [];
      const seen = new Set([start.id]);
      let current = start;
      while (current.supersedesId) {
        current = await this._record(context, current.supersedesId);
        if (!current || seen.has(current.id)) throw Object.assign(new Error('INVARIANT_VIOLATION'), { code: 'INVARIANT_VIOLATION' });
        seen.add(current.id);
        previous.unshift(current);
      }
      current = start;
      while (current.supersededById) {
        current = await this._record(context, current.supersededById);
        if (!current || seen.has(current.id)) throw Object.assign(new Error('INVARIANT_VIOLATION'), { code: 'INVARIANT_VIOLATION' });
        seen.add(current.id);
        next.push(current);
      }
      return [...previous, start, ...next];
    }
  }

  async listMemories(context, query = {}) {
    if (!this._validate(context).valid) return this._invalid(context, GovernanceOperation.VIEW);
    const repositoryQuery = {
      userId: context.authenticatedUserId,
      limit: Math.min(Number.isInteger(query.limit) ? query.limit : 50, 100),
      cursor: query.cursor || null,
      sort: 'updatedAt:desc'
    };
    if (query.view === 'history') repositoryQuery.includeHistorical = true;
    if (query.view === 'recycle_bin') repositoryQuery.statuses = [MemoryStatus.DELETED];
    if (query.memoryType) repositoryQuery.memoryType = query.memoryType;
    const page = await this.repository.query(this.toRepositoryContext(context), repositoryQuery);
    const items = page.items.map((record) => view(record, this._now()));
    const audit = this._audit(context, GovernanceAuditAction.VIEWED, 'completed', 'MEMORY_GOVERNANCE_LISTED', items.map((item) => item.memoryId));
    return this._result(context, {
      status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.VIEW,
      affectedMemoryIds: items.map((item) => item.memoryId), reversible: false,
      reasonCode: 'MEMORY_GOVERNANCE_LISTED', safeMessage: `已显示 ${items.length} 条记忆。`,
      auditEventId: audit.id, data: { items, nextCursor: page.nextCursor }
    });
  }

  async getMemoryDetails(context, memoryId) {
    if (!this._validate(context).valid) return this._invalid(context, GovernanceOperation.VIEW);
    let record;
    try { record = await this._record(context, memoryId); } catch { record = null; }
    if (!record) return this._result(context, {
      status: GovernanceStatus.NOT_FOUND, operation: GovernanceOperation.VIEW, memoryId,
      reasonCode: 'MEMORY_RECORD_NOT_FOUND', safeMessage: '未找到这条记忆。'
    });
    const audit = this._audit(context, GovernanceAuditAction.VIEWED, 'completed', 'MEMORY_GOVERNANCE_VIEWED', [record.id]);
    return this._result(context, {
      status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.VIEW, memoryId: record.id,
      affectedMemoryIds: [record.id], reasonCode: 'MEMORY_GOVERNANCE_VIEWED', safeMessage: '已显示这条记忆。',
      auditEventId: audit.id, data: view(record, this._now())
    });
  }

  async getMemoryHistory(context, memoryId) {
    if (!this._validate(context).valid) return this._invalid(context, GovernanceOperation.HISTORY);
    try {
      const records = await this._versionChain(context, memoryId);
      const items = records.map((record) => view(record, this._now()));
      const audit = this._audit(context, GovernanceAuditAction.VIEWED, 'completed', 'MEMORY_HISTORY_VIEWED', records.map((record) => record.id));
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.HISTORY, memoryId,
        affectedMemoryIds: records.map((record) => record.id), reasonCode: 'MEMORY_HISTORY_VIEWED',
        safeMessage: `已显示 ${items.length} 个历史版本。`, auditEventId: audit.id, data: { items }
      });
    } catch {
      return this._result(context, { status: GovernanceStatus.NOT_FOUND, operation: GovernanceOperation.HISTORY, memoryId, reasonCode: 'MEMORY_RECORD_NOT_FOUND', safeMessage: '未找到历史记录。' });
    }
  }

  async getConflictCase(context, conflictId) {
    if (!this._validate(context).valid) return this._invalid(context, GovernanceOperation.VIEW);
    try {
      const records = await this.repository.getConflictGroup(this.toRepositoryContext(context), conflictId);
      const conflictCase = deepFreezeGovernance({
        conflictId,
        userId: context.authenticatedUserId,
        memoryIds: records.map((record) => record.id),
        subject: records[0].subject,
        predicate: records[0].predicate,
        conflictType: records[0].memoryType,
        safeSummaries: records.map((record) => ({ memoryId: record.id, safeSummary: safeSummary(record) })),
        detectedAt: records.map((record) => record.createdAt).sort()[0],
        status: records.some((record) => record.metadata?.governanceConflict?.status === 'resolved') ? 'resolved' : 'open',
        availableDecisions: Object.values(GovernanceConflictDecision),
        resolutionReason: records.find((record) => record.metadata?.governanceConflict)?.metadata.governanceConflict.reasonCode || null
      });
      const audit = this._audit(context, GovernanceAuditAction.CONFLICT_OPENED, 'completed', 'MEMORY_CONFLICT_VIEWED', conflictCase.memoryIds);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.VIEW,
        affectedMemoryIds: conflictCase.memoryIds, reasonCode: 'MEMORY_CONFLICT_VIEWED',
        safeMessage: '已显示冲突记忆，请选择如何处理。', auditEventId: audit.id, data: conflictCase
      });
    } catch {
      return this._result(context, { status: GovernanceStatus.NOT_FOUND, operation: GovernanceOperation.VIEW, reasonCode: 'MEMORY_RECORD_NOT_FOUND', safeMessage: '未找到冲突记录。' });
    }
  }

  async resolveConflict(context, conflictId, decision = {}) {
    if (!this._validate(context, { mutation: true }).valid) return this._invalid(context, GovernanceOperation.RESOLVE_CONFLICT);
    if (!Object.values(GovernanceConflictDecision).includes(decision.decision)) {
      return this._result(context, {
        status: GovernanceStatus.REJECTED, operation: GovernanceOperation.RESOLVE_CONFLICT,
        reasonCode: 'MEMORY_CONFLICT_DECISION_INVALID', safeMessage: '请选择一个可用的处理方式。'
      });
    }
    let records;
    try { records = await this.repository.getConflictGroup(this.toRepositoryContext(context), conflictId); } catch (error) {
      return this._failure(context, GovernanceOperation.RESOLVE_CONFLICT, error);
    }
    if (!records.length) return this._failure(context, GovernanceOperation.RESOLVE_CONFLICT, { code: 'MEMORY_RECORD_NOT_FOUND' });
    if (!records.every((record) => Number.isInteger(decision.expectedVersions?.[record.id]))) {
      return this._result(context, {
        status: GovernanceStatus.FAILED, operation: GovernanceOperation.RESOLVE_CONFLICT,
        affectedMemoryIds: records.map((record) => record.id), reasonCode: 'MEMORY_EXPECTED_VERSION_REQUIRED',
        safeMessage: '记忆已发生变化，请刷新后重试。'
      });
    }
    if (decision.decision === GovernanceConflictDecision.KEEP_BOTH && !decision.effectiveRanges) {
      return this._result(context, {
        status: GovernanceStatus.NEEDS_CLARIFICATION, operation: GovernanceOperation.RESOLVE_CONFLICT,
        affectedMemoryIds: records.map((record) => record.id), reasonCode: 'MEMORY_EFFECTIVE_RANGE_REQUIRED',
        safeMessage: '请说明这两条记忆各自适用的时间。'
      });
    }
    if (decision.decision === GovernanceConflictDecision.KEEP_BOTH) {
      const [first, second] = records;
      const firstRange = decision.effectiveRanges[first.id] || {};
      const secondRange = decision.effectiveRanges[second.id] || {};
      const firstEnd = Date.parse(firstRange.effectiveTo || first.effectiveTo || '9999-12-31T23:59:59.999Z');
      const secondStart = Date.parse(secondRange.effectiveFrom || second.effectiveFrom);
      if (!Number.isFinite(firstEnd) || !Number.isFinite(secondStart) || firstEnd >= secondStart) {
        return this._result(context, {
          status: GovernanceStatus.CONFLICT, operation: GovernanceOperation.RESOLVE_CONFLICT,
          affectedMemoryIds: records.map((record) => record.id), reasonCode: 'MEMORY_EFFECTIVE_RANGE_OVERLAP',
          safeMessage: '两条记忆的适用时间仍有重叠，请再确认一次。'
        });
      }
    }
    if (decision.decision === GovernanceConflictDecision.MERGE_AS_NEW_VERSION &&
      (!decision.merged || !Object.hasOwn(decision.merged, 'value'))) {
      return this._result(context, {
        status: GovernanceStatus.NEEDS_CLARIFICATION, operation: GovernanceOperation.RESOLVE_CONFLICT,
        affectedMemoryIds: records.map((record) => record.id), reasonCode: 'MEMORY_MERGED_CONTENT_REQUIRED',
        safeMessage: '请说明合并后的正确内容。'
      });
    }
    try {
      const changed = await this.repository.withTransaction(this.toRepositoryContext(context), async (transaction, transactionContext) => {
        const results = [];
        const optionsFor = (record, reason) => ({
          idempotencyKey: null,
          requestId: context.requestId,
          expectedVersion: decision.expectedVersions[record.id],
          operationReason: reason
        });
        const updateResolution = (record, status, reasonCode) => ({
          metadata: {
            ...structuredClone(record.metadata),
            governanceConflict: { status, reasonCode, resolvedAt: this._now() }
          }
        });
        if ([GovernanceConflictDecision.KEEP_A, GovernanceConflictDecision.KEEP_B].includes(decision.decision)) {
          const winnerIndex = decision.decision === GovernanceConflictDecision.KEEP_A ? 0 : 1;
          for (let index = 0; index < records.length; index += 1) {
            const record = records[index];
            const result = index === winnerIndex
              ? await transaction.update(transactionContext, record.id, updateResolution(record, 'resolved', decision.decision), optionsFor(record, 'conflict_keep'))
              : await transaction.archive(transactionContext, record.id, {}, optionsFor(record, 'conflict_archive'));
            results.push(result);
          }
        } else if (decision.decision === GovernanceConflictDecision.KEEP_BOTH) {
          for (const record of records) {
            const range = decision.effectiveRanges[record.id] || {};
            results.push(await transaction.update(transactionContext, record.id, {
              ...range,
              ...updateResolution(record, 'resolved', 'keep_both')
            }, optionsFor(record, 'conflict_keep_both')));
          }
        } else if (decision.decision === GovernanceConflictDecision.MARK_UNCERTAIN) {
          for (const record of records) results.push(await transaction.dispute(transactionContext, record.id, {}, optionsFor(record, 'conflict_uncertain')));
        } else if (decision.decision === GovernanceConflictDecision.DEFER) {
          for (const record of records) results.push(await transaction.update(transactionContext, record.id,
            updateResolution(record, 'deferred', 'defer'), optionsFor(record, 'conflict_defer')));
        } else if (decision.decision === GovernanceConflictDecision.REJECT_ALL) {
          for (const record of records) results.push(await transaction.archive(transactionContext, record.id, {}, optionsFor(record, 'conflict_reject_all')));
        } else {
          const policy = this.sensitivePolicy.evaluate(text(decision.merged.value));
          if (policy.prohibited) {
            const error = new Error('SECRET_FORBIDDEN');
            error.code = 'SECRET_FORBIDDEN';
            throw error;
          }
          const replacement = this._replacement(context, records[0], decision.merged,
            policy.sensitivity === MemorySensitivity.HIGH ? MemorySensitivity.HIGH : records[0].sensitivity);
          const merged = await transaction.supersede(transactionContext, records[0].id, replacement, optionsFor(records[0], 'conflict_merge'));
          results.push(merged.previous, merged.current);
          for (const record of records.slice(1)) results.push(await transaction.archive(transactionContext, record.id, {}, optionsFor(record, 'conflict_merge_archive')));
        }
        return results;
      }, { transactionId: context.requestId });
      const reasonCode = decision.decision === GovernanceConflictDecision.DEFER ? 'MEMORY_CONFLICT_DEFERRED' : 'MEMORY_CONFLICT_RESOLVED';
      const affectedMemoryIds = [...new Set(changed.map((record) => record.id))];
      const audit = this._audit(context, GovernanceAuditAction.CONFLICT_RESOLVED, 'completed', reasonCode, affectedMemoryIds);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.RESOLVE_CONFLICT,
        affectedMemoryIds, reasonCode,
        safeMessage: decision.decision === GovernanceConflictDecision.DEFER ? '冲突已保留，系统不会强行给出唯一答案。' : '冲突已按你的选择处理。',
        auditEventId: audit.id, data: { records: changed.map(safeMutationRecord) }
      });
    } catch (error) { return this._failure(context, GovernanceOperation.RESOLVE_CONFLICT, error); }
  }

  async listAuditEvents(context, query = {}) {
    if (!this._validate(context).valid) return this._invalid(context, GovernanceOperation.AUDIT);
    const allowed = this.auditEvents.filter((event) => event.userId === context.authenticatedUserId && (!query.action || event.action === query.action));
    const limit = Math.min(Number.isInteger(query.limit) ? query.limit : 50, 100);
    const items = allowed.slice(-limit).reverse();
    return this._result(context, {
      status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.AUDIT,
      affectedMemoryIds: [], reasonCode: 'MEMORY_AUDIT_LISTED', safeMessage: `已显示 ${items.length} 条安全审计记录。`,
      data: { items: deepFreezeGovernance([...items]) }
    });
  }

  async correctMemory(context, memoryId, correction = {}) {
    if (!this._validate(context, { mutation: true }).valid) return this._invalid(context, GovernanceOperation.CORRECT);
    if (!Object.hasOwn(correction, 'value') || correction.value === null || text(correction.value).trim() === '') {
      return this._result(context, {
        status: GovernanceStatus.NEEDS_CLARIFICATION, operation: GovernanceOperation.CORRECT, memoryId,
        reasonCode: 'MEMORY_CORRECTION_CONTENT_REQUIRED', safeMessage: '请说明要纠正成哪项内容。'
      });
    }
    let current;
    try { current = await this._record(context, memoryId); } catch (error) { return this._failure(context, GovernanceOperation.CORRECT, error, memoryId); }
    if (!current) return this._failure(context, GovernanceOperation.CORRECT, { code: 'MEMORY_RECORD_NOT_FOUND' }, memoryId);
    const policy = this.sensitivePolicy.evaluate(text(correction.value));
    if (policy.prohibited) {
      return this._result(context, {
        status: GovernanceStatus.REJECTED, operation: GovernanceOperation.CORRECT, memoryId,
        reasonCode: 'MEMORY_PROHIBITED_SECRET_REJECTED', safeMessage: '认证秘密不能保存为记忆。'
      });
    }
    if (policy.sensitivity === MemorySensitivity.HIGH || ['relationship', 'sensitive_memory'].includes(current.memoryType)) {
      const confirmation = this._confirmation(context, GovernanceOperation.CORRECT, memoryId, correction);
      if (confirmation) {
        this._audit(context, GovernanceAuditAction.CORRECTION_PROPOSED, 'confirmation_required', confirmation.reasonCode, [memoryId]);
        return confirmation;
      }
    }
    try {
      const replacement = this._replacement(context, current, correction, policy.sensitivity === MemorySensitivity.HIGH ? MemorySensitivity.HIGH : current.sensitivity);
      const changed = await this.repository.supersede(this.toRepositoryContext(context), memoryId, replacement, mutationOptions(context, 'governance_correction'));
      const audit = this._audit(context, GovernanceAuditAction.CORRECTED, 'completed', 'MEMORY_CORRECTED', [memoryId, changed.current.id]);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.CORRECT,
        memoryId: changed.current.id, affectedMemoryIds: [memoryId, changed.current.id], reversible: false,
        reasonCode: 'MEMORY_CORRECTED', safeMessage: '记忆已纠正，原内容已保留为历史版本。', auditEventId: audit.id,
        data: { previous: safeMutationRecord(changed.previous), current: safeMutationRecord(changed.current) }
      });
    } catch (error) { return this._failure(context, GovernanceOperation.CORRECT, error, memoryId); }
  }

  async deleteMemory(context, memoryId) {
    if (!this._validate(context, { mutation: true }).valid) return this._invalid(context, GovernanceOperation.DELETE);
    let current;
    try { current = await this._record(context, memoryId); } catch (error) { return this._failure(context, GovernanceOperation.DELETE, error, memoryId); }
    if (!current) return this._failure(context, GovernanceOperation.DELETE, { code: 'MEMORY_RECORD_NOT_FOUND' }, memoryId);
    try {
      if (current.sensitivity === MemorySensitivity.RESTRICTED) {
        await this.repository.purge(this.toRepositoryContext(context), memoryId, mutationOptions(context, 'prohibited_secret'));
        const audit = this._audit(context, GovernanceAuditAction.PURGED, 'completed', 'MEMORY_PROHIBITED_PURGED', [memoryId]);
        return this._result(context, {
          status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.PURGE, memoryId,
          affectedMemoryIds: [memoryId], reasonCode: 'MEMORY_PROHIBITED_PURGED',
          safeMessage: '禁止保存的内容已立即永久清除。', auditEventId: audit.id
        });
      }
      if (current.sensitivity === MemorySensitivity.HIGH) {
        const confirmation = this._confirmation(context, GovernanceOperation.DELETE, memoryId, { version: context.expectedVersion });
        if (confirmation) return confirmation;
      }
      const deleted = await this.repository.moveToRecycleBin(this.toRepositoryContext(context), memoryId, mutationOptions(context, 'user_delete'));
      const undoUntil = deleted.metadata.recycleBin.purgeAfter;
      const audit = this._audit(context, GovernanceAuditAction.DELETED, 'completed', 'MEMORY_MOVED_TO_RECYCLE_BIN', [memoryId]);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.DELETE, memoryId,
        affectedMemoryIds: [memoryId], reversible: true, undoUntil,
        reasonCode: 'MEMORY_MOVED_TO_RECYCLE_BIN', safeMessage: `记忆已删除，可在 ${undoUntil} 前恢复。`, auditEventId: audit.id,
        data: safeMutationRecord(deleted)
      });
    } catch (error) { return this._failure(context, GovernanceOperation.DELETE, error, memoryId); }
  }

  async restoreMemory(context, memoryId) {
    if (!this._validate(context, { mutation: true }).valid) return this._invalid(context, GovernanceOperation.RESTORE);
    try {
      const restored = await this.repository.restore(this.toRepositoryContext(context), memoryId, mutationOptions(context, 'user_restore'));
      const audit = this._audit(context, GovernanceAuditAction.RESTORED, 'completed', 'MEMORY_RESTORED', [memoryId]);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.RESTORE, memoryId,
        affectedMemoryIds: [memoryId], reasonCode: 'MEMORY_RESTORED', safeMessage: '记忆已恢复，并重新按原规则使用。', auditEventId: audit.id,
        data: safeMutationRecord(restored)
      });
    } catch (error) { return this._failure(context, GovernanceOperation.RESTORE, error, memoryId); }
  }

  async purgeMemory(context, memoryId) {
    if (!this._validate(context, { mutation: true }).valid) return this._invalid(context, GovernanceOperation.PURGE);
    let current;
    try { current = await this._record(context, memoryId); } catch (error) { return this._failure(context, GovernanceOperation.PURGE, error, memoryId); }
    if (!current) return this._failure(context, GovernanceOperation.PURGE, { code: 'MEMORY_RECORD_NOT_FOUND' }, memoryId);
    const confirmation = this._confirmation(context, GovernanceOperation.PURGE, memoryId, { version: context.expectedVersion });
    if (confirmation) return confirmation;
    try {
      await this.repository.purge(this.toRepositoryContext(context), memoryId, mutationOptions(context, 'user_permanent_delete'));
      const audit = this._audit(context, GovernanceAuditAction.PURGED, 'completed', 'MEMORY_PERMANENTLY_PURGED', [memoryId]);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.PURGE, memoryId,
        affectedMemoryIds: [memoryId], reversible: false, reasonCode: 'MEMORY_PERMANENTLY_PURGED',
        safeMessage: '记忆已永久删除，无法恢复。', auditEventId: audit.id
      });
    } catch (error) { return this._failure(context, GovernanceOperation.PURGE, error, memoryId); }
  }

  async updateSensitivity(context, memoryId, options = {}) {
    if (!this._validate(context, { mutation: true }).valid) return this._invalid(context, GovernanceOperation.CHANGE_SENSITIVITY);
    let target;
    try { target = governanceSensitivityToKernel(options.sensitivity); } catch {
      return this._result(context, {
        status: GovernanceStatus.REJECTED, operation: GovernanceOperation.CHANGE_SENSITIVITY, memoryId,
        reasonCode: 'MEMORY_SENSITIVITY_INVALID', safeMessage: '不能使用这个敏感等级。'
      });
    }
    let current;
    try { current = await this._record(context, memoryId); } catch (error) { return this._failure(context, GovernanceOperation.CHANGE_SENSITIVITY, error, memoryId); }
    if (!current) return this._failure(context, GovernanceOperation.CHANGE_SENSITIVITY, { code: 'MEMORY_RECORD_NOT_FOUND' }, memoryId);
    if (current.sensitivity === MemorySensitivity.RESTRICTED) {
      try {
        await this.repository.purge(this.toRepositoryContext(context), memoryId, mutationOptions(context, 'prohibited_secret'));
        const audit = this._audit(context, GovernanceAuditAction.PURGED, 'completed', 'MEMORY_PROHIBITED_PURGED', [memoryId]);
        return this._result(context, {
          status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.PURGE, memoryId,
          affectedMemoryIds: [memoryId], reasonCode: 'MEMORY_PROHIBITED_PURGED',
          safeMessage: '禁止保存的内容已立即永久清除，不能降低保护级别。', auditEventId: audit.id
        });
      } catch (error) { return this._failure(context, GovernanceOperation.CHANGE_SENSITIVITY, error, memoryId); }
    }
    if (SENSITIVITY_RANK[target] < SENSITIVITY_RANK[current.sensitivity]) {
      const confirmation = this._confirmation(context, GovernanceOperation.CHANGE_SENSITIVITY, memoryId, options);
      if (confirmation) return confirmation;
    }
    try {
      const updated = await this.repository.update(this.toRepositoryContext(context), memoryId, { sensitivity: target }, mutationOptions(context, 'governance_sensitivity'));
      const audit = this._audit(context, GovernanceAuditAction.SENSITIVITY_CHANGED, 'completed', 'MEMORY_SENSITIVITY_CHANGED', [memoryId]);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.CHANGE_SENSITIVITY, memoryId,
        affectedMemoryIds: [memoryId], reasonCode: 'MEMORY_SENSITIVITY_CHANGED',
        safeMessage: '记忆的隐私保护级别已更新。', auditEventId: audit.id, data: safeMutationRecord(updated)
      });
    } catch (error) { return this._failure(context, GovernanceOperation.CHANGE_SENSITIVITY, error, memoryId); }
  }

  async updateAccessPolicy(context, memoryId, options = {}) {
    if (!this._validate(context, { mutation: true }).valid) return this._invalid(context, GovernanceOperation.CHANGE_ACCESS);
    if (!['private', 'assistant_only', 'task_scoped', 'explicitly_shared', 'archived_only'].includes(options.mode)) {
      return this._result(context, { status: GovernanceStatus.REJECTED, operation: GovernanceOperation.CHANGE_ACCESS, memoryId, reasonCode: 'MEMORY_ACCESS_POLICY_INVALID', safeMessage: '不能使用这个访问范围。' });
    }
    if (options.mode === 'task_scoped' && (!Array.isArray(options.taskScopes) || options.taskScopes.length === 0)) {
      return this._result(context, { status: GovernanceStatus.NEEDS_CLARIFICATION, operation: GovernanceOperation.CHANGE_ACCESS, memoryId, reasonCode: 'MEMORY_TASK_SCOPE_REQUIRED', safeMessage: '请说明这条记忆可以用于哪类任务。' });
    }
    let current;
    try { current = await this._record(context, memoryId); } catch (error) { return this._failure(context, GovernanceOperation.CHANGE_ACCESS, error, memoryId); }
    if (!current) return this._failure(context, GovernanceOperation.CHANGE_ACCESS, { code: 'MEMORY_RECORD_NOT_FOUND' }, memoryId);
    const currentMode = current.accessPolicy?.governanceMode || 'private';
    if (ACCESS_RANK[options.mode] > ACCESS_RANK[currentMode]) {
      const confirmation = this._confirmation(context, GovernanceOperation.CHANGE_ACCESS, memoryId, options);
      if (confirmation) return confirmation;
    }
    try {
      const updated = await this.repository.update(this.toRepositoryContext(context), memoryId, { accessPolicy: accessPolicy(options) }, mutationOptions(context, 'governance_access'));
      const audit = this._audit(context, GovernanceAuditAction.ACCESS_CHANGED, 'completed', 'MEMORY_ACCESS_POLICY_CHANGED', [memoryId]);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.CHANGE_ACCESS, memoryId,
        affectedMemoryIds: [memoryId], reasonCode: 'MEMORY_ACCESS_POLICY_CHANGED',
        safeMessage: '记忆的使用范围已更新。', auditEventId: audit.id, data: safeMutationRecord(updated)
      });
    } catch (error) { return this._failure(context, GovernanceOperation.CHANGE_ACCESS, error, memoryId); }
  }

  async batchGovern(context, request = {}) {
    if (!this._validate(context, { mutation: true }).valid) return this._invalid(context, GovernanceOperation.BATCH);
    const allowed = ['archive', 'delete', 'restore', 'tag'];
    if (!allowed.includes(request.operation) || !Array.isArray(request.memoryIds) || request.memoryIds.length === 0 || request.memoryIds.length > 100) {
      return this._result(context, {
        status: GovernanceStatus.REJECTED, operation: GovernanceOperation.BATCH,
        reasonCode: 'MEMORY_BATCH_OPERATION_REJECTED', safeMessage: '这项批量操作不受支持。'
      });
    }
    if (!request.memoryIds.every((id) => Number.isInteger(request.expectedVersions?.[id]))) {
      return this._result(context, {
        status: GovernanceStatus.FAILED, operation: GovernanceOperation.BATCH,
        reasonCode: 'MEMORY_EXPECTED_VERSION_REQUIRED', safeMessage: '记忆已发生变化，请刷新后重试。'
      });
    }
    if (request.operation === 'delete') {
      const confirmation = this._confirmation(context, GovernanceOperation.BATCH, request.memoryIds.join(','), request);
      if (confirmation) return confirmation;
    }
    try {
      const existing = [];
      for (const id of request.memoryIds) {
        const record = await this._record(context, id);
        if (!record) throw Object.assign(new Error('MEMORY_RECORD_NOT_FOUND'), { code: 'MEMORY_RECORD_NOT_FOUND' });
        existing.push(record);
      }
      const records = await this.repository.withTransaction(this.toRepositoryContext(context), async (transaction, transactionContext) => {
        const changed = [];
        for (const record of existing) {
          const options = {
            idempotencyKey: null, requestId: context.requestId,
            expectedVersion: request.expectedVersions[record.id], operationReason: `governance_batch_${request.operation}`
          };
          if (request.operation === 'archive') changed.push(await transaction.archive(transactionContext, record.id, {}, options));
          if (request.operation === 'delete') changed.push(await transaction.moveToRecycleBin(transactionContext, record.id, options));
          if (request.operation === 'restore') changed.push(await transaction.restore(transactionContext, record.id, options));
          if (request.operation === 'tag') changed.push(await transaction.update(transactionContext, record.id, {
            tags: [...new Set([...(record.tags || []), ...(Array.isArray(request.tags) ? request.tags : [])])]
          }, options));
        }
        return changed;
      }, { transactionId: context.requestId });
      const auditAction = request.operation === 'delete' ? GovernanceAuditAction.DELETED : GovernanceAuditAction.VIEWED;
      const audit = this._audit(context, auditAction, 'completed', `MEMORY_BATCH_${request.operation.toUpperCase()}_COMPLETED`, request.memoryIds);
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.BATCH,
        affectedMemoryIds: request.memoryIds, reversible: request.operation === 'delete',
        reasonCode: `MEMORY_BATCH_${request.operation.toUpperCase()}_COMPLETED`,
        safeMessage: `已完成 ${records.length} 条记忆的批量处理。`, auditEventId: audit.id,
        data: { count: records.length, records: records.map(safeMutationRecord) }
      });
    } catch (error) {
      return this._result(context, {
        status: GovernanceStatus.FAILED, operation: GovernanceOperation.BATCH,
        affectedMemoryIds: [], reasonCode: error?.code || 'MEMORY_BATCH_ATOMICITY_FAILED',
        safeMessage: '批量操作未完成，所有记忆均保持原状。'
      });
    }
  }

  async exportMemories(context, options = {}) {
    if (!this._validate(context).valid) return this._invalid(context, GovernanceOperation.EXPORT);
    if (!['json', 'markdown'].includes(options.format)) {
      return this._result(context, {
        status: GovernanceStatus.REJECTED, operation: GovernanceOperation.EXPORT,
        reasonCode: 'MEMORY_EXPORT_FORMAT_UNSUPPORTED', safeMessage: '请选择 JSON 或 Markdown 格式。'
      });
    }
    if (options.includeHighSensitivity) {
      const confirmation = this._confirmation(context, GovernanceOperation.EXPORT, 'all', options);
      if (confirmation) {
        this._audit(context, GovernanceAuditAction.EXPORT_REQUESTED, 'confirmation_required', confirmation.reasonCode);
        return confirmation;
      }
    }
    try {
      const repositoryContext = this.toRepositoryContext(context);
      const collected = [];
      let cursor = null;
      do {
        const page = await this.repository.query(repositoryContext, {
          userId: context.authenticatedUserId, limit: 100, cursor, sort: 'createdAt:asc'
        });
        collected.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      if (options.includeHistorical) {
        cursor = null;
        do {
          const page = await this.repository.query(repositoryContext, {
            userId: context.authenticatedUserId,
            statuses: [MemoryStatus.DISPUTED, MemoryStatus.SUPERSEDED, MemoryStatus.EXPIRED, MemoryStatus.ARCHIVED],
            includeHistorical: true, limit: 100, cursor, sort: 'createdAt:asc'
          });
          collected.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
      }
      if (options.includeDeleted) {
        cursor = null;
        do {
          const page = await this.repository.query(repositoryContext, {
            userId: context.authenticatedUserId, statuses: [MemoryStatus.DELETED],
            limit: 100, cursor, sort: 'createdAt:asc'
          });
          collected.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
      }
      const unique = [...new Map(collected.map((record) => [record.id, record])).values()]
        .filter((record) => record.sensitivity !== MemorySensitivity.RESTRICTED)
        .filter((record) => options.includeHighSensitivity || record.sensitivity !== MemorySensitivity.HIGH);
      const memories = unique.map((record) => ({
        id: record.id,
        memoryType: record.memoryType,
        subject: structuredClone(record.subject),
        predicate: record.predicate,
        value: structuredClone(record.value),
        normalizedValue: structuredClone(record.normalizedValue),
        source: { type: record.source.type, id: record.source.id },
        sourceTimestamp: record.sourceTimestamp,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        effectiveFrom: record.effectiveFrom,
        effectiveTo: record.effectiveTo,
        status: record.status,
        confirmationStatus: record.confirmationStatus,
        sensitivity: kernelSensitivityToGovernance(record.sensitivity),
        accessPolicy: structuredClone(record.accessPolicy),
        version: record.version,
        supersedesId: record.supersedesId,
        supersededById: record.supersededById,
        conflictGroupId: record.conflictGroupId
      }));
      const document = {
        formatVersion: 'memory-export-v1',
        userId: context.authenticatedUserId,
        generatedAt: this._now(),
        warning: 'Export files are not encrypted. Store them safely.',
        memories
      };
      const content = options.format === 'json'
        ? `${JSON.stringify(document, null, 2)}\n`
        : [
            '# Memory Export', '',
            `Generated: ${document.generatedAt}`,
            '', '> This export is not encrypted. Store it safely.', '',
            ...memories.flatMap((record) => [
              `## ${record.id}`, '',
              `- Type: ${record.memoryType}`,
              `- Status: ${record.status}`,
              `- Sensitivity: ${record.sensitivity}`,
              `- Source: ${record.source.type} (${record.sourceTimestamp})`,
              `- Version: ${record.version}`,
              `- Value: ${text(record.value).replace(/\r?\n/g, ' ')}`, ''
            ])
          ].join('\n');
      await mkdir(this.exportDirectory, { recursive: true, mode: 0o700 });
      const extension = options.format === 'json' ? 'json' : 'md';
      const fileName = `memory-export-${this.idFactory()}.${extension}`;
      await writeFile(join(this.exportDirectory, fileName), content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const audit = this._audit(context, GovernanceAuditAction.EXPORT_COMPLETED, 'completed', 'MEMORY_EXPORT_COMPLETED', memories.map((record) => record.id));
      return this._result(context, {
        status: GovernanceStatus.COMPLETED, operation: GovernanceOperation.EXPORT,
        affectedMemoryIds: memories.map((record) => record.id), warnings: ['export_not_encrypted'],
        reasonCode: 'MEMORY_EXPORT_COMPLETED', safeMessage: `已导出 ${memories.length} 条记忆。请妥善保管未加密文件。`,
        auditEventId: audit.id,
        data: { format: options.format, fileName, itemCount: memories.length, content, encrypted: false }
      });
    } catch (error) { return this._failure(context, GovernanceOperation.EXPORT, error); }
  }
}
