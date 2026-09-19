import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAssistantAgentOrchestrator } from '../agent/assistantAgentOrchestrator.js';
import { canonicalizeUnifiedProviderPlan } from '../agent/unifiedProviderPlanCanonicalizer.js';
import { createFinanceRuntime } from './runtime.js';
import {
  GEN147_DEEPSEEK_INCOME_PLAN,
  GEN147_INCOME_MESSAGE
} from './fixtures/gen147DeepseekIncomePlan.js';

const OWNER = 'gen147-contract-owner';
const NOW = new Date('2026-07-31T04:00:00.000Z');

function harness(canonicalPlan) {
  const finance = createFinanceRuntime({
    database: new DatabaseSync(':memory:'),
    applyMigrations: true,
    timezone: 'Asia/Shanghai',
    clock: () => new Date(NOW)
  });
  const agent = createAssistantAgentOrchestrator({
    semanticIngress: {
      async interpret() {
        return { ok: true, plan: structuredClone(canonicalPlan) };
      }
    },
    financeService: finance.service,
    timezone: 'Asia/Shanghai',
    clock: finance.clock
  });
  return { finance, agent };
}

async function run(canonicalPlan, requestId, message = GEN147_INCOME_MESSAGE) {
  const { finance, agent } = harness(canonicalPlan);
  try {
    const result = await agent.processUserMessage({
      ownerId: OWNER,
      conversationId: `gen147-contract-${requestId}`,
      message,
      clientRequestId: requestId,
      sourceMessageId: `source-${requestId}`,
      conversationMessages: []
    });
    return { result, entries: finance.repository.list({ ownerId: OWNER }) };
  } finally {
    finance.close();
  }
}

function fullArguments({ direction = 'income', amountText = '500', changes = {} } = {}) {
  return {
    metrics: [direction],
    transaction_candidate: {
      direction,
      amount_text: amountText,
      occurred_expression: null
    },
    changes
  };
}

function canonicalPlan(message = GEN147_INCOME_MESSAGE) {
  const result = canonicalizeUnifiedProviderPlan(structuredClone(GEN147_DEEPSEEK_INCOME_PLAN), {
    ownerId: OWNER,
    conversationId: 'gen147-contract-canonical',
    message,
    timezone: 'Asia/Shanghai',
    now: NOW
  });
  assert.equal(result.ok, true, result.code);
  return result.plan;
}

function withFinanceArguments(message, overrides = {}) {
  const plan = structuredClone(canonicalPlan(message));
  plan.canonical_arguments = fullArguments(overrides);
  return plan;
}

test('Finance conflict contract: explicit income direction wins over a Provider expense candidate', async () => {
  const message = '请分析并记录这笔收入500元';
  const { result, entries } = await run(
    withFinanceArguments(message, { direction: 'expense' }),
    'gen147-direction-conflict',
    message
  );

  assert.equal(result.action, 'create');
  assert.equal(result.code, undefined);
  assert.equal(result.audit.code, 'PROVIDER_FIELD_CONFLICT_OVERRIDDEN');
  assert.equal(result.audit.source, 'user_message');
  assert.ok(result.audit.conflicts.some(({ field }) => field === 'direction'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'income');
  assert.equal(entries[0].amountMinor, 50000);
});

test('Finance conflict contract: explicit 500 yuan wins over a Provider amount_text mismatch', async () => {
  const message = '请分析并记录这笔收入500元';
  const { result, entries } = await run(
    withFinanceArguments(message, { amountText: '400' }),
    'gen147-amount-conflict',
    message
  );

  assert.equal(result.action, 'create');
  assert.equal(result.code, undefined);
  assert.equal(result.audit.code, 'PROVIDER_FIELD_CONFLICT_OVERRIDDEN');
  assert.ok(result.audit.conflicts.some(({ field }) => field === 'amount_text'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'income');
  assert.equal(entries[0].amountMinor, 50000);
});

test('Finance conflict contract: Provider changes cannot override explicit income direction or amount', async () => {
  const message = '请分析并记录这笔收入500元';
  const { result, entries } = await run(
    withFinanceArguments(message, { changes: { direction: 'expense', amount_text: '500' } }),
    'gen147-changes-conflict',
    message
  );

  assert.equal(result.action, 'create');
  assert.equal(result.code, undefined);
  assert.equal(result.audit.code, 'PROVIDER_FIELD_CONFLICT_OVERRIDDEN');
  assert.ok(result.audit.conflicts.some(({ field }) => field === 'changes.direction'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'income');
  assert.equal(entries[0].amountMinor, 50000);
});
