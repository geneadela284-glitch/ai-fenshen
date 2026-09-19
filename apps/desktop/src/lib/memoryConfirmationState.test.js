import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findPendingMemoryConfirmation,
  shouldKeepMemoryConfirmation
} from './memoryConfirmationState.js';

test('restores the newest actionable memory confirmation from conversation tasks', () => {
  const result = findPendingMemoryConfirmation([
    {
      taskId: 'older-task',
      updatedAt: '2026-07-16T01:00:00.000Z',
      workspaceMetadata: { memoryIntegration: { status: 'confirmation_required', confirmationId: 'older-confirm' } }
    },
    {
      taskId: 'newer-task',
      updatedAt: '2026-07-16T02:00:00.000Z',
      workspaceMetadata: {
        memoryIntegration: {
          status: 'confirmation_required', confirmationId: 'newer-confirm', safeSummary: '喜欢吃辣'
        }
      }
    }
  ]);
  assert.equal(result.taskId, 'newer-task');
  assert.equal(result.confirmationId, 'newer-confirm');
  assert.equal(result.safeSummary, '喜欢吃辣');
});

test('does not restore resolved or identifier-less confirmations', () => {
  assert.equal(findPendingMemoryConfirmation([
    { taskId: 'stored', workspaceMetadata: { memoryIntegration: { status: 'stored', confirmationId: '' } } },
    { taskId: 'legacy', workspaceMetadata: { memoryIntegration: { status: 'confirmation_required' } } }
  ]), null);
});

test('explicit low-risk stored result never opens a confirmation card', () => {
  assert.equal(findPendingMemoryConfirmation([{
    taskId: 'explicit-low-risk',
    updatedAt: '2026-07-16T02:00:00.000Z',
    workspaceMetadata: {
      memoryIntegration: { status: 'stored', confirmationId: '', memoryType: 'preference', sensitivity: 'low' }
    }
  }]), null);
});

for (const status of ['stored', 'cancelled', 'expired', 'conflict', 'rejected']) {
  test(`confirmation card closes after ${status}`, () => {
    assert.equal(shouldKeepMemoryConfirmation({ status }), false);
  });
}

test('confirmation card stays for edited candidate and retryable service failure', () => {
  assert.equal(shouldKeepMemoryConfirmation({ status: 'confirmation_required' }), true);
  assert.equal(shouldKeepMemoryConfirmation({ status: 'failed' }), true);
});
