import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';

import { createMeetingAnalysisModelClient } from './meetingAnalysisModelClient.js';

test('meeting client receives a slow valid result and aborts a request exceeding its bounded transport window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = createMeetingAnalysisModelClient({ fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true, async json() { return { ok: true, content: 'verified result' }; } }), 54000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  }) });
  const pending = client({ input: 'synthetic', messages: [{ role: 'user', content: 'synthetic' }] });
  await flush();
  t.mock.timers.tick(54000);
  assert.deepEqual(await pending, { content: 'verified result' });
  let activeSignal;
  const stuckClient = createMeetingAnalysisModelClient({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    activeSignal = signal;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  const stuck = stuckClient({ input: 'synthetic', messages: [{ role: 'user', content: 'synthetic' }] });
  const rejection = assert.rejects(stuck, error => error.code === 'TIMEOUT');
  t.mock.timers.tick(104999);
  assert.equal(activeSignal.aborted, false);
  t.mock.timers.tick(1);
  await rejection;
});

test('meeting analysis model client sends only the transient model request contract', async () => {
  let request;
  const client = createMeetingAnalysisModelClient({
    idFactory: () => 'client-request-1',
    fetchImpl: async (...args) => {
      request = args;
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, content: '{"summary":{}}' }; }
      };
    }
  });

  const result = await client({
    input: 'transient transcript batch',
    messages: [
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'transient transcript batch' }
    ],
    metadata: {
      idempotencyKey: 'analysis-key-1',
      ownerId: 'owner-a',
      meetingId: 'meeting-a',
      transcriptRevision: 4
    }
  });

  assert.deepEqual(result, { content: '{"summary":{}}' });
  assert.equal(request[0], '/api/meeting/analysis');
  assert.equal(request[1].method, 'POST');
  assert.equal(request[1].credentials, 'include');
  assert.equal(request[1].mode, 'same-origin');
  assert.equal(request[1].headers['Content-Type'], 'application/json');
  assert.equal(typeof request[1].signal?.aborted, 'boolean');
  assert.deepEqual(JSON.parse(request[1].body), {
    input: 'transient transcript batch',
    messages: [
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'transient transcript batch' }
    ],
    clientRequestId: 'analysis-key-1'
  });
  assert.doesNotMatch(request[1].body, /owner-a|meeting-a|transcriptRevision/);
});

test('meeting analysis model client maps unavailable responses to stable error codes', async () => {
  const client = createMeetingAnalysisModelClient({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async json() { return { ok: false, code: 'PROVIDER_SECRET_LEAK' }; }
    })
  });

  await assert.rejects(
    () => client({
      input: 'transient transcript batch',
      messages: [{ role: 'user', content: 'transient transcript batch' }]
    }),
    (error) => error.code === 'AI_ANALYSIS_UNAVAILABLE'
  );
});
