import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyFinanceF201Migration } from '../finance/financeF201Migration.js';
import { applyFinanceMigrations } from '../finance/migrations.js';
import { createFinanceRuntime } from '../finance/runtime.js';
import { createConversationRuntime } from './runtime.js';

const NOW = new Date('2026-08-02T06:00:00.000Z');

function harness() {
  const financeDatabase = new DatabaseSync(':memory:');
  applyFinanceMigrations(financeDatabase);
  applyFinanceF201Migration(financeDatabase, { clock: () => new Date(NOW) });
  const finance = createFinanceRuntime({
    database: financeDatabase,
    f201Enabled: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const provider = {
    calls: [],
    async stream(request, { onDelta }) {
      this.calls.push(request);
      await onDelta('模型回复');
      return { ok: true, content: '模型回复' };
    }
  };
  const conversation = createConversationRuntime({
    database: new DatabaseSync(':memory:'),
    aiService: provider,
    applyMigrations: true,
    memoryPolicy: 'disabled',
    financeIntegration: finance.service
  });
  return {
    finance,
    financeDatabase,
    provider,
    conversation,
    close() {
      conversation.close();
      finance.close();
      financeDatabase.close();
    }
  };
}

async function exchange(h, message, clientRequestId, conversationId = null) {
  const prepared = h.conversation.service.prepare({
    ownerId: 'session-owner',
    conversationId,
    message,
    clientRequestId
  });
  const result = await h.conversation.service.execute(prepared, { onDelta: () => {} });
  return { prepared, result };
}

test('F2.0-1 conversation update and delete use the same versioned Repository ledger as page reports', async (t) => {
  const h = harness();
  t.after(() => h.close());

  const created = await exchange(h, '早餐花了18元', 'conversation-create');
  const conversationId = created.prepared.conversation.id;
  assert.equal(created.result.content, '已记录');
  assert.equal(h.finance.repository.list({ ownerId: 'session-owner' })[0].version, 1);

  const updated = await exchange(h, '刚才早餐不是18元，是20元', 'conversation-update', conversationId);
  assert.equal(updated.result.content, '已修改');
  const afterUpdate = h.finance.repository.list({ ownerId: 'session-owner' })[0];
  assert.equal(afterUpdate.amountMinor, 2000);
  assert.equal(afterUpdate.version, 2);
  assert.equal(h.finance.repository.summarizeAllForOwner('session-owner').expenseMinor, 2000);

  const deleted = await exchange(h, '删除刚才的早餐', 'conversation-delete', conversationId);
  assert.equal(deleted.result.content, '已删除');
  const afterDelete = h.finance.repository.list({
    ownerId: 'session-owner', includeDeleted: true
  })[0];
  assert.equal(afterDelete.status, 'deleted');
  assert.equal(afterDelete.version, 3);
  assert.equal(h.finance.repository.summarizeAllForOwner('session-owner').expenseMinor, 0);
  assert.equal(
    h.financeDatabase.prepare('SELECT COUNT(*) AS count FROM finance_revisions').get().count,
    2
  );
  assert.equal(h.provider.calls.length, 0);
});
