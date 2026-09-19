import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createTasksRuntime } from './runtime.js';

const COOKIE_SECRET = 'tasks-domain-test-cookie-secret-32-bytes';
const FIXED_NOW = new Date('2026-07-29T06:30:00.000Z');

function disabledMemoryRuntime() {
  return {
    initialize: async () => ({ status: 'disabled', pathSummary: 'tasks-test-memory.sqlite' }),
    close: async () => {},
    service: {}
  };
}

async function request(harness, pathname, cookie = '', options = {}) {
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function createHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-tasks-domain-'));
  const publicDir = path.join(directory, 'public');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<main>test</main>');
  const tasksPath = path.join(directory, 'tasks.sqlite');
  const tasksRuntime = createTasksRuntime({
    databasePath: tasksPath,
    applyMigrations: true,
    clock: () => new Date(FIXED_NOW)
  });
  const instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access.sqlite'),
      privacyDb: path.join(directory, 'privacy.sqlite'),
      privacyExportDir: path.join(directory, 'privacy-exports'),
      privacyRequired: false,
      cookieSecret: COOKIE_SECRET,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0
    },
    aiService: {
      getStatus: () => ({ available: false }),
      run: async () => ({ ok: false }),
      stream: async () => ({ ok: false })
    },
    memoryRuntime: disabledMemoryRuntime(),
    conversationRuntime: null,
    financeRuntime: null,
    tasksRuntime
  });
  const accountA = await instance.auth.createAccount({
    username: 'tasks_owner_a',
    displayName: 'Tasks Owner A',
    password: 'TasksPasswordA1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const accountB = await instance.auth.createAccount({
    username: 'tasks_owner_b',
    displayName: 'Tasks Owner B',
    password: 'TasksPasswordB1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const loginA = await instance.auth.login({ username: 'tasks_owner_a', password: 'TasksPasswordA1!' });
  const loginB = await instance.auth.login({ username: 'tasks_owner_b', password: 'TasksPasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    directory,
    tasksPath,
    instance,
    accountA,
    accountB,
    loginA,
    loginB,
    baseUrl: `http://127.0.0.1:${instance.server.address().port}`,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function createTask(harness, cookie, overrides = {}) {
  return request(harness, '/api/tasks', cookie, {
    method: 'POST',
    body: {
      title: '本人事项',
      description: '只属于当前账号',
      scheduledAt: '2026-07-29T17:00:00.000Z',
      timezone: 'America/Los_Angeles',
      ...overrides
    }
  });
}

test('RED: Tasks API trusts only the Session user and keeps A isolated from B', async () => {
  const h = await createHarness();
  try {
    assert.equal((await request(h, '/api/tasks', '')).status, 401);
    const forged = await createTask(h, h.loginA.setCookie, {
      userId: h.accountB.id,
      ownerId: h.accountB.id
    });
    assert.equal(forged.status, 403);

    const created = await createTask(h, h.loginA.setCookie);
    assert.equal(created.status, 201);
    assert.equal(created.body.task.userId, h.accountA.id);

    const bList = await request(
      h,
      '/api/tasks?start=2026-07-28T00%3A00%3A00.000Z&end=2026-08-01T00%3A00%3A00.000Z',
      h.loginB.setCookie
    );
    assert.equal(bList.status, 200);
    assert.deepEqual(bList.body.tasks, []);

    const crossPatch = await request(h, `/api/tasks/${created.body.task.id}`, h.loginB.setCookie, {
      method: 'PATCH',
      body: { title: 'B伪造修改', userId: h.accountA.id }
    });
    const crossDelete = await request(h, `/api/tasks/${created.body.task.id}`, h.loginB.setCookie, {
      method: 'DELETE'
    });
    assert.equal(crossPatch.status, 403);
    assert.equal(crossDelete.status, 404);
    assert.equal(h.instance.tasksRuntime.repository.getForOwner(h.accountA.id, created.body.task.id).title, '本人事项');
  } finally {
    await h.close();
  }
});

test('RED: today and tomorrow are grouped by the requested IANA timezone without UTC date leakage', async () => {
  const h = await createHarness();
  try {
    const fixtures = [
      ['昨日事项', '2026-07-27T17:00:00.000Z'],
      ['今日事项', '2026-07-28T17:00:00.000Z'],
      ['明日事项', '2026-07-29T17:00:00.000Z'],
      ['后天事项', '2026-07-30T17:00:00.000Z']
    ];
    for (const [title, scheduledAt] of fixtures) {
      assert.equal((await createTask(h, h.loginA.setCookie, { title, scheduledAt })).status, 201);
    }

    const response = await request(
      h,
      '/api/tasks/today-tomorrow?timezone=America%2FLos_Angeles',
      h.loginA.setCookie
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.state, 'ready');
    assert.deepEqual(response.body.today.map((item) => item.title), ['今日事项']);
    assert.deepEqual(response.body.tomorrow.map((item) => item.title), ['明日事项']);
    assert.deepEqual(response.body.range, {
      timezone: 'America/Los_Angeles',
      today: '2026-07-28',
      tomorrow: '2026-07-29'
    });
  } finally {
    await h.close();
  }
});

test('RED: empty today/tomorrow and repository failure have distinct stable states', async () => {
  const h = await createHarness();
  try {
    const empty = await request(
      h,
      '/api/tasks/today-tomorrow?timezone=Asia%2FShanghai',
      h.loginA.setCookie
    );
    assert.equal(empty.status, 200);
    assert.equal(empty.body.state, 'empty');
    assert.deepEqual(empty.body.today, []);
    assert.deepEqual(empty.body.tomorrow, []);

    h.instance.tasksRuntime.repository.listRangeForOwner = () => {
      throw new Error('private task title must not leak');
    };
    const failed = await request(
      h,
      '/api/tasks/today-tomorrow?timezone=Asia%2FShanghai',
      h.loginA.setCookie
    );
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, {
      ok: false,
      state: 'error',
      code: 'TASKS_UNAVAILABLE',
      message: '事项暂时无法读取，请稍后重试。'
    });
  } finally {
    await h.close();
  }
});

test('RED: update, complete, restore and delete preserve the owner-scoped task contract', async () => {
  const h = await createHarness();
  try {
    const created = await createTask(h, h.loginA.setCookie);
    const id = created.body.task.id;
    const updated = await request(h, `/api/tasks/${id}`, h.loginA.setCookie, {
      method: 'PATCH',
      body: {
        title: '已修改事项',
        description: null,
        scheduledAt: '2026-07-30T09:00:00.000Z',
        timezone: 'Asia/Shanghai'
      }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.task.title, '已修改事项');
    assert.equal(updated.body.task.description, null);

    const cancelled = await request(h, `/api/tasks/${id}`, h.loginA.setCookie, {
      method: 'PATCH',
      body: { status: 'cancelled' }
    });
    assert.equal(cancelled.body.task.status, 'cancelled');
    assert.equal(cancelled.body.task.completedAt, null);

    const completed = await request(h, `/api/tasks/${id}/complete`, h.loginA.setCookie, {
      method: 'POST'
    });
    assert.equal(completed.body.task.status, 'completed');
    assert.match(completed.body.task.completedAt, /Z$/);

    const restored = await request(h, `/api/tasks/${id}/restore`, h.loginA.setCookie, {
      method: 'POST'
    });
    assert.equal(restored.body.task.status, 'pending');
    assert.equal(restored.body.task.completedAt, null);

    const removed = await request(h, `/api/tasks/${id}`, h.loginA.setCookie, {
      method: 'DELETE'
    });
    assert.equal(removed.status, 200);
    assert.equal(h.instance.tasksRuntime.repository.getForOwner(h.accountA.id, id), null);
  } finally {
    await h.close();
  }
});

test('RED: tasks persist after closing and reopening the independent SQLite runtime', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-tasks-persistence-'));
  const databasePath = path.join(directory, 'tasks.sqlite');
  try {
    const first = createTasksRuntime({
      databasePath,
      applyMigrations: true,
      clock: () => new Date(FIXED_NOW)
    });
    const created = first.service.create('owner-persistent', {
      title: '重启后仍存在',
      scheduledAt: '2026-07-29T08:00:00.000Z',
      timezone: 'Asia/Shanghai'
    });
    first.close();

    const reopened = createTasksRuntime({
      databasePath,
      applyMigrations: true,
      clock: () => new Date(FIXED_NOW)
    });
    assert.equal(reopened.repository.getForOwner('owner-persistent', created.id).title, '重启后仍存在');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
