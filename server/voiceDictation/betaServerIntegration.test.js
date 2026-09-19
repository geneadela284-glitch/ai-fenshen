import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBetaServer } from '../betaServer.js';

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

function voiceHeaders(audio, requestId = 'dictation-request-0001', durationMs = 1_000) {
  return {
    'Content-Type': 'audio/wav',
    'X-Voice-Request-Id': requestId,
    'X-Voice-Audio-Hash': createHash('sha256').update(audio).digest('hex'),
    'X-Voice-Format': 'audio/wav',
    'X-Voice-Sample-Rate': '16000',
    'X-Voice-Duration-Ms': String(durationMs)
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('beta server routes dictation through the Session owner and permits microphone only for same-origin pages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-fenshen-dictation-http-'));
  const cookieSecret = randomBytes(32).toString('hex');
  const password = `DictationOwner-${randomUUID()}-Aa1!`;
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>candidate</title>');
  let received = null;
  let closeCalls = 0;
  const voiceRuntime = {
    async transcribe(request) {
      received = request;
      return {
        requestId: request.requestId,
        transcript: 'AI分身今天收款 18 元',
        durationMs: request.durationMs,
        latencyMs: 7,
        providerId: 'local_whisper_cpp',
        cleanupStatus: 'cleaned',
        autoSend: false,
        errorCode: null
      };
    },
    cancel() { return false; },
    async close() { closeCalls += 1; }
  };
  const instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access-control.sqlite'),
      cookieSecret,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0,
      privacyRequired: false
    },
    aiService: { getStatus: () => ({ available: false }) },
    memoryRuntime: {
      service: {},
      async initialize() { return { status: 'disabled' }; },
      async close() {}
    },
    voiceDictationRuntime: voiceRuntime
  });

  try {
    await instance.auth.createAccount({
      username: 'dictation_owner',
      displayName: 'Dictation Owner',
      password,
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    const login = await instance.auth.login({ username: 'dictation_owner', password });
    assert.equal(login.ok, true);
    await listen(instance.server);
    const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
    const audio = wav();

    const anonymous = await fetch(`${baseUrl}/api/voice/dictation`, {
      method: 'POST', headers: voiceHeaders(audio), body: audio
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).errorCode, 'AUTH_REQUIRED');

    const response = await fetch(`${baseUrl}/api/voice/dictation`, {
      method: 'POST',
      headers: { ...voiceHeaders(audio), Cookie: login.setCookie },
      body: audio
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requestId: 'dictation-request-0001',
      transcript: 'AI分身今天收款 18 元',
      durationMs: 1_000,
      latencyMs: 7,
      providerId: 'local_whisper_cpp',
      cleanupStatus: 'cleaned',
      autoSend: false,
      errorCode: null
    });
    assert.equal(received.ownerId, login.user.id);
    assert.equal(received.autoSend, false);

    const forged = await fetch(`${baseUrl}/api/voice/dictation`, {
      method: 'POST',
      headers: { ...voiceHeaders(audio, 'dictation-request-0002'), Cookie: login.setCookie, 'X-Owner-Id': 'forged-owner' },
      body: audio
    });
    assert.equal(forged.status, 400);
    assert.equal((await forged.json()).errorCode, 'CLIENT_OWNER_FORBIDDEN');
    assert.equal(received.requestId, 'dictation-request-0001');

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('permissions-policy'), 'camera=(), microphone=(self), geolocation=()');
    assert.equal(await readFile(path.join(publicDir, 'index.html'), 'utf8'), '<!doctype html><title>candidate</title>');
  } finally {
    await closeServer(instance.server);
    instance.auth.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(closeCalls, 1);
});
