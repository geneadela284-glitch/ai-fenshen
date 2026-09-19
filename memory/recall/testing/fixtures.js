import { MemoryConfirmation, MemorySensitivity, MemorySourceType, MemoryStatus, MemoryType } from '../../kernel/index.js';

export const TEST_NOW = '2026-07-15T08:00:00.000Z';

export function fakeRecallContext(overrides = {}) {
  return {
    authenticatedUserId: 'fake-user-a',
    actorType: 'user',
    actorId: 'fake-user-a',
    requestId: 'fake-recall-request',
    correlationId: 'fake-recall-correlation',
    timestamp: TEST_NOW,
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    taskType: 'assistant_request',
    purpose: 'personal_assistance',
    sensitivityAllowance: MemorySensitivity.LOW,
    contextBudget: {
      maxItems: 8,
      maxCharacters: 4000,
      maxEstimatedTokens: 1000,
      maxSensitiveItems: 0,
      perTypeLimit: 4,
      reserveForCurrentTask: 200,
      reserveForSystemInstructions: 200
    },
    policyVersion: 'memory-recall-v1',
    metadata: {},
    ...overrides
  };
}

export function fakeMemoryRecord(id, overrides = {}) {
  return {
    id,
    schemaVersion: 'v1',
    userId: 'fake-user-a',
    memoryType: MemoryType.PREFERENCE,
    subject: 'fake-user-a',
    predicate: 'prefers',
    value: '虚构咖啡偏好',
    normalizedValue: '虚构咖啡偏好',
    source: { type: MemorySourceType.USER_CONFIRMED, id: `fake-source-${id}` },
    sourceTimestamp: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-01T08:00:00.000Z',
    effectiveFrom: '2026-07-01T08:00:00.000Z',
    effectiveTo: null,
    confidence: 0.9,
    importance: 0.7,
    sensitivity: MemorySensitivity.LOW,
    status: MemoryStatus.CONFIRMED,
    confirmationStatus: MemoryConfirmation.USER_CONFIRMED,
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: { mode: 'until_deleted' },
    accessPolicy: { scope: 'private' },
    checksum: null,
    tags: [],
    metadata: {},
    ...overrides
  };
}

export function staticRepository(records = [], { error = null } = {}) {
  const repository = {
    async getById(_context, id) {
      if (error) throw error;
      const record = records.find((item) => item.id === id);
      if (!record) throw Object.assign(new Error('not found'), { code: 'MEMORY_RECORD_NOT_FOUND' });
      return structuredClone(record);
    },
    async query() {
      if (error) throw error;
      return { items: structuredClone(records), nextCursor: null };
    },
    async count() { return records.length; },
    async getVersionChain() { return structuredClone(records); },
    async getConflictGroup() { return structuredClone(records); },
    async create() {}, async createMany() {}, async update() {}, async confirm() {}, async reject() {},
    async dispute() {}, async archive() {}, async expire() {}, async supersede() {},
    async moveToRecycleBin() {}, async restore() {}, async purge() {}, async withTransaction() {}
  };
  return repository;
}
