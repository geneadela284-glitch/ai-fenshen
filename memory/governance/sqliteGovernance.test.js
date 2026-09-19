import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSQLitePersistenceAdapter } from '../persistence/sqlite/sqlitePersistenceAdapter.js';
import { MemoryRecallEngine } from '../recall/index.js';
import { fakeRecallContext } from '../recall/testing/fixtures.js';
import { createPersistenceMemoryRepository } from '../repository/index.js';
import { MemoryGovernanceService } from './index.js';
import { fakeGovernanceContext, fakeGovernanceRecord } from './testing/fixtures.js';

const NOW = '2026-07-15T12:00:00.000Z';

function repositoryContext(userId = 'fake-user-a') {
  return {
    authenticatedUserId: userId,
    actorType: 'user',
    actorId: userId,
    requestId: `sqlite-governance-${userId}`,
    correlationId: `sqlite-governance-correlation-${userId}`,
    timestamp: NOW,
    policyVersion: 'memory-governance-v1',
    transactionId: null,
    metadata: { fixture: true }
  };
}

function options(overrides = {}) {
  return { idempotencyKey: null, requestId: 'sqlite-governance', expectedVersion: null, operationReason: 'fictional_governance_acceptance', ...overrides };
}

function governance(operation, expectedVersion = null, overrides = {}) {
  return fakeGovernanceContext({ operation, expectedVersion, ...overrides });
}

test('real SQLite reopen preserves governance, isolation, export and safe recall', async () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-governance-sqlite-'));
  const exportDirectory = path.join(rootDirectory, 'exports');
  const adapterOptions = { rootDirectory, databasePath: 'memory.sqlite', backupDirectory: 'backups' };
  let repository;
  let adapter;
  try {
    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(NOW) });
    const records = [
      fakeGovernanceRecord('sqlite-preference'),
      fakeGovernanceRecord('sqlite-goal', { memoryType: 'goal', predicate: 'long_term_goal', value: '虚构长期目标' }),
      fakeGovernanceRecord('sqlite-sensitive', { memoryType: 'sensitive_memory', predicate: 'health_note', value: '虚构高敏感健康记录', sensitivity: 'high' }),
      fakeGovernanceRecord('sqlite-history-old', { memoryType: 'fact', predicate: 'current_city', value: '虚构旧城市' }),
      fakeGovernanceRecord('sqlite-conflict-a', { conflictGroupId: 'sqlite-conflict', normalizedValue: '咖啡' }),
      fakeGovernanceRecord('sqlite-conflict-b', { conflictGroupId: 'sqlite-conflict', value: '虚构茶偏好', normalizedValue: '茶' }),
      fakeGovernanceRecord('sqlite-purge')
    ];
    for (const record of records) await repository.create(repositoryContext(), record, options());
    await repository.create(repositoryContext('fake-user-b'), fakeGovernanceRecord('sqlite-user-b', { userId: 'fake-user-b' }), options());
    await repository.supersede(repositoryContext(), 'sqlite-history-old', fakeGovernanceRecord('sqlite-history-current', {
      memoryType: 'fact', predicate: 'current_city', value: '虚构新城市'
    }), options({ expectedVersion: 1 }));

    await repository.close();
    repository = null;
    adapter = null;

    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(NOW) });
    let sequence = 0;
    const service = new MemoryGovernanceService({
      repository, exportDirectory, clock: () => new Date(NOW), idFactory: () => `sqlite-governance-${++sequence}`
    });

    assert.equal((await service.listMemories(governance('view'))).status, 'completed');
    assert.equal((await service.getMemoryHistory(governance('history'), 'sqlite-history-current')).data.items.length, 2);

    const correction = await service.correctMemory(governance('correct', 1), 'sqlite-preference', { value: '虚构纠正后的偏好' });
    assert.equal(correction.status, 'completed');
    assert.equal((await service.getMemoryHistory(governance('history'), correction.memoryId)).data.items.length, 2);

    const conflict = await service.resolveConflict(governance('resolve_conflict', 1), 'sqlite-conflict', {
      decision: 'keep_a', expectedVersions: { 'sqlite-conflict-a': 1, 'sqlite-conflict-b': 1 }
    });
    assert.equal(conflict.status, 'completed');

    const deleted = await service.deleteMemory(governance('delete', 1), 'sqlite-goal');
    assert.equal(deleted.reversible, true);

    await repository.close();
    repository = null;
    adapter = null;

    adapter = createSQLitePersistenceAdapter(adapterOptions);
    repository = createPersistenceMemoryRepository({ adapter, clock: () => new Date(NOW) });
    const reopenedService = new MemoryGovernanceService({
      repository, exportDirectory, clock: () => new Date(NOW), idFactory: () => `sqlite-reopen-${++sequence}`
    });
    const recall = new MemoryRecallEngine({ repository });
    const goalRecall = await recall.recall(fakeRecallContext(), { text: '我的长期目标是什么？' });
    assert.equal(goalRecall.selected.some((item) => item.record.id === 'sqlite-goal'), false);
    assert.equal((await reopenedService.listMemories(governance('view'), { view: 'recycle_bin' })).data.items.some((item) => item.memoryId === 'sqlite-goal'), true);

    assert.equal((await reopenedService.restoreMemory(governance('restore', 2), 'sqlite-goal')).status, 'completed');
    const purgeFirst = await reopenedService.purgeMemory(governance('purge', 1), 'sqlite-purge');
    assert.equal(purgeFirst.status, 'confirmation_required');
    assert.equal((await reopenedService.purgeMemory(governance('purge', 1, { confirmationToken: purgeFirst.data.confirmationToken }), 'sqlite-purge')).status, 'completed');
    assert.equal((await reopenedService.getMemoryDetails(governance('view'), 'sqlite-purge')).status, 'not_found');

    assert.equal((await reopenedService.updateSensitivity(governance('change_sensitivity', 3), 'sqlite-goal', { sensitivity: 'sensitive' })).status, 'completed');
    assert.equal((await reopenedService.updateAccessPolicy(governance('change_access', 4), 'sqlite-goal', { mode: 'archived_only' })).status, 'completed');

    const jsonExport = await reopenedService.exportMemories(governance('export'), { format: 'json', includeHistorical: true });
    const markdownExport = await reopenedService.exportMemories(governance('export'), { format: 'markdown' });
    assert.equal(fs.existsSync(path.join(exportDirectory, jsonExport.data.fileName)), true);
    assert.equal(fs.existsSync(path.join(exportDirectory, markdownExport.data.fileName)), true);

    const crossUser = await reopenedService.getMemoryDetails(governance('view', null, {
      authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b'
    }), 'sqlite-goal');
    assert.equal(crossUser.status, 'not_found');

    const audits = await reopenedService.listAuditEvents(governance('audit'));
    const auditOutput = JSON.stringify(audits);
    assert.equal(auditOutput.includes('虚构高敏感健康记录'), false);
    assert.equal(auditOutput.includes('虚构纠正后的偏好'), false);
    assert.equal((await adapter.integrityCheck()).status, 'valid');
  } finally {
    if (repository) await repository.close();
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});
