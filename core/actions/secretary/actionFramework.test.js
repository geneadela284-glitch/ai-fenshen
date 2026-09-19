import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_TYPES } from './actionTypes.js';
import { ACTION_RESULT_STATUS, createActionResult } from './actionResult.js';
import { createActionProposal } from './actionProposal.js';
import { getConfirmationPolicy } from './confirmationPolicy.js';
import { validateActionContract } from './actionContract.js';
import { ActionAuditRepository } from './actionAuditRepository.js';
import { ActionRegistry } from './actionRegistry.js';
import { ActionExecutor } from './actionExecutor.js';
import { createMemoryStorage } from '../../storage/memoryStorage.js';

test('Action Type 同时覆盖工作与生活的通用事务', () => {
  assert.deepEqual(
    [
      ACTION_TYPES.EXPENSE,
      ACTION_TYPES.INCOME,
      ACTION_TYPES.SCHEDULE,
      ACTION_TYPES.REMINDER,
      ACTION_TYPES.TODO,
      ACTION_TYPES.MEETING,
      ACTION_TYPES.KNOWLEDGE_SEARCH,
      ACTION_TYPES.MEMORY_SAVE,
      ACTION_TYPES.CONTRACT_LOOKUP,
      ACTION_TYPES.DOCUMENT_SUMMARY
    ],
    [
      'expense',
      'income',
      'schedule',
      'reminder',
      'todo',
      'meeting',
      'knowledge_search',
      'memory_save',
      'contract_lookup',
      'document_summary'
    ]
  );
});

test('Action Proposal 只有描述能力，没有执行能力', () => {
  const proposal = createActionProposal({
    actionName: 'CreateExpense',
    actionType: ACTION_TYPES.EXPENSE,
    arguments: { input: '今天午饭 20 元' },
    source: { type: 'conversation', id: 'conversation-1' },
    userId: 'user-1',
    proposedBy: 'ai',
    now: new Date('2026-07-14T08:00:00.000Z'),
    idGenerator: () => 'proposal-1'
  });

  assert.equal(proposal.schemaVersion, 'v1');
  assert.equal(proposal.proposalId, 'proposal-1');
  assert.equal(proposal.actionName, 'CreateExpense');
  assert.equal(proposal.actionType, ACTION_TYPES.EXPENSE);
  assert.equal(proposal.source.id, 'conversation-1');
  assert.equal(proposal.execute, undefined);
  assert.ok(Object.isFrozen(proposal));
});

test('Action Proposal 拒绝敏感凭据字段', () => {
  assert.throws(
    () => createActionProposal({
      actionName: 'CreateExpense',
      actionType: ACTION_TYPES.EXPENSE,
      arguments: { input: '午饭 20 元', apiKey: 'secret' }
    }),
    /敏感字段/
  );
});

test('Action Result 统一五种状态', () => {
  assert.deepEqual(Object.values(ACTION_RESULT_STATUS), [
    'success',
    'pending',
    'need_confirmation',
    'failed',
    'rolled_back'
  ]);

  const result = createActionResult({
    status: ACTION_RESULT_STATUS.SUCCESS,
    code: 'ACTION_SUCCEEDED',
    proposalId: 'proposal-1',
    actionName: 'CreateExpense',
    data: { memoryId: 'memory-1' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'success');
  assert.equal(result.data.memoryId, 'memory-1');
});

test('Confirmation Policy 对读取和常规记录直接执行，对高风险动作要求确认', () => {
  assert.equal(getConfirmationPolicy(ACTION_TYPES.CONTRACT_LOOKUP).mode, 'direct');
  assert.equal(getConfirmationPolicy(ACTION_TYPES.EXPENSE).mode, 'direct');
  assert.equal(getConfirmationPolicy(ACTION_TYPES.MEETING).mode, 'direct');
  assert.equal(getConfirmationPolicy(ACTION_TYPES.DELETE).mode, 'confirm');
  assert.equal(getConfirmationPolicy(ACTION_TYPES.SEND_EMAIL).mode, 'confirm');
});

test('Action Contract 强制完整生命周期', () => {
  const validAction = {
    name: 'CreateExpense',
    type: ACTION_TYPES.EXPENSE,
    validate() {},
    prepare() {},
    confirm() {},
    execute() {},
    rollback() {},
    audit() {}
  };

  assert.equal(validateActionContract(validAction), true);
  assert.throws(
    () => validateActionContract({ ...validAction, rollback: undefined }),
    /rollback/
  );
});

function createLifecycleAction({
  name = 'CreateExpense',
  type = ACTION_TYPES.EXPENSE,
  needsConfirmation = false,
  executeError = null,
  calls = []
} = {}) {
  return {
    name,
    type,
    validate(proposal) {
      calls.push('validate');
      return { ok: Boolean(proposal.arguments.input), code: 'VALID' };
    },
    prepare(proposal) {
      calls.push('prepare');
      return { input: proposal.arguments.input };
    },
    confirm() {
      calls.push('confirm');
      return { required: needsConfirmation };
    },
    execute(prepared) {
      calls.push('execute');
      if (executeError) throw executeError;
      return { code: 'CREATED', data: { input: prepared.input, memoryId: 'memory-1' } };
    },
    rollback() {
      calls.push('rollback');
      return { ok: true };
    },
    audit(record) {
      calls.push('audit');
      return record;
    }
  };
}

function expenseProposal(overrides = {}) {
  return createActionProposal({
    actionName: 'CreateExpense',
    actionType: ACTION_TYPES.EXPENSE,
    arguments: { input: '今天午饭 20 元' },
    source: { type: 'conversation', id: 'conversation-1' },
    userId: 'user-1',
    now: new Date('2026-07-14T08:00:00.000Z'),
    idGenerator: () => 'proposal-1',
    ...overrides
  });
}

test('Action Registry 只注册满足 Contract 的 Action', () => {
  const registry = new ActionRegistry();
  const action = createLifecycleAction();

  registry.register(action);
  assert.equal(registry.get('CreateExpense'), action);
  assert.deepEqual(registry.list().map((item) => item.name), ['CreateExpense']);
  assert.throws(() => registry.register({ name: 'Broken', type: ACTION_TYPES.TODO }), /validate/);
  assert.throws(() => registry.register(action), /已注册/);
});

test('Action Executor 按 Contract 顺序执行并统一审计', async () => {
  const calls = [];
  const registry = new ActionRegistry();
  registry.register(createLifecycleAction({ calls }));
  const auditRepository = new ActionAuditRepository({
    storage: createMemoryStorage(),
    now: () => new Date('2026-07-14T08:00:01.000Z'),
    idGenerator: () => 'audit-1'
  });
  const executor = new ActionExecutor({
    registry,
    auditRepository,
    now: () => new Date('2026-07-14T08:00:00.000Z')
  });

  const result = await executor.run(expenseProposal());

  assert.equal(result.status, ACTION_RESULT_STATUS.SUCCESS);
  assert.equal(result.auditId, 'audit-1');
  assert.deepEqual(calls, ['validate', 'prepare', 'confirm', 'execute', 'audit']);
  assert.deepEqual(auditRepository.listRecent(), [{
    auditId: 'audit-1',
    proposalId: 'proposal-1',
    actionName: 'CreateExpense',
    actionType: ACTION_TYPES.EXPENSE,
    occurredAt: '2026-07-14T08:00:01.000Z',
    userId: 'user-1',
    resultStatus: 'success',
    resultCode: 'CREATED',
    sourceType: 'conversation',
    sourceId: 'conversation-1',
    durationMs: 0
  }]);
});

test('Action Executor 在确认前不执行', async () => {
  const calls = [];
  const registry = new ActionRegistry();
  registry.register(createLifecycleAction({
    name: 'DeleteItem',
    type: ACTION_TYPES.DELETE,
    needsConfirmation: true,
    calls
  }));
  const auditRepository = new ActionAuditRepository({ storage: createMemoryStorage() });
  const executor = new ActionExecutor({ registry, auditRepository });
  const proposal = createActionProposal({
    actionName: 'DeleteItem',
    actionType: ACTION_TYPES.DELETE,
    arguments: { input: '删除记录' }
  });

  const result = await executor.run(proposal);

  assert.equal(result.status, ACTION_RESULT_STATUS.NEED_CONFIRMATION);
  assert.deepEqual(calls, ['validate', 'prepare', 'confirm', 'audit']);
});

test('Action Executor 执行失败后统一回滚并审计', async () => {
  const calls = [];
  const registry = new ActionRegistry();
  registry.register(createLifecycleAction({ calls, executeError: new Error('write failed') }));
  const auditRepository = new ActionAuditRepository({ storage: createMemoryStorage() });
  const executor = new ActionExecutor({ registry, auditRepository });

  const result = await executor.run(expenseProposal());

  assert.equal(result.status, ACTION_RESULT_STATUS.ROLLED_BACK);
  assert.equal(result.code, 'ACTION_ROLLED_BACK');
  assert.deepEqual(calls, ['validate', 'prepare', 'confirm', 'execute', 'rollback', 'audit']);
});

test('Action Audit 使用白名单，不记录输入与敏感字段', () => {
  const repository = new ActionAuditRepository({ storage: createMemoryStorage() });
  const record = repository.record({
    actionName: 'CreateExpense',
    actionType: ACTION_TYPES.EXPENSE,
    resultStatus: 'success',
    input: '午饭 20 元',
    arguments: { password: 'password-value' },
    apiKey: 'api-key-value',
    cookie: 'cookie-value'
  });
  const serialized = JSON.stringify(record);

  assert.equal(serialized.includes('午饭'), false);
  assert.equal(serialized.includes('password-value'), false);
  assert.equal(serialized.includes('api-key-value'), false);
  assert.equal(serialized.includes('cookie-value'), false);
});
