import { MemoryConfirmation, MemorySensitivity, MemoryStatus } from '../../kernel/index.js';

export const MIGRATION_NOW = '2031-02-03T04:05:06.000Z';

export function fakeMigrationContext(overrides = {}) {
  return {
    authenticatedUserId: 'fake-user-a', actorType: 'user', actorId: 'fake-user-a',
    requestId: 'fake-request-1', correlationId: 'fake-correlation-1', timestamp: MIGRATION_NOW,
    purpose: 'legacy_memory_migration', policyVersion: 'm8-v1', metadata: {}, ...overrides
  };
}

export function fakeLegacyItem(id, overrides = {}) {
  return {
    sourceRecordId: id, userId: 'fake-user-a', memoryType: 'preference', subject: 'self',
    predicate: 'prefers_drink', value: `虚构偏好-${id}`, normalizedValue: `虚构偏好-${id}`,
    occurredAt: '2030-01-02T03:04:05.000Z', confidence: 0.7, importance: 0.5,
    tags: ['fake'], metadata: {}, ...overrides
  };
}

export function fakeMigrationSource(items = [], overrides = {}) {
  return {
    id: 'fake-source-1', userId: 'fake-user-a', kind: 'fake', label: 'Fake legacy source',
    schemaVersion: 'v1', metadata: {}, scan: async () => structuredClone(items), ...overrides
  };
}

export function fakeExistingMemory(id, overrides = {}) {
  return {
    id, schemaVersion: 'v1', userId: 'fake-user-a', memoryType: 'preference', subject: 'self',
    predicate: 'prefers_drink', value: `虚构偏好-${id}`, normalizedValue: `虚构偏好-${id}`,
    source: { type: 'user_confirmed', id: `fake-source-${id}` },
    sourceTimestamp: '2029-01-02T03:04:05.000Z', createdAt: '2029-01-02T03:04:05.000Z',
    updatedAt: '2029-01-02T03:04:05.000Z', effectiveFrom: '2029-01-02T03:04:05.000Z', effectiveTo: null,
    confidence: 1, importance: 0.5, sensitivity: MemorySensitivity.LOW, status: MemoryStatus.CONFIRMED,
    confirmationStatus: MemoryConfirmation.USER_CONFIRMED, expiresAt: null, version: 1,
    supersedesId: null, supersededById: null, conflictGroupId: null,
    retentionPolicy: { mode: 'user_controlled' }, accessPolicy: { scope: 'private', allowRecall: true },
    checksum: `fake-checksum-${id}`, tags: ['fake'], metadata: {}, ...overrides
  };
}

export function fakeTimelineEvent(id, overrides = {}) {
  return {
    id, userId: 'fake-user-a', memoryIds: [`fake-memory-${id}`], title: '虚构事件', summary: '虚构摘要',
    type: 'preference', beginTime: '2030-01-02T03:04:05.000Z', endTime: null, status: 'current',
    confidence: 1, importance: 0.5, visibility: 'visible', sourceCount: 1, version: 1,
    metadata: { subject: 'self', predicate: 'prefers_drink', normalizedValue: '虚构咖啡' },
    ...overrides
  };
}

export class FakeMigrationTarget {
  constructor({ failStageAt = null, failRemoveAt = null } = {}) {
    this._candidates = new Map();
    this.failStageAt = failStageAt;
    this.failRemoveAt = failRemoveAt;
    this.stageCalls = 0;
    this.removeCalls = 0;
  }

  async withTransaction(callback) {
    const snapshot = new Map([...this._candidates].map(([id, value]) => [id, structuredClone(value)]));
    const stageCalls = this.stageCalls;
    const removeCalls = this.removeCalls;
    try { return await callback(this); }
    catch (error) {
      this._candidates = snapshot;
      this.stageCalls = stageCalls;
      this.removeCalls = removeCalls;
      throw error;
    }
  }

  async stageCandidate(candidate) {
    this.stageCalls += 1;
    if (this.failStageAt === this.stageCalls) throw new Error('fake stage failure');
    this._candidates.set(candidate.id, structuredClone(candidate));
    return structuredClone(candidate);
  }

  async removeCandidate(candidateId) {
    this.removeCalls += 1;
    if (this.failRemoveAt === this.removeCalls) throw new Error('fake remove failure');
    this._candidates.delete(candidateId);
  }

  list(userId = 'fake-user-a') {
    return [...this._candidates.values()]
      .filter((candidate) => candidate.userId === userId)
      .map((candidate) => structuredClone(candidate));
  }
}
