import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_KERNEL_ERROR_CODES,
  MemoryRepository,
  validateMemoryRepositoryInterface
} from '../kernel/index.js';
import * as RepositoryModule from './index.js';
import {
  createInMemoryMemoryRepository,
  RepositoryActorType,
  validateRepositoryContext
} from './index.js';

const NOW = '2030-01-02T03:04:05.000Z';

function fakeContext(overrides = {}) {
  return {
    authenticatedUserId: 'fake-user-a',
    actorType: 'user',
    actorId: 'fake-user-a',
    requestId: 'fake-request-001',
    correlationId: 'fake-correlation-001',
    timestamp: NOW,
    policyVersion: 'memory-policy-v1',
    transactionId: null,
    metadata: { fixture: true },
    ...overrides
  };
}

function fakeRecord(id = 'fake-memory-001', userId = 'fake-user-a', overrides = {}) {
  return {
    id,
    schemaVersion: 'v1',
    userId,
    memoryType: 'preference',
    subject: userId,
    predicate: 'prefers_drink',
    value: 'tea',
    normalizedValue: 'tea',
    source: { type: 'user_explicit', id: `fake-source-${id}` },
    sourceTimestamp: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    effectiveFrom: NOW,
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
    accessPolicy: { scope: 'private' },
    checksum: `fake-checksum-${id}`,
    tags: ['fixture'],
    metadata: { fixture: true },
    ...overrides
  };
}

function options(overrides = {}) {
  return {
    idempotencyKey: null,
    requestId: 'fake-request-001',
    expectedVersion: null,
    operationReason: 'fixture_operation',
    ...overrides
  };
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => (
    error?.code === code &&
    !['fake-user', 'fake-memory', 'preference', 'sensitivity: low'].some((value) => error.message.includes(value))
  ));
}

function fakeClock(initial = NOW) {
  let current = new Date(initial);
  return {
    clock: () => new Date(current),
    set(value) { current = new Date(value); },
    advanceDays(days) { current = new Date(current.getTime() + days * 24 * 60 * 60 * 1000); }
  };
}

test('valid RepositoryContext passes', () => {
  assert.deepEqual(validateRepositoryContext(fakeContext()), { valid: true, errors: [], warnings: [] });
});

for (const field of [
  'authenticatedUserId', 'actorType', 'actorId', 'requestId',
  'correlationId', 'timestamp', 'policyVersion', 'transactionId', 'metadata'
]) {
  test(`RepositoryContext requires ${field}`, () => {
    const context = fakeContext();
    delete context[field];
    const validation = validateRepositoryContext(context);
    assert.ok(validation.errors.some((error) => error.path === field && error.code === 'REQUIRED'));
  });
}

for (const actorType of ['user', 'system', 'admin']) {
  test(`RepositoryContext accepts explicit ${actorType} actor`, () => {
    assert.equal(validateRepositoryContext(fakeContext({ actorType, actorId: `fake-${actorType}-actor` })).valid, true);
  });
}

test('RepositoryContext rejects an unknown actor type', () => {
  const validation = validateRepositoryContext(fakeContext({ actorType: 'anonymous' }));
  assert.ok(validation.errors.some((error) => error.path === 'actorType' && error.code === 'INVALID_ENUM'));
});

test('RepositoryContext rejects secret metadata', () => {
  const validation = validateRepositoryContext(fakeContext({ metadata: { accessToken: 'fake-secret-canary' } }));
  assert.ok(validation.errors.some((error) => error.path === 'metadata.accessToken' && error.code === 'SECRET_FORBIDDEN'));
});

test('RepositoryContext rejects unknown fields', () => {
  const validation = validateRepositoryContext(fakeContext({ userId: 'fake-user-b' }));
  assert.ok(validation.errors.some((error) => error.path === 'userId' && error.code === 'UNKNOWN_FIELD'));
});

test('Repository actor types are frozen and explicit', () => {
  assert.deepEqual(RepositoryActorType, { USER: 'user', SYSTEM: 'system', ADMIN: 'admin' });
  assert.ok(Object.isFrozen(RepositoryActorType));
});

const repositoryMethods = [
  'getById', 'query', 'count', 'getVersionChain', 'getConflictGroup',
  'create', 'createMany', 'update', 'confirm', 'reject', 'dispute',
  'archive', 'expire', 'supersede', 'moveToRecycleBin', 'restore',
  'purge', 'withTransaction'
];

test('MemoryRepository freezes the complete M2 behavior surface', () => {
  assert.deepEqual(MemoryRepository.requiredMethods, repositoryMethods);
  assert.ok(Object.isFrozen(MemoryRepository.requiredMethods));
});

test('MemoryRepository interface rejects every missing M2 method', () => {
  for (const missing of repositoryMethods) {
    const port = Object.fromEntries(repositoryMethods.filter((name) => name !== missing).map((name) => [name, () => undefined]));
    const validation = validateMemoryRepositoryInterface(port);
    assert.ok(validation.errors.some((error) => error.path === missing && error.code === 'INTERFACE_METHOD_MISSING'));
  }
});

test('Repository module does not expose storage capability contracts', () => {
  assert.equal('MEMORY_STORAGE_CAPABILITIES' in RepositoryModule, false);
  assert.equal('IN_MEMORY_STORAGE_CAPABILITIES' in RepositoryModule, false);
});

for (const code of [
  'MEMORY_EXPECTED_VERSION_REQUIRED',
  'MEMORY_VERSION_CONFLICT',
  'MEMORY_RECORD_NOT_FOUND',
  'MEMORY_TRANSACTION_FAILED',
  'MEMORY_NESTED_TRANSACTION_UNSUPPORTED',
  'MEMORY_BATCH_ATOMICITY_FAILED'
]) {
  test(`Kernel exposes M2 repository error code ${code}`, () => {
    assert.ok(MEMORY_KERNEL_ERROR_CODES.includes(code));
  });
}

test('in-memory repository conforms to the M2 interface', () => {
  assert.equal(validateMemoryRepositoryInterface(createInMemoryMemoryRepository()).valid, true);
});

test('create stores a valid user-scoped record at version one', async () => {
  const repository = createInMemoryMemoryRepository();
  const created = await repository.create(fakeContext(), fakeRecord(), options());
  assert.equal(created.id, 'fake-memory-001');
  assert.equal(created.userId, 'fake-user-a');
  assert.equal(created.version, 1);
  assert.deepEqual(await repository.getById(fakeContext(), created.id), created);
});

test('create rejects record userId mismatch', async () => {
  const repository = createInMemoryMemoryRepository();
  await rejectsCode(
    () => repository.create(fakeContext(), fakeRecord('fake-memory-b', 'fake-user-b'), options()),
    'USER_SCOPE_MISMATCH'
  );
});

test('create rejects missing source through Kernel validation', async () => {
  const repository = createInMemoryMemoryRepository();
  const record = fakeRecord();
  delete record.source;
  await rejectsCode(() => repository.create(fakeContext(), record, options()), 'REQUIRED');
});

test('create rejects prohibited secret fields through Kernel validation', async () => {
  const repository = createInMemoryMemoryRepository();
  await rejectsCode(
    () => repository.create(fakeContext(), fakeRecord('fake-secret-record', 'fake-user-a', {
      metadata: { accessToken: 'fake-secret-canary' }
    }), options()),
    'SECRET_FORBIDDEN'
  );
});

test('create rejects an initial version other than one', async () => {
  const repository = createInMemoryMemoryRepository();
  await rejectsCode(
    () => repository.create(fakeContext(), fakeRecord('fake-version-two', 'fake-user-a', { version: 2 }), options()),
    'INVARIANT_VIOLATION'
  );
});

test('cross-user getById returns only the safe not-found error', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  await rejectsCode(
    () => repository.getById(fakeContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' }), 'fake-memory-001'),
    'MEMORY_RECORD_NOT_FOUND'
  );
});

test('admin actor cannot read another authenticated user scope', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  const adminContext = fakeContext({
    authenticatedUserId: 'fake-admin',
    actorType: 'admin',
    actorId: 'fake-admin'
  });
  await rejectsCode(() => repository.getById(adminContext, 'fake-memory-001'), 'MEMORY_RECORD_NOT_FOUND');
});

test('system actor remains explicitly scoped to authenticatedUserId', async () => {
  const repository = createInMemoryMemoryRepository();
  const systemContext = fakeContext({ actorType: 'system', actorId: 'fake-system-worker' });
  const created = await repository.create(systemContext, fakeRecord(), options());
  assert.equal(created.userId, systemContext.authenticatedUserId);
});

test('mutating a create result does not mutate repository state', async () => {
  const repository = createInMemoryMemoryRepository();
  const created = await repository.create(fakeContext(), fakeRecord(), options());
  assert.throws(() => { created.value = 'mutated'; }, TypeError);
  assert.equal((await repository.getById(fakeContext(), created.id)).value, 'tea');
});

test('mutating source input after create does not mutate repository state', async () => {
  const repository = createInMemoryMemoryRepository();
  const input = fakeRecord();
  await repository.create(fakeContext(), input, options());
  input.value = 'mutated';
  assert.equal((await repository.getById(fakeContext(), input.id)).value, 'tea');
});

test('reset clears only the in-memory reference instance', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  repository.reset();
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 0);
});

test('createMany commits all valid records atomically', async () => {
  const repository = createInMemoryMemoryRepository();
  const created = await repository.createMany(fakeContext(), [
    fakeRecord('fake-batch-1'),
    fakeRecord('fake-batch-2')
  ], options());
  assert.equal(created.length, 2);
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 2);
});

test('createMany rolls back every record when one is invalid', async () => {
  const repository = createInMemoryMemoryRepository();
  const invalid = fakeRecord('fake-batch-invalid');
  delete invalid.source;
  await rejectsCode(
    () => repository.createMany(fakeContext(), [fakeRecord('fake-batch-valid'), invalid], options()),
    'MEMORY_BATCH_ATOMICITY_FAILED'
  );
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 0);
});

test('update requires expectedVersion', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  await rejectsCode(
    () => repository.update(fakeContext(), 'fake-memory-001', { importance: 0.8 }, options()),
    'MEMORY_EXPECTED_VERSION_REQUIRED'
  );
});

test('update rejects stale expectedVersion', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  await rejectsCode(
    () => repository.update(fakeContext(), 'fake-memory-001', { importance: 0.8 }, options({ expectedVersion: 2 })),
    'MEMORY_VERSION_CONFLICT'
  );
});

test('update increments version exactly once', async () => {
  const repository = createInMemoryMemoryRepository({ clock: () => NOW });
  await repository.create(fakeContext(), fakeRecord(), options());
  const updated = await repository.update(
    fakeContext(),
    'fake-memory-001',
    { importance: 0.8, tags: ['fixture', 'updated'] },
    options({ expectedVersion: 1 })
  );
  assert.equal(updated.version, 2);
  assert.equal(updated.importance, 0.8);
  assert.deepEqual(updated.tags, ['fixture', 'updated']);
});

for (const immutableField of ['id', 'userId', 'schemaVersion', 'value', 'normalizedValue', 'source']) {
  test(`update rejects immutable field ${immutableField}`, async () => {
    const repository = createInMemoryMemoryRepository();
    await repository.create(fakeContext(), fakeRecord(), options());
    await rejectsCode(
      () => repository.update(fakeContext(), 'fake-memory-001', { [immutableField]: 'changed' }, options({ expectedVersion: 1 })),
      'INVARIANT_VIOLATION'
    );
  });
}

test('create idempotency retry returns the same record without duplicate creation', async () => {
  const repository = createInMemoryMemoryRepository();
  const createOptions = options({ idempotencyKey: 'fake-create-key' });
  const first = await repository.create(fakeContext(), fakeRecord(), createOptions);
  const second = await repository.create(fakeContext(), fakeRecord(), createOptions);
  assert.deepEqual(second, first);
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 1);
});

test('same idempotency key with a different create payload is rejected', async () => {
  const repository = createInMemoryMemoryRepository();
  const createOptions = options({ idempotencyKey: 'fake-create-key' });
  await repository.create(fakeContext(), fakeRecord(), createOptions);
  await rejectsCode(
    () => repository.create(fakeContext(), fakeRecord('fake-memory-002'), createOptions),
    'MEMORY_IDEMPOTENCY_CONFLICT'
  );
});

test('different users may reuse the same idempotency key', async () => {
  const repository = createInMemoryMemoryRepository();
  const createOptions = options({ idempotencyKey: 'shared-fake-key' });
  await repository.create(fakeContext(), fakeRecord(), createOptions);
  const contextB = fakeContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' });
  await repository.create(contextB, fakeRecord('fake-memory-b', 'fake-user-b'), createOptions);
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 1);
  assert.equal(await repository.count(contextB, { userId: 'fake-user-b' }), 1);
});

test('equal text without idempotency key remains two legitimate events', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord('fake-event-1'), options());
  await repository.create(fakeContext(), fakeRecord('fake-event-2'), options());
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 2);
});

test('withTransaction commits successful changes', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.withTransaction(fakeContext(), async (transaction) => {
    await transaction.create(fakeContext(), fakeRecord(), options());
  });
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 1);
});

test('transaction reads its own uncommitted changes while outer repository cannot', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.withTransaction(fakeContext(), async (transaction) => {
    await transaction.create(fakeContext(), fakeRecord(), options());
    assert.equal(await transaction.count(fakeContext(), { userId: 'fake-user-a' }), 1);
    assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 0);
  });
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 1);
});

test('withTransaction rolls back callback failure', async () => {
  const repository = createInMemoryMemoryRepository();
  await rejectsCode(
    () => repository.withTransaction(fakeContext(), async (transaction) => {
      await transaction.create(fakeContext(), fakeRecord(), options());
      throw new Error('fake callback failure');
    }),
    'MEMORY_TRANSACTION_FAILED'
  );
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 0);
});

test('nested transaction is explicitly rejected', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.withTransaction(fakeContext(), async (transaction) => {
    await rejectsCode(
      () => transaction.withTransaction(fakeContext(), async () => undefined),
      'MEMORY_NESTED_TRANSACTION_UNSUPPORTED'
    );
  });
});

test('confirm turns a pending candidate into a confirmed fact', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord('fake-candidate', 'fake-user-a', {
    status: 'pending_confirmation',
    confirmationStatus: 'pending'
  }), options());
  const confirmed = await repository.confirm(
    fakeContext(),
    'fake-candidate',
    { confirmationStatus: 'user_confirmed' },
    options({ expectedVersion: 1 })
  );
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmationStatus, 'user_confirmed');
  assert.equal(confirmed.version, 2);
});

test('confirm requires expectedVersion', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord('fake-candidate', 'fake-user-a', {
    status: 'candidate', confirmationStatus: 'pending'
  }), options());
  await rejectsCode(
    () => repository.confirm(fakeContext(), 'fake-candidate', { confirmationStatus: 'user_confirmed' }, options()),
    'MEMORY_EXPECTED_VERSION_REQUIRED'
  );
});

test('reject records user rejection without leaving a current fact', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord('fake-reject', 'fake-user-a', {
    status: 'pending_confirmation', confirmationStatus: 'pending'
  }), options());
  const rejected = await repository.reject(fakeContext(), 'fake-reject', {}, options({ expectedVersion: 1 }));
  assert.equal(rejected.status, 'archived');
  assert.equal(rejected.confirmationStatus, 'user_rejected');
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 0);
});

for (const [method, expectedStatus] of [
  ['dispute', 'disputed'],
  ['archive', 'archived'],
  ['expire', 'expired']
]) {
  test(`${method} applies its explicit status and increments version`, async () => {
    const time = fakeClock();
    const repository = createInMemoryMemoryRepository({ clock: time.clock });
    await repository.create(fakeContext(), fakeRecord(`fake-${method}`), options());
    const changed = await repository[method](
      fakeContext(), `fake-${method}`, {}, options({ expectedVersion: 1 })
    );
    assert.equal(changed.status, expectedStatus);
    assert.equal(changed.version, 2);
    assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 0);
  });
}

test('state mutation rejects stale expectedVersion', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  await rejectsCode(
    () => repository.archive(fakeContext(), 'fake-memory-001', {}, options({ expectedVersion: 2 })),
    'MEMORY_VERSION_CONFLICT'
  );
});

test('cross-user state mutation returns safe not-found', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  const contextB = fakeContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' });
  await rejectsCode(
    () => repository.archive(contextB, 'fake-memory-001', {}, options({ expectedVersion: 1 })),
    'MEMORY_RECORD_NOT_FOUND'
  );
});

test('supersede atomically links old and replacement records', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord('fake-old'), options());
  const result = await repository.supersede(
    fakeContext(),
    'fake-old',
    fakeRecord('fake-new', 'fake-user-a', { value: 'coffee', normalizedValue: 'coffee' }),
    options({ expectedVersion: 1 })
  );
  assert.equal(result.previous.status, 'superseded');
  assert.equal(result.previous.supersededById, 'fake-new');
  assert.equal(result.previous.version, 2);
  assert.equal(result.current.status, 'confirmed');
  assert.equal(result.current.supersedesId, 'fake-old');
  assert.equal(result.current.version, 1);
});

test('supersede leaves only the replacement in current query', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord('fake-old'), options());
  await repository.supersede(
    fakeContext(), 'fake-old', fakeRecord('fake-new'), options({ expectedVersion: 1 })
  );
  const result = await repository.query(fakeContext(), { userId: 'fake-user-a' });
  assert.deepEqual(result.items.map((record) => record.id), ['fake-new']);
});

test('getVersionChain returns a complete oldest-to-newest chain', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord('fake-v1'), options());
  await repository.supersede(fakeContext(), 'fake-v1', fakeRecord('fake-v2'), options({ expectedVersion: 1 }));
  await repository.supersede(fakeContext(), 'fake-v2', fakeRecord('fake-v3'), options({ expectedVersion: 1 }));
  const chain = await repository.getVersionChain(fakeContext(), 'fake-v2');
  assert.deepEqual(chain.map((record) => record.id), ['fake-v1', 'fake-v2', 'fake-v3']);
});

test('supersede rejects self replacement', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord('fake-same'), options());
  await rejectsCode(
    () => repository.supersede(fakeContext(), 'fake-same', fakeRecord('fake-same'), options({ expectedVersion: 1 })),
    'INVARIANT_VIOLATION'
  );
});

test('supersede rejects a record already superseded', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord('fake-old'), options());
  await repository.supersede(fakeContext(), 'fake-old', fakeRecord('fake-new'), options({ expectedVersion: 1 }));
  await rejectsCode(
    () => repository.supersede(fakeContext(), 'fake-old', fakeRecord('fake-newer'), options({ expectedVersion: 2 })),
    'INVALID_TRANSITION'
  );
});

test('failed supersede leaves the old record current and creates no replacement', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord('fake-old'), options());
  const invalid = fakeRecord('fake-invalid');
  delete invalid.source;
  await rejectsCode(
    () => repository.supersede(fakeContext(), 'fake-old', invalid, options({ expectedVersion: 1 })),
    'MEMORY_TRANSACTION_FAILED'
  );
  assert.equal((await repository.getById(fakeContext(), 'fake-old')).status, 'confirmed');
  await rejectsCode(() => repository.getById(fakeContext(), 'fake-invalid'), 'MEMORY_RECORD_NOT_FOUND');
});

test('moveToRecycleBin immediately removes a record from normal reads', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord(), options());
  const deleted = await repository.moveToRecycleBin(
    fakeContext(), 'fake-memory-001', options({ expectedVersion: 1, operationReason: 'user_delete' })
  );
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.version, 2);
  assert.equal(deleted.metadata.recycleBin.previousStatus, 'confirmed');
  assert.equal(deleted.metadata.recycleBin.deletedAt, NOW);
  assert.equal(deleted.metadata.recycleBin.purgeAfter, '2030-01-09T03:04:05.000Z');
  await rejectsCode(() => repository.getById(fakeContext(), 'fake-memory-001'), 'MEMORY_RECORD_NOT_FOUND');
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a' }), 0);
});

test('moveToRecycleBin requires expectedVersion', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  await rejectsCode(
    () => repository.moveToRecycleBin(fakeContext(), 'fake-memory-001', options()),
    'MEMORY_EXPECTED_VERSION_REQUIRED'
  );
});

test('restore before purgeAfter returns the record to its previous status', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord(), options());
  await repository.moveToRecycleBin(fakeContext(), 'fake-memory-001', options({ expectedVersion: 1 }));
  time.advanceDays(6);
  const restored = await repository.restore(
    fakeContext(), 'fake-memory-001', options({ expectedVersion: 2, operationReason: 'user_restore' })
  );
  assert.equal(restored.status, 'confirmed');
  assert.equal(restored.version, 3);
  assert.equal(restored.metadata.recycleBin, undefined);
  assert.equal(restored.metadata.recycleHistory.at(-1).reasonCode, 'user_restore');
});

test('restore at or after purgeAfter is rejected', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord(), options());
  await repository.moveToRecycleBin(fakeContext(), 'fake-memory-001', options({ expectedVersion: 1 }));
  time.advanceDays(7);
  await rejectsCode(
    () => repository.restore(fakeContext(), 'fake-memory-001', options({ expectedVersion: 2 })),
    'INVALID_TRANSITION'
  );
});

test('deleted record cannot have its body updated', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord(), options());
  await repository.moveToRecycleBin(fakeContext(), 'fake-memory-001', options({ expectedVersion: 1 }));
  await rejectsCode(
    () => repository.update(fakeContext(), 'fake-memory-001', { importance: 0.2 }, options({ expectedVersion: 2 })),
    'MEMORY_RECORD_NOT_FOUND'
  );
});

test('purge permanently removes a record and makes restore impossible', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord(), options());
  await repository.moveToRecycleBin(fakeContext(), 'fake-memory-001', options({ expectedVersion: 1 }));
  const purged = await repository.purge(
    fakeContext(), 'fake-memory-001', options({ expectedVersion: 2, operationReason: 'permanent_delete' })
  );
  assert.deepEqual(purged, { id: 'fake-memory-001', purged: true, reasonCode: 'permanent_delete' });
  await rejectsCode(() => repository.getById(fakeContext(), 'fake-memory-001'), 'MEMORY_RECORD_NOT_FOUND');
  await rejectsCode(
    () => repository.restore(fakeContext(), 'fake-memory-001', options({ expectedVersion: 2 })),
    'MEMORY_RECORD_NOT_FOUND'
  );
});

test('prohibited secret purge retains no body in safe diagnostics', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord('fake-purge-secret', 'fake-user-a', {
    value: 'prohibited-secret-canary', normalizedValue: 'prohibited-secret-canary'
  }), options());
  await repository.purge(
    fakeContext(), 'fake-purge-secret', options({ expectedVersion: 1, operationReason: 'prohibited_secret' })
  );
  const diagnostics = JSON.stringify(repository.inspectSafeState());
  assert.equal(diagnostics.includes('prohibited-secret-canary'), false);
  assert.equal(diagnostics.includes('prohibited_secret'), true);
});

test('cross-user restore and purge both return safe not-found', async () => {
  const time = fakeClock();
  const repository = createInMemoryMemoryRepository({ clock: time.clock });
  await repository.create(fakeContext(), fakeRecord(), options());
  await repository.moveToRecycleBin(fakeContext(), 'fake-memory-001', options({ expectedVersion: 1 }));
  const contextB = fakeContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' });
  await rejectsCode(() => repository.restore(contextB, 'fake-memory-001', options({ expectedVersion: 2 })), 'MEMORY_RECORD_NOT_FOUND');
  await rejectsCode(() => repository.purge(contextB, 'fake-memory-001', options({ expectedVersion: 2 })), 'MEMORY_RECORD_NOT_FOUND');
});

test('query rejects a cross-user scope without revealing records', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord(), options());
  await rejectsCode(
    () => repository.query(fakeContext(), { userId: 'fake-user-b' }),
    'MEMORY_RECORD_NOT_FOUND'
  );
});

for (const [status, confirmationStatus] of [
  ['candidate', 'pending'],
  ['pending_confirmation', 'pending'],
  ['disputed', 'user_confirmed'],
  ['superseded', 'user_confirmed'],
  ['expired', 'user_confirmed'],
  ['archived', 'user_confirmed'],
  ['deleted', 'user_confirmed']
]) {
  test(`default query excludes ${status}`, async () => {
    const repository = createInMemoryMemoryRepository();
    const record = fakeRecord(`fake-${status}`, 'fake-user-a', { status, confirmationStatus });
    if (status === 'superseded') record.supersededById = 'fake-future-record';
    await repository.create(fakeContext(), record, options());
    assert.equal((await repository.query(fakeContext(), { userId: 'fake-user-a' })).items.length, 0);
  });
}

test('includeHistorical returns non-deleted historical records', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-current'),
    fakeRecord('fake-disputed', 'fake-user-a', { status: 'disputed' }),
    fakeRecord('fake-archived', 'fake-user-a', { status: 'archived' }),
    fakeRecord('fake-expired', 'fake-user-a', { status: 'expired' })
  ], options());
  const result = await repository.query(fakeContext(), { userId: 'fake-user-a', includeHistorical: true });
  assert.deepEqual(result.items.map((record) => record.id), [
    'fake-archived', 'fake-current', 'fake-disputed', 'fake-expired'
  ]);
});

test('includeCandidates returns pending candidates but not user-rejected records', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-candidate', 'fake-user-a', { status: 'candidate', confirmationStatus: 'pending' }),
    fakeRecord('fake-pending', 'fake-user-a', { status: 'pending_confirmation', confirmationStatus: 'pending' }),
    fakeRecord('fake-rejected', 'fake-user-a', { status: 'archived', confirmationStatus: 'user_rejected' })
  ], options());
  const result = await repository.query(fakeContext(), { userId: 'fake-user-a', includeCandidates: true });
  assert.deepEqual(result.items.map((record) => record.id), ['fake-candidate', 'fake-pending']);
});

test('explicit rejected confirmation filter requires historical inclusion', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord('fake-rejected', 'fake-user-a', {
    status: 'archived', confirmationStatus: 'user_rejected'
  }), options());
  const result = await repository.query(fakeContext(), {
    userId: 'fake-user-a',
    includeHistorical: true,
    confirmationStatus: 'user_rejected'
  });
  assert.deepEqual(result.items.map((record) => record.id), ['fake-rejected']);
});

test('query filters exact memoryType, subject, and predicate', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-preference'),
    fakeRecord('fake-goal', 'fake-user-a', {
      memoryType: 'goal', subject: 'fake-project', predicate: 'targets'
    })
  ], options());
  const result = await repository.query(fakeContext(), {
    userId: 'fake-user-a', memoryType: 'goal', subject: 'fake-project', predicate: 'targets'
  });
  assert.deepEqual(result.items.map((record) => record.id), ['fake-goal']);
});

test('query supports explicit status and confirmationStatus', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-confirmed'),
    fakeRecord('fake-system', 'fake-user-a', { confirmationStatus: 'system_verified' })
  ], options());
  const result = await repository.query(fakeContext(), {
    userId: 'fake-user-a', status: 'confirmed', confirmationStatus: 'system_verified'
  });
  assert.deepEqual(result.items.map((record) => record.id), ['fake-system']);
});

test('query sensitivityMax excludes higher sensitivity', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-public', 'fake-user-a', { sensitivity: 'public' }),
    fakeRecord('fake-medium', 'fake-user-a', { sensitivity: 'medium' }),
    fakeRecord('fake-high', 'fake-user-a', { sensitivity: 'high' })
  ], options());
  const result = await repository.query(fakeContext(), { userId: 'fake-user-a', sensitivityMax: 'medium' });
  assert.deepEqual(result.items.map((record) => record.id), ['fake-medium', 'fake-public']);
});

test('query filters records effective at the requested instant', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-effective', 'fake-user-a', {
      effectiveFrom: '2029-01-01T00:00:00.000Z',
      effectiveTo: '2031-01-01T00:00:00.000Z'
    }),
    fakeRecord('fake-future', 'fake-user-a', { effectiveFrom: '2032-01-01T00:00:00.000Z' })
  ], options());
  const result = await repository.query(fakeContext(), { userId: 'fake-user-a', effectiveAt: NOW });
  assert.deepEqual(result.items.map((record) => record.id), ['fake-effective']);
});

test('query requires every requested tag', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-all-tags', 'fake-user-a', { tags: ['fixture', 'alpha', 'beta'] }),
    fakeRecord('fake-one-tag', 'fake-user-a', { tags: ['fixture', 'alpha'] })
  ], options());
  const result = await repository.query(fakeContext(), { userId: 'fake-user-a', tags: ['alpha', 'beta'] });
  assert.deepEqual(result.items.map((record) => record.id), ['fake-all-tags']);
});

test('query rejects a limit above the configured maximum', async () => {
  const repository = createInMemoryMemoryRepository({ maxQueryLimit: 2 });
  await rejectsCode(
    () => repository.query(fakeContext(), { userId: 'fake-user-a', limit: 3 }),
    'INVALID_RANGE'
  );
});

test('cursor pagination has no duplicates or omissions', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), Array.from({ length: 7 }, (_, index) => (
    fakeRecord(`fake-page-${index}`, 'fake-user-a', {
      createdAt: `2030-01-02T03:04:${String(index).padStart(2, '0')}.000Z`,
      updatedAt: `2030-01-02T03:04:${String(index).padStart(2, '0')}.000Z`
    })
  )), options());
  const ids = [];
  let pageCount = 0;
  let cursor = null;
  do {
    const page = await repository.query(fakeContext(), {
      userId: 'fake-user-a', limit: 3, cursor, sort: 'createdAt:asc'
    });
    ids.push(...page.items.map((record) => record.id));
    pageCount += 1;
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, Array.from({ length: 7 }, (_, index) => `fake-page-${index}`));
  assert.equal(new Set(ids).size, 7);
  assert.equal(pageCount, 3);
});

test('cursor contains no record id, value, subject, or predicate', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [fakeRecord('fake-cursor-secret'), fakeRecord('fake-cursor-next')], options());
  const page = await repository.query(fakeContext(), { userId: 'fake-user-a', limit: 1 });
  const decoded = Buffer.from(page.nextCursor, 'base64url').toString('utf8');
  for (const forbidden of ['fake-cursor-secret', 'tea', 'fake-user-a', 'prefers_drink']) {
    assert.equal(decoded.includes(forbidden), false);
  }
});

for (const sort of ['createdAt:asc', 'createdAt:desc', 'updatedAt:asc', 'updatedAt:desc', 'importance:asc', 'importance:desc']) {
  test(`query sort ${sort} is stable and deterministic`, async () => {
    const repository = createInMemoryMemoryRepository();
    await repository.createMany(fakeContext(), [
      fakeRecord('fake-sort-b', 'fake-user-a', { importance: 0.2 }),
      fakeRecord('fake-sort-a', 'fake-user-a', { importance: 0.8 })
    ], options());
    const first = await repository.query(fakeContext(), { userId: 'fake-user-a', sort });
    const second = await repository.query(fakeContext(), { userId: 'fake-user-a', sort });
    assert.deepEqual(first.items.map((record) => record.id), second.items.map((record) => record.id));
  });
}

test('count applies filters but ignores pagination', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-count-1'), fakeRecord('fake-count-2'), fakeRecord('fake-count-3')
  ], options());
  assert.equal(await repository.count(fakeContext(), { userId: 'fake-user-a', limit: 1 }), 3);
});

test('conflict group is user-scoped and returns stable frozen copies', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.createMany(fakeContext(), [
    fakeRecord('fake-conflict-b', 'fake-user-a', { conflictGroupId: 'fake-group' }),
    fakeRecord('fake-conflict-a', 'fake-user-a', { conflictGroupId: 'fake-group' })
  ], options());
  const records = await repository.getConflictGroup(fakeContext(), 'fake-group');
  assert.deepEqual(records.map((record) => record.id), ['fake-conflict-a', 'fake-conflict-b']);
  assert.ok(Object.isFrozen(records));
});

test('cross-user version chain and conflict group return safe not-found', async () => {
  const repository = createInMemoryMemoryRepository();
  await repository.create(fakeContext(), fakeRecord('fake-chain', 'fake-user-a', { conflictGroupId: 'fake-group' }), options());
  const contextB = fakeContext({ authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' });
  await rejectsCode(() => repository.getVersionChain(contextB, 'fake-chain'), 'MEMORY_RECORD_NOT_FOUND');
  await rejectsCode(() => repository.getConflictGroup(contextB, 'fake-group'), 'MEMORY_RECORD_NOT_FOUND');
});
