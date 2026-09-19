import { createHash } from 'node:crypto';

import { MemorySensitivity, MemoryStatus } from '../kernel/index.js';
import { SensitivePolicy } from '../capture/index.js';
import { MigrationCandidateStatus, createMigrationCandidate, deepFreezeMigration } from './contracts.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function equal(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function sameKey(record, candidate) {
  const proposed = candidate.proposedMemory;
  return record.userId === candidate.userId && record.memoryType === proposed.memoryType &&
    record.subject === proposed.subject && record.predicate === proposed.predicate;
}
function lifeEventDifferentTime(record, candidate) {
  return candidate.proposedMemory.memoryType === 'life_event' && record.effectiveFrom !== candidate.proposedMemory.effectiveFrom;
}
function safeMatch(kind, id, reasonCode) { return { kind, id, reasonCode }; }

export class DuplicateDetector {
  detect(candidate, { memories = [], timelineEvents = [], candidates = [] } = {}) {
    const proposed = candidate.proposedMemory;
    const matches = [];
    for (const record of memories) {
      if (!sameKey(record, candidate) || !equal(record.normalizedValue, proposed.normalizedValue) || lifeEventDifferentTime(record, candidate)) continue;
      matches.push(safeMatch('memory', record.id, record.status === MemoryStatus.DELETED ? 'MIGRATION_DUPLICATE_DELETED_MEMORY' : 'MIGRATION_DUPLICATE_MEMORY'));
    }
    for (const event of timelineEvents) {
      const metadata = event?.metadata || {};
      const same = event.userId === candidate.userId && event.type === proposed.memoryType && metadata.subject === proposed.subject &&
        metadata.predicate === proposed.predicate && equal(metadata.normalizedValue, proposed.normalizedValue);
      if (same && !(proposed.memoryType === 'life_event' && event.beginTime !== proposed.effectiveFrom)) {
        matches.push(safeMatch('timeline', event.id, 'MIGRATION_DUPLICATE_TIMELINE'));
      }
    }
    for (const peer of candidates) {
      if (peer.id === candidate.id || peer.userId !== candidate.userId) continue;
      if (sameKey(peer.proposedMemory, candidate) && equal(peer.proposedMemory.normalizedValue, proposed.normalizedValue) && !lifeEventDifferentTime(peer.proposedMemory, candidate)) {
        matches.push(safeMatch('candidate', peer.id, 'MIGRATION_DUPLICATE_CANDIDATE'));
      }
    }
    return deepFreezeMigration({ isDuplicate: matches.length > 0, matches, reasonCode: matches[0]?.reasonCode || null });
  }
}

export class ConflictDetector {
  detect(candidate, { memories = [], timelineEvents = [], candidates = [] } = {}) {
    const proposed = candidate.proposedMemory;
    const matches = [];
    if (proposed.memoryType !== 'life_event') {
      for (const record of memories) {
        if (![MemoryStatus.CONFIRMED, MemoryStatus.DISPUTED].includes(record.status)) continue;
        if (sameKey(record, candidate) && !equal(record.normalizedValue, proposed.normalizedValue)) {
          matches.push(safeMatch('memory', record.id, 'MIGRATION_CONFLICT_MEMORY'));
        }
      }
      for (const peer of candidates) {
        if (peer.id !== candidate.id && sameKey(peer.proposedMemory, candidate) && !equal(peer.proposedMemory.normalizedValue, proposed.normalizedValue)) {
          matches.push(safeMatch('candidate', peer.id, 'MIGRATION_CONFLICT_CANDIDATE'));
        }
      }
    }
    for (const event of timelineEvents) {
      const metadata = event?.metadata || {};
      if (event.userId === candidate.userId && event.status === 'conflict' && event.type === proposed.memoryType &&
        metadata.subject === proposed.subject && metadata.predicate === proposed.predicate) {
        matches.push(safeMatch('timeline', event.id, 'MIGRATION_CONFLICT_TIMELINE'));
      }
    }
    return deepFreezeMigration({
      hasConflict: matches.length > 0, matches, reasonCode: matches[0]?.reasonCode || null,
      resolution: matches.length ? 'governance_required' : null
    });
  }
}

export class SensitiveDetector {
  constructor({ policy = new SensitivePolicy() } = {}) { this.policy = policy; }

  detect(candidate) {
    const proposed = candidate.proposedMemory;
    const evaluation = this.policy.evaluate(JSON.stringify([proposed.value, proposed.normalizedValue]));
    return deepFreezeMigration({
      sensitivity: evaluation.sensitivity,
      prohibited: evaluation.prohibited,
      requiresExplicitApproval: evaluation.sensitivity === MemorySensitivity.HIGH,
      categories: [...evaluation.categories],
      reasonCode: evaluation.prohibited ? 'MIGRATION_PROHIBITED_SECRET' : evaluation.sensitivity === MemorySensitivity.HIGH ? 'MIGRATION_SENSITIVE_APPROVAL_REQUIRED' : null
    });
  }

  redactProhibited(candidate) {
    const sensitiveReport = this.detect(candidate);
    if (!sensitiveReport.prohibited) return candidate;
    const proposedMemory = structuredClone(candidate.proposedMemory);
    proposedMemory.value = '[REDACTED_PROHIBITED]';
    proposedMemory.normalizedValue = '[REDACTED_PROHIBITED]';
    proposedMemory.sensitivity = MemorySensitivity.RESTRICTED;
    proposedMemory.checksum = hash(proposedMemory);
    return createMigrationCandidate({
      ...structuredClone(candidate), proposedMemory,
      status: MigrationCandidateStatus.PROHIBITED, sensitiveReport
    });
  }
}
