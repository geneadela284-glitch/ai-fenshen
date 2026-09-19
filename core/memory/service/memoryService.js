import { analyzeMemoryCandidate } from '../memoryEngine.js';
import { MemoryConfirmationPolicy, memoryConfirmationModes } from './memoryConfirmationPolicy.js';
import { createMemoryServiceResult } from './memoryServiceResult.js';

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function errorCode(result, fallback = 'MEMORY_STORAGE_FAILED') {
  if (result?.duplicate) return 'MEMORY_DUPLICATE_FOUND';
  return result?.error?.code || fallback;
}

function errorMessage(result, fallback) {
  return result?.error?.message || fallback;
}

export class MemoryService {
  constructor({
    repository,
    engine = analyzeMemoryCandidate,
    confirmationPolicy = new MemoryConfirmationPolicy(),
    now = () => new Date(),
    candidateTtlMs = 15 * 60 * 1000
  } = {}) {
    if (!repository) throw new Error('MemoryService requires a MemoryRepository');
    this.repository = repository;
    this.engine = engine;
    this.confirmationPolicy = confirmationPolicy;
    this.now = now;
    this.candidateTtlMs = candidateTtlMs;
    this.candidates = new Map();
    this.candidateSequence = 0;
  }

  timestamp() {
    return iso(this.now());
  }

  analyze(input, context = {}) {
    try {
      const analysis = this.engine(input, context);
      const policy = this.confirmationPolicy.evaluate(analysis);
      if (policy.mode === memoryConfirmationModes.DO_NOT_SAVE) {
        return this.result({
          ok: true,
          action: 'ignored',
          code: policy.code,
          message: policy.reason,
          data: { decision: analysis.decision, normalizedInput: analysis.normalizedInput },
          warnings: analysis.warnings
        });
      }
      return this.result({
        ok: Boolean(analysis.validation?.valid),
        action: 'analyzed',
        code: analysis.validation?.valid ? 'MEMORY_ANALYZED' : 'MEMORY_VALIDATION_FAILED',
        message: analysis.validation?.valid ? 'Memory candidate analyzed' : 'Memory candidate is invalid',
        data: { ...analysis, confirmationPolicy: policy.mode, confirmationReason: policy.reason },
        warnings: analysis.warnings,
        requiresConfirmation: policy.mode === memoryConfirmationModes.CONFIRM_BEFORE_SAVE
      });
    } catch {
      return this.result({ ok: false, action: 'analyzed', code: 'MEMORY_STORAGE_FAILED', message: 'Memory analysis failed' });
    }
  }

  prepare(input, context = {}) {
    const analyzed = this.analyze(input, context);
    if (analyzed.action === 'ignored' || !analyzed.ok) return analyzed;
    const analysis = analyzed.data;
    if (!analyzed.requiresConfirmation) {
      return this.result({
        ok: true,
        action: 'prepared',
        code: 'MEMORY_READY_TO_SAVE',
        message: 'Memory candidate is ready to save',
        data: analysis.memoryCandidate,
        warnings: analyzed.warnings
      });
    }
    const candidate = this.storeCandidate(analysis.memoryCandidate, analysis.confirmationReason);
    return this.result({
      ok: true,
      action: 'prepared',
      code: 'MEMORY_CONFIRMATION_REQUIRED',
      message: 'Memory candidate requires confirmation',
      data: candidate.memoryCandidate,
      warnings: analyzed.warnings,
      requiresConfirmation: true,
      candidateId: candidate.candidateId
    });
  }

  remember(input, options = {}) {
    const prepared = this.prepare(input, options.context || options);
    if (prepared.action === 'ignored' || !prepared.ok || prepared.requiresConfirmation) return prepared;
    return this.saveRecord(prepared.data, { ...options, confirmedByUser: true }, 'remembered');
  }

  confirm(candidateId, confirmation = {}) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return this.result({ ok: false, action: 'confirmed', code: 'MEMORY_CANDIDATE_NOT_FOUND', message: 'Memory candidate was not found', candidateId });
    if (candidate.status === 'expired' || new Date(candidate.expiresAt).getTime() <= new Date(this.timestamp()).getTime()) {
      candidate.status = 'expired';
      return this.result({ ok: false, action: 'confirmed', code: 'MEMORY_CANDIDATE_EXPIRED', message: 'Memory candidate has expired', candidateId });
    }
    if (candidate.status !== 'pending') {
      return this.result({ ok: false, action: 'confirmed', code: 'MEMORY_CANDIDATE_NOT_FOUND', message: 'Memory candidate is no longer pending', candidateId });
    }
    const record = { ...candidate.memoryCandidate, status: 'confirmed', needsConfirmation: false };
    const result = this.saveRecord(record, { ...confirmation, confirmedByUser: true }, 'confirmed', candidateId);
    if (result.ok) candidate.status = 'confirmed';
    return result;
  }

  reject(candidateId, reason = '') {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return this.result({ ok: false, action: 'rejected', code: 'MEMORY_CANDIDATE_NOT_FOUND', message: 'Memory candidate was not found', candidateId });
    if (candidate.status === 'expired') return this.result({ ok: false, action: 'rejected', code: 'MEMORY_CANDIDATE_EXPIRED', message: 'Memory candidate has expired', candidateId });
    candidate.status = 'rejected';
    candidate.rejectionReason = String(reason || '');
    return this.result({ ok: true, action: 'rejected', code: 'MEMORY_CANDIDATE_REJECTED', message: 'Memory candidate rejected', candidateId });
  }

  getMemory(id, options = {}) {
    return this.withRecord('retrieved', id, () => this.repository.getById(id, options));
  }

  searchMemories(query = {}) {
    try {
      return this.result({ ok: true, action: 'searched', code: 'MEMORY_SEARCHED', message: 'Memories retrieved', data: this.repository.search(query) });
    } catch {
      return this.result({ ok: false, action: 'searched', code: 'MEMORY_STORAGE_FAILED', message: 'Memory search failed' });
    }
  }

  updateMemory(id, changes = {}, options = {}) {
    try {
      const result = this.repository.update(id, { ...changes, confirmedByUser: Boolean(options.confirmedByUser) });
      return this.fromRepository('updated', id, result, 'Memory updated');
    } catch {
      return this.result({ ok: false, action: 'updated', code: 'MEMORY_STORAGE_FAILED', message: 'Memory update failed', memoryId: id });
    }
  }

  deleteMemory(id, options = {}) {
    try {
      return this.fromRepository('deleted', id, this.repository.remove(id, options), 'Memory deleted');
    } catch {
      return this.result({ ok: false, action: 'deleted', code: 'MEMORY_STORAGE_FAILED', message: 'Memory deletion failed', memoryId: id });
    }
  }

  forgetMemory(id, options = {}) {
    try {
      const existing = this.repository.getById(id, { includeDeleted: true, includeForgotten: true });
      if (!existing) return this.result({ ok: false, action: 'forgotten', code: 'MEMORY_NOT_FOUND', message: 'Memory record was not found', memoryId: id });
      if (existing.status === 'forgotten') return this.result({ ok: false, action: 'forgotten', code: 'MEMORY_ALREADY_FORGOTTEN', message: 'Memory has already been forgotten', memoryId: id });
      return this.fromRepository('forgotten', id, this.repository.forget(id, options), 'Memory forgotten');
    } catch {
      return this.result({ ok: false, action: 'forgotten', code: 'MEMORY_STORAGE_FAILED', message: 'Memory forget failed', memoryId: id });
    }
  }

  restoreMemory(id) {
    try {
      const result = this.repository.restore(id);
      if (!result.ok && result.error?.code === 'MEMORY_FORGOTTEN') {
        return this.result({ ok: false, action: 'restored', code: 'MEMORY_ALREADY_FORGOTTEN', message: 'Forgotten memory cannot be restored', memoryId: id });
      }
      return this.fromRepository('restored', id, result, 'Memory restored');
    } catch {
      return this.result({ ok: false, action: 'restored', code: 'MEMORY_STORAGE_FAILED', message: 'Memory restore failed', memoryId: id });
    }
  }

  exportMemories(options = {}) {
    try {
      return this.result({ ok: true, action: 'exported', code: 'MEMORY_EXPORTED', message: 'Memories exported', data: this.repository.exportAll(options) });
    } catch {
      return this.result({ ok: false, action: 'exported', code: 'MEMORY_STORAGE_FAILED', message: 'Memory export failed' });
    }
  }

  importMemories(data, options = {}) {
    try {
      return this.fromRepository('imported', null, this.repository.importAll(data, options), 'Memories imported');
    } catch {
      return this.result({ ok: false, action: 'imported', code: 'MEMORY_STORAGE_FAILED', message: 'Memory import failed' });
    }
  }

  storeCandidate(memoryCandidate, confirmationReason) {
    const createdAt = this.timestamp();
    const candidateId = `memory-candidate-${Date.parse(createdAt)}-${++this.candidateSequence}`;
    const expiresAt = new Date(Date.parse(createdAt) + this.candidateTtlMs).toISOString();
    const candidate = {
      candidateId,
      memoryCandidate: clone(memoryCandidate),
      createdAt,
      expiresAt,
      confirmationReason: String(confirmationReason || ''),
      status: 'pending'
    };
    this.candidates.set(candidateId, candidate);
    return candidate;
  }

  saveRecord(record, options, action, candidateId = null) {
    try {
      const result = this.repository.create({ ...record, status: 'confirmed', needsConfirmation: false }, options);
      if (result.ok) {
        return this.result({ ok: true, action, code: 'MEMORY_SAVED', message: 'Memory saved', data: result.record, memoryId: result.record.id, candidateId });
      }
      if (result.duplicate) {
        return this.result({
          ok: false,
          action,
          code: 'MEMORY_DUPLICATE_FOUND',
          message: 'Duplicate memory was not saved',
          data: {
            duplicate: true,
            existingMemoryId: result.existingId,
            recommendation: options.duplicateStrategy || result.recommendation || 'skip'
          },
          candidateId
        });
      }
      return this.result({ ok: false, action, code: errorCode(result), message: errorMessage(result, 'Memory save failed'), data: result.error?.details || null, candidateId });
    } catch {
      return this.result({ ok: false, action, code: 'MEMORY_STORAGE_FAILED', message: 'Memory save failed', candidateId });
    }
  }

  withRecord(action, id, read) {
    try {
      const record = read();
      if (!record) return this.result({ ok: false, action, code: 'MEMORY_NOT_FOUND', message: 'Memory record was not found', memoryId: id });
      return this.result({ ok: true, action, code: 'MEMORY_RETRIEVED', message: 'Memory retrieved', data: record, memoryId: record.id });
    } catch {
      return this.result({ ok: false, action, code: 'MEMORY_STORAGE_FAILED', message: 'Memory retrieval failed', memoryId: id });
    }
  }

  fromRepository(action, id, result, successMessage) {
    if (result?.ok) {
      const record = result.record || null;
      return this.result({ ok: true, action, code: `MEMORY_${action.toUpperCase()}`, message: successMessage, data: record || result, memoryId: record?.id || id });
    }
    return this.result({ ok: false, action, code: errorCode(result), message: errorMessage(result, `${successMessage} failed`), data: result?.error?.details || null, memoryId: id });
  }

  result(fields) {
    return createMemoryServiceResult({ ...fields, timestamp: this.timestamp() });
  }
}
