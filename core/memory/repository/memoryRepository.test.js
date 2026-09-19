import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../../storage/memoryStorage.js';
import { analyzeMemoryCandidate, createMemoryRecord } from '../index.js';
import { MemoryRepository } from './memoryRepository.js';

const context = { now: '2026-07-13T09:00:00+08:00', sourceType: 'manual' };

function createRepository(namespace = 'test-memory') {
  return new MemoryRepository({
    storage: createMemoryStorage(),
    namespace
  });
}

function candidate(input, extra = {}) {
  return createMemoryRecord({
    ...analyzeMemoryCandidate(input, context).memoryCandidate,
    ...extra,
    status: extra.status || 'confirmed',
    needsConfirmation: extra.needsConfirmation ?? false
  }, context);
}

test('saves expense memory and recovers after repository refresh', () => {
  const storage = createMemoryStorage();
  const first = new MemoryRepository({ storage, namespace: 'test-refresh' });
  const saved = first.create(candidate('今天买菜花了100元。'));
  const second = new MemoryRepository({ storage, namespace: 'test-refresh' });

  assert.equal(saved.ok, true);
  assert.equal(saved.record.amount, 100);
  assert.equal(saved.record.direction, 'expense');
  assert.equal(second.getById(saved.record.id).amount, 100);
});

test('saves schedule memory and queries by person', () => {
  const repository = createRepository('test-person');
  const saved = repository.create(candidate('明天下午3点见张总。'));

  assert.equal(saved.ok, true);
  assert.deepEqual(saved.record.people, ['张总']);
  assert.equal(saved.record.eventTime, '15:00');
  assert.equal(repository.search({ people: ['张总'] }).length, 1);
});

test('saves customer quote and queries by organization', () => {
  const repository = createRepository('test-quote');
  const saved = repository.create(candidate('华南客户报价是12万元。'));

  assert.equal(saved.record.amount, 120000);
  assert.equal(repository.search({ organizations: ['华南客户'] })[0].id, saved.record.id);
});

test('queries monthly expenses by date range and direction', () => {
  const repository = createRepository('test-expense-query');
  repository.create(candidate('今天买菜花了100元。', { eventDate: '2026-07-13' }));
  repository.create(candidate('后天买文具花了50元。', { eventDate: '2026-07-15' }));
  repository.create(candidate('刚才收到客户货款5000元。', { eventDate: '2026-07-13' }));

  const expenses = repository.list({
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    direction: 'expense'
  });

  assert.equal(expenses.length, 2);
  assert.deepEqual(expenses.map((item) => item.amount).sort((a, b) => a - b), [50, 100]);
});

test('updates memory without changing id or createdAt', () => {
  const repository = createRepository('test-update');
  const saved = repository.create(candidate('今天买菜花了100元。'));
  const updated = repository.update(saved.record.id, {
    id: 'other-id',
    createdAt: '2000-01-01T00:00:00.000Z',
    summary: '买菜支出',
    metadata: { updateReason: 'manual correction' }
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.record.id, saved.record.id);
  assert.equal(updated.record.createdAt, saved.record.createdAt);
  assert.equal(updated.record.summary, '买菜支出');
  assert.notEqual(updated.record.updatedAt, saved.record.updatedAt);
  assert.equal(updated.record.metadata.updateReason, 'manual correction');
});

test('soft deletes and restores memory', () => {
  const repository = createRepository('test-delete');
  const saved = repository.create(candidate('今天买菜花了100元。'));

  repository.remove(saved.record.id);

  assert.equal(repository.getById(saved.record.id), null);
  assert.equal(repository.list({ includeDeleted: true })[0].status, 'deleted');
  assert.equal(repository.restore(saved.record.id).ok, true);
  assert.equal(repository.getById(saved.record.id).status, 'confirmed');
});

test('forgets memory and prevents restore and default export', () => {
  const repository = createRepository('test-forget');
  const saved = repository.create(candidate('今天买菜花了100元。'));

  repository.forget(saved.record.id);

  assert.equal(repository.getById(saved.record.id), null);
  assert.equal(repository.restore(saved.record.id).ok, false);
  assert.equal(repository.exportAll().records.length, 0);
  assert.equal(repository.list({ includeForgotten: true })[0].status, 'forgotten');
  assert.equal(repository.list({ includeForgotten: true })[0].originalText, '');
});

test('rejects unconfirmed high sensitivity memory', () => {
  const repository = createRepository('test-sensitive-reject');
  const sensitive = createMemoryRecord({
    originalText: '我的银行卡号是6222021234567890123。',
    normalizedText: '我的银行卡号是6222021234567890123。',
    sensitivity: 'high',
    needsConfirmation: true,
    status: 'needs_confirmation',
    summary: '银行卡号'
  }, context);
  const result = repository.create(sensitive);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEMORY_CONFIRMATION_REQUIRED');
});

test('allows confirmed high sensitivity memory', () => {
  const repository = createRepository('test-sensitive-allow');
  const sensitive = createMemoryRecord({
    originalText: '我的银行卡号是6222021234567890123。',
    normalizedText: '我的银行卡号是6222021234567890123。',
    sensitivity: 'high',
    needsConfirmation: false,
    status: 'confirmed',
    summary: '银行卡号'
  }, context);
  const result = repository.create(sensitive, { confirmedByUser: true });

  assert.equal(result.ok, true);
  assert.equal(result.record.sensitivity, 'high');
});

test('detects duplicate memory without overwriting existing record', () => {
  const repository = createRepository('test-duplicate');
  const first = repository.create(candidate('今天买菜花了100元。'));
  const second = repository.create(candidate('今天买菜花了100元。'));

  assert.equal(second.duplicate, true);
  assert.equal(second.existingId, first.record.id);
  assert.equal(second.recommendation, 'skip');
  assert.equal(repository.count(), 1);
});

test('rejects empty or invalid memory without unhandled throw', () => {
  const repository = createRepository('test-invalid');
  const result = repository.create({ id: 'bad-memory' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEMORY_VALIDATION_FAILED');
});

test('exports and imports valid data without damaging existing records', () => {
  const source = createRepository('test-export-source');
  const target = createRepository('test-export-target');
  const existing = target.create(candidate('今天买菜花了100元。'));
  const exported = source.create(candidate('华南客户报价是12万元。'));
  const payload = source.exportAll();
  const badImport = target.importAll({ records: [{ id: 'bad' }] });
  const goodImport = target.importAll(payload);

  assert.equal(payload.version, 1);
  assert.equal(exported.ok, true);
  assert.equal(badImport.ok, false);
  assert.equal(target.exists(existing.record.id), true);
  assert.equal(goodImport.ok, true);
  assert.equal(target.search({ organizations: ['华南客户'] }).length, 1);
});

test('updates access statistics on getById and search', () => {
  const repository = createRepository('test-access');
  const saved = repository.create(candidate('华南客户报价是12万元。'));
  const firstRead = repository.getById(saved.record.id);
  const searched = repository.search({ keyword: '华南客户' })[0];

  assert.equal(firstRead.accessCount, 1);
  assert.equal(searched.accessCount, 2);
  assert.ok(searched.lastAccessedAt);
});

test('clearTestDataOnly does not affect non-test namespace', () => {
  const storage = createMemoryStorage();
  const official = new MemoryRepository({ storage, namespace: 'aiworkcenter.memory.records.v1' });
  const testing = new MemoryRepository({ storage, namespace: 'test-isolated-memory' });
  official.create(candidate('今天买菜花了100元。'));
  testing.create(candidate('华南客户报价是12万元。'));

  assert.equal(testing.clearTestDataOnly().ok, true);
  assert.equal(testing.count(), 0);
  assert.equal(official.count(), 1);
});
