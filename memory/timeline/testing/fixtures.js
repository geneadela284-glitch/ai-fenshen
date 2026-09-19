import {
  MemoryConfirmation,
  MemorySensitivity,
  MemorySourceType,
  MemoryStatus,
  MemoryType
} from '../../kernel/index.js';
import { createInMemoryMemoryRepository } from '../../repository/index.js';

export const TIMELINE_NOW = '2026-07-15T08:00:00.000Z';

export function fakeTimelineContext(overrides = {}) {
  return {
    authenticatedUserId: 'fake-user-a',
    actorType: 'user',
    actorId: 'fake-user-a',
    requestId: 'fake-timeline-request',
    correlationId: 'fake-timeline-correlation',
    timestamp: TIMELINE_NOW,
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    purpose: 'life_timeline',
    policyVersion: 'memory-timeline-v1',
    metadata: {},
    ...overrides
  };
}

export function fakeTimelineMemory(id, overrides = {}) {
  return {
    id,
    schemaVersion: 'v1',
    userId: 'fake-user-a',
    memoryType: MemoryType.PREFERENCE,
    subject: 'fake-user-a',
    predicate: 'prefers_drink',
    value: `虚构偏好-${id}`,
    normalizedValue: `虚构偏好-${id}`,
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
    accessPolicy: { scope: 'private', allowRecall: true },
    checksum: `fake-checksum-${id}`,
    tags: ['fictional'],
    metadata: { fixture: true },
    ...overrides
  };
}

export function fakeLifeEvent(id, overrides = {}) {
  return fakeTimelineMemory(id, {
    memoryType: MemoryType.LIFE_EVENT,
    predicate: 'experienced',
    value: `虚构人生事件-${id}`,
    normalizedValue: `虚构人生事件-${id}`,
    ...overrides
  });
}

export function fakeTimelineRepositoryContext(userId = 'fake-user-a') {
  return {
    authenticatedUserId: userId,
    actorType: 'user',
    actorId: userId,
    requestId: 'fake-timeline-seed-request',
    correlationId: 'fake-timeline-seed-correlation',
    timestamp: TIMELINE_NOW,
    policyVersion: 'memory-timeline-v1',
    transactionId: null,
    metadata: {}
  };
}

export async function seedTimelineRepository(repository, records) {
  for (const record of records) {
    await repository.create(fakeTimelineRepositoryContext(record.userId), record, {
      idempotencyKey: null,
      requestId: 'fake-timeline-seed-request',
      expectedVersion: null,
      operationReason: 'fictional_timeline_seed'
    });
  }
  return repository;
}

export function createTimelineRepository(options = {}) {
  return createInMemoryMemoryRepository({ clock: () => new Date(TIMELINE_NOW), ...options });
}
