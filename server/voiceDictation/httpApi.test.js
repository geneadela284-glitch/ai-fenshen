import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleVoiceDictationApi } from './httpApi.js';
import { sha256Hex } from './audioContract.js';

function wav(durationMs = 1_000) {
  const dataBytes = Math.round(16_000 * durationMs / 1_000) * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function requestFor({ audio = wav(), requestId = 'dictation-request-0001', durationMs = 1_000, ownerHeader = '' } = {}) {
  const request = Readable.from([audio]);
  request.method = 'POST';
  request.headers = {
    'content-type': 'audio/wav',
    'content-length': String(audio.length),
    'x-voice-request-id': requestId,
    'x-voice-audio-hash': sha256Hex(audio),
    'x-voice-format': 'audio/wav',
    'x-voice-sample-rate': '16000',
    'x-voice-duration-ms': String(durationMs),
    ...(ownerHeader ? { 'x-owner-id': ownerHeader } : {})
  };
  return request;
}

class ResponseHarness extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.headers = null;
    this.body = null;
    this.writableEnded = false;
  }

  end() {
    this.writableEnded = true;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.status = status;
  res.headers = headers;
  res.body = body;
  res.writableEnded = true;
}

function diagnosticLogger() {
  const events = [];
  return {
    events,
    log(event) {
      events.push(event);
      return Promise.resolve();
    }
  };
}

test('uses only the authenticated session owner and returns an editable draft result', async () => {
  const res = new ResponseHarness();
  let received;
  const runtime = {
    transcribe: async (request) => {
      received = request;
      return {
        requestId: request.requestId,
        transcript: '今天下午三点提醒我开会',
        durationMs: request.durationMs,
        latencyMs: 21,
        providerId: 'local_whisper_cpp',
        cleanupStatus: 'cleaned',
        autoSend: false,
        errorCode: null
      };
    },
    cancel: () => false
  };
  const handled = await handleVoiceDictationApi({
    req: requestFor(),
    res,
    url: new URL('http://local/api/voice/dictation'),
    session: { user: { id: 'acct-session-owner' } },
    runtime,
    sendJson
  });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(received.ownerId, 'acct-session-owner');
  assert.equal(Object.hasOwn(received, 'ownerId'), true);
  assert.deepEqual(res.body, {
    ok: true,
    requestId: 'dictation-request-0001',
    transcript: '今天下午三点提醒我开会',
    durationMs: 1_000,
    latencyMs: 21,
    providerId: 'local_whisper_cpp',
    cleanupStatus: 'cleaned',
    autoSend: false,
    errorCode: null
  });
});

test('rejects a forged client owner before reading or invoking ASR', async () => {
  const res = new ResponseHarness();
  let invoked = false;
  const handled = await handleVoiceDictationApi({
    req: requestFor({ ownerHeader: 'forged-owner' }),
    res,
    url: new URL('http://local/api/voice/dictation'),
    session: { user: { id: 'acct-session-owner' } },
    runtime: { transcribe: async () => { invoked = true; }, cancel: () => false },
    sendJson
  });
  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, 'CLIENT_OWNER_FORBIDDEN');
  assert.equal(invoked, false);
});

test('maps busy, timeout, malformed audio, and unauthenticated requests to stable safe responses', async () => {
  const cases = [
    { code: 'ASR_BUSY', status: 429 },
    { code: 'TIMEOUT', status: 504 },
    { code: 'TRANSCRIPTION_FAILED', status: 502 }
  ];
  for (const item of cases) {
    const res = new ResponseHarness();
    await handleVoiceDictationApi({
      req: requestFor(),
      res,
      url: new URL('http://local/api/voice/dictation'),
      session: { user: { id: 'acct-session-owner' } },
      runtime: { transcribe: async () => { throw Object.assign(new Error('private details'), { code: item.code }); }, cancel: () => false },
      sendJson
    });
    assert.equal(res.status, item.status);
    assert.equal(res.body.errorCode, item.code);
    assert.doesNotMatch(res.body.message, /private|opt|whisper|command/i);
  }

  const invalid = new ResponseHarness();
  await handleVoiceDictationApi({
    req: requestFor({ audio: Buffer.from('bad'), requestId: 'dictation-request-bad', durationMs: 1_000 }),
    res: invalid,
    url: new URL('http://local/api/voice/dictation'),
    session: { user: { id: 'acct-session-owner' } },
    runtime: { transcribe: async () => { throw new Error('must not invoke'); }, cancel: () => false },
    sendJson
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.errorCode, 'AUDIO_INVALID');

  const anonymous = new ResponseHarness();
  await handleVoiceDictationApi({
    req: requestFor(),
    res: anonymous,
    url: new URL('http://local/api/voice/dictation'),
    session: { user: null },
    runtime: { transcribe: async () => { throw new Error('must not invoke'); }, cancel: () => false },
    sendJson
  });
  assert.equal(anonymous.status, 401);
});

test('records a complete secret-safe HTTP phase trail with actual audio metadata', async () => {
  const res = new ResponseHarness();
  const logger = diagnosticLogger();
  const audio = wav();
  await handleVoiceDictationApi({
    req: requestFor({ audio }),
    res,
    url: new URL('http://local/api/voice/dictation'),
    session: { user: { id: 'acct-session-owner' } },
    runtime: {
      transcribe: async (request) => ({
        requestId: request.requestId,
        transcript: '不应进入诊断日志正文',
        durationMs: request.durationMs,
        latencyMs: 3,
        providerId: 'local_whisper_cpp',
        cleanupStatus: 'cleaned',
        autoSend: false,
        errorCode: null
      }),
      cancel: () => false
    },
    sendJson,
    logger
  });

  assert.equal(res.status, 200);
  assert.deepEqual(logger.events.map((event) => event.phase), [
    'request_received',
    'session_validated',
    'owner_resolved',
    'audio_metadata_received',
    'audio_validated',
    'response_sent'
  ]);
  const metadata = logger.events.find((event) => event.phase === 'audio_metadata_received');
  assert.equal(metadata.contentType, 'audio/wav');
  assert.equal(metadata.bytes, audio.length);
  assert.equal(metadata.durationMs, 1_000);
  assert.equal(metadata.sampleRate, 16_000);
  assert.equal(metadata.audioHashPrefix, sha256Hex(audio).slice(0, 8));
  assert.equal(logger.events.every((event) => event.requestId === 'dictation-request-0001'), true);
  assert.doesNotMatch(JSON.stringify(logger.events), /不应进入诊断日志正文|acct-session-owner/);
});

test('generates a diagnostic request id and records the exact invalid-audio phase', async () => {
  const res = new ResponseHarness();
  const logger = diagnosticLogger();
  await handleVoiceDictationApi({
    req: requestFor({ audio: Buffer.from('not-a-wav'), requestId: 'dictation-request-bad' }),
    res,
    url: new URL('http://local/api/voice/dictation'),
    session: { user: { id: 'acct-session-owner' } },
    runtime: { transcribe: async () => { throw new Error('must not invoke'); }, cancel: () => false },
    sendJson,
    logger
  });

  assert.equal(res.status, 400);
  assert.equal(logger.events[0].requestId, 'dictation-request-bad');
  assert.deepEqual(logger.events.map((event) => event.phase), [
    'request_received',
    'session_validated',
    'owner_resolved',
    'audio_metadata_received',
    'audio_invalid',
    'response_sent'
  ]);
  assert.equal(logger.events.find((event) => event.phase === 'audio_invalid').errorCode, 'AUDIO_INVALID');
  assert.equal(logger.events.at(-1).httpStatus, 400);

  const generatedRes = new ResponseHarness();
  const generatedLogger = diagnosticLogger();
  await handleVoiceDictationApi({
    req: requestFor({ audio: Buffer.alloc(0), requestId: '' }),
    res: generatedRes,
    url: new URL('http://local/api/voice/dictation'),
    session: { user: { id: 'acct-session-owner' } },
    runtime: { transcribe: async () => { throw new Error('must not invoke'); }, cancel: () => false },
    sendJson,
    logger: generatedLogger
  });
  assert.match(generatedLogger.events[0].requestId, /^dictation-[0-9a-f-]{36}$/);
  assert.equal(generatedLogger.events.at(-1).errorCode, 'AUDIO_EMPTY');
});
