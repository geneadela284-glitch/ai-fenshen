import { createInMemoryMemoryRepository } from '../../repository/index.js';

export const GOVERNANCE_NOW = '2026-07-15T12:00:00.000Z';

export function fakeGovernanceContext(overrides = {}) {
  return {
    authenticatedUserId: 'fake-user-a',
    actorType: 'user',
    actorId: 'fake-user-a',
    requestId: 'fake-governance-request',
    correlationId: 'fake-governance-correlation',
    timestamp: GOVERNANCE_NOW,
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    purpose: 'memory_governance',
    operation: 'view',
    confirmationToken: null,
    expectedVersion: null,
    policyVersion: 'memory-governance-v1',
    metadata: {},
    ...overrides
  };
}

export function fakeGovernanceRecord(id, overrides = {}) {
  return {
    id,
    schemaVersion: 'v1',
    userId: 'fake-user-a',
    memoryType: 'preference',
    subject: 'fake-user-a',
    predicate: 'prefers_drink',
    value: `虚构偏好-${id}`,
    normalizedValue: `虚构偏好-${id}`,
    source: { type: 'user_confirmed', id: `fake-source-${id}` },
    sourceTimestamp: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-01T08:00:00.000Z',
    effectiveFrom: '2026-07-01T08:00:00.000Z',
    effectiveTo: null,
    confidence: 0.9,
    importance: 0.7,
    sensitivity: 'low',
    status: 'confirmed',
    confirmationStatus: 'user_confirmed',
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: { mode: 'until_deleted' },
    accessPolicy: { scope: 'private', governanceMode: 'private' },
    checksum: `fake-checksum-${id}`,
    tags: ['fictional'],
    metadata: { fixture: true },
    ...overrides
  };
}

export function repositoryOptions(overrides = {}) {
  return {
    idempotencyKey: null,
    requestId: 'fake-governance-request',
    expectedVersion: null,
    operationReason: 'fictional_governance_test',
    ...overrides
  };
}

export function createGovernanceRepository(options = {}) {
  return createInMemoryMemoryRepository({ clock: () => new Date(GOVERNANCE_NOW), ...options });
}

export async function seed(repository, records, userId = 'fake-user-a') {
  const context = fakeGovernanceContext({
    authenticatedUserId: userId,
    actorId: userId,
    operation: 'view'
  });
  for (const record of records) await repository.create(
    {
      authenticatedUserId: context.authenticatedUserId,
      actorType: context.actorType,
      actorId: context.actorId,
      requestId: context.requestId,
      correlationId: context.correlationId,
      timestamp: context.timestamp,
      policyVersion: context.policyVersion,
      transactionId: null,
      metadata: {}
    },
    record,
    repositoryOptions()
  );
}
