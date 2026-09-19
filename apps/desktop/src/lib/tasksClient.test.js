import assert from 'node:assert/strict';
import test from 'node:test';

import { createTasksClient } from './tasksClient.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('Tasks client reads today/tomorrow with an IANA timezone and never sends user identity', async () => {
  const calls = [];
  const client = createTasksClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        ok: true,
        state: 'ready',
        today: [{ id: 'task-today', title: '今天' }],
        tomorrow: [{ id: 'task-tomorrow', title: '明天' }],
        range: { timezone: 'America/Los_Angeles', today: '2026-07-28', tomorrow: '2026-07-29' }
      });
    }
  });

  const result = await client.getTodayTomorrow({ timezone: 'America/Los_Angeles' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/tasks/today-tomorrow?timezone=America%2FLos_Angeles');
  assert.equal(calls[0].options.credentials, 'include');
  assert.doesNotMatch(JSON.stringify(calls[0]), /ownerId|userId|accountId/);
  assert.equal(result.state, 'ready');
  assert.equal(result.today[0].id, 'task-today');
  assert.equal(result.tomorrow[0].id, 'task-tomorrow');
});

test('Tasks client preserves empty and error as distinct states', async () => {
  const emptyClient = createTasksClient({
    fetchImpl: async () => response(200, {
      ok: true,
      state: 'empty',
      today: [],
      tomorrow: [],
      range: { timezone: 'Asia/Shanghai', today: '2026-07-29', tomorrow: '2026-07-30' }
    })
  });
  assert.equal((await emptyClient.getTodayTomorrow({ timezone: 'Asia/Shanghai' })).state, 'empty');

  const failedClient = createTasksClient({
    fetchImpl: async () => response(503, {
      ok: false,
      state: 'error',
      code: 'TASKS_UNAVAILABLE',
      message: '事项暂时无法读取，请稍后重试。'
    })
  });
  await assert.rejects(
    failedClient.getTodayTomorrow({ timezone: 'Asia/Shanghai' }),
    (error) => error.code === 'TASKS_UNAVAILABLE' && error.message === '事项暂时无法读取，请稍后重试。'
  );
});

test('Tasks client completes and restores through owner-free authenticated endpoints', async () => {
  const calls = [];
  const client = createTasksClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        ok: true,
        task: {
          id: 'task-1',
          title: '真实事项',
          status: url.endsWith('/complete') ? 'completed' : 'pending'
        }
      });
    }
  });

  assert.equal((await client.complete('task-1')).status, 'completed');
  assert.equal((await client.restore('task-1')).status, 'pending');
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['/api/tasks/task-1/complete', 'POST'],
    ['/api/tasks/task-1/restore', 'POST']
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /ownerId|userId|accountId/);
});
