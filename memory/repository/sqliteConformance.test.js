import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSQLitePersistenceAdapter } from '../persistence/sqlite/sqlitePersistenceAdapter.js';
import { runMemoryRepositoryConformanceSuite } from './conformance.js';
import { createPersistenceMemoryRepository } from './persistenceMemoryRepository.js';

const conformanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sqlite-repository-'));
const repositories = [];
let sequence = 0;

function factory(options = {}) {
  sequence += 1;
  const adapter = createSQLitePersistenceAdapter({
    rootDirectory: conformanceRoot,
    databasePath: `repository-${sequence}.sqlite`,
    backupDirectory: 'backups',
    clock: options.clock
  });
  const repository = createPersistenceMemoryRepository({ adapter, ...options });
  repositories.push(repository);
  return repository;
}

runMemoryRepositoryConformanceSuite(factory);

test.after(async () => {
  for (const repository of repositories) await repository.close();
  fs.rmSync(conformanceRoot, { recursive: true, force: true });
});

function context(userId = 'fake-user-a') {
  return {
    authenticatedUserId: userId,
    actorType: 'user',
    actorId: userId,
    requestId: 'fake-restart-request',
    correlationId: 'fake-restart-correlation',
    timestamp: '2026-07-15T10:00:00.000Z',
    policyVersion: 'memory-policy-v1',
    transactionId: null,
    metadata: { fixture: true }
  };
}

function record(id, overrides = {}) {
  return {
    id,
    schemaVersion: 'v1',
    userId: 'fake-user-a',
    memoryType: 'fact',
    subject: 'fictional-subject',
    predicate: 'fictional_predicate',
    value: { text: `fictional-${id}` },
    normalizedValue: { text: `fictional-${id}` },
    source: { type: 'user_explicit', id: `fake-source-${id}` },
    sourceTimestamp: '2026-07-15T10:00:00.000Z',
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    effectiveFrom: '2026-07-15T10:00:00.000Z',
    effectiveTo: null,
    confidence: 0.9,
    importance: 0.7,
    sensitivity: 'low',
    status: 'confirmed',
    confirmationStatus: 'not_required',
    expiresAt: null,
    version: 1,
    supersedesId: null,
    supersededById: null,
    conflictGroupId: null,
    retentionPolicy: { mode: 'retain' },
    accessPolicy: { scope: 'private' },
    checksum: `fake-checksum-${id}`,
    tags: ['fictional'],
    metadata: { fixture: true },
    ...overrides
  };
}

function options(overrides = {}) {
  return {
    idempotencyKey: null,
    requestId: 'fake-restart-request',
    expectedVersion: null,
    operationReason: 'fictional_test',
    ...overrides
  };
}

test('real restart preserves records, version chain, idempotency, deletion, and user isolation', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sqlite-restart-'));
  test.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  const adapterOptions = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups' };

  const firstAdapter = createSQLitePersistenceAdapter(adapterOptions);
  const first = createPersistenceMemoryRepository({ adapter: firstAdapter });
  await first.create(context(), record('fact'), options({ idempotencyKey: 'fact-create' }));
  await first.create(context(), record('preference', { memoryType: 'preference' }), options());
  await first.create(context(), record('candidate', {
    memoryType: 'memory_candidate', status: 'candidate', confirmationStatus: 'pending', confidence: 0.5
  }), options());
  await first.supersede(context(), 'fact', record('fact-v2'), options({ expectedVersion: 1, idempotencyKey: 'fact-supersede' }));
  await first.moveToRecycleBin(context(), 'preference', options({ expectedVersion: 1 }));
  await first.close();

  const secondAdapter = createSQLitePersistenceAdapter(adapterOptions);
  const second = createPersistenceMemoryRepository({ adapter: secondAdapter });
  assert.deepEqual((await second.getVersionChain(context(), 'fact-v2')).map((item) => item.id), ['fact', 'fact-v2']);
  assert.equal((await second.getById(context(), 'fact-v2')).checksum, 'fake-checksum-fact-v2');
  assert.equal((await second.create(context(), record('fact'), options({ idempotencyKey: 'fact-create' }))).id, 'fact');
  await assert.rejects(() => second.getById(context(), 'preference'), (error) => error?.code === 'MEMORY_RECORD_NOT_FOUND');
  await assert.rejects(() => second.getById(context('fake-user-b'), 'fact-v2'), (error) => error?.code === 'MEMORY_RECORD_NOT_FOUND');
  assert.equal((await secondAdapter.integrityCheck()).status, 'valid');
  await second.close();
});
