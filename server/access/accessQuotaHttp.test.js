import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createConversationRuntime } from '../conversation/runtime.js';
import {
  createMockStreamingAiService,
  createMockStreamingProvider
} from '../conversation/testing/mockStreamingProvider.js';
import { createFinanceRuntime } from '../finance/runtime.js';

const COOKIE_SECRET = 'access-quota-http-secret-32-bytes';

function memoryRuntime() {
  return {
    initialize: async () => ({ status: 'disabled', pathSummary: 'test-memory.sqlite' }),
    close: async () => {},
    service: {}
  };
}

async function createHarness(providerOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiwc-access-http-'));
  const provider = createMockStreamingProvider(providerOptions);
  const financeRuntime = createFinanceRuntime({
    databasePath: path.join(directory, 'finance.sqlite'),
    applyMigrations: true
  });
  const conversationRuntime = createConversationRuntime({
    databasePath: path.join(directory, 'conversation.sqlite'),
    aiService: createMockStreamingAiService(provider),
    applyMigrations: true,
    financeIntegration: financeRuntime.service
  });
  const instance = await createBetaServer({
    config: {
      publicDir: path.join(directory, 'public'),
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access-control.sqlite'),
      cookieSecret: COOKIE_SECRET,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0
    },
    aiService: { getStatus: () => ({ available: true }) },
    memoryRuntime: memoryRuntime(),
    conversationRuntime
  });
  const accountA = await instance.auth.createAccount({
    username: 'quota_a',
    displayName: 'Quota A',
    password: 'QuotaPasswordA1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const accountB = await instance.auth.createAccount({
    username: 'quota_b',
    displayName: 'Quota B',
    password: 'QuotaPasswordB1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const loginA = await instance.auth.login({ username: 'quota_a', password: 'QuotaPasswordA1!' });
  const loginB = await instance.auth.login({ username: 'quota_b', password: 'QuotaPasswordB1!' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    directory,
    provider,
    instance,
    financeRuntime,
    accountA,
    accountB,
    loginA,
    loginB,
    baseUrl: `http://127.0.0.1:${instance.server.address().port}`,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      financeRuntime.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function postStream(h, cookie, clientRequestId, message = '正式入口额度测试') {
  return fetch(`${h.baseUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ message, clientRequestId })
  });
}

function putProfile(h, profile) {
  h.instance.accessControlStore.putCustomProfile({
    requestsPerMinute: 10,
    maxConcurrentRequests: 2,
    providerCallsPerDay: 100,
    inputTokensPerDay: 100000,
    outputTokensPerDay: 100000,
    dailyCostMicros: 1000000,
    monthlyCostMicros: 5000000,
    lifetimeCostMicros: 10000000,
    enabled: true,
    ...profile
  });
}

test('account A request-rate exhaustion makes zero additional Provider calls and does not affect B', async () => {
  const h = await createHarness();
  try {
    putProfile(h, { id: 'http_one_request_v1', requestsPerMinute: 1 });
    h.instance.accessControl.bindAccountProfile({
      accountId: h.accountA.id,
      profileId: 'http_one_request_v1',
      enabled: true
    });

    assert.equal((await postStream(h, h.loginA.setCookie, 'a-1')).status, 200);
    const rejected = await postStream(h, h.loginA.setCookie, 'a-2', '早餐14元');
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).code, 'ACCOUNT_REQUEST_RATE_LIMITED');
    assert.equal(h.provider.calls, 1);
    assert.equal(h.financeRuntime.repository.list({ ownerId: h.accountA.id }).length, 0);

    assert.equal((await postStream(h, h.loginB.setCookie, 'b-1')).status, 200);
    assert.equal(h.provider.calls, 2);
  } finally {
    await h.close();
  }
});

test('a concurrent request above the account limit is rejected before Provider invocation', async () => {
  const h = await createHarness({ chunks: ['slow'], delayMs: 200 });
  try {
    putProfile(h, { id: 'http_one_concurrent_v1', maxConcurrentRequests: 1 });
    h.instance.accessControl.bindAccountProfile({
      accountId: h.accountA.id,
      profileId: 'http_one_concurrent_v1',
      enabled: true
    });

    const first = await postStream(h, h.loginA.setCookie, 'concurrent-1');
    assert.equal(first.status, 200);
    const rejected = await postStream(h, h.loginA.setCookie, 'concurrent-2');
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).code, 'ACCOUNT_CONCURRENCY_LIMITED');
    assert.equal(h.provider.calls, 1);
    await first.text();
  } finally {
    await h.close();
  }
});

test('security-store failure returns stable 503 and invokes no Provider', async () => {
  const h = await createHarness();
  try {
    h.instance.accessControlStore.close();
    const rejected = await postStream(h, h.loginA.setCookie, 'store-failed');
    assert.equal(rejected.status, 503);
    assert.deepEqual(await rejected.json(), {
      ok: false,
      code: 'ACCESS_CONTROL_UNAVAILABLE',
      message: '访问控制服务暂时不可用，请稍后再试。'
    });
    assert.equal(h.provider.calls, 0);
  } finally {
    await h.close();
  }
});
