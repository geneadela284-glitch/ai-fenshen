import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createTasksRuntime } from '../../tasks/runtime.js';
import { createAssistantToolRegistry } from '../assistantToolRegistry.js';
import { createTasksTool } from './tasksTool.js';

const NOW = new Date('2026-07-29T06:30:00.000Z');

function plan(argumentsValue) {
  return {
    domain: 'tool',
    action: 'create_task',
    tool: 'tasks.create',
    arguments: {
      title: '提交方案',
      description: null,
      ...argumentsValue
    },
    required_evidence: []
  };
}

function harness() {
  const runtime = createTasksRuntime({
    database: new DatabaseSync(':memory:'),
    applyMigrations: true,
    clock: () => new Date(NOW)
  });
  const registry = createAssistantToolRegistry();
  registry.register(createTasksTool({ service: runtime.service }));
  return { runtime, registry };
}

test('Tasks Tool deterministically resolves relative day and authenticated timezone', async () => {
  const h = harness();
  try {
    const result = await h.registry.invoke('tasks.create', {
      plan: plan({ relative_day_offset: 2, local_time: '15:00' }),
      ownerId: 'owner-a',
      clientRequestId: 'request-after-tomorrow',
      timezone: 'Asia/Shanghai',
      now: NOW
    });
    assert.equal(result.decision, 'ACCEPT');
    assert.equal(result.result.data.task.userId, 'owner-a');
    assert.equal(result.result.data.task.scheduledAt, '2026-07-31T07:00:00.000Z');
    assert.equal(result.result.data.task.timezone, 'Asia/Shanghai');
    assert.match(result.result.safe_user_message, /2026-07-31/);
  } finally {
    h.runtime.close();
  }
});

test('Tasks Tool creates missing-time items once and uses the request idempotency key', async () => {
  const h = harness();
  try {
    const input = {
      plan: plan({ relative_day_offset: 1 }),
      ownerId: 'owner-a',
      clientRequestId: 'same-request',
      timezone: 'America/Los_Angeles',
      now: NOW
    };
    const first = await h.registry.invoke('tasks.create', input);
    const second = await h.registry.invoke('tasks.create', input);
    assert.equal(first.decision, 'ACCEPT');
    assert.equal(second.decision, 'ACCEPT');
    assert.equal(first.result.data.task.id, second.result.data.task.id);
    assert.equal(first.result.data.task.scheduledAt, '2026-07-29T16:00:00.000Z');
    assert.equal(h.runtime.repository.exportForOwner('owner-a').length, 1);
  } finally {
    h.runtime.close();
  }
});

test('Tasks Tool fails closed for ambiguous dates, invalid timezone and owner authority', async () => {
  const h = harness();
  try {
    assert.deepEqual(
      h.registry.validatePlan('tasks.create', plan({})),
      { ok: false, errors: ['tasks.date: exactly one date source required'] }
    );
    assert.equal((await h.registry.invoke('tasks.create', {
      plan: plan({ relative_day_offset: 0 }),
      ownerId: 'owner-a',
      clientRequestId: 'bad-zone',
      timezone: 'Invalid/Timezone',
      now: NOW
    })).decision, 'REJECT');
    assert.equal(h.registry.validatePlan('tasks.create', {
      ...plan({ relative_day_offset: 0 }),
      arguments: {
        ...plan({ relative_day_offset: 0 }).arguments,
        user_id: 'owner-b'
      }
    }).ok, false);
    assert.equal(h.runtime.repository.exportForOwner('owner-a').length, 0);
  } finally {
    h.runtime.close();
  }
});
