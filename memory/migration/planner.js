import { createHash } from 'node:crypto';

import { MemorySensitivity } from '../kernel/index.js';
import {
  MigrationCandidateStatus,
  MigrationPlanStatus,
  createMigrationCandidate,
  createMigrationPlan,
  createMigrationReport,
  deepFreezeMigration,
  MigrationError,
  validateMigrationContext
} from './contracts.js';
import { ConflictDetector, DuplicateDetector, SensitiveDetector } from './detectors.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

function updateCandidate(candidate, { duplicateReport, conflictReport, sensitiveReport, status }) {
  const proposedMemory = structuredClone(candidate.proposedMemory);
  proposedMemory.sensitivity = sensitiveReport.sensitivity;
  proposedMemory.checksum = hash(proposedMemory);
  return createMigrationCandidate({
    ...structuredClone(candidate), proposedMemory, duplicateReport, conflictReport, sensitiveReport, status
  });
}

export class MigrationPlanner {
  constructor({
    clock = () => new Date(), idFactory = () => crypto.randomUUID(),
    duplicateDetector = new DuplicateDetector(), conflictDetector = new ConflictDetector(),
    sensitiveDetector = new SensitiveDetector()
  } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.duplicateDetector = duplicateDetector;
    this.conflictDetector = conflictDetector;
    this.sensitiveDetector = sensitiveDetector;
  }

  _now() { const value = this.clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); }

  build(context, scanResult, { existingMemories = [], existingTimelineEvents = [] } = {}) {
    const validation = validateMigrationContext(context);
    if (!validation.valid) throw new MigrationError(validation.errors[0].code);
    if (!scanResult || scanResult.userId !== context.authenticatedUserId || !Array.isArray(scanResult.candidates)) throw new MigrationError('MIGRATION_PLAN_INVALID');
    const planned = [];
    for (const original of scanResult.candidates) {
      const sensitiveReport = this.sensitiveDetector.detect(original);
      if (sensitiveReport.prohibited) { planned.push(this.sensitiveDetector.redactProhibited(original)); continue; }
      const inputs = { memories: existingMemories, timelineEvents: existingTimelineEvents, candidates: planned };
      const duplicateReport = this.duplicateDetector.detect(original, inputs);
      const conflictReport = this.conflictDetector.detect(original, inputs);
      const status = duplicateReport.isDuplicate
        ? MigrationCandidateStatus.DUPLICATE
        : conflictReport.hasConflict
          ? MigrationCandidateStatus.CONFLICT
          : sensitiveReport.requiresExplicitApproval
            ? MigrationCandidateStatus.SENSITIVE_APPROVAL_REQUIRED
            : MigrationCandidateStatus.READY_FOR_APPROVAL;
      planned.push(updateCandidate(original, { duplicateReport, conflictReport, sensitiveReport, status }));
    }
    const seed = {
      userId: context.authenticatedUserId, sourceId: scanResult.sourceId, version: 1,
      status: MigrationPlanStatus.DRAFT, createdAt: this._now(), candidates: planned,
      inputCount: scanResult.counts.scanned, excludedCount: scanResult.counts.excluded, metadata: {}
    };
    return createMigrationPlan({ id: `migration-plan-${this.idFactory()}`, ...seed, checksum: hash(seed) });
  }
}

const INSIGHT_TYPES = new Set(['preference', 'goal', 'habit_routine']);

export class DryRunEngine {
  run(context, plan) {
    const validation = validateMigrationContext(context);
    if (!validation.valid) throw new MigrationError(validation.errors[0].code);
    if (!plan || plan.userId !== context.authenticatedUserId || !Array.isArray(plan.candidates)) throw new MigrationError('MIGRATION_PLAN_INVALID');
    const candidates = plan.candidates;
    const eligible = candidates.filter((item) => [MigrationCandidateStatus.READY_FOR_APPROVAL, MigrationCandidateStatus.SENSITIVE_APPROVAL_REQUIRED].includes(item.status));
    const counts = {
      scanned: plan.inputCount,
      candidates: candidates.length,
      newCandidates: eligible.length,
      duplicates: candidates.filter((item) => item.status === MigrationCandidateStatus.DUPLICATE).length,
      conflicts: candidates.filter((item) => item.status === MigrationCandidateStatus.CONFLICT).length,
      sensitive: candidates.filter((item) => item.status === MigrationCandidateStatus.SENSITIVE_APPROVAL_REQUIRED).length,
      prohibited: candidates.filter((item) => item.status === MigrationCandidateStatus.PROHIBITED).length,
      excluded: plan.excludedCount
    };
    const approvedPlan = createMigrationPlan({ ...structuredClone(plan), status: MigrationPlanStatus.APPROVAL_REQUIRED });
    const report = createMigrationReport({
      planId: plan.id, userId: plan.userId, generatedAt: new Date(context.timestamp).toISOString(), counts,
      estimatedTimelineChanges: eligible.length,
      estimatedInsightRecomputes: eligible.filter((item) => INSIGHT_TYPES.has(item.proposedMemory.memoryType)).length,
      requiresApproval: eligible.length > 0,
      reasonCodes: [
        'MIGRATION_DRY_RUN_ONLY',
        ...(counts.duplicates ? ['MIGRATION_DUPLICATES_REQUIRE_REVIEW'] : []),
        ...(counts.conflicts ? ['MIGRATION_CONFLICTS_REQUIRE_GOVERNANCE'] : []),
        ...(counts.sensitive ? ['MIGRATION_SENSITIVE_APPROVAL_REQUIRED'] : []),
        ...(counts.prohibited ? ['MIGRATION_PROHIBITED_BLOCKED'] : [])
      ],
      metadata: { generatedArtifacts: false, writesPerformed: false }
    });
    return deepFreezeMigration({ plan: approvedPlan, report });
  }
}

export function migrationPlanHash(plan) {
  return hash({
    userId: plan.userId, sourceId: plan.sourceId, version: plan.version,
    candidates: plan.candidates, inputCount: plan.inputCount, excludedCount: plan.excludedCount
  });
}
