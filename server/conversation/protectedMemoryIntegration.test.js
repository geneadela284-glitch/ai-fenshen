import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createConversationRuntime } from './runtime.js';

function memoryIntegration({ result, failure } = {}) {
  const calls = [];
  return {
    calls,
    isMemoryQuery: (message) => /什么时候生日/.test(message),
    async processUserMessage(input) {
      calls.push(structuredClone(input));
      if (failure) throw Object.assign(new Error('private memory database detail'), { code: failure });
      return result || { kind: 'none', outcome: 'ignored' };
    }
  };
}

function aiService() {
  const calls = [];
  return {
    calls,
    async stream(request, { onDelta }) {
      calls.push(structuredClone(request));
      await onDelta('好的。');
      return { ok: true, content: '好的。' };
    }
  };
}

function runtime({ memory, ai = aiService() } = {}) {
  return createConversationRuntime({
    database: new DatabaseSync(':memory:'),
    aiService: ai,
    applyMigrations: true,
    memoryPolicy: 'protected_acceptance',
    memoryIntegration: memory
  });
}

async function exchange(subject, overrides = {}) {
  const prepared = subject.service.prepare({
    ownerId: 'session-owner',
    conversationId: null,
    message: '我妈妈5月6号生日。',
    clientRequestId: 'client-memory-1',
    ...overrides
  });
  return { prepared, result: await subject.service.execute(prepared) };
}

test('protected policy is server-only and captures the authenticated owner user message once', async (t) => {
  const memory = memoryIntegration();
  const subject = runtime({ memory });
  t.after(() => subject.close());
  await exchange(subject);
  assert.equal(memory.calls.length, 1);
  assert.match(memory.calls[0].requestId, /^req_/);
  assert.deepEqual(memory.calls[0], {
    requestId: memory.calls[0].requestId,
    ownerId: 'session-owner',
    conversationId: memory.calls[0].conversationId,
    message: '我妈妈5月6号生日。',
    clientRequestId: 'client-memory-1',
    sourceMessageId: memory.calls[0].sourceMessageId,
    conversationMessages: [{ role: 'user', content: '我妈妈5月6号生日。' }],
    captureEligible: true
  });
});

test('trusted Query V2 exact fact uses the sealed SafeAnswer without Provider mutation', async (t) => {
  const memory = memoryIntegration({ result: {
    kind: 'query',
    safeAnswer: { type: 'fact', safeUserMessage: '5月6号。' },
    trustedContext: {
      source: 'memory_query_v2_grounding', grounded: true,
      entity: { id: 'ent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'mother' },
      fact: { type: 'birthday', displayDate: '5月6日', yearKnown: false, month: 5, day: 6 },
      evidence: ['memory-1'], confidence: 1, version: 1
    }
  } });
  const ai = aiService();
  const subject = runtime({ memory, ai });
  t.after(() => subject.close());
  const { result } = await exchange(subject, { message: '我妈什么时候生日？' });
  assert.equal(result.content, '5月6号。');
  assert.equal(ai.calls.length, 0);
});

test('explicit record request is acknowledged only from a committed Memory outcome without Provider text', async (t) => {
  const memory = memoryIntegration({ result: { kind: 'capture', outcome: 'memory_written' } });
  const ai = aiService();
  const subject = runtime({ memory, ai });
  t.after(() => subject.close());
  const { result } = await exchange(subject, {
    message: '请记录我妈妈是阴历7月16日生日', clientRequestId: 'explicit-lunar-memory'
  });
  assert.equal(result.content, '好的，已经记住了。');
  assert.equal(result.deterministicAction, 'memory_commit_acknowledged');
  assert.equal(ai.calls.length, 0);
});

test('background capture and duplicate outcomes never claim that Memory was saved', async (t) => {
  for (const outcome of ['memory_written', 'duplicate_detected']) {
    const memory = memoryIntegration({ result: { kind: 'capture', outcome, acknowledgement: 'none' } });
    const ai = {
      calls: [],
      async stream(request, { onDelta }) {
        this.calls.push(structuredClone(request));
        const content = '已经记住了。';
        await onDelta(content);
        return { ok: true, content };
      }
    };
    const subject = runtime({ memory, ai });
    t.after(() => subject.close());
    const { result } = await exchange(subject, { clientRequestId: `capture-${outcome}` });
    assert.doesNotMatch(result.content, /记住|已保存|已写入/);
    assert.equal(ai.calls.length, 1);
    assert.doesNotMatch(ai.calls[0].messages[0].content, /允许.*已保存|允许.*已写入/);
  }
});

test('background correction does not announce an internal memory update', async (t) => {
  const memory = memoryIntegration({ result: {
    kind: 'capture', outcome: 'memory_corrected', acknowledgement: 'none'
  } });
  memory.isMemoryQuery = () => false;
  const ai = {
    async stream(request, { onDelta }) {
      const content = '收到，已更新，女儿最爱吃芒果。';
      await onDelta(content);
      return { ok: true, content };
    }
  };
  const subject = runtime({ memory, ai });
  t.after(() => subject.close());
  const { result } = await exchange(subject, {
    message: '她现在最喜欢吃芒果，不是草莓。', clientRequestId: 'preference-correction'
  });
  assert.doesNotMatch(result.content, /已更新|记住|已保存|已写入/);
});

test('capture failure cannot leak a false remembered confirmation to the user', async (t) => {
  const memory = memoryIntegration({ failure: 'MEMORY_CAPTURE_FAILED' });
  memory.isMemoryQuery = () => false;
  const ai = {
    calls: [],
    async stream(request, { onDelta }) {
      this.calls.push(structuredClone(request));
      await onDelta('已经');
      await onDelta('记住了。');
      return { ok: true, content: '已经记住了。' };
    }
  };
  const subject = runtime({ memory, ai });
  t.after(() => subject.close());
  const deltas = [];
  const prepared = subject.service.prepare({
    ownerId: 'session-owner', conversationId: null,
    message: '我女儿最喜欢吃草莓。', clientRequestId: 'capture-failure'
  });
  const result = await subject.service.execute(prepared, { onDelta: (delta) => deltas.push(delta) });
  assert.equal(result.status, 'completed');
  assert.doesNotMatch(result.content, /已经记住|已保存|已写入/);
  assert.doesNotMatch(deltas.join(''), /已经记住|已保存|已写入/);
});

test('ignored capture cannot be presented as a successful write', async (t) => {
  const memory = memoryIntegration({ result: { kind: 'none', outcome: 'ignored' } });
  memory.isMemoryQuery = () => false;
  const ai = {
    async stream(request, { onDelta }) {
      await onDelta('我已经记住了。');
      return { ok: true, content: '我已经记住了。' };
    }
  };
  const subject = runtime({ memory, ai });
  t.after(() => subject.close());
  const { result } = await exchange(subject, {
    message: '我女儿最喜欢吃草莓。', clientRequestId: 'ignored-capture'
  });
  assert.doesNotMatch(result.content, /已经记住|已保存|已写入/);
});

test('generic 已记录 is sealed unless Memory reports a committed write', async (t) => {
  for (const [memoryResult, expected] of [
    [{ kind: 'none', outcome: 'ignored' }, '这条信息暂时没能记下来，请稍后再试。'],
    [{ kind: 'none', outcome: 'capture_failed' }, '这条信息暂时没能记下来，请稍后再试。'],
    [{ kind: 'capture', outcome: 'memory_written', acknowledgement: 'none' }, '好的。']
  ]) {
    const memory = memoryIntegration({ result: memoryResult });
    memory.isMemoryQuery = () => false;
    const ai = {
      async stream(request, { onDelta }) {
        await onDelta('好的，已记录。');
        return { ok: true, content: '好的，已记录。' };
      }
    };
    const subject = runtime({ memory, ai });
    t.after(() => subject.close());
    const { result } = await exchange(subject, {
      message: '我女儿出生于2012年6月8日',
      clientRequestId: `generic-recorded-${memoryResult.outcome}`
    });
    assert.equal(result.content, expected);
    assert.doesNotMatch(result.content, /已记录/);
  }
});

test('memory query failure fails sealed and never asks Provider to guess', async (t) => {
  const memory = memoryIntegration({ failure: 'MEMORY_QUERY_FAILED' });
  const ai = aiService();
  const subject = runtime({ memory, ai });
  t.after(() => subject.close());
  const { result } = await exchange(subject, { message: '我妈什么时候生日？' });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'MEMORY_QUERY_UNAVAILABLE');
  assert.equal(ai.calls.length, 0);
});

test('retry reuses the user message and never captures Memory twice', async (t) => {
  const memory = memoryIntegration();
  const ai = {
    calls: 0,
    async stream(request, { onDelta }) {
      this.calls += 1;
      if (this.calls === 1) return { ok: false, code: 'PROVIDER_ERROR' };
      await onDelta('重试成功。');
      return { ok: true, content: '重试成功。' };
    }
  };
  const subject = runtime({ memory, ai });
  t.after(() => subject.close());
  const first = await exchange(subject);
  assert.equal(first.result.status, 'error');
  const retry = subject.service.prepare({
    ownerId: 'session-owner', conversationId: first.prepared.conversation.id,
    message: '我妈妈5月6号生日。', clientRequestId: 'client-memory-1', retry: true
  });
  const result = await subject.service.execute(retry);
  assert.equal(result.status, 'completed');
  assert.equal(memory.calls.filter((call) => call.captureEligible).length, 1);
  assert.equal(memory.calls.at(-1).captureEligible, false);
  assert.equal(subject.messages.listForConversationOwner(first.prepared.conversation.id, 'session-owner').length, 2);
});

test('disabled policy remains the default and rejects a protected policy without integration', () => {
  const disabled = createConversationRuntime({ database: new DatabaseSync(':memory:'), aiService: aiService(), applyMigrations: true });
  disabled.close();
  assert.throws(() => createConversationRuntime({
    database: new DatabaseSync(':memory:'), aiService: aiService(), applyMigrations: true,
    memoryPolicy: 'protected_acceptance'
  }), /MEMORY_INTEGRATION_REQUIRED/);
});
