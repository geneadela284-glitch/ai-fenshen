import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDictationDiagnosticLogger,
  createVoiceDictationRuntime,
  sanitizeDiagnosticStderr
} from './runtime.js';
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

function request({ ownerId = 'acct-owner-a', requestId = 'dictation-request-0001', audioBytes = wav(), durationMs = 1_000 } = {}) {
  return {
    ownerId,
    requestId,
    audioBytes,
    audioHash: sha256Hex(audioBytes),
    format: 'audio/wav',
    contentType: 'audio/wav',
    sampleRate: 16_000,
    durationMs
  };
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

test('deduplicates by owner/request/audio hash and keeps owner scopes separate', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-test-'));
  let executions = 0;
  const observed = [];
  const runtime = createVoiceDictationRuntime({
    tempRoot,
    transcribeImpl: async ({ request: input, requestDirectory }) => {
      executions += 1;
      observed.push({ ownerId: input.ownerId, requestDirectory });
      return { transcript: `结果-${input.ownerId}`, processing_ms: 3 };
    }
  });
  try {
    const first = runtime.transcribe(request());
    const duplicate = runtime.transcribe(request());
    const otherOwner = runtime.transcribe(request({ ownerId: 'acct-owner-b' }));
    assert.equal((await first).transcript, '结果-acct-owner-a');
    assert.equal((await duplicate).transcript, '结果-acct-owner-a');
    assert.equal((await otherOwner).transcript, '结果-acct-owner-b');
    assert.equal(executions, 2);
    assert.equal(observed.every((item) => item.requestDirectory.includes('request-dictation-request-0001')), true);
    assert.equal(observed.some((item) => item.requestDirectory.includes('owner-acct-owner-a')), true);
    assert.equal(observed.some((item) => item.requestDirectory.includes('owner-acct-owner-b')), true);
    await assert.rejects(
      runtime.transcribe(request({ audioBytes: wav(2_000), durationMs: 2_000 })),
      { code: 'REQUEST_CONFLICT' }
    );
    assert.deepEqual(runtime.inspect().active, 0);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await runtime.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('enforces one active request plus two queued requests and returns a clear busy error', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-queue-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  const runtime = createVoiceDictationRuntime({
    tempRoot,
    transcribeImpl: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { transcript: '队列结果' };
    }
  });
  try {
    const first = runtime.transcribe(request({ requestId: 'dictation-request-0001' }));
    const second = runtime.transcribe(request({ requestId: 'dictation-request-0002' }));
    const third = runtime.transcribe(request({ requestId: 'dictation-request-0003' }));
    await assert.rejects(
      runtime.transcribe(request({ requestId: 'dictation-request-0004' })),
      { code: 'ASR_BUSY' }
    );
    release();
    await Promise.all([first, second, third]);
    assert.equal(peak, 1);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await runtime.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('cancels a queued or active request without caching its transcript and still cleans temporary scope', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-cancel-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createVoiceDictationRuntime({
    tempRoot,
    transcribeImpl: async () => {
      await gate;
      return { transcript: '不应进入输入框' };
    }
  });
  try {
    const pending = runtime.transcribe(request());
    assert.equal(runtime.cancel({ ...request() }), true);
    await assert.rejects(pending, { code: 'CANCELLED' });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await runtime.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('maps the fixed shared service timeout and engine errors without exposing subprocess details', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-error-'));
  const runtime = createVoiceDictationRuntime({
    tempRoot,
    transcribeImpl: async () => {
      const error = new Error('secret command path');
      error.code = 'TRANSCRIPTION_TIMEOUT';
      throw error;
    }
  });
  try {
    await assert.rejects(runtime.transcribe(request()), (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.message.includes('secret command path'), false);
      assert.equal(error.cleanupStatus, 'cleaned');
      return true;
    });
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await runtime.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('records runtime phases without owner, audio, or transcript contents', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-diagnostic-'));
  const logger = diagnosticLogger();
  const input = request();
  const runtime = createVoiceDictationRuntime({
    tempRoot,
    logger,
    transcribeImpl: async () => ({ transcript: '不应写入诊断日志正文' })
  });
  try {
    const result = await runtime.transcribe(input);
    assert.equal(result.autoSend, false);
    assert.deepEqual(logger.events.map((event) => event.phase), [
      'temp_dir_created',
      'whisper_started',
      'whisper_exited',
      'cleanup_completed'
    ]);
    const evidence = JSON.stringify(logger.events);
    assert.doesNotMatch(evidence, /acct-owner-a|不应写入诊断日志正文/);
    const exit = logger.events.find((event) => event.phase === 'whisper_exited');
    assert.equal(exit.exitCode, null);
    assert.equal(exit.stderrSummary, null);
    assert.equal(exit.audioHashPrefix, input.audioHash.slice(0, 8));
    assert.equal((await readdir(tempRoot)).length, 0);
  } finally {
    await runtime.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('records timeout and cleanup evidence when the ASR operation reports a timeout', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-timeout-diagnostic-'));
  const logger = diagnosticLogger();
  const runtime = createVoiceDictationRuntime({
    tempRoot,
    logger,
    transcribeImpl: async () => {
      const error = new Error('private timeout details');
      error.code = 'TIMEOUT';
      error.stderr = 'Authorization=Bearer should-not-appear';
      throw error;
    }
  });
  try {
    await assert.rejects(runtime.transcribe(request()), { code: 'TIMEOUT' });
    assert.equal(logger.events.some((event) => event.phase === 'whisper_timeout'), true);
    assert.equal(logger.events.some((event) => event.phase === 'cleanup_completed'), true);
    assert.doesNotMatch(JSON.stringify(logger.events), /private timeout details|should-not-appear/);
  } finally {
    await runtime.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('records when Whisper never started and sanitizes subprocess stderr', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dictation-runtime-not-started-'));
  const logger = diagnosticLogger();
  const runtime = createVoiceDictationRuntime({
    tempRoot,
    logger,
    moduleLoader: async () => { throw Object.assign(new Error('private loader path'), { code: 'ASR_ENGINE_UNAVAILABLE' }); }
  });
  try {
    await assert.rejects(runtime.transcribe(request()), { code: 'ASR_ENGINE_UNAVAILABLE' });
    assert.equal(logger.events.some((event) => event.phase === 'whisper_not_started'), true);
    assert.equal(logger.events.some((event) => event.phase === 'cleanup_completed'), true);
    assert.equal(sanitizeDiagnosticStderr('Authorization=Bearer top-secret password=hunter2 /opt/private/audio.wav'), 'Authorization=[redacted] password=[redacted] [path]');
  } finally {
    await runtime.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rotates candidate diagnostic logs before they exceed the configured limit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dictation-log-rotation-'));
  const logPath = path.join(directory, 'logs', 'dictation.jsonl');
  const logger = createDictationDiagnosticLogger({ filePath: logPath, maxBytes: 220 });
  try {
    await logger.log({ phase: 'request_received', requestId: 'dictation-request-0001', message: 'a'.repeat(10) });
    await logger.log({ phase: 'response_sent', requestId: 'dictation-request-0001', message: 'b'.repeat(10) });
    await logger.log({ phase: 'cleanup_completed', requestId: 'dictation-request-0001', cleanupStatus: 'cleaned' });
    const current = await readFile(logPath, 'utf8');
    await access(`${logPath}.1`);
    assert.ok(Buffer.byteLength(current) <= 220);
    assert.doesNotMatch(current, /owner|cookie|session|transcript/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('allowlists diagnostic fields and never writes request secrets or transcript content', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dictation-log-safety-'));
  const logPath = path.join(directory, 'logs', 'dictation.jsonl');
  const logger = createDictationDiagnosticLogger({ filePath: logPath });
  try {
    await logger.log({
      phase: 'response_sent',
      requestId: 'dictation-request-0001',
      ownerId: 'owner-secret',
      transcript: '这段正文不得写入日志',
      session: 'session-secret',
      cookie: 'cookie-secret',
      method: 'POST',
      contentLength: 123,
      errorCode: 'TRANSCRIPTION_FAILED',
      audioHashPrefix: '123456789abcdef0',
      stderrSummary: 'Authorization=Bearer top-secret'
    });
    await logger.flush();
    const raw = await readFile(logPath, 'utf8');
    const record = JSON.parse(raw);
    assert.deepEqual(Object.keys(record).sort(), [
      'audioHashPrefix',
      'errorCode',
      'phase',
      'requestId',
      'stderrSummary',
      'timestamp'
    ]);
    assert.equal(record.audioHashPrefix, '12345678');
    assert.doesNotMatch(raw, /owner-secret|这段正文不得写入日志|session-secret|cookie-secret|top-secret/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
