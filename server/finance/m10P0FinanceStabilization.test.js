import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createConversationRuntime } from '../conversation/runtime.js';
import { handleFinanceApi } from './httpApi.js';
import { createFinanceRuntime } from './runtime.js';

const OWNER = 'authenticated-owner-a';
const NOW = new Date('2026-07-19T18:30:00.000Z');

function harness() {
  const financeDatabase = new DatabaseSync(':memory:');
  const finance = createFinanceRuntime({
    database: financeDatabase,
    applyMigrations: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const provider = {
    calls: [],
    async stream(request, { onDelta }) {
      this.calls.push(structuredClone(request));
      const content = '好的，已记录。';
      await onDelta(content);
      return { ok: true, content };
    }
  };
  const memory = {
    calls: [],
    isMemoryQuery: () => false,
    async processUserMessage(input) {
      this.calls.push(structuredClone(input));
      return { kind: 'none', outcome: 'ignored' };
    }
  };
  const conversation = createConversationRuntime({
    database: new DatabaseSync(':memory:'),
    aiService: provider,
    applyMigrations: true,
    memoryPolicy: 'protected_acceptance',
    memoryIntegration: memory,
    financeIntegration: finance.service
  });
  return {
    finance,
    financeDatabase,
    provider,
    memory,
    conversation,
    close() {
      conversation.close();
      finance.close();
    }
  };
}

async function exchange(h, message, clientRequestId, conversationId = null) {
  const prepared = h.conversation.service.prepare({
    ownerId: OWNER,
    conversationId,
    message,
    clientRequestId
  });
  const deltas = [];
  const result = await h.conversation.service.execute(prepared, {
    onDelta: (delta) => deltas.push(delta)
  });
  return { prepared, result, deltas };
}

test('incident sequence commits 200, 68, 20 and 185 as four owner-scoped rows before acknowledging', async (t) => {
  const h = harness();
  t.after(() => h.close());
  let conversationId = null;
  const inputs = [
    ['今天加油200', 20000],
    ['买菜68', 6800],
    ['停车费20', 2000],
    ['吃饭185', 18500]
  ];
  for (const [index, [message, amountMinor]] of inputs.entries()) {
    const result = await exchange(h, message, `incident-${index + 1}`, conversationId);
    conversationId = result.prepared.conversation.id;
    assert.equal(result.result.content, '已记录');
    assert.deepEqual(result.deltas, ['已记录']);
    const rows = h.finance.repository.list({ ownerId: OWNER });
    assert.equal(rows.length, index + 1);
    assert.equal(rows.some((row) => row.amountMinor === amountMinor), true);
    assert.equal(rows.every((row) => row.timezone === 'Asia/Shanghai'), true);
  }
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.memory.calls.length, 0);
  const rows = h.finance.repository.list({ ownerId: OWNER });
  assert.equal(new Set(rows.map((row) => row.clientRequestId)).size, 4);
  assert.equal(new Set(rows.map((row) => row.sourceMessageId)).size, 4);

  const query = await exchange(h, '我今天花了多少钱？', 'incident-query', conversationId);
  assert.equal(query.result.content, '今天共支出473元：\n餐饮185元，交通220元，其他68元。');
  assert.equal(h.finance.repository.summarize({ ownerId: OWNER, period: 'today', now: NOW }).expenseMinor, 47300);
});

test('same client request is idempotent but four distinct requests never overwrite each other', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const first = await exchange(h, '今天加油200', 'network-retry');
  for (let index = 0; index < 3; index += 1) {
    const retry = h.conversation.service.prepare({
      ownerId: OWNER,
      conversationId: first.prepared.conversation.id,
      message: '今天加油200',
      clientRequestId: 'network-retry'
    });
    await h.conversation.service.execute(retry);
  }
  assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 1);
  for (const [index, message] of ['买菜68', '停车费20', '吃饭185'].entries()) {
    await exchange(h, message, `distinct-${index}`, first.prepared.conversation.id);
  }
  assert.equal(h.finance.repository.list({ ownerId: OWNER }).length, 4);
});

test('repository rolls back the inserted row when COMMIT fails and the API uses the same summary', async (t) => {
  const h = harness();
  t.after(() => h.close());
  const originalExec = h.financeDatabase.exec.bind(h.financeDatabase);
  h.financeDatabase.exec = (sql) => {
    if (String(sql).trim().toUpperCase() === 'COMMIT') throw new Error('simulated commit failure');
    return originalExec(sql);
  };
  assert.throws(() => h.finance.repository.create({
    ownerId: OWNER,
    type: 'expense',
    amountMinor: 20000,
    currency: 'CNY',
    occurredAt: NOW.toISOString(),
    timezone: 'Asia/Shanghai',
    category: '交通',
    note: 'commit evidence',
    sourceMessageId: 'source-commit',
    clientRequestId: 'commit-failure'
  }), /commit failure/);
  assert.equal(h.financeDatabase.prepare('SELECT COUNT(*) AS count FROM finance_entries').get().count, 0);
  h.financeDatabase.exec = originalExec;

  for (const [index, message] of ['今天加油200', '买菜68', '停车费20', '吃饭185'].entries()) {
    await exchange(h, message, `api-${index}`);
  }
  let response;
  await handleFinanceApi({
    req: { method: 'GET' },
    res: {},
    url: new URL('http://localhost/api/finance/overview'),
    user: { id: OWNER },
    runtime: h.finance,
    readJson: async () => ({}),
    sendJson: (_res, status, body) => { response = { status, body }; }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.expenseMinor, 47300);
  assert.equal(response.body.summary.expenseMinor,
    h.finance.repository.summarize({ ownerId: OWNER, period: 'month', now: NOW }).expenseMinor);
});

