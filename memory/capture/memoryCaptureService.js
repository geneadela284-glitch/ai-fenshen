import {
  MemoryConfirmation,
  MemorySourceType,
  MemoryStatus,
  validateMemoryCandidate,
  validateMemoryRecord,
  validateMemoryRepositoryInterface
} from '../kernel/index.js';
import { validateRepositoryContext } from '../repository/index.js';
import { CaptureAudit } from './captureAudit.js';
import { captureChecksum, MemoryCandidateBuilder } from './memoryCandidateBuilder.js';
import { MemoryIntentAnalyzer } from './memoryIntentAnalyzer.js';
import { ConfirmationPolicy, MemoryCapturePolicy, SensitivePolicy } from './policies.js';
import {
  CaptureIntent,
  CaptureOutcome,
  CaptureReasonCode,
  ConfirmationDecision,
  createCaptureResult
} from './contracts.js';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function repositoryOptions(context, options, operationReason) {
  return {
    idempotencyKey: options?.idempotencyKey ?? null,
    requestId: options?.requestId || context.requestId,
    expectedVersion: options?.expectedVersion ?? null,
    operationReason
  };
}

export class MemoryCaptureService {
  constructor({ repository, assistantBoundary = null, clock = () => new Date(), idFactory } = {}) {
    if (!repository || !validateMemoryRepositoryInterface(repository).valid) {
      throw new TypeError('MemoryCaptureService requires a MemoryRepository.');
    }
    this.repository = repository;
    this.assistantBoundary = assistantBoundary;
    this.clock = clock;
    this.intentAnalyzer = new MemoryIntentAnalyzer();
    this.capturePolicy = new MemoryCapturePolicy();
    this.sensitivePolicy = new SensitivePolicy();
    this.confirmationPolicy = new ConfirmationPolicy();
    this.candidateBuilder = new MemoryCandidateBuilder({ clock, idFactory });
    this.audit = new CaptureAudit({ clock });
    this.pendingCandidates = new Map();
  }

  _result(context, values) {
    const audit = this.audit.create({
      context,
      outcome: values.outcome,
      reasonCode: values.reasonCode,
      intent: values.intent,
      sensitivity: values.candidate?.proposedMemory?.sensitivity || values.memory?.sensitivity || null,
      memoryType: values.candidate?.proposedMemory?.memoryType || values.memory?.memoryType || null,
      memoryId: values.memory?.id || values.targetMemoryId || null
    });
    return createCaptureResult({ ...values, audit });
  }

  analyzeIntent(input) {
    return this.intentAnalyzer.analyze(input);
  }

  _invalidContext(context) {
    const safeContext = {
      authenticatedUserId: '',
      requestId: '',
      ...context
    };
    return this._result(safeContext, {
      outcome: CaptureOutcome.REJECTED,
      reasonCode: CaptureReasonCode.INVALID_CONTEXT,
      intent: CaptureIntent.NOT_MEMORY,
      error: { code: CaptureReasonCode.INVALID_CONTEXT }
    });
  }

  _formalize(candidate, confirmationStatus) {
    const nowValue = this.clock();
    const now = confirmationStatus === MemoryConfirmation.NOT_REQUIRED
      ? candidate.proposedMemory.updatedAt
      : (nowValue instanceof Date ? nowValue : new Date(nowValue)).toISOString();
    return {
      ...structuredClone(candidate.proposedMemory),
      source: confirmationStatus === MemoryConfirmation.USER_CONFIRMED
        ? { type: MemorySourceType.USER_CONFIRMED, id: candidate.source.id }
        : structuredClone(candidate.source),
      updatedAt: now,
      status: MemoryStatus.CONFIRMED,
      confirmationStatus,
      metadata: {
        ...structuredClone(candidate.proposedMemory.metadata),
        capture: {
          ...structuredClone(candidate.proposedMemory.metadata.capture),
          candidateId: candidate.id
        }
      }
    };
  }

  _rememberCandidate(candidate, conflict = null) {
    this.pendingCandidates.set(candidate.id, {
      candidate: structuredClone(candidate),
      conflict: conflict ? { id: conflict.id, version: conflict.version } : null
    });
  }

  async _findExclusiveConflict(context, candidate) {
    const proposed = candidate.proposedMemory;
    if (!['resides_in_city', 'birthday'].includes(proposed.predicate)) return null;
    const page = await this.repository.query(context, {
      userId: context.authenticatedUserId,
      subject: proposed.subject,
      predicate: proposed.predicate,
      limit: 10
    });
    return page.items.find((record) => record.normalizedValue !== proposed.normalizedValue) || null;
  }

  async _findSemanticDuplicate(context, candidate) {
    const proposed = candidate.proposedMemory;
    const page = await this.repository.query(context, {
      userId: context.authenticatedUserId,
      subject: proposed.subject,
      predicate: proposed.predicate,
      limit: 50
    });
    return page.items.find((record) => (
      record.memoryType === proposed.memoryType &&
      record.normalizedValue === proposed.normalizedValue
    )) || null;
  }

  async _findIdempotentReplay(context, candidate, input) {
    if (!input.idempotencyKey) return null;
    try {
      const existing = await this.repository.getById(context, candidate.proposedMemory.id);
      const proposed = candidate.proposedMemory;
      const sameSemanticRequest = [
        'memoryType', 'subject', 'predicate', 'normalizedValue'
      ].every((field) => existing[field] === proposed[field]) &&
        existing.source?.type === proposed.source?.type &&
        existing.source?.id === proposed.source?.id;
      return sameSemanticRequest ? existing : null;
    } catch (error) {
      if (error?.code === 'MEMORY_RECORD_NOT_FOUND') return null;
      throw error;
    }
  }

  async capture(context, input = {}) {
    const contextValidation = validateRepositoryContext(context);
    if (!contextValidation.valid) return this._invalidContext(context);

    const analysis = this.analyzeIntent(input.text);
    const action = this.capturePolicy.evaluate(analysis);
    if (action === 'reject') {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: analysis.reasonCode,
        intent: analysis.intent
      });
    }
    if (action === 'context_only') {
      const nowValue = this.clock();
      const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
      return this._result(context, {
        outcome: CaptureOutcome.CONTEXT_ONLY,
        reasonCode: CaptureReasonCode.CONTEXT_ONLY,
        intent: analysis.intent,
        context: {
          value: analysis.content,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
        }
      });
    }
    if (action === 'forget') {
      if (!nonEmptyString(input.targetMemoryId)) {
        return this._result(context, {
          outcome: CaptureOutcome.REJECTED,
          reasonCode: CaptureReasonCode.TARGET_MEMORY_REQUIRED,
          intent: analysis.intent,
          error: { code: CaptureReasonCode.TARGET_MEMORY_REQUIRED }
        });
      }
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
        return this._result(context, {
          outcome: CaptureOutcome.REJECTED,
          reasonCode: CaptureReasonCode.EXPECTED_VERSION_REQUIRED,
          intent: analysis.intent,
          targetMemoryId: input.targetMemoryId,
          error: { code: CaptureReasonCode.EXPECTED_VERSION_REQUIRED }
        });
      }
      await this.repository.moveToRecycleBin(
        context,
        input.targetMemoryId,
        repositoryOptions(context, input, 'capture_user_forget')
      );
      return this._result(context, {
        outcome: CaptureOutcome.FORGOTTEN,
        reasonCode: CaptureReasonCode.MOVED_TO_RECYCLE_BIN,
        intent: analysis.intent,
        targetMemoryId: input.targetMemoryId
      });
    }
    const sensitivity = this.sensitivePolicy.evaluate(analysis.content);
    if (sensitivity.prohibited) {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: CaptureReasonCode.PROHIBITED_SECRET,
        intent: analysis.intent,
        error: { code: CaptureReasonCode.PROHIBITED_SECRET }
      });
    }
    if (!nonEmptyString(input.sourceId)) {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: CaptureReasonCode.SOURCE_REQUIRED,
        intent: analysis.intent,
        error: { code: CaptureReasonCode.SOURCE_REQUIRED }
      });
    }

    const candidate = this.candidateBuilder.build(context, input, analysis, sensitivity);
    const replay = await this._findIdempotentReplay(context, candidate, input);
    if (replay) {
      return this._result(context, {
        outcome: CaptureOutcome.STORED,
        reasonCode: CaptureReasonCode.EXPLICIT_REMEMBER_AUTHORIZED,
        intent: analysis.intent,
        memory: replay
      });
    }
    const semanticDuplicate = analysis.directSaveAuthorized && !analysis.explicit
      ? await this._findSemanticDuplicate(context, candidate)
      : null;
    if (semanticDuplicate) {
      return this._result(context, {
        outcome: CaptureOutcome.STORED,
        reasonCode: CaptureReasonCode.PROACTIVE_HIGH_VALUE_AUTHORIZED,
        intent: analysis.intent,
        memory: semanticDuplicate
      });
    }
    const confirmation = this.confirmationPolicy.evaluate({
      explicit: analysis.explicit,
      directSaveAuthorized: analysis.directSaveAuthorized,
      sensitivity: sensitivity.sensitivity,
      prohibited: sensitivity.prohibited
    });
    const conflict = await this._findExclusiveConflict(context, candidate);
    const idempotentReplay = conflict?.id === candidate.proposedMemory.id;
    if (confirmation === ConfirmationDecision.REQUIRED || (conflict && !idempotentReplay)) {
      this._rememberCandidate(candidate, conflict);
      return this._result(context, {
        outcome: CaptureOutcome.CANDIDATE,
        reasonCode: conflict
          ? CaptureReasonCode.CONFLICT_CONFIRMATION_REQUIRED
          : sensitivity.sensitivity === 'high'
            ? CaptureReasonCode.SENSITIVE_CONFIRMATION_REQUIRED
            : CaptureReasonCode.CONFIRMATION_REQUIRED,
        intent: analysis.intent,
        candidate,
        requiresConfirmation: true
      });
    }

    const record = this._formalize(candidate, MemoryConfirmation.NOT_REQUIRED);
    const validation = validateMemoryRecord(record, { trustedUserId: context.authenticatedUserId });
    if (!validation.valid) throw validation.errors[0];
    const memory = await this.repository.create(
      context,
      record,
      repositoryOptions(context, input, 'capture_explicit_remember')
    );
    return this._result(context, {
      outcome: CaptureOutcome.STORED,
      reasonCode: analysis.directSaveAuthorized && !analysis.explicit
        ? CaptureReasonCode.PROACTIVE_HIGH_VALUE_AUTHORIZED
        : CaptureReasonCode.EXPLICIT_REMEMBER_AUTHORIZED,
      intent: analysis.intent,
      memory
    });
  }

  async confirm(context, candidate, options = {}) {
    const contextValidation = validateRepositoryContext(context);
    if (!contextValidation.valid) return this._invalidContext(context);
    const validation = validateMemoryCandidate(candidate, { trustedUserId: context.authenticatedUserId });
    if (!validation.valid) {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: CaptureReasonCode.INVALID_CANDIDATE,
        intent: CaptureIntent.LONG_TERM_MEMORY,
        error: { code: CaptureReasonCode.INVALID_CANDIDATE }
      });
    }
    const pending = this.pendingCandidates.get(candidate.id);
    const trustedCandidate = pending?.candidate;
    if (
      !trustedCandidate ||
      trustedCandidate.userId !== context.authenticatedUserId ||
      captureChecksum(candidate) !== captureChecksum(trustedCandidate) ||
      candidate.metadata.integrityChecksum !== captureChecksum(candidate.proposedMemory)
    ) {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: CaptureReasonCode.CANDIDATE_INTEGRITY_FAILED,
        intent: CaptureIntent.LONG_TERM_MEMORY,
        error: { code: CaptureReasonCode.CANDIDATE_INTEGRITY_FAILED }
      });
    }
    const record = this._formalize(trustedCandidate, MemoryConfirmation.USER_CONFIRMED);
    const recordValidation = validateMemoryRecord(record, { trustedUserId: context.authenticatedUserId });
    if (!recordValidation.valid) {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: CaptureReasonCode.INVALID_CANDIDATE,
        intent: CaptureIntent.LONG_TERM_MEMORY,
        error: { code: CaptureReasonCode.INVALID_CANDIDATE }
      });
    }
    let memory;
    let reasonCode = CaptureReasonCode.USER_CONFIRMED;
    if (pending.conflict) {
      const superseded = await this.repository.supersede(
        context,
        pending.conflict.id,
        record,
        repositoryOptions(context, { ...options, expectedVersion: pending.conflict.version }, 'capture_conflict_superseded')
      );
      memory = superseded.current;
      reasonCode = CaptureReasonCode.CONFLICT_SUPERSEDED;
    } else {
      memory = await this.repository.create(
        context,
        record,
        repositoryOptions(context, options, 'capture_user_confirmed')
      );
    }
    return this._result(context, {
      outcome: CaptureOutcome.STORED,
      reasonCode,
      intent: CaptureIntent.LONG_TERM_MEMORY,
      memory
    });
  }

  async captureAssistantCandidate(context, input = {}) {
    const contextValidation = validateRepositoryContext(context);
    if (!contextValidation.valid) return this._invalidContext(context);
    if (!this.assistantBoundary || typeof this.assistantBoundary.propose !== 'function') {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: CaptureReasonCode.INVALID_INPUT,
        intent: CaptureIntent.LONG_TERM_MEMORY,
        error: { code: CaptureReasonCode.INVALID_INPUT }
      });
    }
    if (!nonEmptyString(input.sourceId)) {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: CaptureReasonCode.SOURCE_REQUIRED,
        intent: CaptureIntent.LONG_TERM_MEMORY,
        error: { code: CaptureReasonCode.SOURCE_REQUIRED }
      });
    }
    const proposal = await this.assistantBoundary.propose({ text: input.text });
    const sensitivity = this.sensitivePolicy.evaluate(proposal?.content);
    if (sensitivity.prohibited || sensitivity.sensitivity === 'high') {
      return this._result(context, {
        outcome: CaptureOutcome.REJECTED,
        reasonCode: sensitivity.prohibited
          ? CaptureReasonCode.PROHIBITED_SECRET
          : CaptureReasonCode.ASSISTANT_SENSITIVE_REJECTED,
        intent: CaptureIntent.LONG_TERM_MEMORY,
        error: { code: sensitivity.prohibited ? CaptureReasonCode.PROHIBITED_SECRET : CaptureReasonCode.ASSISTANT_SENSITIVE_REJECTED }
      });
    }
    const analysis = {
      intent: CaptureIntent.LONG_TERM_MEMORY,
      reasonCode: CaptureReasonCode.ASSISTANT_CANDIDATE_ONLY,
      content: String(proposal?.content || '').trim(),
      memoryType: proposal?.memoryType,
      explicit: false
    };
    const candidate = this.candidateBuilder.build(context, input, analysis, sensitivity, {
      sourceType: MemorySourceType.MODEL_INFERRED,
      modelGenerated: true
    });
    this._rememberCandidate(candidate);
    return this._result(context, {
      outcome: CaptureOutcome.CANDIDATE,
      reasonCode: CaptureReasonCode.ASSISTANT_CANDIDATE_ONLY,
      intent: analysis.intent,
      candidate,
      requiresConfirmation: true
    });
  }
}
