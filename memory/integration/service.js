import { randomUUID } from 'node:crypto';

import { CaptureIntent, CaptureOutcome, CaptureReasonCode } from '../capture/index.js';
import { GovernanceOperation } from '../governance/index.js';
import { MemoryRecallIntent } from '../recall/index.js';
import { relationshipNoMatchMessage } from '../recall/entity.js';
import { MemoryIntegrationAudit } from './audit.js';

const EXPLICIT_MEMORY = /^(?:(?:请|帮我)\s*)?(?:记住|以后记得|保存(?:一下)?|记一下)/;
const SHORT_OPT_OUT = /^(?:不要记这个|别记这个|这个不要记)[。！!\s]*$/;
const REFERENCE_ONLY_REMEMBER = /^(?:把)?(?:刚才|上面|这件事|这条)(?:说的|提到的)?(?:内容|事情|这件事|这条)?记(?:住|下来)[。！!\s]*$/;
const NON_EXPLICIT_PREFERENCE_CHANGE = /^(?:我现在|以后我).*(?:不再|不喝|不吃|不用|改成|换成).*/;
const TASK_ORIENTED_RECALL = /(?:按我的|根据我的|结合我的|帮我|替我).*(?:写|生成|制定|推荐|整理|规划|介绍)/;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

function emptyContext() { return { items: [], warnings: [], provenance: [] }; }

function safeCandidateSummary(candidate) {
  if (candidate?.proposedMemory?.sensitivity === 'high') return '存在一条高敏感记忆，确认后才会长期保存。';
  const value = typeof candidate?.proposedMemory?.value === 'string'
    ? candidate.proposedMemory.value.replace(/\s+/g, ' ').trim()
    : '';
  return value.replace(/^我(?:平时|通常)?/, '').slice(0, 80) || '存在一条待确认记忆。';
}

function confirmationFailure(error) {
  if (error?.code === 'MEMORY_VERSION_CONFLICT') {
    return {
      status: 'conflict',
      reasonCode: 'MEMORY_VERSION_CONFLICT',
      safeMessage: '这条记忆已发生变化，请重新发起确认。'
    };
  }
  return {
    status: 'failed',
    reasonCode: error?.code || 'MEMORY_CONFIRMATION_FAILED',
    safeMessage: '确认未完成，请稍后重试。'
  };
}

function featureDisabled(message = '永久记忆暂未开启。') {
  return { status: 'disabled', reasonCode: 'MEMORY_FEATURE_DISABLED', safeMessage: message };
}

function safeCaptureResult(result) {
  if (result.outcome === CaptureOutcome.STORED) {
    const proactive = result.reasonCode === CaptureReasonCode.PROACTIVE_HIGH_VALUE_AUTHORIZED;
    let value = proactive && typeof result.memory?.value === 'string'
      ? result.memory.value.replace(/^我/, '你').slice(0, 100)
      : '';
    if (result.memory?.predicate === 'birthday' && value.includes('农历')) value = value.replace(/日$/, '');
    return {
      enabled: true,
      handled: true,
      status: 'stored',
      reasonCode: result.reasonCode,
      safeMessage: proactive ? `我记住了：${value}。` : '已永久保存',
      memoryId: result.memory.id,
      memoryContext: emptyContext()
    };
  }
  if (result.reasonCode === CaptureReasonCode.PROHIBITED_SECRET) {
    return {
      enabled: true,
      handled: true,
      status: 'rejected',
      reasonCode: result.reasonCode,
      safeMessage: '认证秘密不能保存为永久记忆。',
      memoryId: null,
      memoryContext: emptyContext()
    };
  }
  if (result.intent === CaptureIntent.FORGET && result.outcome === CaptureOutcome.REJECTED) {
    return {
      enabled: true,
      handled: true,
      status: 'needs_clarification',
      reasonCode: result.reasonCode,
      safeMessage: '请说明要忘掉哪一条记忆。',
      memoryId: null,
      memoryContext: emptyContext()
    };
  }
  return null;
}

export class MemoryRealUserService {
  constructor({
    contextFactory,
    flags,
    capture,
    recall,
    governance,
    timeline,
    intelligence,
    audit = new MemoryIntegrationAudit(),
    clock = () => new Date(),
    idFactory = randomUUID
  } = {}) {
    Object.assign(this, { contextFactory, flags, capture, recall, governance, timeline, intelligence, audit, clock, idFactory });
    this.confirmations = new Map();
    this.confirmationResults = new Map();
    this.confirmationInFlight = new Map();
    this.conversationEntities = new Map();
  }

  _now() {
    const value = this.clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  _flags(user) { return this.flags.evaluate(user); }

  _audit(user, request, action, result, reasonCode, memoryId = null, metadata = {}) {
    return this.audit.record({
      userId: user.id,
      action,
      result,
      reasonCode,
      memoryId,
      requestId: request?.requestId || '',
      metadata
    });
  }

  getStatus(user) {
    const flags = this._flags(user);
    return { enabled: flags.MEMORY_REAL_USER_ENABLED, flags };
  }

  _confirmationKey(userId, confirmationId) {
    return `${userId}:${String(confirmationId || '')}`;
  }

  _conversationEntityKey(user, request) {
    const conversationId = String(request?.conversationId || '').trim();
    return conversationId ? `${user.id}:${conversationId}` : null;
  }

  _conversationEntity(user, request) {
    const key = this._conversationEntityKey(user, request);
    return key ? this.conversationEntities.get(key) || null : null;
  }

  _rememberConversationEntity(user, request, entityQuery) {
    const key = this._conversationEntityKey(user, request);
    if (!key || entityQuery?.status !== 'exact') return;
    this.conversationEntities.set(key, entityQuery);
  }

  _registerConfirmation(user, capture) {
    const confirmationId = `memory-confirm-${this.idFactory()}`;
    const expiresAt = new Date(Date.parse(this._now()) + CONFIRMATION_TTL_MS).toISOString();
    this.confirmations.set(confirmationId, {
      userId: user.id,
      candidate: capture.candidate,
      expiresAt
    });
    return {
      enabled: true,
      handled: true,
      status: 'confirmation_required',
      reasonCode: capture.reasonCode,
      safeMessage: capture.reasonCode === CaptureReasonCode.CONFLICT_CONFIRMATION_REQUIRED
        ? '发现与现有记忆不一致，需要确认，尚未保存。'
        : '需要确认，尚未保存。',
      safeSummary: safeCandidateSummary(capture.candidate),
      memoryType: capture.candidate.proposedMemory.memoryType,
      sensitivity: capture.candidate.proposedMemory.sensitivity,
      longTerm: true,
      confirmationRequired: true,
      confirmationId,
      expiresAt,
      memoryContext: emptyContext()
    };
  }

  async processConversation(user, request = {}) {
    const repositoryContext = this.contextFactory.repository(user, request);
    const flags = this._flags(user);
    if (!flags.MEMORY_REAL_USER_ENABLED) {
      return { enabled: false, handled: false, status: 'disabled', reasonCode: 'MEMORY_REAL_USER_DISABLED', safeMessage: '', memoryContext: emptyContext() };
    }

    const input = String(request.input || '').trim();
    const captureIntent = typeof this.capture?.analyzeIntent === 'function'
      ? this.capture.analyzeIntent(input)
      : null;
    const captureWasRequested = EXPLICIT_MEMORY.test(input) || Boolean(
      captureIntent?.directSaveAuthorized ||
      captureIntent?.intent === CaptureIntent.LONG_TERM_MEMORY
    );
    if (SHORT_OPT_OUT.test(input)) {
      this._audit(user, request, 'memory_capture_opted_out', 'completed', 'MEMORY_USER_OPTED_OUT');
      return {
        enabled: true, handled: true, status: 'opted_out', reasonCode: 'MEMORY_USER_OPTED_OUT',
        safeMessage: '好的，这条内容不会保存为长期记忆。', memoryContext: emptyContext()
      };
    }
    if (REFERENCE_ONLY_REMEMBER.test(input)) {
      this._audit(user, request, 'memory_clarification_requested', 'needs_clarification', 'MEMORY_TARGET_AMBIGUOUS');
      return {
        enabled: true, handled: true, status: 'needs_clarification', reasonCode: 'MEMORY_TARGET_AMBIGUOUS',
        safeMessage: '请告诉我要记住的具体内容。', memoryContext: emptyContext()
      };
    }
    if (NON_EXPLICIT_PREFERENCE_CHANGE.test(input) && !EXPLICIT_MEMORY.test(input)) {
      this._audit(user, request, 'memory_clarification_requested', 'needs_clarification', 'MEMORY_UPDATE_AUTHORIZATION_REQUIRED');
      return {
        enabled: true, handled: true, status: 'needs_clarification', reasonCode: 'MEMORY_UPDATE_AUTHORIZATION_REQUIRED',
        safeMessage: '要把这项变化作为新的长期偏好保存吗？', memoryContext: emptyContext()
      };
    }
    if (!flags.MEMORY_CAPTURE_ENABLED && captureWasRequested) {
      this._audit(user, request, 'memory_capture_disabled', 'disabled', 'MEMORY_CAPTURE_DISABLED');
      return {
        enabled: true, handled: true, status: 'disabled', reasonCode: 'MEMORY_CAPTURE_DISABLED',
        safeMessage: '永久记忆保存暂未开启，这条内容未保存。', memoryContext: emptyContext()
      };
    }

    if (flags.MEMORY_CAPTURE_ENABLED) {
      try {
        const capture = await this.capture.capture(repositoryContext, {
          text: input,
          sourceId: String(request.sourceId || repositoryContext.requestId),
          sourceTimestamp: repositoryContext.timestamp,
          idempotencyKey: request.idempotencyKey || repositoryContext.requestId,
          targetMemoryId: request.targetMemoryId,
          expectedVersion: request.expectedVersion
        });
        const safe = safeCaptureResult(capture);
        if (safe) {
          this._audit(user, request, 'memory_capture_completed', safe.status, safe.reasonCode, safe.memoryId);
          return safe;
        }
        if (capture.outcome === CaptureOutcome.CANDIDATE && capture.requiresConfirmation) {
          this._audit(user, request, 'memory_confirmation_required', 'confirmation_required', capture.reasonCode);
          return this._registerConfirmation(user, capture);
        }
      } catch {
        this._audit(user, request, 'memory_capture_failed', 'failed', 'MEMORY_CAPTURE_UNAVAILABLE');
        return {
          enabled: true, handled: captureWasRequested, status: 'degraded', reasonCode: 'MEMORY_CAPTURE_UNAVAILABLE',
          safeMessage: captureWasRequested
            ? '永久记忆暂时不可用，这条内容未保存。'
            : '永久记忆暂时不可用，当前对话仍可继续。',
          memoryContext: emptyContext()
        };
      }
    }

    if (!flags.MEMORY_RECALL_ENABLED) {
      return { enabled: true, handled: false, status: 'recall_disabled', reasonCode: 'MEMORY_RECALL_DISABLED', safeMessage: '', memoryContext: emptyContext() };
    }

    const recallContext = this.contextFactory.recall(user, request);
    const recalled = await this.recall.recall(recallContext, {
      text: input,
      conversationEntity: this._conversationEntity(user, request)
    });
    if (!recalled.ok) {
      this._audit(user, request, 'memory_recall_failed', 'failed', recalled.error?.code || 'MEMORY_RECALL_UNAVAILABLE');
      const recallWasRequested = Boolean(recalled.intent?.intent) && ![
        MemoryRecallIntent.NO_MEMORY_NEEDED,
        MemoryRecallIntent.AMBIGUOUS
      ].includes(recalled.intent.intent);
      return {
        enabled: true, handled: recallWasRequested, status: 'degraded', reasonCode: recalled.error?.code || 'MEMORY_RECALL_UNAVAILABLE',
        safeMessage: recallWasRequested
          ? '记忆服务暂时不可用，暂时无法确认你之前保存的内容。'
          : '记忆暂时不可用，当前对话仍可继续。',
        memoryContext: emptyContext()
      };
    }
    if (recalled.intent.intent === MemoryRecallIntent.AMBIGUOUS) {
      return {
        enabled: true, handled: true, status: 'needs_clarification', reasonCode: recalled.intent.reasonCode,
        safeMessage: recalled.intent.clarificationQuestion, memoryContext: emptyContext()
      };
    }
    this._rememberConversationEntity(user, request, recalled.intent.entityQuery);
    const pack = this.recall.buildContextPack(recallContext, recalled, recallContext.contextBudget);
    const memoryContext = {
      items: pack.memoryItems.map((item) => ({
        memoryId: item.memoryId,
        safeText: item.safeText,
        summary: item.safeText,
        sourceType: item.sourceType,
        sourceTimestamp: item.sourceTimestamp,
        confidence: item.confidence,
        importance: item.importance,
        sensitivity: item.sensitivity,
        version: item.version,
        isDerivedSummary: item.isDerivedSummary
      })),
      warnings: pack.warnings,
      provenance: pack.provenance
    };
    if (memoryContext.items.length) {
      this._audit(user, request, 'memory_recalled', 'completed', 'MEMORY_RECALL_SELECTED', null, { selectedCount: memoryContext.items.length });
      const taskOriented = TASK_ORIENTED_RECALL.test(input);
      const proactive = recalled.selected.some((item) => (
        item.record?.metadata?.capture?.reasonCode === CaptureReasonCode.PROACTIVE_HIGH_VALUE_SIGNAL
      ));
      const safeText = memoryContext.items.map((item) => item.safeText.replace(/^我/, '你')).join('；');
      return {
        enabled: true,
        handled: !taskOriented,
        status: 'recalled',
        reasonCode: 'MEMORY_RECALL_SELECTED',
        safeMessage: taskOriented ? '' : proactive ? `我记得：${safeText}` : `你之前让我记住：${safeText}`,
        memoryContext
      };
    }
    if (recalled.intent.entityQuery?.status === 'exact') {
      this._audit(user, request, 'memory_recall_empty', 'empty', 'MEMORY_RECALL_NO_EXACT_ENTITY_MATCH');
      return {
        enabled: true,
        handled: true,
        status: 'no_matching_memory',
        reasonCode: 'MEMORY_RECALL_NO_EXACT_ENTITY_MATCH',
        safeMessage: relationshipNoMatchMessage(recalled.intent.entityQuery),
        memoryContext
      };
    }
    this._audit(user, request, 'memory_recall_empty', 'empty', 'MEMORY_RECALL_EMPTY');
    return { enabled: true, handled: false, status: 'empty', reasonCode: 'MEMORY_RECALL_EMPTY', safeMessage: '', memoryContext };
  }

  async confirmCapture(user, request = {}) {
    const context = this.contextFactory.repository(user, request);
    const flags = this._flags(user);
    if (!flags.MEMORY_CAPTURE_ENABLED) return featureDisabled('永久记忆保存暂未开启，未进行保存。');
    const key = this._confirmationKey(user.id, request.confirmationId);
    if (this.confirmationResults.has(key)) return structuredClone(this.confirmationResults.get(key));
    if (this.confirmationInFlight.has(key)) return this.confirmationInFlight.get(key);
    const pending = this.confirmations.get(request.confirmationId);
    if (!pending || pending.userId !== user.id || Date.parse(pending.expiresAt) <= Date.parse(this._now())) {
      if (pending?.userId === user.id) this.confirmations.delete(request.confirmationId);
      return {
        status: 'expired',
        reasonCode: 'MEMORY_CONFIRMATION_INVALID_OR_EXPIRED',
        safeMessage: '确认无效或已过期，请重新发起。'
      };
    }
    if (!['confirm', 'edit', 'cancel'].includes(request.action)) {
      return { status: 'rejected', reasonCode: 'MEMORY_CONFIRMATION_ACTION_INVALID', safeMessage: '请选择确认保存、修改或取消。' };
    }
    const operation = (async () => {
      try {
        if (request.action === 'cancel') {
          const cancelled = { status: 'cancelled', reasonCode: 'MEMORY_CONFIRMATION_CANCELLED', safeMessage: '已取消，内容未保存。' };
          this._audit(user, request, 'memory_confirmation_cancelled', 'completed', cancelled.reasonCode);
          return cancelled;
        }
        if (request.action === 'edit') {
          const editedText = String(request.editedText || '').trim();
          if (!editedText) return { status: 'rejected', reasonCode: 'MEMORY_CONFIRMATION_EDIT_REQUIRED', safeMessage: '请输入修改后的内容。' };
          const editedCapture = await this.capture.capture(context, {
            text: `记住${editedText}`,
            sourceId: pending.candidate.source.id,
            sourceTimestamp: context.timestamp,
            idempotencyKey: `${request.confirmationId}:edit`
          });
          const safe = safeCaptureResult(editedCapture);
          if (safe) return safe;
          if (editedCapture.outcome === CaptureOutcome.CANDIDATE && editedCapture.requiresConfirmation) {
            this._audit(user, request, 'memory_confirmation_edited', 'confirmation_required', editedCapture.reasonCode);
            return this._registerConfirmation(user, editedCapture);
          }
          return { status: 'rejected', reasonCode: editedCapture.reasonCode, safeMessage: '修改后的内容未通过安全校验，未保存。' };
        }
        const result = await this.capture.confirm(context, pending.candidate, {
          requestId: context.requestId,
          idempotencyKey: request.idempotencyKey || `memory-confirm:${request.confirmationId}`
        });
        this._audit(user, request, 'memory_capture_confirmed', result.ok ? 'completed' : 'failed', result.reasonCode, result.memory?.id || null);
        return result.ok
          ? { status: 'stored', reasonCode: result.reasonCode, safeMessage: '已永久保存', memoryId: result.memory.id }
          : { status: 'rejected', reasonCode: result.reasonCode, safeMessage: '这条记忆未保存。' };
      } catch (error) {
        const failed = confirmationFailure(error);
        this._audit(user, request, 'memory_capture_confirmed', 'failed', failed.reasonCode);
        return failed;
      } finally {
        this.confirmations.delete(request.confirmationId);
      }
    })();
    this.confirmationInFlight.set(key, operation);
    const result = await operation;
    this.confirmationInFlight.delete(key);
    this.confirmationResults.set(key, structuredClone(result));
    return result;
  }

  _governanceContext(user, operation, request = {}) {
    return this.contextFactory.governance(user, { ...request, operation });
  }

  _governanceEnabled(user) { return this._flags(user).MEMORY_GOVERNANCE_ENABLED; }

  listMemories(user, query = {}) {
    if (!this._governanceEnabled(user)) return featureDisabled('记忆管理暂未开启。');
    return this.governance.listMemories(this._governanceContext(user, GovernanceOperation.VIEW, query), query);
  }

  getMemoryDetails(user, memoryId, request = {}) {
    if (!this._governanceEnabled(user)) return featureDisabled('记忆管理暂未开启。');
    return this.governance.getMemoryDetails(this._governanceContext(user, GovernanceOperation.VIEW, request), memoryId);
  }

  getMemoryHistory(user, memoryId, request = {}) {
    if (!this._governanceEnabled(user)) return featureDisabled('记忆管理暂未开启。');
    return this.governance.getMemoryHistory(this._governanceContext(user, GovernanceOperation.HISTORY, request), memoryId);
  }

  correctMemory(user, memoryId, request = {}) {
    if (!this._governanceEnabled(user)) return featureDisabled('记忆管理暂未开启。');
    return this.governance.correctMemory(
      this._governanceContext(user, GovernanceOperation.CORRECT, request), memoryId, { value: request.value }
    );
  }

  deleteMemory(user, memoryId, request = {}) {
    if (!this._governanceEnabled(user)) return featureDisabled('记忆管理暂未开启。');
    return this.governance.deleteMemory(this._governanceContext(user, GovernanceOperation.DELETE, request), memoryId);
  }

  restoreMemory(user, memoryId, request = {}) {
    if (!this._governanceEnabled(user)) return featureDisabled('记忆管理暂未开启。');
    return this.governance.restoreMemory(this._governanceContext(user, GovernanceOperation.RESTORE, request), memoryId);
  }

  purgeMemory(user, memoryId, request = {}) {
    if (!this._governanceEnabled(user)) return featureDisabled('记忆管理暂未开启。');
    return this.governance.purgeMemory(this._governanceContext(user, GovernanceOperation.PURGE, request), memoryId);
  }

  async getTimeline(user, query = {}) {
    if (!this._flags(user).MEMORY_TIMELINE_ENABLED) return { ok: false, reasonCode: 'MEMORY_TIMELINE_DISABLED', events: [], periods: [] };
    return this.timeline.query(this.contextFactory.timeline(user, query), query);
  }

  async getIntelligence(user, query = {}) {
    if (!this._flags(user).MEMORY_INTELLIGENCE_ENABLED) return { ok: false, reasonCode: 'MEMORY_INTELLIGENCE_DISABLED', insights: [], suggestions: [] };
    const timeline = await this.getTimeline(user, query);
    if (!timeline.ok) return { ok: false, reasonCode: timeline.reasonCode, insights: [], suggestions: [] };
    return this.intelligence.analyze(this.contextFactory.timeline(user, { ...query, purpose: 'life_intelligence' }), timeline);
  }

  listAuditEvents(user) {
    this.contextFactory.repository(user);
    return this.audit.list(user.id);
  }
}
