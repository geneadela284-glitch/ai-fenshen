import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../../storage/memoryStorage.js';
import { MemoryRepository } from '../repository/memoryRepository.js';
import { MemoryService } from '../service/memoryService.js';
import { MemoryGovernanceService } from './memoryGovernanceService.js';

function setup() {
  const repository = new MemoryRepository({ storage: createMemoryStorage(), namespace: 'test-governance', now: () => new Date('2026-07-13T09:00:00.000Z') });
  const memory = new MemoryService({ repository, now: () => new Date('2026-07-13T09:00:00.000Z') });
  return { repository, memory, governance: new MemoryGovernanceService({ memory }) };
}

test('creates a new version for explicit quote correction and preserves history', () => {
  const { memory, governance } = setup();
  const old = memory.remember('记一下，华南客户报价12万元。', { context: { sourceType: 'conversation', sourceId: 'c1' } });
  const proposal = governance.proposeUpdate(old.memoryId, '华南客户最新报价改成11.8万元。');
  const updated = governance.confirmUpdate(proposal.data.proposalId);
  assert.equal(updated.ok, true);
  assert.equal(governance.getCurrentVersion(old.memoryId).data.amount, 118000);
  assert.equal(governance.getMemoryHistory(old.memoryId).data.length, 2);
});

test('detects unresolved preference conflict and protects forgotten memory', () => {
  const { memory, governance } = setup();
  const pending = memory.remember('请记住我喜欢深色模式。', { context: { sourceType: 'conversation', sourceId: 'c1' } });
  const old = memory.confirm(pending.candidateId, { confirmedByUser: true });
  const conflict = governance.detectConflict({ originalText: '我喜欢浅色模式。', memoryType: 'preference', category: 'preference', summary: '我喜欢浅色模式', sensitivity: 'low' });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.requiresConfirmation, true);
  governance.forgetMemory(old.memoryId, 'user request');
  assert.equal(governance.restoreDeletedMemory(old.memoryId).code, 'MEMORY_RESTORE_NOT_ALLOWED');
});
