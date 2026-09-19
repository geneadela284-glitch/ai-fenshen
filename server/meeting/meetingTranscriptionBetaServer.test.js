import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('local beta server wires authenticated Meeting transcription to the supplied Speech Gateway', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-transcription-beta-'));
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>candidate</title>');
  const cookieSecret = randomBytes(32).toString('hex');
  const password = `MeetingOwner-${randomUUID()}-Aa1!`;
  const calls = [];
  const meetingSpeechGateway = {
    describe: () => ({ available: true, realProvider: true, providerId: 'xfyun_asr_llm', model: 'recording_file_transcription_llm', status: 'available' }),
    async transcribeChunk(input) {
      calls.push(input);
      return {
        provider: 'xfyun_asr_llm',
        model: 'recording_file_transcription_llm',
        segments: [{ startMs: 0, endMs: 1_000, text: '真实链路测试。', confidence: null, speakerRef: null }],
        lease: { provider: 'xfyun_asr_llm', orderIdHash: 'c'.repeat(64), status: 'completed' },
        cursor: { status: 'completed' },
        cleanupStatus: 'not_required'
      };
    }
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
      privacyRequired: false,
      financeDb: null,
      conversationDb: null,
      tasksDb: null,
      attachmentsDb: null
    },
    aiService: { getStatus: () => ({ available: false }) },
    memoryRuntime: {
      service: {},
      async initialize() { return { status: 'disabled' }; },
      async close() {}
    },
    voiceDictationRuntime: { async close() {} },
    meetingSpeechGateway
  });

  try {
    await instance.auth.createAccount({
      username: 'meeting_owner',
      displayName: 'Meeting Owner',
      password,
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    const login = await instance.auth.login({ username: 'meeting_owner', password });
    assert.equal(login.ok, true);
    await listen(instance.server);
    const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;

    const status = await fetch(`${baseUrl}/api/meeting/transcription/status`, {
      headers: { Cookie: login.setCookie }
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).providerId, 'xfyun_asr_llm');

    const audio = Buffer.from('normalized-audio');
    const response = await fetch(`${baseUrl}/api/meeting/transcription/chunk`, {
      method: 'POST',
      headers: {
        Cookie: login.setCookie,
        'Content-Type': 'audio/wav',
        'X-Meeting-Id': 'meeting-a',
        'X-Source-Id': 'source-a',
        'X-Source-Revision': '4',
        'X-Request-Id': 'request-a',
        'X-Transcription-Attempt': '1',
        'X-Chunk-Sequence': '0',
        'X-Chunk-Start-Ms': '0',
        'X-Chunk-End-Ms': '60000',
        'X-Chunk-Duration-Ms': '60000',
        'X-Chunk-File-Name': 'meeting-a.wav',
        'X-Chunk-Mime-Type': 'audio/wav',
        'X-Chunk-Format': 'wav'
      },
      body: audio
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).segments, [{ startMs: 0, endMs: 1_000, text: '真实链路测试。', confidence: null, speakerRef: null }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ownerId, login.user.id);
    assert.deepEqual(Buffer.from(calls[0].chunk.bytes), audio);
  } finally {
    await closeServer(instance.server);
    instance.auth.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('beta server wires formal Meeting transcription to the AI service CredentialResolver', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-formal-transcription-beta-'));
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>formal candidate</title>');
  const cookieSecret = randomBytes(32).toString('hex');
  const password = `FormalMeetingOwner-${randomUUID()}-Aa1!`;
  const credentialResolver = {
    describeProvider() {
      return {
        providerId: 'iflytek',
        purpose: 'invoke',
        available: true,
        status: 'ready',
        reasonCode: null,
        credentialRevision: 3
      };
    },
    async withCredentials() {
      throw new Error('status smoke must not invoke the external Provider');
    }
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
      privacyRequired: false,
      financeDb: null,
      conversationDb: null,
      tasksDb: null,
      attachmentsDb: null,
      meetingTranscriptionProviderRegistry: true
    },
    aiService: { getStatus: () => ({ available: false }), credentialResolver },
    memoryRuntime: {
      service: {},
      async initialize() { return { status: 'disabled' }; },
      async close() {}
    },
    voiceDictationRuntime: { async close() {} }
  });

  try {
    assert.equal(instance.meetingSpeechGateway.describe().available, true);
    assert.equal(instance.meetingSpeechGateway.describe().sourceAvailable, true);
    await instance.auth.createAccount({
      username: 'formal_meeting_owner',
      displayName: 'Formal Meeting Owner',
      password,
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    const login = await instance.auth.login({ username: 'formal_meeting_owner', password });
    assert.equal(login.ok, true);
    await listen(instance.server);
    const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
    const status = await fetch(`${baseUrl}/api/meeting/transcription/status`, {
      headers: { Cookie: login.setCookie }
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.providerId, 'xfyun_asr_llm');
    assert.equal(body.sourceAvailable, true);
    assert.doesNotMatch(JSON.stringify(body), /credentialRevision|iflytek/);
  } finally {
    await closeServer(instance.server);
    instance.auth.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('beta server keeps formal Meeting transcription blocked when the AI service has no CredentialResolver', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-formal-transcription-blocked-beta-'));
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>blocked formal candidate</title>');
  const cookieSecret = randomBytes(32).toString('hex');
  const password = `FormalBlockedOwner-${randomUUID()}-Aa1!`;
  const instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access-control.sqlite'),
      cookieSecret,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0,
      privacyRequired: false,
      financeDb: null,
      conversationDb: null,
      tasksDb: null,
      attachmentsDb: null,
      meetingTranscriptionProviderRegistry: true
    },
    aiService: { getStatus: () => ({ available: false }) },
    memoryRuntime: {
      service: {},
      async initialize() { return { status: 'disabled' }; },
      async close() {}
    },
    voiceDictationRuntime: { async close() {} }
  });

  try {
    assert.equal(instance.meetingSpeechGateway.describe().available, false);
    await instance.auth.createAccount({
      username: 'formal_blocked_owner',
      displayName: 'Formal Blocked Owner',
      password,
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    const login = await instance.auth.login({ username: 'formal_blocked_owner', password });
    await listen(instance.server);
    const status = await fetch(`http://127.0.0.1:${instance.server.address().port}/api/meeting/transcription/status`, {
      headers: { Cookie: login.setCookie }
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).available, false);
  } finally {
    await closeServer(instance.server);
    instance.auth.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authenticated recording-attempt telemetry persists server-owned identity and rejects forged owner claims', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-recording-attempt-beta-'));
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir, { recursive: true });
  await mkdir(path.join(publicDir, 'assets'), { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>rc</title>');
  await writeFile(path.join(publicDir, 'assets', 'index-test.js'), 'export const build = "test";');
  const cookieSecret = randomBytes(32).toString('hex');
  const password = `RecordingAttempt-${randomUUID()}-Aa1!`;
  const instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access-control.sqlite'),
      recordingAttemptDb: path.join(directory, 'meeting', 'recording-attempts.sqlite'),
      meetingTranscriptionDiagnosticLog: path.join(directory, 'meeting', 'transcription-diagnostics.ndjson'),
      meetingRecordingScope: 'meeting-space',
      meetingGeneration: '270',
      meetingImplementationCommit: '9f832cf2940e58c31e83ad5424e93f5fe1d631b9',
      meetingClientBuildId: 'gen270-aac-test',
      meetingAssetVersionId: 'assets-test',
      cookieSecret,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0,
      privacyRequired: false,
      financeDb: null,
      conversationDb: null,
      tasksDb: null,
      attachmentsDb: null
    },
    aiService: { getStatus: () => ({ available: false }) },
    memoryRuntime: { service: {}, async initialize() { return { status: 'disabled' }; }, async close() {} },
    voiceDictationRuntime: { async close() {} }
  });

  try {
    await instance.auth.createAccount({
      username: 'recording_owner',
      displayName: 'Recording Owner',
      password,
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    await listen(instance.server);
    const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
    const shell = await fetch(`${baseUrl}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('cache-control') || '', /no-store/);
    const asset = await fetch(`${baseUrl}/assets/index-test.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control') || '', /immutable/);
    const missingAsset = await fetch(`${baseUrl}/assets/index-missing.js`);
    assert.equal(missingAsset.status, 404);
    const unauthenticated = await fetch(`${baseUrl}/api/meeting/recording-attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingAttemptId: 'unauthenticated' })
    });
    assert.equal(unauthenticated.status, 401);
    const login = await instance.auth.login({ username: 'recording_owner', password });
    const body = {
      recordingAttemptId: 'attempt-a',
      ownerId: 'forged-owner',
      scope: 'forged-scope',
      generation: '270',
      implementationCommit: '9f832cf2940e58c31e83ad5424e93f5fe1d631b9',
      clientBuildId: 'gen270-aac-test',
      assetVersionId: 'assets-test',
      userAgent: 'iPhone Safari',
      isIOS: true,
      isSafari: true,
      isIphoneProfile: true,
      supportedAacCodecMime: true,
      supportedAacPlainMime: true,
      selectedProfile: 'AAC_MP4_PRIMARY',
      selectionReason: 'AAC_SUPPORTED',
      requestedMimeType: 'audio/mp4;codecs=mp4a.40.2',
      constructorOptions: { mimeType: 'audio/mp4;codecs=mp4a.40.2' },
      actualMimeType: 'audio/mp4;codecs=mp4a.40.2',
      fallbackReason: '',
      mismatchCode: ''
    };
    const response = await fetch(`${baseUrl}/api/meeting/recording-attempt`, {
      method: 'POST',
      headers: {
        Cookie: login.setCookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1'
      },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.serverGate, 'AAC_PRIMARY_ACTIVE');
    assert.equal(result.recordingAttempt.authenticatedUserId, login.user.id);
    assert.notEqual(result.recordingAttempt.ownerId, 'forged-owner');
    assert.equal(result.recordingAttempt.ownerId, login.user.id);

    const chromeResponse = await fetch(`${baseUrl}/api/meeting/recording-attempt`, {
      method: 'POST',
      headers: {
        Cookie: login.setCookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.7258.76 Mobile/15E148 Safari/604.1'
      },
      body: JSON.stringify({
        ...body,
        recordingAttemptId: 'attempt-chrome',
        isSafari: true,
        isIphoneProfile: false
      })
    });
    assert.equal(chromeResponse.status, 200);
    const chromeResult = await chromeResponse.json();
    assert.equal(chromeResult.ok, true);
    assert.equal(chromeResult.recordingAttempt.normalizedDeviceClassification, 'iphone-chrome');
    assert.equal(chromeResult.recordingAttempt.isSafari, false);
    assert.equal(chromeResult.recordingAttempt.isIphoneProfile, true);

    const forgedFirefoxResponse = await fetch(`${baseUrl}/api/meeting/recording-attempt`, {
      method: 'POST',
      headers: {
        Cookie: login.setCookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/141.0 Mobile/15E148 Safari/605.1.15'
      },
      body: JSON.stringify({
        ...body,
        recordingAttemptId: 'attempt-forged-firefox',
        isSafari: true,
        isIphoneProfile: true
      })
    });
    assert.equal(forgedFirefoxResponse.status, 409);
    const forgedFirefoxResult = await forgedFirefoxResponse.json();
    assert.equal(forgedFirefoxResult.errorCode, 'IPHONE_PROFILE_NOT_MATCHED');
    assert.equal(forgedFirefoxResult.recordingAttempt.normalizedDeviceClassification, 'ios-other');
    assert.equal(forgedFirefoxResult.recordingAttempt.isIphoneProfile, false);

    const bind = await fetch(`${baseUrl}/api/meeting/recording-attempt/bind`, {
      method: 'POST',
      headers: { Cookie: login.setCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingAttemptId: 'attempt-a', meetingId: 'meeting-a', sourceId: 'source-a' })
    });
    assert.equal(bind.status, 200);

    const checkpoint = {
      phase: 'recording_checkpoint',
      traceId: 'checkpoint-beta-trace-1',
      meetingId: 'meeting-a',
      sourceId: 'source-a',
      recordingAttemptId: 'attempt-a',
      checkpointId: 'checkpoint-a',
      event: 'checkpoint_succeeded',
      committedDurationMs: 36_000,
      success: true
    };
    const checkpointResponse = await fetch(`${baseUrl}/api/meeting/transcription/diagnostic`, {
      method: 'POST',
      headers: { Cookie: login.setCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(checkpoint)
    });
    assert.equal(checkpointResponse.status, 200);
    assert.equal((await checkpointResponse.json()).code, 'TRACE_BACKFILL_ACCEPTED');
    const duplicateCheckpoint = await fetch(`${baseUrl}/api/meeting/transcription/diagnostic`, {
      method: 'POST',
      headers: { Cookie: login.setCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...checkpoint, traceId: 'checkpoint-beta-trace-2' })
    });
    assert.equal(duplicateCheckpoint.status, 200);
    assert.equal((await duplicateCheckpoint.json()).code, 'TRACE_ALREADY_PRESENT');

    const attemptOnlyCheckpoint = await fetch(`${baseUrl}/api/meeting/transcription/diagnostic`, {
      method: 'POST',
      headers: { Cookie: login.setCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phase: 'recording_checkpoint',
        traceId: 'checkpoint-beta-trace-attempt-only',
        recordingAttemptId: 'attempt-a',
        checkpointId: 'checkpoint-attempt-only',
        event: 'checkpoint_scheduler_armed',
        schedulerNextTick: 'armed'
      })
    });
    assert.equal(attemptOnlyCheckpoint.status, 200);
    assert.equal((await attemptOnlyCheckpoint.json()).code, 'TRACE_BACKFILL_ACCEPTED');

    const repeated = await fetch(`${baseUrl}/api/meeting/recording-attempt`, {
      method: 'POST',
      headers: {
        Cookie: login.setCookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1'
      },
      body: JSON.stringify(body)
    });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).idempotent, true);
    const repeatedChanged = await fetch(`${baseUrl}/api/meeting/recording-attempt`, {
      method: 'POST',
      headers: {
        Cookie: login.setCookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1'
      },
      body: JSON.stringify({ ...body, actualMimeType: 'audio/webm;codecs=opus' })
    });
    assert.equal(repeatedChanged.status, 200);
    const repeatedChangedResult = await repeatedChanged.json();
    assert.equal(repeatedChangedResult.idempotent, true);
    assert.equal(repeatedChangedResult.serverGate, 'AAC_PRIMARY_ACTIVE');

    const staleAsset = await fetch(`${baseUrl}/api/meeting/recording-attempt`, {
      method: 'POST',
      headers: {
        Cookie: login.setCookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1'
      },
      body: JSON.stringify({ ...body, recordingAttemptId: 'attempt-stale', clientBuildId: 'stale-build' })
    });
    assert.equal(staleAsset.status, 409);
    assert.equal((await staleAsset.json()).errorCode, 'CLIENT_ASSET_VERSION_MISMATCH');
  } finally {
    await closeServer(instance.server);
    instance.auth.close();
    await rm(directory, { recursive: true, force: true });
  }
});
