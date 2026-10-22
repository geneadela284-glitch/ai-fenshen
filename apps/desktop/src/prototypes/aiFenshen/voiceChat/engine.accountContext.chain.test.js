import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { VoiceChatEngine } from './engine.js';
import { handleVoiceChatApi } from '../../../../../../server/voiceChat/httpApi.js';

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw || '{}');
}

async function invokeVoiceApi({ session, headers, runtime = { enabled: true, create: () => ({ id: 'synthetic-session' }) } } = {}) {
  const request = Readable.from([JSON.stringify({ consent: true })]);
  request.method = 'POST';
  request.headers = Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
  let result;
  await handleVoiceChatApi({
    req: request,
    res: {},
    url: new URL('https://example.test/api/voice/chat/sessions'),
    session,
    runtime,
    readJson,
    sendJson(_response, status, body, responseHeaders) { result = { status, body, responseHeaders }; }
  });
  return new Response(JSON.stringify(result.body), { status: result.status, headers: result.responseHeaders });
}

function engineWithTransport(transport) {
  return new VoiceChatEngine({ ownerId: 'account-a', mediaDevices: {}, fetchImpl: transport });
}

test('normal account context reaches the real voice entry with the expected request and response headers', async () => {
  let requestHeaders;
  const engine = engineWithTransport(async (_url, options) => {
    requestHeaders = options.headers;
    return invokeVoiceApi({
      session: { user: { id: 'account-a' }, subject: { accountId: 'account-a' } },
      headers: { ...options.headers, origin: 'https://example.test', host: 'example.test' }
    });
  });
  const response = await engine.request('/sessions', { body: { consent: true } });
  assert.equal(response.status, 201);
  assert.equal(requestHeaders['X-AI-Expected-Account-Context'], 'account-a');
  assert.equal(response.headers.get('X-AI-Account-Context'), 'account-a');
});

test('an expired unauthenticated session is reported as unauthenticated when the response has no account header', async () => {
  const engine = engineWithTransport(() => invokeVoiceApi({
    session: undefined,
    headers: { origin: 'https://example.test', host: 'example.test', 'x-ai-expected-account-context': 'account-a' }
  }));
  await assert.rejects(engine.request('/sessions', { body: { consent: true } }), { code: 'UNAUTHENTICATED' });
});

test('a headerless proxy 502 remains a network failure instead of becoming an account mismatch', async () => {
  const engine = engineWithTransport(async () => new Response('bad gateway', { status: 502 }));
  await assert.rejects(engine.request('/sessions', { body: { consent: true } }), { code: 'VOICE_NETWORK_FAILED' });
});

test('a transport timeout without an HTTP response is not recast as an account mismatch', async () => {
  const timeout = Object.assign(new Error('synthetic timeout'), { code: 'VOICE_NETWORK_TIMEOUT' });
  const engine = engineWithTransport(async () => { throw timeout; });
  await assert.rejects(engine.request('/sessions', { body: { consent: true } }), { code: 'VOICE_NETWORK_TIMEOUT' });
});

test('a response explicitly bound to another account remains rejected before its body is processed', async () => {
  const engine = engineWithTransport(async () => new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), {
    status: 403,
    headers: { 'X-AI-Account-Context': 'account-b' }
  }));
  await assert.rejects(engine.request('/sessions', { body: { consent: true } }), { code: 'VOICE_ACCOUNT_MISMATCH' });
});

test('a transport that drops the expected request header is rejected by the real server as an account mismatch', async () => {
  const engine = engineWithTransport(async (_url, options) => invokeVoiceApi({
    session: { user: { id: 'account-a' }, subject: { accountId: 'account-a' } },
    headers: { origin: 'https://example.test', host: 'example.test', ...options.headers, 'X-AI-Expected-Account-Context': undefined }
  }));
  await assert.rejects(engine.request('/sessions', { body: { consent: true } }), { code: 'VOICE_ACCOUNT_MISMATCH' });
});

test('a successful response without an account header remains rejected', async () => {
  const engine = engineWithTransport(async () => new Response('{}', { status: 200 }));
  await assert.rejects(engine.request('/sessions', { body: { consent: true } }), { code: 'VOICE_ACCOUNT_MISMATCH' });
});

test('a non-success response for another account is rejected without reading its body', async () => {
  let bodyRead = false;
  const engine = engineWithTransport(async () => ({
    ok: false,
    status: 403,
    headers: new Headers({ 'X-AI-Account-Context': 'account-b' }),
    async json() { bodyRead = true; return { code: 'UNAUTHENTICATED' }; }
  }));
  await assert.rejects(engine.request('/sessions', { body: { consent: true } }), { code: 'VOICE_ACCOUNT_MISMATCH' });
  assert.equal(bodyRead, false);
});

test('a headerless 403 stays a generic forbidden-response failure', async () => {
  const engine = engineWithTransport(async () => new Response('forbidden', { status: 403 }));
  await assert.rejects(engine.request('/sessions', { body: { consent: true } }), { code: 'VOICE_NETWORK_FAILED' });
});

test('a paused failed audio request exposes only status and account-header booleans', async () => {
  const media = { playing: false, clearPlayback() {}, dispose() {} };
  const engine = new VoiceChatEngine({
    ownerId: 'account-a', mediaAdapter: media, clock: () => 2500,
    fetchImpl: async () => new Response('bad gateway', { status: 502 })
  });
  Object.assign(engine, { sessionId: 'synthetic-session', epoch: 1, upload: [new ArrayBuffer(3200)], uploading: false, sequence: 0, inputEpoch: 0, sessionStartedAt: 1000 });
  await engine.flush();
  assert.deepEqual(engine.state.diagnostic, {
    code: 'VOICE_NETWORK_FAILED', relativeMs: 1500, httpStatus: 502,
    accountContextPresent: false, accountContextMatches: false, requestKind: 'audio'
  });
  assert.deepEqual(Object.keys(engine.state.diagnostic).sort(), ['accountContextMatches', 'accountContextPresent', 'code', 'httpStatus', 'relativeMs', 'requestKind']);
});
