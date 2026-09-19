import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRealUserMemoryRuntime, resolveRealUserMemoryPaths } from './index.js';

const ENABLED = Object.freeze({
  MEMORY_REAL_USER_ENABLED: 'true',
  MEMORY_USER_WHITELIST: 'fake-user-a'
});
const user = Object.freeze({ id: 'fake-user-a', username: 'fake-user-a', role: 'user', status: 'active' });

for (let index = 1; index <= 10; index += 1) {
  test(`memory path is stable and independent of current working directory ${index}`, () => {
    const projectRoot = path.join(os.tmpdir(), `fake-project-${index}`);
    const paths = resolveRealUserMemoryPaths({ projectRoot, env: {} });
    assert.equal(paths.rootDirectory, path.join(projectRoot, 'data/memory'));
    assert.equal(paths.databasePath, path.join(projectRoot, 'data/memory/memory.sqlite'));
    assert.equal(paths.databasePath.includes(process.cwd()), false);
    assert.equal(paths.backupDirectory, path.join(projectRoot, 'data/memory/backups'));
  });
}

for (let index = 1; index <= 8; index += 1) {
  test(`trusted data directory creates a separate memory namespace ${index}`, () => {
    const dataRoot = path.join(os.tmpdir(), `fake-data-${index}`);
    const paths = resolveRealUserMemoryPaths({
      projectRoot: '/unused', env: { AI_SECRETARY_DATA_DIR: dataRoot }
    });
    assert.equal(paths.databasePath, path.join(dataRoot, 'memory/memory.sqlite'));
    assert.notEqual(paths.databasePath, path.join(dataRoot, 'auth/auth.sqlite'));
  });
}

test('explicit trusted memory database path is accepted without exposing it to users', () => {
  const databasePath = path.join(os.tmpdir(), 'fake-explicit-memory', 'memory.sqlite');
  const paths = resolveRealUserMemoryPaths({ projectRoot: '/unused', env: { AI_SECRETARY_MEMORY_DB: databasePath } });
  assert.equal(paths.databasePath, databasePath);
  assert.equal(paths.rootDirectory, path.dirname(databasePath));
});

test('auth database cannot be reused as the memory database', () => {
  const authPath = path.join(os.tmpdir(), 'fake-auth', 'auth.sqlite');
  assert.throws(
    () => resolveRealUserMemoryPaths({
      projectRoot: '/unused', env: { AI_SECRETARY_MEMORY_DB: authPath, AI_SECRETARY_AUTH_DB: authPath }
    }),
    (error) => error?.code === 'MEMORY_PATH_COLLIDES_WITH_AUTH'
  );
});

test('disabled runtime does not create a database', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-disabled-'));
  const runtime = createRealUserMemoryRuntime({ projectRoot, env: {} });
  try {
    const initialized = await runtime.initialize();
    assert.equal(initialized.status, 'disabled');
    assert.equal(fs.existsSync(runtime.paths.databasePath), false);
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('enabled runtime initializes SQLite, verifies integrity and creates a verified baseline backup', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-runtime-'));
  const runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
  try {
    const initialized = await runtime.initialize();
    assert.equal(initialized.status, 'ready');
    assert.equal(initialized.integrity, 'valid');
    assert.equal(initialized.backupVerified, true);
    assert.equal(fs.existsSync(runtime.paths.databasePath), true);
    assert.equal(fs.readdirSync(runtime.paths.backupDirectory).some((name) => name.endsWith('.sqlite')), true);
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('real runtime recalls an explicit food preference after restart and a new authenticated session', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-reopen-'));
  let runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
  try {
    await runtime.initialize();
    const stored = await runtime.service.processConversation(user, {
      input: '记住我喜欢吃虚构辣味食物', sourceId: 'fake-runtime-source', requestId: 'fake-runtime-save',
      conversationId: 'fake-runtime-conversation', idempotencyKey: 'fake-runtime-idempotency'
    });
    assert.equal(stored.status, 'stored');
    await runtime.close();

    runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
    await runtime.initialize();
    const replayed = await runtime.service.processConversation(user, {
      input: '记住我喜欢吃虚构辣味食物', sourceId: 'fake-runtime-source', requestId: 'fake-runtime-save-retry',
      conversationId: 'fake-runtime-conversation', idempotencyKey: 'fake-runtime-idempotency'
    });
    assert.equal(replayed.status, 'stored');
    assert.equal(replayed.memoryId, stored.memoryId);
    const newAuthenticatedSession = { ...user };
    const recalled = await runtime.service.processConversation(newAuthenticatedSession, {
      input: '我喜欢吃什么？', sourceId: 'fake-runtime-recall', requestId: 'fake-runtime-recall',
      conversationId: 'fake-runtime-conversation', idempotencyKey: 'fake-runtime-recall'
    });
    assert.equal(recalled.status, 'recalled');
    assert.equal(recalled.memoryContext.items.length, 1);
    assert.equal(recalled.memoryContext.items[0].safeText.includes('虚构辣味食物'), true);
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('real runtime recalls a proactively captured family birthday after restart and re-login', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-proactive-birthday-'));
  let runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
  try {
    await runtime.initialize();
    const stored = await runtime.service.processConversation(user, {
      input: '我妈是阴历7月16生日', sourceId: 'fake-birthday-source', requestId: 'fake-birthday-save',
      conversationId: 'fake-birthday-conversation', idempotencyKey: 'fake-birthday-idempotency'
    });
    assert.equal(stored.status, 'stored');
    await runtime.close();

    runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
    await runtime.initialize();
    const recalled = await runtime.service.processConversation({ ...user }, {
      input: '我妈妈生日是哪天？', sourceId: 'fake-birthday-recall', requestId: 'fake-birthday-recall',
      conversationId: 'fake-new-session', idempotencyKey: 'fake-birthday-recall'
    });
    assert.equal(recalled.status, 'recalled');
    assert.equal(recalled.memoryContext.items.length, 1);
    assert.equal(recalled.memoryContext.items[0].safeText.includes('农历七月十六日'), true);
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('real runtime preserves strict relationship grounding after restart and re-login', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-entity-grounding-'));
  let runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
  try {
    await runtime.initialize();
    const stored = await runtime.service.processConversation(user, {
      input: '我妈妈阴历七月十六生日', sourceId: 'fake-grounded-source', requestId: 'fake-grounded-save',
      conversationId: 'fake-grounded-before-restart', idempotencyKey: 'fake-grounded-idempotency'
    });
    assert.equal(stored.status, 'stored');
    await runtime.close();

    runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
    await runtime.initialize();
    const mother = await runtime.service.processConversation({ ...user }, {
      input: '我妈妈什么时候生日？', sourceId: 'fake-grounded-mother', requestId: 'fake-grounded-mother',
      conversationId: 'fake-grounded-new-login', idempotencyKey: 'fake-grounded-mother'
    });
    const wife = await runtime.service.processConversation({ ...user }, {
      input: '我老婆什么时候生日？', sourceId: 'fake-grounded-wife', requestId: 'fake-grounded-wife',
      conversationId: 'fake-grounded-new-login', idempotencyKey: 'fake-grounded-wife'
    });
    assert.equal(mother.status, 'recalled');
    assert.match(mother.safeMessage, /妈妈.*七月十六/);
    assert.equal(wife.status, 'no_matching_memory');
    assert.doesNotMatch(wife.safeMessage, /七月十六/);
    const listed = await runtime.service.listMemories({ ...user });
    assert.equal(listed.data.items.length, 1);
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('corrupt existing memory database fails closed and is not replaced', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-corrupt-'));
  const databasePath = path.join(projectRoot, 'data/memory/memory.sqlite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, 'not-a-sqlite-database');
  const before = fs.readFileSync(databasePath);
  const runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
  try {
    await assert.rejects(() => runtime.initialize(), (error) => error?.code === 'PERSISTENCE_CORRUPT');
    assert.deepEqual(fs.readFileSync(databasePath), before);
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('runtime path summary is safe and relative', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-path-summary-'));
  const runtime = createRealUserMemoryRuntime({ projectRoot, env: ENABLED });
  try {
    const initialized = await runtime.initialize();
    assert.equal(initialized.pathSummary, 'data/memory/memory.sqlite');
    assert.equal(initialized.pathSummary.includes(projectRoot), false);
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
