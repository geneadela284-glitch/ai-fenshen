import { createHash, randomUUID } from 'node:crypto';

import {
  MEMORY_SCHEMA_VERSION,
  MemoryConfirmation,
  MemorySourceType,
  MemoryStatus,
  MemoryType,
  validateMemoryCandidate
} from '../kernel/index.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function captureChecksum(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function predicate(memoryType, content) {
  if (/(?:的)?生日是/.test(content)) return 'birthday';
  if (/(?:常住城市是|住在|搬到)/.test(content)) return 'resides_in_city';
  if (memoryType === MemoryType.PREFERENCE) return /(?:不喜欢|讨厌|不吃)/.test(content) ? 'avoids' : 'prefers';
  if (memoryType === MemoryType.RELATIONSHIP) return 'has_relationship';
  if (memoryType === MemoryType.GOAL) return 'has_goal';
  if (memoryType === MemoryType.LIFE_EVENT) return 'experienced_event';
  return 'stated_fact';
}

function subject(context, analysis) {
  if (analysis.semantic?.kind === 'family_birthday' && analysis.semantic.relation) {
    return `family:${analysis.semantic.relation}`;
  }
  return context.authenticatedUserId;
}

function semanticValue(content) {
  const city = content.match(/(?:常住城市是|住在|搬到)([^，。,.\s]+)/)?.[1];
  return city || content;
}

function deterministicId(kind, context, input) {
  if (!input.idempotencyKey) return null;
  const value = `${context.authenticatedUserId}\u0000${input.sourceId}\u0000${input.idempotencyKey}\u0000${kind}`;
  return `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function iso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export class MemoryCandidateBuilder {
  constructor({ clock = () => new Date(), idFactory = randomUUID } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
  }

  build(context, input, analysis, sensitivity, { sourceType = MemorySourceType.USER_EXPLICIT, modelGenerated = false } = {}) {
    const now = input.idempotencyKey ? iso(input.sourceTimestamp || context.timestamp) : iso(this.clock());
    const sourceTimestamp = iso(input.sourceTimestamp || context.timestamp);
    const value = semanticValue(analysis.content);
    const proposedMemory = {
      id: deterministicId('memory', context, input) || this.idFactory(),
      schemaVersion: MEMORY_SCHEMA_VERSION,
      userId: context.authenticatedUserId,
      memoryType: analysis.memoryType,
      subject: subject(context, analysis),
      predicate: predicate(analysis.memoryType, analysis.content),
      value,
      normalizedValue: value.toLocaleLowerCase().trim(),
      source: { type: sourceType, id: input.sourceId },
      sourceTimestamp,
      createdAt: now,
      updatedAt: now,
      effectiveFrom: sourceTimestamp,
      effectiveTo: null,
      confidence: analysis.explicit || analysis.userExplicitStatement ? 0.95 : 0.75,
      importance: analysis.directSaveAuthorized && !analysis.explicit ? 0.7 : 0.5,
      sensitivity: sensitivity.sensitivity,
      status: MemoryStatus.PENDING_CONFIRMATION,
      confirmationStatus: MemoryConfirmation.PENDING,
      expiresAt: null,
      version: 1,
      supersedesId: null,
      supersededById: null,
      conflictGroupId: null,
      retentionPolicy: { mode: 'until_deleted' },
      accessPolicy: { scope: 'private' },
      checksum: null,
      tags: [],
      metadata: {
        capture: {
          intent: analysis.intent,
          reasonCode: analysis.reasonCode,
          userExplicitStatement: analysis.userExplicitStatement === true,
          policyVersion: context.policyVersion
        }
      }
    };
    const candidate = {
      id: deterministicId('candidate', context, input) || this.idFactory(),
      schemaVersion: MEMORY_SCHEMA_VERSION,
      userId: context.authenticatedUserId,
      proposedMemory,
      source: structuredClone(proposedMemory.source),
      createdAt: now,
      expiresAt: null,
      modelGenerated,
      metadata: { integrityChecksum: captureChecksum(proposedMemory) }
    };
    const validation = validateMemoryCandidate(candidate, { trustedUserId: context.authenticatedUserId });
    if (!validation.valid) {
      const error = new Error('Memory candidate validation failed.');
      error.code = validation.errors[0].code;
      throw error;
    }
    return candidate;
  }
}
