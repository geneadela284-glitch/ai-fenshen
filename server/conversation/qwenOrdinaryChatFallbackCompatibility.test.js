import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProviderManager } from '../../core/providers/providerManager.js';
import { createBetaServer } from '../betaServer.js';

const COOKIE_SECRET = 'qwen-fallback-integration-secret-32-bytes';
const PRIVACY_NOTICE_VERSION = 'qwen-fallback-privacy-v1';
const TERMS_VERSION = 'qwen-fallback-terms-v1';
const ORDINARY_MESSAGE = '你好，请用一句话介绍你自己。';

function ordinaryPlan() {
  return {
    domain: 'ordinary_chat',
    intent: 'ordinary_chat',
    action: 'ordinary_chat',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: [],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 0.99,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null
  };
}

function providerConfig(providerId, modelId, {
  healthy = true,
  modelCapabilities = null
} = {}) {
  return {
    id: providerId,
    enabled: true,
    apiKey: `${providerId}-integration-key`,
    baseUrl: `https://${providerId}.provider.test/v1`,
    defaultModel: modelId,
    model: modelId,
    modelOptions: [{ value: modelId }],
    ...(Array.isArray(modelCapabilities)
      ? { modelCapabilities: { [modelId]: modelCapabilities } }
      : {}),
    configured: true,
    healthy,
    status: healthy ? '可用' : '连接失败',
    priority: providerId === 'deepseek' ? 1 : 2
  };
}

function healthSnapshot(deepseekHealthy, qwenHealthy) {
  const provider = (providerId, healthy) => ({
    healthy,
    httpStatus: healthy ? 200 : null,
    errorCode: healthy ? '' : 'NETWORK_ERROR',
    responseTimeMs: 10,
    averageResponseTimeMs: 10,
    sampleCount: 1,
    lastCheckedAt: '2026-07-31T00:00:00.000Z',
    consecutiveFailures: healthy ? 0 : 1,
    lastSuccessAt: healthy ? '2026-07-31T00:00:00.000Z' : '',
    providerId
  });
  return {
    'provider-health': {
      schemaVersion: 1,
      providers: {
        deepseek: provider('deepseek', deepseekHealthy),
        qwen: provider('qwen', qwenHealthy)
      }
    }
  };
}

function parseSse(text) {
  return text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => ({
    type: block.match(/^event:\s*(.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}')
  }));
}

function visibleText(events) {
  return events
    .filter((event) => event.type === 'delta')
    .map((event) => String(event.data.text || ''))
    .join('');
}

function jsonProviderResponse(content, usage = { prompt_tokens: 11, completion_tokens: 7 }) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-integration',
    choices: [{ message: { role: 'assistant', content } }],
    usage
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function streamingProviderResponse(content) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
        'data: [DONE]\n\n'
      ));
      controller.close();
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function installProviderTransport({
  qwenReply = 'Qwen受控单次回复。',
  qwenFailureStatus = null,
  deepseekReply = 'DeepSeek原生流式回复。'
} = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    const providerId = target.includes('qwen.provider.test') ? 'qwen'
      : target.includes('deepseek.provider.test') ? 'deepseek'
        : null;
    if (!providerId) throw new Error(`Unexpected external request: ${target}`);
    const body = JSON.parse(String(options.body || '{}'));
    const providerCallNumber = calls.filter((call) => call.providerId === providerId).length + 1;
    calls.push({ providerId, providerCallNumber, body });

    if (providerCallNumber === 1) {
      return jsonProviderResponse(JSON.stringify(ordinaryPlan()));
    }
    if (providerId === 'deepseek') {
      assert.equal(body.stream, true);
      return streamingProviderResponse(deepseekReply);
    }
    assert.equal(body.stream, false);
    if (qwenFailureStatus) {
      return new Response(JSON.stringify({ error: { message: 'provider rejected request' } }), {
        status: qwenFailureStatus,
        headers: { 'content-type': 'application/json' }
      });
    }
    return jsonProviderResponse(qwenReply, { prompt_tokens: 13, completion_tokens: 5 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

function disabledMemoryRuntime() {
  return {
    initialize: async () => ({ status: 'disabled', pathSummary: 'test-memory-disabled' }),
    close: async () => {},
    service: {}
  };
}

async function createHarness({
  deepseekHealthy,
  qwenHealthy = true,
  modelCapabilities = {
    deepseek: null,
    qwen: null
  },
  transport = {}
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'qwen-fallback-integration-'));
  const aiConfig = path.join(root, 'ai-settings.json');
  const providerHealthStore = path.join(root, 'provider-health.json');
  await writeFile(aiConfig, JSON.stringify({
    'ai-settings': {
      provider: 'deepseek',
      router: { routes: {} },
      providers: {
        deepseek: providerConfig('deepseek', 'deepseek-v4-flash', {
          healthy: deepseekHealthy,
          modelCapabilities: modelCapabilities.deepseek
        }),
        qwen: providerConfig('qwen', 'qwen-max', {
          healthy: qwenHealthy,
          modelCapabilities: modelCapabilities.qwen
        })
      }
    }
  }), { mode: 0o600 });
  await writeFile(
    providerHealthStore,
    JSON.stringify(healthSnapshot(deepseekHealthy, qwenHealthy)),
    { mode: 0o600 }
  );

  const providerTransport = installProviderTransport(transport);
  let instance;
  try {
    instance = await createBetaServer({
      config: {
        publicDir: path.join(root, 'public'),
        authDb: path.join(root, 'auth.sqlite'),
        accessControlDb: path.join(root, 'access-control.sqlite'),
        conversationDb: path.join(root, 'conversations.sqlite'),
        financeDb: path.join(root, 'finance.sqlite'),
        privacyDb: path.join(root, 'privacy.sqlite'),
        privacyExportDir: path.join(root, 'privacy-exports'),
        privacyRequired: true,
        privacyNotice: {
          privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
          termsVersion: TERMS_VERSION,
          locale: 'zh-CN',
          retentionDays: 30,
          contact: 'privacy@example.test'
        },
        aiConfig,
        providerHealthStore,
        providerRegistry: { enabled: false },
        cookieSecret: COOKIE_SECRET,
        secureCookie: false,
        host: '127.0.0.1',
        port: 0
      },
      memoryRuntime: disabledMemoryRuntime()
    });
    const account = await instance.auth.createAccount({
      username: `qf_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
      displayName: 'Qwen Fallback Integration',
      password: 'QwenFallbackPasswordA1!',
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    const login = await instance.auth.login({
      username: account.username,
      password: 'QwenFallbackPasswordA1!'
    });
    await new Promise((resolve, reject) => {
      instance.server.once('error', reject);
      instance.server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
    const consent = await fetch(`${baseUrl}/api/privacy/consent`, {
      method: 'POST',
      headers: {
        cookie: login.setCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        accepted: true,
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        termsVersion: TERMS_VERSION,
        locale: 'zh-CN',
        source: 'qwen_fallback_integration'
      })
    });
    assert.equal(consent.status, 200);
    return {
      root,
      instance,
      account,
      cookie: login.setCookie,
      baseUrl,
      providerTransport,
      async send(clientRequestId = 'ordinary-request') {
        const response = await fetch(`${baseUrl}/api/ai/chat/stream`, {
          method: 'POST',
          headers: {
            cookie: login.setCookie,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            message: ORDINARY_MESSAGE,
            clientRequestId,
            timezone: 'Asia/Shanghai'
          })
        });
        const events = parseSse(await response.text());
        return {
          response,
          events,
          text: visibleText(events),
          conversationId: events.find((event) => event.type === 'started')?.data.conversationId
        };
      },
      async close() {
        if (instance.server.listening) {
          await new Promise((resolve) => instance.server.close(resolve));
        }
        instance.auth.close();
        providerTransport.restore();
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    providerTransport.restore();
    if (instance?.server?.listening) {
      await new Promise((resolve) => instance.server.close(resolve));
    }
    instance?.auth?.close?.();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('real DeepSeek adapter uses native streaming for formal ordinary-chat SSE when healthy', async (t) => {
  const h = await createHarness({ deepseekHealthy: true });
  t.after(() => h.close());

  const result = await h.send('deepseek-native-stream');
  const persistedHealth = JSON.parse(await readFile(path.join(h.root, 'provider-health.json'), 'utf8'));

  assert.equal(result.response.status, 200);
  assert.equal(result.events.at(-1).type, 'completed', JSON.stringify({
    events: result.events,
    calls: h.providerTransport.calls,
    persistedHealth
  }));
  assert.equal(result.text, 'DeepSeek原生流式回复。');
  assert.deepEqual(
    h.providerTransport.calls.map(({ providerId, body }) => ({ providerId, stream: body.stream })),
    [
      { providerId: 'deepseek', stream: false },
      { providerId: 'deepseek', stream: true }
    ]
  );
});

test('real Qwen fallback bridges one non-streaming chat call into formal ordinary-chat SSE', async (t) => {
  const h = await createHarness({ deepseekHealthy: false });
  t.after(() => h.close());

  const result = await h.send('qwen-single-shot-sse');

  assert.equal(result.response.status, 200);
  assert.equal(result.events.at(-1).type, 'completed', JSON.stringify({
    events: result.events,
    calls: h.providerTransport.calls
  }));
  assert.equal(result.text, 'Qwen受控单次回复。');
  assert.deepEqual(
    h.providerTransport.calls.map(({ providerId, body }) => ({ providerId, stream: body.stream })),
    [
      { providerId: 'qwen', stream: false },
      { providerId: 'qwen', stream: false }
    ]
  );
  const exchange = h.instance.conversationRuntime.messages.findByClientRequestId(
    result.conversationId,
    h.account.id,
    'qwen-single-shot-sse'
  );
  assert.equal(exchange.assistant.status, 'completed');
  assert.equal(exchange.assistant.content, 'Qwen受控单次回复。');
});

test('real Qwen single-shot SSE bridge settles Provider attempts, tokens and quota once per call', async (t) => {
  const h = await createHarness({ deepseekHealthy: false });
  t.after(() => h.close());

  const result = await h.send('qwen-attempt-accounting');

  assert.equal(result.events.at(-1).type, 'completed');
  const attempts = h.instance.accessControlStore.database.prepare(`
    SELECT status, settled_input_tokens, settled_output_tokens
    FROM provider_attempts
    ORDER BY created_at
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(attempts, [
    { status: 'settled', settled_input_tokens: 11, settled_output_tokens: 7 },
    { status: 'settled', settled_input_tokens: 13, settled_output_tokens: 5 }
  ]);
  const daily = h.instance.accessControlStore.database.prepare(`
    SELECT provider_calls, input_tokens, output_tokens
    FROM usage_buckets
    WHERE account_id = ? AND bucket_type = 'day'
  `).get(h.account.id);
  const dailyUsage = { ...daily };
  assert.deepEqual(dailyUsage, {
    provider_calls: 2,
    input_tokens: 24,
    output_tokens: 12
  });
});

test('real Qwen bridge failure persists error and never fabricates completed', async (t) => {
  const h = await createHarness({
    deepseekHealthy: false,
    transport: { qwenFailureStatus: 401 }
  });
  t.after(() => h.close());

  const result = await h.send('qwen-provider-failure');

  assert.equal(result.events.at(-1).type, 'error', JSON.stringify({
    events: result.events,
    calls: h.providerTransport.calls
  }));
  assert.equal(result.events.at(-1).data.code, 'AUTH_FAILED');
  const exchange = h.instance.conversationRuntime.messages.findByClientRequestId(
    result.conversationId,
    h.account.id,
    'qwen-provider-failure'
  );
  assert.equal(exchange.assistant.status, 'error');
  assert.equal(exchange.assistant.errorCode, 'AUTH_FAILED');
  assert.doesNotMatch(exchange.assistant.content, /成功|已完成|已记录/);
});

test('real Qwen bridge timeout persists TIMEOUT and never completes a message', async (t) => {
  const h = await createHarness({
    deepseekHealthy: false,
    transport: { qwenFailureStatus: 504 }
  });
  t.after(() => h.close());

  const result = await h.send('qwen-provider-timeout');

  assert.equal(result.events.at(-1).type, 'error');
  assert.equal(result.events.at(-1).data.code, 'TIMEOUT');
  const exchange = h.instance.conversationRuntime.messages.findByClientRequestId(
    result.conversationId,
    h.account.id,
    'qwen-provider-timeout'
  );
  assert.equal(exchange.assistant.status, 'error');
  assert.equal(exchange.assistant.errorCode, 'TIMEOUT');
  assert.doesNotMatch(exchange.assistant.content, /成功|已完成|已记录/);
});

test('real Qwen empty response fails closed instead of completing an empty assistant message', async (t) => {
  const h = await createHarness({
    deepseekHealthy: false,
    transport: { qwenReply: '' }
  });
  t.after(() => h.close());

  const result = await h.send('qwen-empty-response');

  assert.equal(result.events.at(-1).type, 'error');
  assert.equal(result.events.at(-1).data.code, 'EMPTY_PROVIDER_RESPONSE');
  const exchange = h.instance.conversationRuntime.messages.findByClientRequestId(
    result.conversationId,
    h.account.id,
    'qwen-empty-response'
  );
  assert.equal(exchange.assistant.status, 'error');
  assert.equal(exchange.assistant.content, '');
});

test('formal ordinary chat returns stable no-provider error when approved models lack chat capability', async (t) => {
  const h = await createHarness({
    deepseekHealthy: true,
    qwenHealthy: true,
    modelCapabilities: {
      deepseek: ['reasoning', 'structured_extraction'],
      qwen: ['reasoning', 'structured_extraction']
    }
  });
  t.after(() => h.close());

  const result = await h.send('no-chat-capability');

  assert.equal(result.events.at(-1).type, 'error', JSON.stringify({
    events: result.events,
    calls: h.providerTransport.calls
  }));
  assert.equal(result.events.at(-1).data.code, 'NO_USABLE_RUNTIME_CONNECTION');
  assert.equal(h.providerTransport.calls.length, 0);
  const exchange = h.instance.conversationRuntime.messages.findByClientRequestId(
    result.conversationId,
    h.account.id,
    'no-chat-capability'
  );
  assert.equal(exchange.assistant.status, 'error');
});

test('approved ordinary-chat adapters explicitly declare their real delivery capabilities', () => {
  const manager = new ProviderManager();
  const deepseek = manager.getProvider('deepseek');
  const qwen = manager.getProvider('qwen');

  assert.deepEqual(manager.getCapabilities?.('deepseek'), {
    supportsChat: true,
    supportsStreaming: true,
    supportsSingleShotSseBridge: false,
    supportsVoiceStreaming: true
  });
  assert.deepEqual(manager.getCapabilities?.('qwen'), {
    supportsChat: true,
    supportsStreaming: false,
    supportsSingleShotSseBridge: true,
    supportsVoiceStreaming: true
  });
  assert.equal(typeof deepseek.chat, 'function');
  assert.equal(typeof deepseek.streamChat, 'function');
  assert.equal(typeof qwen.chat, 'function');
  assert.equal(typeof qwen.streamChat, 'undefined');
});
