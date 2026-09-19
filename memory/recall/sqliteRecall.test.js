import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSQLitePersistenceAdapter } from '../persistence/sqlite/sqlitePersistenceAdapter.js';
import { createPersistenceMemoryRepository } from '../repository/index.js';
import { MemoryRecallEngine } from './index.js';
import { fakeMemoryRecord, fakeRecallContext, TEST_NOW } from './testing/fixtures.js';

function repositoryOptions(overrides = {}) {
  return {
    idempotencyKey: null,
    requestId: 'fake-recall-sqlite-request',
    expectedVersion: null,
    operationReason: 'fictional_recall_acceptance',
    ...overrides
  };
}

function memory(id, overrides = {}) {
  return fakeMemoryRecord(id, {
    checksum: `fake-checksum-${id}`,
    ...overrides
  });
}

test('real SQLite reopen preserves safe deterministic recall behavior', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recall-sqlite-'));
  const adapterOptions = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups' };
  const contextA = fakeRecallContext();
  const repositoryContextA = {
    authenticatedUserId: 'fake-user-a',
    actorType: 'user',
    actorId: 'fake-user-a',
    requestId: 'fake-recall-sqlite-request',
    correlationId: 'fake-recall-sqlite-correlation',
    timestamp: TEST_NOW,
    policyVersion: 'memory-recall-v1',
    transactionId: null,
    metadata: { fixture: true }
  };
  let repository;
  let adapter;

  try {
    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(TEST_NOW) });
    await repository.create(repositoryContextA, memory('fake-coffee-preference', {
      memoryType: 'preference', predicate: 'prefers_drink', value: '虚构咖啡偏好', normalizedValue: '咖啡'
    }), repositoryOptions({ idempotencyKey: 'fake-create-coffee' }));
    await repository.create(repositoryContextA, memory('fake-goal', {
      memoryType: 'goal', predicate: 'long_term_goal', value: '虚构长期学习目标', normalizedValue: '长期学习'
    }), repositoryOptions());
    await repository.create(repositoryContextA, memory('fake-relationship', {
      memoryType: 'relationship', predicate: 'fictional_family_relation', value: '虚构家庭关系', normalizedValue: '虚构关系'
    }), repositoryOptions());
    await repository.create(repositoryContextA, memory('fake-life-event', {
      memoryType: 'life_event', predicate: 'fictional_life_event', value: '虚构毕业事件', normalizedValue: '虚构毕业事件'
    }), repositoryOptions());
    await repository.create(repositoryContextA, memory('fake-city-old', {
      memoryType: 'fact', predicate: 'current_city', value: '虚构旧城市', normalizedValue: '旧城市'
    }), repositoryOptions());
    await repository.supersede(repositoryContextA, 'fake-city-old', memory('fake-city-current', {
      memoryType: 'fact', predicate: 'current_city', value: '虚构新城市', normalizedValue: '新城市'
    }), repositoryOptions({ expectedVersion: 1, idempotencyKey: 'fake-supersede-city' }));
    await repository.create(repositoryContextA, memory('fake-deleted-preference', {
      memoryType: 'preference', predicate: 'prefers_drink', value: '虚构已删除茶偏好', normalizedValue: '茶'
    }), repositoryOptions());
    await repository.moveToRecycleBin(repositoryContextA, 'fake-deleted-preference', repositoryOptions({ expectedVersion: 1 }));
    await repository.create(repositoryContextA, memory('fake-sensitive-health', {
      memoryType: 'sensitive_memory',
      predicate: 'fictional_health_note',
      value: '虚构高敏感健康记录',
      normalizedValue: '虚构健康记录',
      sensitivity: 'high',
      confirmationStatus: 'user_confirmed'
    }), repositoryOptions());

    await repository.close();
    repository = null;
    adapter = null;

    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(TEST_NOW) });
    const engine = new MemoryRecallEngine({ repository });

    const preference = await engine.recall(contextA, { text: '我喜欢喝什么？' });
    assert.equal(preference.ok, true);
    assert.deepEqual(preference.selected.map((item) => item.record.id), ['fake-coffee-preference']);
    assert.equal(preference.excluded.some((item) => item.memoryId === 'fake-deleted-preference'), false);

    const history = await engine.recall(contextA, { text: '我以前住在哪里？' });
    assert.deepEqual(
      history.selected.map((item) => item.record.id).sort(),
      ['fake-city-current', 'fake-city-old']
    );
    assert.deepEqual(
      history.selected.map((item) => item.classification).sort(),
      ['historical_only', 'resolved_current']
    );

    const sensitiveContext = fakeRecallContext({
      purpose: 'sensitive_assistance',
      sensitivityAllowance: 'high',
      contextBudget: { ...contextA.contextBudget, maxSensitiveItems: 1 },
      metadata: { sensitiveAccessApproved: true }
    });
    const sensitive = await engine.recall(sensitiveContext, { text: '我的健康记录是什么？' });
    const pack = engine.buildContextPack(sensitiveContext, sensitive, { maxItems: 1, maxSensitiveItems: 1 });
    assert.equal(pack.memoryItems.length, 1);
    assert.equal(pack.memoryItems[0].isDerivedSummary, true);
    assert.equal(pack.memoryItems[0].safeText.includes('虚构高敏感健康记录'), false);

    const limitedPack = engine.buildContextPack(contextA, preference, {
      maxItems: 1,
      maxCharacters: 80,
      maxEstimatedTokens: 20,
      maxSensitiveItems: 0,
      perTypeLimit: 1
    });
    assert.equal(limitedPack.memoryItems.length, 1);
    const repeatedPack = engine.buildContextPack(contextA, preference, {
      maxItems: 1,
      maxCharacters: 80,
      maxEstimatedTokens: 20,
      maxSensitiveItems: 0,
      perTypeLimit: 1
    });
    assert.deepEqual(repeatedPack.memoryItems, limitedPack.memoryItems);

    const contextB = fakeRecallContext({
      authenticatedUserId: 'fake-user-b',
      actorId: 'fake-user-b',
      requestId: 'fake-user-b-recall',
      correlationId: 'fake-user-b-correlation'
    });
    const userB = await engine.recall(contextB, { text: '我喜欢喝什么？' });
    assert.equal(userB.ok, true);
    assert.deepEqual(userB.selected, []);
    assert.equal((await adapter.integrityCheck()).status, 'valid');
  } finally {
    if (repository) await repository.close();
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});
