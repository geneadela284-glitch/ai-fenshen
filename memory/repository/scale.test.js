import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryMemoryRepository } from './index.js';

const NOW = '2040-01-01T00:00:00.000Z';
const USER_ID = 'scale-fake-user';

function context() {
  return {
    authenticatedUserId: USER_ID,
    actorType: 'system',
    actorId: 'scale-fixture-generator',
    requestId: 'scale-request',
    correlationId: 'scale-correlation',
    timestamp: NOW,
    policyVersion: 'memory-policy-v1',
    transactionId: null,
    metadata: { scaleFixture: true }
  };
}

function record(index, overrides = {}) {
  const id = `scale-memory-${String(index).padStart(4, '0')}`;
  return {
    id,
    schemaVersion: 'v1',
    userId: USER_ID,
    memoryType: index % 2 === 0 ? 'fact' : 'preference',
    subject: USER_ID,
    predicate: 'scale_fixture_value',
    value: `fictional-${index}`,
    normalizedValue: `fictional-${index}`,
    source: { type: 'structured_system_record', id: `scale-source-${index}` },
    sourceTimestamp: NOW,
    createdAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
    updatedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
    effectiveFrom: NOW,
    effectiveTo: null,
    confidence: 0.8,
    importance: (index % 10) / 10,
    sensitivity: 'low',
    status: 'confirmed',
    confirmationStatus: 'system_verified',
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: { mode: 'until_deleted' },
    accessPolicy: { scope: 'private' },
    checksum: `scale-checksum-${index}`,
    tags: ['scale-fixture'],
    metadata: { scaleFixture: true },
    ...overrides
  };
}

function options(overrides = {}) {
  return {
    idempotencyKey: null,
    requestId: 'scale-request',
    expectedVersion: null,
    operationReason: 'scale_fixture',
    ...overrides
  };
}

test('1,000-record reference baseline preserves repository behavior', async () => {
  const repository = createInMemoryMemoryRepository({
    maxQueryLimit: 100,
    clock: () => new Date(Date.parse(NOW) + 2000 * 1000)
  });
  const records = Array.from({ length: 1000 }, (_, index) => record(index));

  await repository.createMany(context(), records, options({ idempotencyKey: 'scale-batch-1000' }));
  assert.equal(await repository.count(context(), { userId: USER_ID }), 1000);
  assert.equal(await repository.count(context(), { userId: USER_ID, memoryType: 'fact' }), 500);

  const seen = new Set();
  let cursor = null;
  do {
    const page = await repository.query(context(), {
      userId: USER_ID,
      limit: 73,
      cursor,
      sort: 'createdAt:asc'
    });
    for (const item of page.items) seen.add(item.id);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 1000);

  const replacement = record(1000, { value: 'fictional-replacement', normalizedValue: 'fictional-replacement' });
  await repository.supersede(context(), records[0].id, replacement, options({ expectedVersion: 1 }));
  assert.deepEqual(
    (await repository.getVersionChain(context(), replacement.id)).map((item) => item.id),
    [records[0].id, replacement.id]
  );
  assert.equal(await repository.count(context(), { userId: USER_ID }), 1000);

  const deleted = await repository.moveToRecycleBin(context(), records[1].id, options({ expectedVersion: 1 }));
  assert.equal(await repository.count(context(), { userId: USER_ID }), 999);
  await repository.restore(context(), deleted.id, options({ expectedVersion: deleted.version }));
  assert.equal(await repository.count(context(), { userId: USER_ID }), 1000);
});
