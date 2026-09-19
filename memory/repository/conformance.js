import assert from 'node:assert/strict';
import test from 'node:test';

const NOW = '2035-05-06T07:08:09.000Z';

function context(userId = 'conformance-user-a', overrides = {}) {
  return {
    authenticatedUserId: userId,
    actorType: 'user',
    actorId: userId,
    requestId: `request-${userId}`,
    correlationId: `correlation-${userId}`,
    timestamp: NOW,
    policyVersion: 'memory-policy-v1',
    transactionId: null,
    metadata: { conformanceFixture: true },
    ...overrides
  };
}

function record(id = 'conformance-memory-001', userId = 'conformance-user-a', overrides = {}) {
  return {
    id,
    schemaVersion: 'v1',
    userId,
    memoryType: 'fact',
    subject: userId,
    predicate: 'uses_fixture',
    value: 'conformance-value',
    normalizedValue: 'conformance-value',
    source: { type: 'user_explicit', id: `source-${id}` },
    sourceTimestamp: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    effectiveFrom: NOW,
    effectiveTo: null,
    confidence: 0.9,
    importance: 0.5,
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
    checksum: `checksum-${id}`,
    tags: ['conformance'],
    metadata: { conformanceFixture: true },
    ...overrides
  };
}

function mutationOptions(overrides = {}) {
  return {
    idempotencyKey: null,
    requestId: 'conformance-request',
    expectedVersion: null,
    operationReason: 'conformance_operation',
    ...overrides
  };
}

function clock(initial = NOW) {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    advanceDays(days) { current = new Date(current.getTime() + days * 86400000); }
  };
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

export function runMemoryRepositoryConformanceSuite(factory) {
  if (typeof factory !== 'function') throw new TypeError('factory must be a function');

  function setup(options = {}) {
    const fakeClock = clock();
    return {
      repository: factory({ clock: fakeClock.now, maxQueryLimit: 100, recycleBinDays: 7, ...options }),
      fakeClock
    };
  }

  test('conformance: creates and reads a valid MemoryRecord', async () => {
    const { repository } = setup();
    const created = await repository.create(context(), record(), mutationOptions());
    assert.deepEqual(await repository.getById(context(), created.id), created);
  });

  test('conformance: create initial version is exactly one', async () => {
    const { repository } = setup();
    assert.equal((await repository.create(context(), record(), mutationOptions())).version, 1);
  });

  test('conformance: create rejects userId mismatch', async () => {
    const { repository } = setup();
    await rejectsCode(() => repository.create(context(), record('memory-b', 'conformance-user-b'), mutationOptions()), 'USER_SCOPE_MISMATCH');
  });

  test('conformance: create rejects missing source', async () => {
    const { repository } = setup();
    const invalid = record();
    delete invalid.source;
    await rejectsCode(() => repository.create(context(), invalid, mutationOptions()), 'REQUIRED');
  });

  for (const secretKey of ['password', 'apiKey', 'cookie', 'accessToken', 'privateKey']) {
    test(`conformance: create rejects prohibited secret field ${secretKey}`, async () => {
      const { repository } = setup();
      await rejectsCode(() => repository.create(context(), record(`secret-${secretKey}`, 'conformance-user-a', {
        metadata: { [secretKey]: 'conformance-secret-canary' }
      }), mutationOptions()), 'SECRET_FORBIDDEN');
    });
  }

  test('conformance: same create idempotency request returns same result', async () => {
    const { repository } = setup();
    const options = mutationOptions({ idempotencyKey: 'create-key' });
    const first = await repository.create(context(), record(), options);
    assert.deepEqual(await repository.create(context(), record(), options), first);
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 1);
  });

  test('conformance: same create idempotency key rejects different payload', async () => {
    const { repository } = setup();
    const options = mutationOptions({ idempotencyKey: 'create-key' });
    await repository.create(context(), record(), options);
    await rejectsCode(() => repository.create(context(), record('memory-other'), options), 'MEMORY_IDEMPOTENCY_CONFLICT');
  });

  test('conformance: different users may reuse create idempotency key', async () => {
    const { repository } = setup();
    const options = mutationOptions({ idempotencyKey: 'shared-key' });
    await repository.create(context(), record(), options);
    await repository.create(context('conformance-user-b'), record('memory-b', 'conformance-user-b'), options);
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 1);
    assert.equal(await repository.count(context('conformance-user-b'), { userId: 'conformance-user-b' }), 1);
  });

  test('conformance: equal value without idempotency key stays as distinct events', async () => {
    const { repository } = setup();
    await repository.create(context(), record('event-1'), mutationOptions());
    await repository.create(context(), record('event-2'), mutationOptions());
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 2);
  });

  test('conformance: createMany commits a valid batch', async () => {
    const { repository } = setup();
    const result = await repository.createMany(context(), [record('batch-1'), record('batch-2')], mutationOptions());
    assert.equal(result.length, 2);
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 2);
  });

  test('conformance: createMany failure leaves zero records', async () => {
    const { repository } = setup();
    const invalid = record('batch-invalid');
    delete invalid.source;
    await rejectsCode(() => repository.createMany(context(), [record('batch-valid'), invalid], mutationOptions()), 'MEMORY_BATCH_ATOMICITY_FAILED');
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 0);
  });

  test('conformance: createMany idempotency does not duplicate a batch', async () => {
    const { repository } = setup();
    const options = mutationOptions({ idempotencyKey: 'batch-key' });
    const records = [record('batch-1'), record('batch-2')];
    const first = await repository.createMany(context(), records, options);
    assert.deepEqual(await repository.createMany(context(), records, options), first);
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 2);
  });

  test('conformance: update requires expectedVersion', async () => {
    const { repository } = setup();
    await repository.create(context(), record(), mutationOptions());
    await rejectsCode(() => repository.update(context(), record().id, { importance: 0.7 }, mutationOptions()), 'MEMORY_EXPECTED_VERSION_REQUIRED');
  });

  test('conformance: update rejects stale expectedVersion', async () => {
    const { repository } = setup();
    await repository.create(context(), record(), mutationOptions());
    await rejectsCode(() => repository.update(context(), record().id, { importance: 0.7 }, mutationOptions({ expectedVersion: 2 })), 'MEMORY_VERSION_CONFLICT');
  });

  test('conformance: successful update increments version', async () => {
    const { repository } = setup();
    await repository.create(context(), record(), mutationOptions());
    const updated = await repository.update(context(), record().id, { importance: 0.7 }, mutationOptions({ expectedVersion: 1 }));
    assert.equal(updated.version, 2);
  });

  for (const field of ['id', 'userId', 'schemaVersion', 'value', 'normalizedValue', 'source']) {
    test(`conformance: update rejects immutable ${field}`, async () => {
      const { repository } = setup();
      await repository.create(context(), record(), mutationOptions());
      await rejectsCode(() => repository.update(context(), record().id, { [field]: 'changed' }, mutationOptions({ expectedVersion: 1 })), 'INVARIANT_VIOLATION');
    });
  }

  test('conformance: update idempotency retry does not increment twice', async () => {
    const { repository } = setup();
    await repository.create(context(), record(), mutationOptions());
    const options = mutationOptions({ expectedVersion: 1, idempotencyKey: 'update-key' });
    const first = await repository.update(context(), record().id, { importance: 0.7 }, options);
    assert.deepEqual(await repository.update(context(), record().id, { importance: 0.7 }, options), first);
    assert.equal((await repository.getById(context(), record().id)).version, 2);
  });

  const crossUserOperations = [
    ['getById', (repository) => repository.getById(context('conformance-user-b'), record().id)],
    ['query', (repository) => repository.query(context('conformance-user-b'), { userId: 'conformance-user-a' })],
    ['count', (repository) => repository.count(context('conformance-user-b'), { userId: 'conformance-user-a' })],
    ['update', (repository) => repository.update(context('conformance-user-b'), record().id, { importance: 0.7 }, mutationOptions({ expectedVersion: 1 }))],
    ['archive', (repository) => repository.archive(context('conformance-user-b'), record().id, {}, mutationOptions({ expectedVersion: 1 }))],
    ['recycle', (repository) => repository.moveToRecycleBin(context('conformance-user-b'), record().id, mutationOptions({ expectedVersion: 1 }))],
    ['purge', (repository) => repository.purge(context('conformance-user-b'), record().id, mutationOptions({ expectedVersion: 1 }))],
    ['version-chain', (repository) => repository.getVersionChain(context('conformance-user-b'), record().id)],
    ['conflict-group', (repository) => repository.getConflictGroup(context('conformance-user-b'), 'group-a')]
  ];

  for (const [name, operation] of crossUserOperations) {
    test(`conformance: cross-user ${name} returns safe not-found`, async () => {
      const { repository } = setup();
      await repository.create(context(), record(record().id, 'conformance-user-a', { conflictGroupId: 'group-a' }), mutationOptions());
      await rejectsCode(() => operation(repository), 'MEMORY_RECORD_NOT_FOUND');
    });
  }

  test('conformance: admin cannot read ordinary user body by default', async () => {
    const { repository } = setup();
    await repository.create(context(), record(), mutationOptions());
    await rejectsCode(() => repository.getById(context('conformance-admin', {
      actorType: 'admin', actorId: 'conformance-admin'
    }), record().id), 'MEMORY_RECORD_NOT_FOUND');
  });

  test('conformance: transaction commits successful writes', async () => {
    const { repository } = setup();
    await repository.withTransaction(context(), async (transaction) => {
      await transaction.create(context(), record(), mutationOptions());
    });
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 1);
  });

  test('conformance: transaction rollback removes uncommitted writes', async () => {
    const { repository } = setup();
    await rejectsCode(() => repository.withTransaction(context(), async (transaction) => {
      await transaction.create(context(), record(), mutationOptions());
      throw new Error('conformance rollback');
    }), 'MEMORY_TRANSACTION_FAILED');
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 0);
  });

  test('conformance: transaction reads its own writes', async () => {
    const { repository } = setup();
    await repository.withTransaction(context(), async (transaction) => {
      await transaction.create(context(), record(), mutationOptions());
      assert.equal(await transaction.count(context(), { userId: 'conformance-user-a' }), 1);
    });
  });

  test('conformance: uncommitted transaction writes stay invisible outside', async () => {
    const { repository } = setup();
    await repository.withTransaction(context(), async (transaction) => {
      await transaction.create(context(), record(), mutationOptions());
      assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 0);
    });
  });

  test('conformance: outer writes are rejected while a transaction is active', async () => {
    const { repository } = setup();
    await repository.withTransaction(context(), async (transaction) => {
      await transaction.create(context(), record('inside'), mutationOptions());
      await rejectsCode(
        () => repository.create(context(), record('outside'), mutationOptions()),
        'MEMORY_TRANSACTION_FAILED'
      );
    });
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 1);
  });

  test('conformance: nested transaction is rejected', async () => {
    const { repository } = setup();
    await repository.withTransaction(context(), async (transaction) => {
      await rejectsCode(() => transaction.withTransaction(context(), async () => undefined), 'MEMORY_NESTED_TRANSACTION_UNSUPPORTED');
    });
  });

  test('conformance: transaction rejects mixed-user writes atomically', async () => {
    const { repository } = setup();
    await rejectsCode(() => repository.withTransaction(context(), async (transaction) => {
      await transaction.create(context(), record('memory-a'), mutationOptions());
      await transaction.create(context('conformance-user-b'), record('memory-b', 'conformance-user-b'), mutationOptions());
    }), 'MEMORY_TRANSACTION_FAILED');
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 0);
  });

  for (const [method, status] of [
    ['confirm', 'confirmed'], ['dispute', 'disputed'], ['archive', 'archived'], ['expire', 'expired']
  ]) {
    test(`conformance: ${method} applies ${status} with version increment`, async () => {
      const { repository } = setup();
      const start = method === 'confirm'
        ? record(`memory-${method}`, 'conformance-user-a', { status: 'candidate', confirmationStatus: 'pending' })
        : record(`memory-${method}`);
      await repository.create(context(), start, mutationOptions());
      const changed = await repository[method](context(), start.id, {}, mutationOptions({ expectedVersion: 1 }));
      assert.equal(changed.status, status);
      assert.equal(changed.version, 2);
    });
  }

  test('conformance: reject preserves explicit user rejection', async () => {
    const { repository } = setup();
    const candidate = record('memory-reject', 'conformance-user-a', { status: 'candidate', confirmationStatus: 'pending' });
    await repository.create(context(), candidate, mutationOptions());
    const rejected = await repository.reject(context(), candidate.id, {}, mutationOptions({ expectedVersion: 1 }));
    assert.equal(rejected.confirmationStatus, 'user_rejected');
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 0);
  });

  test('conformance: supersede creates bidirectional version links', async () => {
    const { repository } = setup();
    await repository.create(context(), record('memory-v1'), mutationOptions());
    const result = await repository.supersede(context(), 'memory-v1', record('memory-v2'), mutationOptions({ expectedVersion: 1 }));
    assert.equal(result.previous.supersededById, 'memory-v2');
    assert.equal(result.current.supersedesId, 'memory-v1');
  });

  test('conformance: supersede removes old record from current query', async () => {
    const { repository } = setup();
    await repository.create(context(), record('memory-v1'), mutationOptions());
    await repository.supersede(context(), 'memory-v1', record('memory-v2'), mutationOptions({ expectedVersion: 1 }));
    assert.deepEqual((await repository.query(context(), { userId: 'conformance-user-a' })).items.map((item) => item.id), ['memory-v2']);
  });

  test('conformance: version chain stays complete and ordered', async () => {
    const { repository } = setup();
    await repository.create(context(), record('memory-v1'), mutationOptions());
    await repository.supersede(context(), 'memory-v1', record('memory-v2'), mutationOptions({ expectedVersion: 1 }));
    await repository.supersede(context(), 'memory-v2', record('memory-v3'), mutationOptions({ expectedVersion: 1 }));
    assert.deepEqual((await repository.getVersionChain(context(), 'memory-v2')).map((item) => item.id), ['memory-v1', 'memory-v2', 'memory-v3']);
  });

  test('conformance: self supersede is rejected', async () => {
    const { repository } = setup();
    await repository.create(context(), record('memory-v1'), mutationOptions());
    await rejectsCode(() => repository.supersede(context(), 'memory-v1', record('memory-v1'), mutationOptions({ expectedVersion: 1 })), 'INVARIANT_VIOLATION');
  });

  test('conformance: repeated supersede is rejected', async () => {
    const { repository } = setup();
    await repository.create(context(), record('memory-v1'), mutationOptions());
    await repository.supersede(context(), 'memory-v1', record('memory-v2'), mutationOptions({ expectedVersion: 1 }));
    await rejectsCode(() => repository.supersede(context(), 'memory-v1', record('memory-v3'), mutationOptions({ expectedVersion: 2 })), 'INVALID_TRANSITION');
  });

  test('conformance: failed supersede rolls back both sides', async () => {
    const { repository } = setup();
    await repository.create(context(), record('memory-v1'), mutationOptions());
    const invalid = record('memory-v2');
    delete invalid.source;
    await rejectsCode(() => repository.supersede(context(), 'memory-v1', invalid, mutationOptions({ expectedVersion: 1 })), 'MEMORY_TRANSACTION_FAILED');
    assert.equal((await repository.getById(context(), 'memory-v1')).status, 'confirmed');
    await rejectsCode(() => repository.getById(context(), 'memory-v2'), 'MEMORY_RECORD_NOT_FOUND');
  });

  test('conformance: recycle bin immediately hides a record and count excludes it', async () => {
    const { repository } = setup();
    await repository.create(context(), record(), mutationOptions());
    await repository.moveToRecycleBin(context(), record().id, mutationOptions({ expectedVersion: 1 }));
    await rejectsCode(() => repository.getById(context(), record().id), 'MEMORY_RECORD_NOT_FOUND');
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 0);
  });

  test('conformance: recycle bin can restore before seven days', async () => {
    const { repository, fakeClock } = setup();
    await repository.create(context(), record(), mutationOptions());
    await repository.moveToRecycleBin(context(), record().id, mutationOptions({ expectedVersion: 1 }));
    fakeClock.advanceDays(6);
    assert.equal((await repository.restore(context(), record().id, mutationOptions({ expectedVersion: 2 }))).status, 'confirmed');
  });

  test('conformance: recycle bin cannot restore at seven days', async () => {
    const { repository, fakeClock } = setup();
    await repository.create(context(), record(), mutationOptions());
    await repository.moveToRecycleBin(context(), record().id, mutationOptions({ expectedVersion: 1 }));
    fakeClock.advanceDays(7);
    await rejectsCode(() => repository.restore(context(), record().id, mutationOptions({ expectedVersion: 2 })), 'INVALID_TRANSITION');
  });

  test('conformance: purge is permanent', async () => {
    const { repository } = setup();
    await repository.create(context(), record(), mutationOptions());
    await repository.purge(context(), record().id, mutationOptions({ expectedVersion: 1, operationReason: 'permanent_delete' }));
    await rejectsCode(() => repository.getById(context(), record().id), 'MEMORY_RECORD_NOT_FOUND');
    await rejectsCode(() => repository.restore(context(), record().id, mutationOptions({ expectedVersion: 1 })), 'MEMORY_RECORD_NOT_FOUND');
  });

  for (const [name, query, expected] of [
    ['memoryType', { memoryType: 'goal' }, ['goal']],
    ['subject', { subject: 'subject-target' }, ['subject']],
    ['predicate', { predicate: 'predicate_target' }, ['predicate']],
    ['tags', { tags: ['target'] }, ['tags']],
    ['sensitivityMax', { sensitivityMax: 'medium' }, ['low', 'medium']]
  ]) {
    test(`conformance: query filters ${name}`, async () => {
      const { repository } = setup();
      await repository.createMany(context(), [
        record('goal', 'conformance-user-a', { memoryType: 'goal', sensitivity: 'high' }),
        record('subject', 'conformance-user-a', { subject: 'subject-target', sensitivity: 'high' }),
        record('predicate', 'conformance-user-a', { predicate: 'predicate_target', sensitivity: 'high' }),
        record('tags', 'conformance-user-a', { tags: ['conformance', 'target'], sensitivity: 'high' }),
        record('low', 'conformance-user-a', { sensitivity: 'low' }),
        record('medium', 'conformance-user-a', { sensitivity: 'medium' }),
        record('high', 'conformance-user-a', { sensitivity: 'high' })
      ], mutationOptions());
      const ids = (await repository.query(context(), { userId: 'conformance-user-a', ...query })).items.map((item) => item.id);
      assert.deepEqual(ids, expected);
    });
  }

  test('conformance: default query excludes candidates and historical records', async () => {
    const { repository } = setup();
    await repository.createMany(context(), [
      record('current'),
      record('candidate', 'conformance-user-a', { status: 'candidate', confirmationStatus: 'pending' }),
      record('archived', 'conformance-user-a', { status: 'archived' })
    ], mutationOptions());
    assert.deepEqual((await repository.query(context(), { userId: 'conformance-user-a' })).items.map((item) => item.id), ['current']);
  });

  test('conformance: includeCandidates is explicit', async () => {
    const { repository } = setup();
    await repository.create(context(), record('candidate', 'conformance-user-a', { status: 'candidate', confirmationStatus: 'pending' }), mutationOptions());
    assert.deepEqual((await repository.query(context(), { userId: 'conformance-user-a', includeCandidates: true })).items.map((item) => item.id), ['candidate']);
  });

  test('conformance: includeHistorical is explicit', async () => {
    const { repository } = setup();
    await repository.create(context(), record('archived', 'conformance-user-a', { status: 'archived' }), mutationOptions());
    assert.deepEqual((await repository.query(context(), { userId: 'conformance-user-a', includeHistorical: true })).items.map((item) => item.id), ['archived']);
  });

  test('conformance: cursor pagination is complete and duplicate-free', async () => {
    const { repository } = setup();
    await repository.createMany(context(), Array.from({ length: 9 }, (_, index) => record(`page-${index}`, 'conformance-user-a', {
      createdAt: `2035-05-06T07:08:${String(index).padStart(2, '0')}.000Z`,
      updatedAt: `2035-05-06T07:08:${String(index).padStart(2, '0')}.000Z`
    })), mutationOptions());
    const ids = [];
    let cursor = null;
    do {
      const page = await repository.query(context(), { userId: 'conformance-user-a', limit: 4, cursor });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 9);
    assert.equal(new Set(ids).size, 9);
  });

  test('conformance: returned objects cannot mutate stored state', async () => {
    const { repository } = setup();
    const created = await repository.create(context(), record(), mutationOptions());
    assert.throws(() => { created.value = 'changed'; }, TypeError);
    assert.equal((await repository.getById(context(), created.id)).value, 'conformance-value');
  });

  test('conformance: Provider label changes do not alter repository behavior', async () => {
    const { repository } = setup();
    await repository.createMany(context(), [
      record('provider-a', 'conformance-user-a', { metadata: { providerLabel: 'fake-provider-alpha' } }),
      record('provider-b', 'conformance-user-a', { metadata: { providerLabel: 'fake-provider-beta' } })
    ], mutationOptions());
    assert.equal(await repository.count(context(), { userId: 'conformance-user-a' }), 2);
  });
}
