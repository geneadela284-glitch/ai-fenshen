import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createLocalMeetingSpeechGateway,
  createProviderRegistryMeetingSpeechGateway,
  readXfyunMeetingCredentials
} from './meetingTranscriptionRuntime.js';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function transcriptionRequest() {
  return {
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 1,
    requestId: 'request-a',
    attempt: 1,
    chunk: {
      sequence: 0,
      startMs: 0,
      endMs: 1_000,
      durationMs: 1_000,
      bytes: Buffer.from('normalized-audio'),
      fileName: 'meeting.wav',
      mimeType: 'audio/wav',
      format: 'wav',
      sourceChunkRefs: ['chunk-0']
    }
  };
}

test('local Xfyun credential loader reports presence without exposing credential values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-xfyun-credentials-'));
  const filePath = path.join(directory, 'xfyun.env');
  await writeFile(filePath, 'XFYUN_APP_ID=app-test\nXFYUN_API_KEY=key-test\nXFYUN_API_SECRET=secret-test\n', { mode: 0o600 });
  await chmod(filePath, 0o600);
  try {
    const credentials = readXfyunMeetingCredentials({ filePath });
    assert.deepEqual(credentials, { appId: 'app-test', accessKeyId: 'key-test', accessKeySecret: 'secret-test' });
    const gateway = createLocalMeetingSpeechGateway({ credentials });
    const description = gateway.describe();
    assert.equal(description.available, true);
    assert.equal(JSON.stringify(description).includes('secret-test'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local Xfyun credential loader fails closed when a required field is missing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-xfyun-credentials-missing-'));
  const filePath = path.join(directory, 'xfyun.env');
  await writeFile(filePath, 'XFYUN_APP_ID=app-test\nXFYUN_API_KEY=\nXFYUN_API_SECRET=secret-test\n', { mode: 0o600 });
  await chmod(filePath, 0o600);
  try {
    assert.throws(() => readXfyunMeetingCredentials({ filePath }), (error) => error.code === 'XFYUN_ASR_CREDENTIALS_MISSING');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Provider Registry Meeting gateway stays blocked when formal credentials are unavailable', async () => {
  let resolverCalls = 0;
  const gateway = createProviderRegistryMeetingSpeechGateway({
    credentialResolver: {
      describeProvider() {
        return {
          providerId: 'iflytek',
          purpose: 'invoke',
          available: false,
          status: 'blocked',
          reasonCode: 'CREDENTIAL_MISSING',
          credentialRevision: null
        };
      },
      async withCredentials() {
        resolverCalls += 1;
        throw new Error('must-not-run');
      }
    },
    fetchImpl: async () => {
      throw new Error('must-not-fetch');
    }
  });

  assert.equal(gateway.describe().available, false);
  assert.equal(gateway.describe().sourceAvailable, false);
  await assert.rejects(
    gateway.transcribeChunk(transcriptionRequest()),
    (error) => error.code === 'REAL_MEETING_ASR_PROVIDER_BLOCKED'
  );
  assert.equal(resolverCalls, 0);
});

test('Provider Registry Meeting gateway resolves signed credentials only inside the existing XFYUN adapter call', async () => {
  const resolverCalls = [];
  const fetchCalls = [];
  const gateway = createProviderRegistryMeetingSpeechGateway({
    credentialResolver: {
      describeProvider() {
        return {
          providerId: 'iflytek',
          purpose: 'invoke',
          available: true,
          status: 'ready',
          reasonCode: null,
          credentialRevision: 7
        };
      },
      async withCredentials(input, callback) {
        resolverCalls.push(input);
        return callback({
          app_id: 'app-from-vault',
          api_key: 'key-from-vault',
          api_secret: 'secret-from-vault'
        });
      }
    },
    providerOptions: {
      pollIntervalMs: 0,
      randomString: () => 'ABCDEFGHIJKLMNOP',
      audioNormalizer: {
        async normalizeChunk(chunk) {
          return { ...chunk, normalized: true };
        }
      }
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: new URL(url), options });
      return new URL(url).pathname.endsWith('/upload')
        ? response({ code: '000000', content: { orderId: 'order-vault-test' } })
        : response({
            code: '000000',
            content: {
              orderInfo: { status: 4 },
              orderResult: JSON.stringify({
                lattice: [{ json_1best: JSON.stringify({
                  st: { bg: '0', ed: '1000', rt: [{ ws: [{ cw: [{ w: '正式转写' }] }] }] }
                }) }]
              })
            }
          });
    }
  });

  assert.equal(gateway.describe().available, true);
  assert.equal(gateway.describe().sourceAvailable, true);
  const result = await gateway.transcribeChunk(transcriptionRequest());
  assert.deepEqual(resolverCalls, [{ providerId: 'iflytek', purpose: 'invoke' }]);
  assert.equal(fetchCalls.length, 2);
  assert.equal(result.provider, 'xfyun_asr_llm');
  assert.equal(result.segments[0].text, '正式转写');
  assert.doesNotMatch(JSON.stringify(result), /app-from-vault|key-from-vault|secret-from-vault/);
});
