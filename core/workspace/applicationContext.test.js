import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceToolRegistry } from './workspaceToolRegistry.js';

test('answers current date from application time without calling AI', async () => {
  const registry = new WorkspaceToolRegistry({
    inputRouter: { handle: async () => ({ handled: false, status: 'pass_through', intent: { intent: 'question' } }) }
  });

  const result = await registry.runForInput('今天几号？', {
    conversationId: 'conversation-date-test',
    now: '2026-07-14T09:30:00+08:00',
    locale: 'zh-CN',
    timeZone: 'Asia/Shanghai'
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, '今天是 2026年7月14日，星期二。');
  assert.equal(result.metadata.answerSource, 'application_context');
});
