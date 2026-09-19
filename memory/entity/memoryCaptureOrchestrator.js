function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} is required.`);
  return value;
}

function method(value, name, label) {
  if (!value || typeof value[name] !== 'function') throw new TypeError(`${label} must expose ${name}().`);
}

function confirmationQuestion(decision) {
  if (decision.reasonCodes.includes('existing_fact_conflict')) return '现有记录与新信息不一致，是否用新信息更正？';
  if (decision.reasonCodes.includes('possible_duplicate')) return '这条记录可能重复，仍要记录吗？';
  return '这条信息需要确认后保存，是否保存？';
}

export class MemoryCaptureOrchestrator {
  constructor({
    resolutionService,
    decisionService,
    safeWriteService,
    pendingCandidates,
    temporaryContexts,
    businessRecordAdapter,
    now = () => new Date().toISOString()
  }) {
    method(resolutionService, 'resolve', 'Entity Resolution Service');
    method(decisionService, 'decide', 'Memory Decision Service');
    method(safeWriteService, 'inspect', 'Safe Write Service');
    method(safeWriteService, 'write', 'Safe Write Service');
    for (const name of ['create', 'get', 'consume', 'reject']) method(pendingCandidates, name, 'Pending Candidate Store');
    method(temporaryContexts, 'put', 'Temporary Context Store');
    for (const name of ['inspect', 'commit']) method(businessRecordAdapter, name, 'Business Record Adapter');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    Object.assign(this, {
      resolutionService,
      decisionService,
      safeWriteService,
      pendingCandidates,
      temporaryContexts,
      businessRecordAdapter,
      now
    });
  }

  async process({ ownerUserId, text, locale = 'zh-CN', conversationId, idempotencyKey }) {
    required(ownerUserId, 'ownerUserId');
    required(text, 'text');
    required(locale, 'locale');
    required(conversationId, 'conversationId');
    required(idempotencyKey, 'idempotencyKey');
    const resolution = await this.resolutionService.resolve({
      ownerUserId, text, locale, conversationId, purpose: 'capture', effectiveAt: this.now()
    });
    const decision = await this.decisionService.decide({
      ownerUserId, text, locale, entityResolution: resolution, conversationContext: null
    });

    if (decision.decision === 'answer_only') {
      return immutable({ outcome: 'answer_only', acknowledgement: 'none', decision });
    }
    if (decision.decision === 'ignore') {
      return immutable({
        outcome: decision.reasonCodes.includes('exact_duplicate') ? 'duplicate_detected' : 'ignored',
        acknowledgement: 'none',
        decision
      });
    }
    if (resolution.resolutionStatus !== 'exact' || resolution.ownerUserId !== ownerUserId) {
      return immutable({
        outcome: 'resolution_required', acknowledgement: 'none',
        resolutionStatus: resolution.resolutionStatus,
        clarificationQuestion: resolution.clarificationQuestion ?? null
      });
    }
    if (decision.reasonCodes.some((reason) => [
      'structured_value_invalid', 'owner_scope_mismatch', 'retention_policy_mismatch'
    ].includes(reason))) {
      return immutable({ outcome: 'candidate_rejected', acknowledgement: 'none', reasonCodes: decision.reasonCodes });
    }
    if (decision.decision === 'temporary_context') {
      const temporaryContext = this.temporaryContexts.put({
        ownerUserId,
        subjectEntityId: resolution.entityId,
        decision,
        idempotencyKey
      });
      return immutable({ outcome: 'temporary_context_stored', acknowledgement: 'none', temporaryContext });
    }
    if (decision.decision === 'confirm_before_store') {
      const inspection = await this.safeWriteService.inspect({ ownerUserId, resolution, decision });
      return this.#pending({
        ownerUserId,
        resolution,
        decision,
        idempotencyKey,
        kind: 'memory',
        conflictMemoryId: inspection.conflictStatus === 'conflict'
          ? inspection.matchingMemoryIds[0]
          : null
      });
    }
    if (decision.decision === 'business_record') {
      return this.#commitBusiness({ ownerUserId, resolution, decision, idempotencyKey, duplicateConfirmed: false });
    }
    if (decision.decision === 'store_silently') {
      const result = await this.safeWriteService.write({
        ownerUserId, resolution, decision, idempotencyKey
      });
      if (result.outcome === 'confirmation_required') {
        return this.#pending({
          ownerUserId, resolution, decision, idempotencyKey, kind: 'memory',
          conflictMemoryId: result.conflictMemoryIds[0]
        });
      }
      if (result.outcome === 'duplicate_detected') {
        return immutable({ ...result, acknowledgement: 'none' });
      }
      return immutable({ ...result, acknowledgement: 'none' });
    }
    return immutable({ outcome: 'candidate_rejected', acknowledgement: 'none' });
  }

  async confirm({ ownerUserId, confirmationToken, accepted }) {
    required(ownerUserId, 'ownerUserId');
    required(confirmationToken, 'confirmationToken');
    if (typeof accepted !== 'boolean') throw new TypeError('accepted must be boolean.');
    const pending = this.pendingCandidates.get(ownerUserId, confirmationToken);
    if (!accepted) {
      this.pendingCandidates.reject(ownerUserId, confirmationToken);
      return immutable({ outcome: 'candidate_rejected', acknowledgement: 'none' });
    }
    const candidate = pending.candidate;
    let result;
    if (candidate.kind === 'business') {
      result = await this.#commitBusiness({ ...candidate, duplicateConfirmed: true });
    } else {
      result = await this.safeWriteService.write({
        ownerUserId,
        resolution: candidate.resolution,
        decision: candidate.decision,
        idempotencyKey: candidate.idempotencyKey,
        confirmationStatus: 'user_confirmed',
        confirmedConflictMemoryId: candidate.conflictMemoryId
      });
      result = immutable({ ...result, acknowledgement: 'none' });
    }
    if (['memory_written', 'duplicate_detected', 'business_record_committed'].includes(result.outcome)) {
      this.pendingCandidates.consume(ownerUserId, confirmationToken);
    }
    return result;
  }

  #pending({ ownerUserId, resolution, decision, idempotencyKey, kind, conflictMemoryId = null }) {
    if (kind === 'memory' && decision.reasonCodes.includes('existing_fact_conflict') && !conflictMemoryId) {
      conflictMemoryId = null;
    }
    const entry = this.pendingCandidates.create(ownerUserId, {
      kind,
      ownerUserId,
      resolution: structuredClone(resolution),
      decision: structuredClone(decision),
      idempotencyKey,
      conflictMemoryId
    });
    return immutable({
      outcome: 'confirmation_required',
      acknowledgement: 'none',
      confirmationToken: entry.confirmationToken,
      confirmationQuestion: confirmationQuestion(decision),
      existingMemoryId: conflictMemoryId
    });
  }

  async #commitBusiness({ ownerUserId, resolution, decision, idempotencyKey, duplicateConfirmed }) {
    let inspection;
    try {
      inspection = await this.businessRecordAdapter.inspect({
        ownerUserId,
        subjectEntityId: resolution.entityId,
        structuredValue: decision.suggestedStructuredValue,
        idempotencyKey,
        at: this.now()
      });
    } catch {
      return immutable({ outcome: 'business_commit_failed', acknowledgement: 'none' });
    }
    if (inspection.duplicateStatus === 'exact') {
      return immutable({ outcome: 'duplicate_detected', acknowledgement: 'none', recordId: inspection.recordId });
    }
    if (inspection.duplicateStatus === 'possible' && !duplicateConfirmed) {
      const pendingDecision = immutable({
        ...structuredClone(decision),
        reasonCodes: [...new Set([...decision.reasonCodes, 'possible_duplicate'])]
      });
      return this.#pending({
        ownerUserId, resolution, decision: pendingDecision, idempotencyKey,
        kind: 'business'
      });
    }
    let committed;
    try {
      committed = await this.businessRecordAdapter.commit({
        ownerUserId,
        subjectEntityId: resolution.entityId,
        memoryType: decision.memoryType,
        predicate: decision.predicate,
        structuredValue: structuredClone(decision.suggestedStructuredValue),
        sourceTextDigest: decision.sourceTextDigest,
        idempotencyKey,
        duplicateConfirmed,
        committedAt: this.now()
      });
    } catch {
      return immutable({ outcome: 'business_commit_failed', acknowledgement: 'none' });
    }
    if (!committed?.committed) {
      return immutable({ outcome: 'business_commit_failed', acknowledgement: 'none' });
    }
    return immutable({
      outcome: 'business_record_committed',
      acknowledgement: '已记录',
      recordId: committed.recordId
    });
  }
}

export function createMemoryCaptureOrchestrator(options) {
  return new MemoryCaptureOrchestrator(options);
}
