import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSQLitePersistenceAdapter } from '../persistence/sqlite/sqlitePersistenceAdapter.js';
import { createPersistenceMemoryRepository } from '../repository/index.js';
import { MemoryCaptureService } from './index.js';
import { fakeConversation, fakeUserContext, FAKE_NOW } from './testFixtures.js';

test('explicit fake memory survives a real SQLite close and reopen', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-capture-sqlite-'));
  const adapterOptions = {
    rootDirectory,
    databasePath: 'memory.sqlite',
    backupDirectory: 'backups'
  };
  let firstRepository;
  let reopenedRepository;
  try {
    firstRepository = createPersistenceMemoryRepository({
      adapter: createSQLitePersistenceAdapter(adapterOptions),
      clock: () => new Date(FAKE_NOW)
    });
    const service = new MemoryCaptureService({
      repository: firstRepository,
      clock: () => new Date(FAKE_NOW),
      idFactory: (() => {
        let id = 0;
        return () => `fake-sqlite-capture-${++id}`;
      })()
    });
    const context = fakeUserContext();
    const result = await service.capture(context, {
      ...fakeConversation('记住我喜欢喝乌龙茶'),
      idempotencyKey: 'fake-sqlite-capture-key'
    });
    await firstRepository.close();
    firstRepository = null;

    reopenedRepository = createPersistenceMemoryRepository({
      adapter: createSQLitePersistenceAdapter(adapterOptions),
      clock: () => new Date(FAKE_NOW)
    });
    const reopened = await reopenedRepository.getById(context, result.memory.id);
    assert.equal(reopened.value, '我喜欢喝乌龙茶');
    assert.equal(reopened.status, 'confirmed');
    assert.equal(reopened.userId, 'fake-user-a');
    await assert.rejects(
      () => reopenedRepository.getById(fakeUserContext({
        authenticatedUserId: 'fake-user-b',
        actorId: 'fake-user-b'
      }), result.memory.id),
      (error) => error?.code === 'MEMORY_RECORD_NOT_FOUND'
    );
  } finally {
    if (firstRepository) await firstRepository.close();
    if (reopenedRepository) await reopenedRepository.close();
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('capture idempotency survives SQLite and service restart', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-capture-idempotency-'));
  const adapterOptions = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups' };
  const context = fakeUserContext();
  const input = {
    ...fakeConversation('记住我喜欢喝乌龙茶'),
    idempotencyKey: 'fake-persistent-capture-key'
  };
  let repository;
  try {
    repository = createPersistenceMemoryRepository({
      adapter: createSQLitePersistenceAdapter(adapterOptions),
      clock: () => new Date(FAKE_NOW)
    });
    const first = await new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) }).capture(context, input);
    await repository.close();

    repository = createPersistenceMemoryRepository({
      adapter: createSQLitePersistenceAdapter(adapterOptions),
      clock: () => new Date('2030-01-03T03:04:05.000Z')
    });
    const retry = await new MemoryCaptureService({
      repository,
      clock: () => new Date('2030-01-03T03:04:05.000Z')
    }).capture({ ...context, requestId: 'fake-retry-request', timestamp: '2030-01-03T03:04:05.000Z' }, input);
    assert.equal(retry.memory.id, first.memory.id);
    assert.equal(await repository.count(context, { userId: 'fake-user-a' }), 1);
  } finally {
    if (repository) await repository.close();
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('same persistent idempotency key rejects a changed exclusive fact', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-capture-idempotency-conflict-'));
  const adapterOptions = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups' };
  let repository;
  try {
    repository = createPersistenceMemoryRepository({ adapter: createSQLitePersistenceAdapter(adapterOptions) });
    const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
    const context = fakeUserContext();
    await service.capture(context, fakeConversation('记住我的常住城市是上海', {
      sourceId: 'fake-idempotent-city-source',
      idempotencyKey: 'fake-idempotent-city-key'
    }));
    await assert.rejects(
      () => service.capture(context, fakeConversation('记住我的常住城市是深圳', {
        sourceId: 'fake-idempotent-city-source',
        idempotencyKey: 'fake-idempotent-city-key'
      })),
      (error) => error?.code === 'MEMORY_IDEMPOTENCY_CONFLICT'
    );
  } finally {
    if (repository) await repository.close();
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('SQLite restart preserves supersede chain and forgotten-record filtering', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-capture-write-restart-'));
  const adapterOptions = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups' };
  const context = fakeUserContext();
  let repository;
  try {
    repository = createPersistenceMemoryRepository({
      adapter: createSQLitePersistenceAdapter(adapterOptions),
      clock: () => new Date(FAKE_NOW)
    });
    const service = new MemoryCaptureService({ repository, clock: () => new Date(FAKE_NOW) });
    const oldCity = await service.capture(context, fakeConversation('记住我的常住城市是上海', {
      sourceId: 'fake-restart-city-1'
    }));
    const conflict = await service.capture(context, fakeConversation('记住我已经搬到深圳', {
      sourceId: 'fake-restart-city-2'
    }));
    const newCity = await service.confirm(context, conflict.candidate, {
      requestId: 'fake-restart-city-confirm',
      idempotencyKey: 'fake-restart-city-confirm-key'
    });
    const preference = await service.capture(context, fakeConversation('记住我喜欢喝乌龙茶', {
      sourceId: 'fake-restart-preference'
    }));
    await service.capture(context, fakeConversation('忘掉这条记忆', {
      targetMemoryId: preference.memory.id,
      expectedVersion: preference.memory.version,
      idempotencyKey: 'fake-restart-forget-key'
    }));
    await repository.close();

    repository = createPersistenceMemoryRepository({
      adapter: createSQLitePersistenceAdapter(adapterOptions),
      clock: () => new Date(FAKE_NOW)
    });
    const chain = await repository.getVersionChain(context, newCity.memory.id);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].id, oldCity.memory.id);
    assert.equal(chain[0].status, 'superseded');
    assert.equal(chain[1].value, '深圳');
    const current = await repository.query(context, { userId: 'fake-user-a' });
    assert.deepEqual(current.items.map((record) => record.id), [newCity.memory.id]);
    await assert.rejects(
      () => repository.getById(context, preference.memory.id),
      (error) => error?.code === 'MEMORY_RECORD_NOT_FOUND'
    );
  } finally {
    if (repository) await repository.close();
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});
