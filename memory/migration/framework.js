import {
  MigrationApprovalStatus,
  MigrationAuditAction,
  MigrationCandidateStatus,
  MigrationError,
  MigrationExecutionStatus,
  MigrationPlanStatus,
  deepFreezeMigration,
  validateMigrationContext
} from './contracts.js';
import { MigrationScanner } from './scanner.js';
import { DryRunEngine, MigrationPlanner } from './planner.js';

function validateContext(context) {
  const validation = validateMigrationContext(context);
  if (!validation.valid) throw new MigrationError(validation.errors[0].code);
}
function targetValid(target) {
  return target && typeof target.withTransaction === 'function' && typeof target.stageCandidate === 'function' && typeof target.removeCandidate === 'function';
}

export class ApprovalEngine {
  constructor({ clock = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) { this.clock = clock; this.idFactory = idFactory; }
  _now() { const value = this.clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); }

  approve(context, dryRun, { decision, candidateIds = [], sensitiveCandidateIds = [] } = {}) {
    validateContext(context);
    if (context.actorType !== 'user' || context.actorId !== context.authenticatedUserId) throw new MigrationError('MIGRATION_USER_APPROVAL_REQUIRED');
    const plan = dryRun?.plan;
    if (!plan || plan.status !== MigrationPlanStatus.APPROVAL_REQUIRED) throw new MigrationError('MIGRATION_APPROVAL_REQUIRED');
    if (plan.userId !== context.authenticatedUserId) throw new MigrationError('USER_SCOPE_MISMATCH');
    if (decision === 'cancel') return deepFreezeMigration({
      id: `migration-approval-${this.idFactory()}`, planId: plan.id, userId: plan.userId,
      status: MigrationApprovalStatus.CANCELLED, approvedCandidateIds: [], sensitiveCandidateIds: [],
      planChecksum: plan.checksum, approvedAt: this._now()
    });
    if (decision !== 'approve' || !Array.isArray(candidateIds) || candidateIds.length === 0 || !Array.isArray(sensitiveCandidateIds)) {
      throw new MigrationError('MIGRATION_CANDIDATE_NOT_ELIGIBLE');
    }
    const uniqueIds = [...new Set(candidateIds)];
    const selected = uniqueIds.map((id) => plan.candidates.find((item) => item.id === id));
    if (selected.some((item) => !item || ![MigrationCandidateStatus.READY_FOR_APPROVAL, MigrationCandidateStatus.SENSITIVE_APPROVAL_REQUIRED].includes(item.status))) {
      throw new MigrationError('MIGRATION_CANDIDATE_NOT_ELIGIBLE');
    }
    const sensitiveSet = new Set(sensitiveCandidateIds);
    if (selected.some((item) => item.status === MigrationCandidateStatus.SENSITIVE_APPROVAL_REQUIRED && !sensitiveSet.has(item.id))) {
      throw new MigrationError('MIGRATION_SENSITIVE_APPROVAL_REQUIRED');
    }
    return deepFreezeMigration({
      id: `migration-approval-${this.idFactory()}`, planId: plan.id, userId: plan.userId,
      status: MigrationApprovalStatus.APPROVED, approvedCandidateIds: uniqueIds,
      sensitiveCandidateIds: [...new Set(sensitiveCandidateIds)].filter((id) => uniqueIds.includes(id)),
      planChecksum: plan.checksum, approvedAt: this._now()
    });
  }
}

export class MigrationAudit {
  constructor({ clock = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) { this.clock = clock; this.idFactory = idFactory; this.events = []; }
  _now() { const value = this.clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); }
  record(context, action, reasonCode, details = {}) {
    validateContext(context);
    const event = deepFreezeMigration({
      id: `migration-audit-${this.idFactory()}`, userId: context.authenticatedUserId,
      actor: { type: context.actorType, id: context.actorId }, action, reasonCode,
      timestamp: this._now(), sourceId: details.sourceId ?? null, planId: details.planId ?? null,
      candidateCount: Number.isInteger(details.candidateCount) ? details.candidateCount : 0,
      result: details.result ?? 'ok', metadata: {}
    });
    this.events.push(event);
    return event;
  }
  list(context) { validateContext(context); return deepFreezeMigration(structuredClone(this.events.filter((event) => event.userId === context.authenticatedUserId))); }
}

export class RollbackEngine {
  constructor({ clock = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) { this.clock = clock; this.idFactory = idFactory; }
  _now() { const value = this.clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); }
  async rollback(context, execution, target) {
    validateContext(context);
    if (!execution || execution.status !== MigrationExecutionStatus.COMPLETED) throw new MigrationError('MIGRATION_ROLLBACK_NOT_AVAILABLE');
    if (execution.userId !== context.authenticatedUserId) throw new MigrationError('USER_SCOPE_MISMATCH');
    if (!targetValid(target)) throw new MigrationError('MIGRATION_TARGET_INVALID');
    try {
      await target.withTransaction(async (transaction) => {
        for (const id of execution.candidateIds) await transaction.removeCandidate(id);
      });
    } catch { throw new MigrationError('MIGRATION_ROLLBACK_FAILED'); }
    return deepFreezeMigration({
      ...structuredClone(execution), status: MigrationExecutionStatus.ROLLED_BACK,
      rolledBackAt: this._now(), reasonCode: 'MIGRATION_ROLLBACK_COMPLETED'
    });
  }
}

export class MemoryMigrationFramework {
  constructor({ clock = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.scanner = new MigrationScanner({ clock, idFactory });
    this.planner = new MigrationPlanner({ clock, idFactory });
    this.dryRunEngine = new DryRunEngine();
    this.approvalEngine = new ApprovalEngine({ clock, idFactory });
    this.rollbackEngine = new RollbackEngine({ clock, idFactory });
    this.audit = new MigrationAudit({ clock, idFactory });
    this.plans = new Map();
    this.executions = new Map();
  }
  _now() { const value = this.clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); }

  async preview(context, source, { existingMemories = [], existingTimelineEvents = [] } = {}) {
    validateContext(context);
    this.audit.record(context, MigrationAuditAction.SCAN_STARTED, 'MIGRATION_SCAN_STARTED', { sourceId: source?.id });
    let scan;
    try { scan = await this.scanner.scan(context, source); }
    catch (error) {
      this.audit.record(context, MigrationAuditAction.FAILED, error?.code || 'MIGRATION_SOURCE_SCAN_FAILED', { sourceId: source?.id, result: 'failed' });
      throw error;
    }
    this.audit.record(context, MigrationAuditAction.SCAN_COMPLETED, 'MIGRATION_SCAN_COMPLETED', { sourceId: scan.sourceId, candidateCount: scan.candidates.length });
    const draft = this.planner.build(context, scan, { existingMemories, existingTimelineEvents });
    this.audit.record(context, MigrationAuditAction.PLAN_CREATED, 'MIGRATION_PLAN_CREATED', { sourceId: scan.sourceId, planId: draft.id, candidateCount: draft.candidates.length });
    const dryRun = this.dryRunEngine.run(context, draft);
    this.plans.set(dryRun.plan.id, dryRun.plan);
    this.audit.record(context, MigrationAuditAction.DRY_RUN_COMPLETED, 'MIGRATION_DRY_RUN_COMPLETED', { sourceId: scan.sourceId, planId: draft.id, candidateCount: dryRun.report.counts.newCandidates });
    const scanSummary = {
      sourceId: scan.sourceId, sourceKind: scan.sourceKind, userId: scan.userId,
      scannedAt: scan.scannedAt, excluded: scan.excluded, counts: scan.counts
    };
    return deepFreezeMigration({ scan: scanSummary, plan: dryRun.plan, dryRun, auditEvents: this.audit.list(context) });
  }

  approve(context, dryRun, decision) {
    const approval = this.approvalEngine.approve(context, dryRun, decision);
    this.audit.record(context,
      approval.status === MigrationApprovalStatus.APPROVED ? MigrationAuditAction.APPROVED : MigrationAuditAction.CANCELLED,
      approval.status === MigrationApprovalStatus.APPROVED ? 'MIGRATION_PLAN_APPROVED' : 'MIGRATION_PLAN_CANCELLED',
      { planId: approval.planId, candidateCount: approval.approvedCandidateIds.length }
    );
    return approval;
  }

  async execute(context, approval, target) {
    validateContext(context);
    if (!approval || approval.status !== MigrationApprovalStatus.APPROVED) throw new MigrationError('MIGRATION_APPROVAL_REQUIRED');
    if (approval.userId !== context.authenticatedUserId) throw new MigrationError('USER_SCOPE_MISMATCH');
    if (!targetValid(target)) throw new MigrationError('MIGRATION_TARGET_INVALID');
    const plan = this.plans.get(approval.planId);
    if (!plan || plan.userId !== context.authenticatedUserId || plan.checksum !== approval.planChecksum) throw new MigrationError('MIGRATION_APPROVAL_REQUIRED');
    const previous = this.executions.get(plan.id);
    if (previous?.status === MigrationExecutionStatus.COMPLETED) return previous;
    const candidates = approval.approvedCandidateIds.map((id) => plan.candidates.find((item) => item.id === id));
    if (candidates.some((item) => !item)) throw new MigrationError('MIGRATION_CANDIDATE_NOT_ELIGIBLE');
    this.audit.record(context, MigrationAuditAction.STARTED, 'MIGRATION_EXECUTION_STARTED', { planId: plan.id, candidateCount: candidates.length });
    const startedAt = this._now();
    try {
      await target.withTransaction(async (transaction) => {
        for (const item of candidates) await transaction.stageCandidate(item);
      });
      const execution = deepFreezeMigration({
        id: `migration-execution-${this.idFactory()}`, planId: plan.id, userId: plan.userId,
        status: MigrationExecutionStatus.COMPLETED, candidateIds: candidates.map((item) => item.id),
        startedAt, completedAt: this._now(), rollbackToken: `migration-rollback-${plan.checksum.slice(0, 24)}`,
        report: { stagedCandidates: candidates.length, formalMemoriesCreated: 0, partialSuccess: false }
      });
      this.executions.set(plan.id, execution);
      this.audit.record(context, MigrationAuditAction.COMPLETED, 'MIGRATION_EXECUTION_COMPLETED', { planId: plan.id, candidateCount: candidates.length });
      return execution;
    } catch {
      const execution = deepFreezeMigration({
        id: `migration-execution-${this.idFactory()}`, planId: plan.id, userId: plan.userId,
        status: MigrationExecutionStatus.FAILED, candidateIds: [], startedAt, completedAt: this._now(),
        rollbackToken: null, report: { stagedCandidates: 0, formalMemoriesCreated: 0, partialSuccess: false },
        reasonCode: 'MIGRATION_TRANSACTION_FAILED'
      });
      this.executions.set(plan.id, execution);
      this.audit.record(context, MigrationAuditAction.FAILED, 'MIGRATION_TRANSACTION_FAILED', { planId: plan.id, candidateCount: 0, result: 'failed' });
      return execution;
    }
  }

  async rollback(context, execution, target) {
    this.audit.record(context, MigrationAuditAction.ROLLBACK_STARTED, 'MIGRATION_ROLLBACK_STARTED', { planId: execution?.planId, candidateCount: execution?.candidateIds?.length || 0 });
    try {
      const result = await this.rollbackEngine.rollback(context, execution, target);
      this.executions.set(result.planId, result);
      this.audit.record(context, MigrationAuditAction.ROLLED_BACK, 'MIGRATION_ROLLBACK_COMPLETED', { planId: result.planId, candidateCount: result.candidateIds.length });
      return result;
    } catch (error) {
      this.audit.record(context, MigrationAuditAction.FAILED, 'MIGRATION_ROLLBACK_FAILED', { planId: execution?.planId, result: 'failed' });
      throw error;
    }
  }

  listAuditEvents(context) { return this.audit.list(context); }
}
