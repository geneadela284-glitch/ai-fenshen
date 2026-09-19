import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage } from '../../storage/memoryStorage.js';
import { ACTION_TYPES } from './actionTypes.js';
import { ACTION_RESULT_STATUS } from './actionResult.js';
import { ActionAuditRepository } from './actionAuditRepository.js';
import { createSecretaryActionFramework } from './actionFramework.js';

function createFramework(memoryService) {
  const auditRepository = new ActionAuditRepository({
    storage: createMemoryStorage(),
    now: () => new Date('2026-07-14T09:00:00.000Z'),
    idGenerator: () => `audit-${auditRepository.listRecent(500).length + 1}`
  });
  return createSecretaryActionFramework({
    memoryService,
    auditRepository,
    now: () => new Date('2026-07-14T08:00:00.000Z'),
    idGenerator: (() => {
      let index = 0;
      return () => `proposal-${++index}`;
    })()
  });
}

test('默认 Registry 只接入 CreateExpense 与 CreateSchedule', () => {
  const framework = createFramework({ remember() {} });
  assert.deepEqual(
    framework.registry.list().map((action) => action.name).sort(),
    ['CreateExpense', 'CreateSchedule']
  );
});

test('CreateExpense 通过完整 Action Contract 调用 MemoryService', async () => {
  const calls = [];
  const record = {
    id: 'expense-memory-1',
    type: 'expense',
    summary: '午饭 20 元',
    createdAt: '2026-07-14T08:00:00.000Z'
  };
  const framework = createFramework({
    remember(input, options) {
      calls.push({ input, options });
      return { ok: true, code: 'MEMORY_SAVED', data: record };
    }
  });
  const proposal = framework.propose({
    actionName: 'CreateExpense',
    actionType: ACTION_TYPES.EXPENSE,
    arguments: {
      input: '今天午饭 20 元',
      memoryContext: { userId: 'user-1', sourceType: 'conversation' }
    },
    source: { type: 'conversation', id: 'conversation-1' },
    userId: 'user-1',
    proposedBy: 'ai'
  });

  const result = await framework.execute(proposal);

  assert.equal(result.status, ACTION_RESULT_STATUS.SUCCESS);
  assert.equal(result.code, 'MEMORY_SAVED');
  assert.equal(result.data.record.id, 'expense-memory-1');
  assert.deepEqual(calls, [{
    input: '今天午饭 20 元',
    options: { context: { userId: 'user-1', sourceType: 'conversation' } }
  }]);
  assert.equal(framework.auditRepository.listRecent(1)[0].actionName, 'CreateExpense');
});

test('CreateSchedule 通过完整 Action Contract 调用 MemoryService', async () => {
  const calls = [];
  const record = {
    id: 'schedule-memory-1',
    type: 'schedule',
    summary: '下午四点开会',
    createdAt: '2026-07-14T08:00:00.000Z'
  };
  const framework = createFramework({
    remember(input, options) {
      calls.push({ input, options });
      return { ok: true, code: 'MEMORY_SAVED', data: record };
    }
  });
  const proposal = framework.propose({
    actionName: 'CreateSchedule',
    actionType: ACTION_TYPES.SCHEDULE,
    arguments: {
      input: '今天下午四点开会',
      memoryContext: { userId: 'user-1', sourceType: 'conversation' }
    },
    source: { type: 'conversation', id: 'conversation-1' },
    userId: 'user-1',
    proposedBy: 'ai'
  });

  const result = await framework.execute(proposal);

  assert.equal(result.status, ACTION_RESULT_STATUS.SUCCESS);
  assert.equal(result.code, 'MEMORY_SAVED');
  assert.equal(result.data.record.id, 'schedule-memory-1');
  assert.equal(calls.length, 1);
  assert.equal(framework.auditRepository.listRecent(1)[0].actionName, 'CreateSchedule');
});

test('审计写入失败不改变已经真实完成的 Action 结果', async () => {
  const framework = createSecretaryActionFramework({
    memoryService: {
      remember() {
        return { ok: true, code: 'MEMORY_SAVED', data: { id: 'expense-memory-audit', amount: 20 } };
      }
    },
    auditRepository: {
      record() {
        throw new Error('audit unavailable');
      }
    },
    now: () => new Date('2026-07-14T08:00:00.000Z')
  });
  const proposal = framework.propose({
    actionName: 'CreateExpense',
    actionType: ACTION_TYPES.EXPENSE,
    arguments: { input: '今天午饭20元', memoryContext: { sourceType: 'conversation' } },
    source: { type: 'conversation', id: 'task-audit-failure' }
  });

  const result = await framework.execute(proposal);

  assert.equal(result.status, ACTION_RESULT_STATUS.SUCCESS);
  assert.equal(result.code, 'MEMORY_SAVED');
  assert.equal(result.auditId, '');
});
