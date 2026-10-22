#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBetaServer } from '../server/betaServer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const financeDb = process.env.AI_SECRETARY_FINANCE_DB;
if (!financeDb || !path.isAbsolute(financeDb) || path.normalize(financeDb) !== financeDb) {
  throw new Error('AI_SECRETARY_FINANCE_DB must be a normalized absolute path.');
}
if (existsSync(financeDb)) throw new Error('Acceptance Finance database already exists; refusing to overwrite it.');

mkdirSync(path.dirname(financeDb), { recursive: true });
const temporary = mkdtempSync(path.join(tmpdir(), 'ai-fenshen-finance-acceptance-'));
let memoryCalls = 0;
const memoryRuntime = {
  service: {},
  async initialize() { return { status: 'disabled', pathSummary: 'isolated acceptance' }; },
  async close() { memoryCalls += 0; }
};
const aiService = {
  getStatus: () => ({ available: false }),
  run: async () => ({ ok: false, code: 'NOT_USED' }),
  async stream() { throw new Error('Provider must not run for deterministic Finance acceptance.'); }
};

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = block.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
    return { event, data: JSON.parse(data) };
  });
}

const instance = await createBetaServer({
  config: {
    publicDir: path.join(root, 'apps/desktop/dist'),
    authDb: path.join(temporary, 'auth.sqlite'),
    conversationDb: path.join(temporary, 'conversations.sqlite'),
    financeDb,
    financeTimezone: 'Asia/Shanghai',
    aiConfig: path.join(temporary, 'ai-settings.json'),
    cookieSecret: randomBytes(32).toString('base64url'),
    secureCookie: false,
    host: '127.0.0.1',
    port: 0
  },
  aiService,
  memoryRuntime
});

try {
  const username = `finance_acceptance_${Date.now()}`;
  const password = randomBytes(24).toString('base64url');
  await instance.auth.createAccount({
    username,
    displayName: 'Finance Acceptance',
    password,
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie);
  let conversationId = null;
  let requestSequence = 0;

  async function say(message) {
    requestSequence += 1;
    const response = await fetch(`${baseUrl}/api/ai/chat/stream`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, message, clientRequestId: `acceptance-${requestSequence}` })
    });
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    conversationId = events.find((item) => item.event === 'started')?.data.conversationId || conversationId;
    assert.equal(events.at(-1)?.event, 'completed');
    return events.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
  }

  assert.equal(await say('早餐18元'), '已记录');
  assert.equal(await say('打车32.5元'), '已记录');
  assert.equal(await say('收到客户款3000元'), '已记录');
  assert.equal(await say('今天花了多少？'), '今天共支出50.5元：\n餐饮18元，交通32.5元。');
  const monthBefore = await say('本月收支情况');
  assert.match(monthBefore, /收入3000元/);
  assert.match(monthBefore, /支出50.5元/);
  assert.match(monthBefore, /结余2949.5元/);
  assert.equal(await say('把早餐改成20元'), '已修改');
  assert.equal(await say('删除打车记录'), '已删除');
  assert.equal(await say('今天花了多少？'), '今天共支出20元：\n餐饮20元。');

  const overview = await fetch(`${baseUrl}/api/finance/overview`, { headers: { cookie } });
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.equal(payload.summary.incomeMinor, 300000);
  assert.equal(payload.summary.expenseMinor, 2000);
  assert.equal(payload.summary.balanceMinor, 298000);
  assert.equal(payload.entries.length, 2);
  assert.equal(memoryCalls, 0);
  assert.equal(instance.financeRuntime.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

  console.log('FINANCE_LOCAL_ACCEPTANCE_PASS');
  console.log('expense_minor=2000');
  console.log('income_minor=300000');
  console.log('balance_minor=298000');
  console.log('active_entries=2');
  console.log('memory_writes=0');
  console.log('integrity_check=ok');
} finally {
  if (instance.server.listening) await new Promise((resolve) => instance.server.close(resolve));
  instance.auth.close();
  rmSync(temporary, { recursive: true, force: true });
}
