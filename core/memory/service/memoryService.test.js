import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../../storage/memoryStorage.js';
import { MemoryRepository } from '../repository/memoryRepository.js';
import { deleteSuspiciousQueryMemories, forgetSuspiciousQueryMemories, listSuspiciousQueryMemories } from '../memoryDiagnostics.js';
import { MemoryService } from './memoryService.js';

const context = {
  now: '2026-07-13T09:00:00.000Z',
  sourceType: 'manual',
  sourceId: 'service-test-source'
};

function createService(namespace = 'test-memory-service', options = {}) {
  const storage = options.storage || createMemoryStorage();
  const repository = new MemoryRepository({
    storage,
    namespace,
    now: options.now || (() => new Date('2026-07-13T09:00:00.000Z'))
  });
  return {
    storage,
    repository,
    service: new MemoryService({
      repository,
      now: options.now || (() => new Date('2026-07-13T09:00:00.000Z')),
      candidateTtlMs: options.candidateTtlMs || 60_000
    })
  };
}

test('automatically saves an expense memory', () => {
  const { service, repository } = createService('test-service-expense');
  const result = service.remember('今天买菜花了100元。', { context });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'remembered');
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.data.amount, 100);
  assert.equal(repository.count({ direction: 'expense' }), 1);
});

test('automatically saves an income memory', () => {
  const { service } = createService('test-service-income');
  const result = service.remember('刚才收到客户货款5000元。', { context });

  assert.equal(result.ok, true);
  assert.equal(result.data.direction, 'income');
  assert.equal(result.data.amount, 5000);
});

test('automatically saves a complete schedule memory', () => {
  const { service } = createService('test-service-schedule');
  const result = service.remember('明天下午3点见张总。', { context });

  assert.equal(result.ok, true);
  assert.equal(result.data.eventTime, '15:00');
  assert.deepEqual(result.data.people, ['张总']);
});

test('automatically saves a non-sensitive explicit remember request', () => {
  const { service } = createService('test-service-explicit');
  const result = service.remember('记一下，华南客户报价12万元。', { context });

  assert.equal(result.ok, true);
  assert.equal(result.data.amount, 120000);
  assert.deepEqual(result.data.organizations, ['华南客户']);
});

test('does not save empty input', () => {
  const { service } = createService('test-service-empty');
  const result = service.remember('   ', { context });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'ignored');
  assert.equal(result.code, 'MEMORY_INPUT_EMPTY');
});

test('does not save casual chat or translation requests', () => {
  const { service } = createService('test-service-ignored');

  assert.equal(service.remember('你好。', { context }).code, 'MEMORY_NOT_WORTH_REMEMBERING');
  assert.equal(service.remember('帮我翻译这句话。', { context }).code, 'MEMORY_NOT_WORTH_REMEMBERING');
});

test('diagnostics list suspicious query memories and require confirmation before cleanup', () => {
  const { service, repository } = createService('test-service-diagnostics');
  repository.create({
    sourceType: 'conversation',
    sourceId: 'bad-query',
    originalText: '640元是怎么得出的结果？',
    normalizedText: '640元是怎么得出的结果？',
    memoryType: 'generic_memory',
    category: 'generic_memory',
    title: '错误查询记忆',
    summary: '640元是怎么得出的结果？',
    amount: 640,
    currency: 'CNY',
    direction: 'neutral',
    status: 'confirmed',
    needsConfirmation: false
  }, { confirmedByUser: true });

  const suspicious = listSuspiciousQueryMemories({ memoryService: service });
  const dryForget = forgetSuspiciousQueryMemories([suspicious[0].id], { memoryService: service });
  const dryDelete = deleteSuspiciousQueryMemories([suspicious[0].id], { memoryService: service });

  assert.equal(suspicious.length, 1);
  assert.equal(suspicious[0].amount, 640);
  assert.equal(dryForget.ok, false);
  assert.equal(dryDelete.ok, false);
  assert.equal(repository.count(), 1);
});

test('does not save an explicit do-not-remember request', () => {
  const { service } = createService('test-service-opt-out');
  const result = service.remember('这条不要记住。', { context });

  assert.equal(result.action, 'ignored');
  assert.equal(result.code, 'MEMORY_NOT_WORTH_REMEMBERING');
});

test('requires confirmation for a time without an event', () => {
  const { service, repository } = createService('test-service-time-only');
  const result = service.remember('今晚8点。', { context });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'MEMORY_CONFIRMATION_REQUIRED');
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.candidateId);
  assert.equal(repository.count(), 0);
});

test('requires confirmation for high sensitivity content', () => {
  const { service, repository } = createService('test-service-sensitive');
  const result = service.remember('我的银行卡号是6222021234567890123。', { context });

  assert.equal(result.code, 'MEMORY_CONFIRMATION_REQUIRED');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(repository.count(), 0);
});

test('requires confirmation for ambiguous amounts', () => {
  const { service, repository } = createService('test-service-ambiguous');
  const result = service.remember('华南客户报价可能是12万或者15万。', { context });

  assert.equal(result.code, 'MEMORY_CONFIRMATION_REQUIRED');
  assert.equal(repository.count(), 0);
});

test('saves a candidate only after explicit confirmation', () => {
  const { service, repository } = createService('test-service-confirm');
  const prepared = service.prepare('今晚8点。', context);
  const confirmed = service.confirm(prepared.candidateId, { confirmedByUser: true });

  assert.equal(prepared.requiresConfirmation, true);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.action, 'confirmed');
  assert.equal(repository.count(), 1);
});

test('rejecting a candidate never writes a formal memory', () => {
  const { service, repository } = createService('test-service-reject');
  const prepared = service.prepare('今晚8点。', context);
  const rejected = service.reject(prepared.candidateId, 'not useful');

  assert.equal(rejected.ok, true);
  assert.equal(rejected.action, 'rejected');
  assert.equal(repository.count(), 0);
});

test('does not confirm an expired candidate', () => {
  let now = new Date('2026-07-13T09:00:00.000Z');
  const { service, repository } = createService('test-service-expired', {
    now: () => now,
    candidateTtlMs: 1
  });
  const prepared = service.prepare('今晚8点。', context);
  now = new Date('2026-07-13T09:00:01.000Z');
  const result = service.confirm(prepared.candidateId, { confirmedByUser: true });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MEMORY_CANDIDATE_EXPIRED');
  assert.equal(repository.count(), 0);
});

test('does not write a duplicate memory and exposes its recommendation', () => {
  const { service, repository } = createService('test-service-duplicate');
  const first = service.remember('今天买菜花了100元。', { context });
  const second = service.remember('今天买菜花了100元。', { context });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'MEMORY_DUPLICATE_FOUND');
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.existingMemoryId, first.memoryId);
  assert.equal(repository.count(), 1);
});

test('queries and updates a saved memory while preserving source', () => {
  const { service } = createService('test-service-query-update');
  const remembered = service.remember('记一下，华南客户报价是12万元。', { context });
  const searched = service.searchMemories({ organizations: ['华南客户'] });
  const updated = service.updateMemory(remembered.memoryId, { summary: '华南客户最终报价12万元' });

  assert.equal(searched.ok, true);
  assert.equal(searched.data.length, 1);
  assert.equal(updated.ok, true);
  assert.equal(updated.data.sourceId, 'service-test-source');
  assert.equal(updated.data.summary, '华南客户最终报价12万元');
});

test('soft deletes and restores a memory', () => {
  const { service } = createService('test-service-delete-restore');
  const remembered = service.remember('今天买菜花了100元。', { context });
  const deleted = service.deleteMemory(remembered.memoryId);

  assert.equal(deleted.ok, true);
  assert.equal(service.getMemory(remembered.memoryId).code, 'MEMORY_NOT_FOUND');
  const restored = service.restoreMemory(remembered.memoryId);
  assert.equal(restored.ok, true);
  assert.equal(service.getMemory(remembered.memoryId).ok, true);
});

test('forgets a memory and refuses restoration', () => {
  const { service } = createService('test-service-forget');
  const remembered = service.remember('今天买菜花了100元。', { context });
  const forgotten = service.forgetMemory(remembered.memoryId);
  const restored = service.restoreMemory(remembered.memoryId);

  assert.equal(forgotten.ok, true);
  assert.equal(restored.ok, false);
  assert.equal(restored.code, 'MEMORY_ALREADY_FORGOTTEN');
});

test('uses the uniform result structure for failures', () => {
  const { service } = createService('test-service-result-shape');
  const result = service.getMemory('missing');

  assert.deepEqual(Object.keys(result).sort(), [
    'action', 'candidateId', 'code', 'data', 'memoryId', 'message', 'ok', 'requiresConfirmation', 'timestamp', 'warnings'
  ]);
  assert.equal(result.code, 'MEMORY_NOT_FOUND');
});

test('keeps service test data isolated from formal memory storage', () => {
  const storage = createMemoryStorage();
  const officialRepository = new MemoryRepository({ storage, namespace: 'aiworkcenter.memory.records.v1' });
  const { service, repository } = createService('test-service-isolation', { storage });

  officialRepository.create({
    id: 'official-memory',
    sourceType: 'manual',
    sourceId: 'official',
    originalText: '正式数据',
    normalizedText: '正式数据',
    memoryType: 'generic_memory',
    category: 'generic_memory',
    summary: '正式数据',
    status: 'confirmed'
  });
  service.remember('今天买菜花了100元。', { context });

  assert.equal(repository.count(), 1);
  assert.equal(officialRepository.count(), 1);
});

test('does not expose or depend on a provider', () => {
  const { service } = createService('test-service-no-provider');

  assert.equal(Object.hasOwn(service, 'provider'), false);
  assert.equal(Object.hasOwn(service, 'router'), false);
  assert.equal(service.analyze('今天买菜花了100元。', context).ok, true);
});
