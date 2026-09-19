import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssistantToolRegistry } from './assistantToolRegistry.js';

function tool(overrides = {}) {
  return {
    id: 'calendar.convert',
    description: 'Deterministic calendar conversion.',
    argumentSchema: { type: 'object' },
    actions: ['convert_calendar_date'],
    evidenceSchema: { predicates: ['birthday'] },
    permissions: ['authenticated_session', 'owner_scoped_evidence'],
    planSchema: (plan) => ({ ok: plan?.action === 'convert_calendar_date', errors: ['action invalid'] }),
    resultSchema: (value) => Boolean(value?.ok && value.tool === 'calendar.convert'),
    failureBehavior: 'fail_closed',
    contract: () => ({ decision: 'ACCEPT', input: { value: 1 } }),
    execute: () => ({ ok: true, tool: 'calendar.convert', value: 1 }),
    ...overrides
  };
}

test('production Tool Registry exposes audited descriptors without demo or mock behavior', () => {
  const registry = createAssistantToolRegistry();
  registry.register(tool());
  assert.deepEqual(registry.descriptors(), [{
    id: 'calendar.convert', description: 'Deterministic calendar conversion.',
    argumentSchema: { type: 'object' },
    actions: ['convert_calendar_date'], evidenceSchema: { predicates: ['birthday'] },
    permissions: ['authenticated_session', 'owner_scoped_evidence'],
    planSchema: 'declared', resultSchema: 'declared', failureBehavior: 'fail_closed'
  }]);
  assert.throws(() => registry.register({ id: 'bad' }), /contract|schema|permission/i);
});

test('Tool Registry validates the selected tool Plan before Evidence binding', () => {
  const registry = createAssistantToolRegistry();
  registry.register(tool());
  assert.equal(registry.validatePlan('calendar.convert', { action: 'convert_calendar_date' }).ok, true);
  assert.equal(registry.validatePlan('calendar.convert', { action: 'store_memory' }).ok, false);
  assert.equal(registry.validatePlan('missing.tool', {}).ok, false);
});

test('Tool Registry runs Contract before execute and never executes on ASK', async () => {
  let executions = 0;
  const registry = createAssistantToolRegistry();
  registry.register(tool({
    contract: () => ({ decision: 'ASK', question: '需要确认。' }),
    execute: () => { executions += 1; return { ok: true }; }
  }));
  const result = await registry.invoke('calendar.convert', {});
  assert.equal(result.decision, 'ASK');
  assert.equal(executions, 0);
});

test('Tool Registry validates result schema and sanitizes deterministic failures', async () => {
  const registry = createAssistantToolRegistry();
  registry.register(tool({ execute: () => ({ ok: false, secret: 'must-not-leak' }) }));
  const result = await registry.invoke('calendar.convert', {});
  assert.deepEqual(result, { decision: 'ERROR', code: 'TOOL_RESULT_INVALID' });
  await assert.rejects(() => registry.invoke('missing.tool', {}), /not registered/i);
});
