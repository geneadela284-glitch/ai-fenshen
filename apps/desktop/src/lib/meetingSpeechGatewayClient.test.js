import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createMeetingSpeechGateway } from '../../../../core/meeting/stage3a/meetingSpeechGateway.js';
import {
  createMeetingSpeechGatewayClient,
  encodeMeetingFileNameForHeader
} from './meetingSpeechGatewayClient.js';

function request() {
  return {
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 4,
    requestId: 'request-a',
    traceId: 'meeting-trace-a',
    attempt: 1,
    chunk: {
      sequence: 0,
      startMs: 0,
      endMs: 60_000,
      durationMs: 60_000,
      bytes: new Uint8Array([1, 2, 3]),
      fileName: 'meeting-a.wav',
      mimeType: 'audio/wav',
      format: 'wav'
    }
  };
}

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

test('browser Meeting Gateway exposes the verified real diarization capability', () => {
  const provider = createMeetingSpeechGatewayClient({ fetchImpl: async () => new Response('{}') });
  const gateway = createMeetingSpeechGateway({ provider });
  assert.equal(provider.supportsDiarization, true);
  assert.equal(gateway.describe().diarizationAvailable, true);
});

test('browser Meeting Gateway probes the authenticated server capability and fails closed when Provider is unavailable', async () => {
  const calls = [];
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        ok: true,
        capability: 'meeting_transcription',
        available: false,
        sourceAvailable: false,
        diarizationAvailable: false,
        status: 'blocked'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  const gateway = createMeetingSpeechGateway({ provider });

  assert.equal(gateway.describe().sourceAvailable, true);
  const capability = await gateway.probeCapability();
  assert.equal(capability.sourceAvailable, false);
  assert.equal(gateway.describe().available, false);
  assert.equal(gateway.describe().sourceAvailable, false);
  assert.equal(calls[0].url, '/api/meeting/transcription/status');
  assert.equal(calls[0].options.credentials, 'include');
});

test('browser Meeting Gateway filename headers are ASCII-safe and round-trip UTF-8 names', () => {
  const fileNames = [
    '现场录音',
    'meeting.webm',
    '项目 2026 English.webm',
    '会议-Project🚀.webm',
    '100%完成.webm'
  ];

  for (const fileName of fileNames) {
    const encoded = encodeMeetingFileNameForHeader(fileName);
    assert.match(encoded, /^[\x00-\x7f]*$/);
    assert.doesNotMatch(encoded, /[\r\n]/);
    assert.equal(decodeURIComponent(encoded), fileName);
  }
  assert.equal(encodeMeetingFileNameForHeader('现场录音'), '%E7%8E%B0%E5%9C%BA%E5%BD%95%E9%9F%B3');
});

test('browser Meeting Gateway rejects empty and CR/LF filename header values', () => {
  for (const fileName of ['', 'bad\r\nX-Injected: yes']) {
    assert.throws(
      () => encodeMeetingFileNameForHeader(fileName),
      (error) => error.code === 'TRANSCRIPTION_FILE_NAME_INVALID'
    );
  }
});

test('browser Meeting Gateway client sends only the current chunk and never sends client owner identity', async () => {
  let call = null;
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (url, options) => {
      call = { url, options };
      return new Response(JSON.stringify({
        ok: true,
        provider: 'xfyun_asr_llm',
        model: 'recording_file_transcription_llm',
        segments: [{ startMs: 0, endMs: 1_000, text: '云端结果。', confidence: null, speakerRef: null }],
        lease: { provider: 'xfyun_asr_llm', orderIdHash: 'b'.repeat(64), status: 'completed' },
        cursor: { status: 'completed' },
        cleanupStatus: 'not_required'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });

  const result = await provider.transcribeChunk(request());
  assert.equal(call.url, '/api/meeting/transcription/chunk');
  assert.equal(call.options.credentials, 'include');
  assert.equal(call.options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(call.options.body instanceof Blob, true);
  const bodyBytes = new Uint8Array(await call.options.body.arrayBuffer());
  assert.deepEqual([...bodyBytes], [1, 2, 3]);
  assert.equal(call.options.body.size, 3);
  assert.equal(sha256(bodyBytes), sha256(new Uint8Array([1, 2, 3])));
  assert.equal(Object.hasOwn(call.options.headers, 'X-Owner-Id'), false);
  assert.equal(call.options.headers['X-Meeting-Id'], 'meeting-a');
  assert.equal(call.options.headers['X-Meeting-Trace-Id'], 'meeting-trace-a');
  assert.equal(call.options.headers['X-Chunk-Sequence'], '0');
  assert.deepEqual(result.segments, [{ startMs: 0, endMs: 1_000, text: '云端结果。', confidence: null, speakerRef: null }]);
  assert.equal(result.speakerRef, undefined);
});

test('browser Meeting Gateway client keeps provider errors bounded and credential-free', async () => {
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      code: 'XFYUN_PROVIDER_ERROR',
      providerErrorCode: '100007',
      message: '云端语音转写未完成。'
    }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  });

  await assert.rejects(
    provider.transcribeChunk(request()),
    (error) => {
      assert.equal(error.code, 'XFYUN_PROVIDER_ERROR');
      assert.equal(error.providerErrorCode, '100007');
      assert.equal(error.message, 'XFYUN_PROVIDER_ERROR');
      return true;
    }
  );
});

test('browser Meeting Gateway client streams ordered WebM source chunks to the source assembler', async () => {
  const calls = [];
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const final = options.headers['X-Source-Chunk-Final'] === '1';
      return new Response(JSON.stringify(final ? {
        ok: true,
        provider: 'xfyun_asr_llm',
        model: 'recording_file_transcription_llm',
        effectiveDurationMs: 2_000,
        chunks: [{ sequence: 0, startMs: 0, endMs: 2_000, sourceChunkRefs: ['segment-0', 'segment-1'], segments: [{ startMs: 0, endMs: 1_000, text: '连续流结果。' }] }],
        lease: { provider: 'xfyun_asr_llm', orderIdHash: 'c'.repeat(64), status: 'completed' },
        cursor: { status: 'completed' },
        cleanupStatus: 'completed'
      } : { ok: true, acknowledged: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  async function* sourceChunks() {
    yield { sourceChunkId: 'segment-0', sequence: 0, durationMs: 1_000, checksum: '1'.repeat(64), bytes: new Uint8Array([1, 2]) };
    yield { sourceChunkId: 'segment-1', sequence: 1, durationMs: 1_000, checksum: '2'.repeat(64), bytes: new Uint8Array([3, 4]) };
  }

  const result = await provider.transcribeSource({
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 1,
    requestId: 'assembly-a',
    attempt: 1,
    source: {
      fileName: '现场录音',
      mimeType: 'audio/webm;codecs=opus',
      format: 'webm-opus',
      byteLength: 4,
      durationMs: 2_000,
      chunkCount: 2,
      checksum: '3'.repeat(64)
    },
    sourceChunks: sourceChunks()
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.url === '/api/meeting/transcription/source'), true);
  assert.equal(calls[0].options.headers['X-Source-Chunk-Sequence'], '0');
  assert.equal(calls[0].options.headers['X-Source-Chunk-Final'], '0');
  assert.equal(calls[1].options.headers['X-Source-Chunk-Sequence'], '1');
  assert.equal(calls[1].options.headers['X-Source-Chunk-Final'], '1');
  assert.equal(calls[0].options.headers['X-Source-File-Name'], encodeMeetingFileNameForHeader('现场录音'));
  assert.match(calls[0].options.headers['X-Source-File-Name'], /^[\x00-\x7f]*$/);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].options.body instanceof Blob, true);
  assert.deepEqual([...new Uint8Array(await calls[0].options.body.arrayBuffer())], [1, 2]);
  assert.deepEqual([...new Uint8Array(await calls[1].options.body.arrayBuffer())], [3, 4]);
  assert.equal(result.effectiveDurationMs, 2_000);
  assert.deepEqual(result.chunks[0].segments[0].text, '连续流结果。');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'X-Meeting-Transcription-Mode'), false);
});

test('browser Meeting Gateway client preserves independent MP4 container layout on every source chunk', async () => {
  const calls = [];
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (_url, options) => {
      calls.push(options);
      const final = options.headers['X-Source-Chunk-Final'] === '1';
      return new Response(JSON.stringify(final ? {
        ok: true,
        effectiveDurationMs: 2_000,
        chunks: [{ sequence: 0, startMs: 0, endMs: 2_000, sourceChunkRefs: ['segment-0', 'segment-1'], segments: [{ startMs: 0, endMs: 1_000, text: '独立分段结果。' }] }]
      } : { ok: true, acknowledged: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  async function* sourceChunks() {
    yield { sourceChunkId: 'segment-0', sequence: 0, durationMs: 1_000, checksum: '1'.repeat(64), bytes: new Uint8Array([1, 2]) };
    yield { sourceChunkId: 'segment-1', sequence: 1, durationMs: 1_000, checksum: '2'.repeat(64), bytes: new Uint8Array([3, 4]) };
  }

  await provider.transcribeSource({
    ownerId: 'owner-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    sourceRevision: 1,
    requestId: 'assembly-independent-a',
    attempt: 1,
    source: {
      fileName: 'iphone-recording.m4a',
      mimeType: 'audio/mp4;codecs=mp4a.40.2',
      format: 'm4a',
      containerLayout: 'independent-mp4-segments-v1',
      byteLength: 4,
      durationMs: 2_000,
      chunkCount: 2,
      checksum: '3'.repeat(64)
    },
    sourceChunks: sourceChunks()
  });

  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.headers['X-Source-Container-Layout'] === 'independent-mp4-segments-v1'), true);
});

test('browser Meeting Gateway client sends diarization mode and bounded speaker count through the existing source bridge', async () => {
  const calls = [];
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const final = options.headers['X-Source-Chunk-Final'] === '1';
      return new Response(JSON.stringify(final ? {
        ok: true,
        provider: 'xfyun_asr_llm',
        model: 'recording_file_transcription_llm',
        effectiveDurationMs: 1_000,
        chunks: [{ sequence: 0, startMs: 0, endMs: 1_000, sourceChunkRefs: ['segment-0'], segments: [{ startMs: 0, endMs: 1_000, text: '多人会议。', providerRole: 1 }] }]
      } : { ok: true, acknowledged: true }), { status: 200 });
    }
  });

  async function* sourceChunks() {
    yield { sourceChunkId: 'segment-0', sequence: 0, durationMs: 1_000, checksum: '1'.repeat(64), bytes: new Uint8Array([1, 2]) };
  }

  await provider.transcribeSource({
    ...request(),
    mode: 'diarization',
    speakerCount: 4,
    requestId: 'assembly-diarization',
    source: {
      fileName: 'meeting.webm',
      mimeType: 'audio/webm;codecs=opus',
      format: 'webm-opus',
      byteLength: 2,
      durationMs: 1_000,
      chunkCount: 1,
      checksum: '2'.repeat(64)
    },
    sourceChunks: sourceChunks()
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['X-Meeting-Transcription-Mode'], 'diarization');
  assert.equal(calls[0].options.headers['X-Meeting-Speaker-Count'], '4');
});

test('browser Meeting Gateway client posts only allowlisted diagnostic metadata to the candidate endpoint', async () => {
  let call = null;
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (url, options) => {
      call = { url, options };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(await provider.recordDiagnostic({ traceId: 'meeting-trace-a', phase: 'job_state', jobState: 'ready' }), true);
  assert.equal(call.url, '/api/meeting/transcription/diagnostic');
  assert.equal(call.options.headers['X-Meeting-Trace-Id'], 'meeting-trace-a');
  assert.deepEqual(JSON.parse(call.options.body), { traceId: 'meeting-trace-a', phase: 'job_state', jobState: 'ready' });
});

test('browser Meeting Gateway client records the resolved URL and raw transport error before returning the failure', async () => {
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'https://192.168.110.233:18443/meeting', origin: 'https://192.168.110.233:18443', hostname: '192.168.110.233', port: '18443' }
  });
  const calls = [];
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/meeting/transcription/diagnostic') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new TypeError('Failed to fetch');
    }
  });
  try {
    await assert.rejects(provider.transcribeChunk(request()), (error) => error.name === 'TypeError');
    const diagnosticBodies = calls
      .filter(({ url }) => url === '/api/meeting/transcription/diagnostic')
      .map(({ options }) => JSON.parse(options.body));
    assert.equal(diagnosticBodies.length, 2);
    assert.equal(diagnosticBodies[0].phase, 'transport_request');
    assert.equal(diagnosticBodies[0].resolvedUrl, 'https://192.168.110.233:18443/api/meeting/transcription/chunk');
    assert.equal(diagnosticBodies[0].sameOrigin, true);
    assert.equal(diagnosticBodies[0].requestBodyType, 'Blob');
    assert.equal(diagnosticBodies[1].phase, 'transport_error');
    assert.equal(diagnosticBodies[1].errorName, 'TypeError');
    assert.equal(diagnosticBodies[1].errorMessage, 'Failed to fetch');
  } finally {
    if (originalLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
  }
});

test('browser Meeting Gateway client probes same-origin GET and diagnostic POST transport', async () => {
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'https://192.168.110.233:18443/meeting', origin: 'https://192.168.110.233:18443', hostname: '192.168.110.233', port: '18443' }
  });
  const calls = [];
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === '/healthz') return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  try {
    const result = await provider.probeTransport({ traceId: 'meeting-trace-probe', meetingId: 'meeting-a', sourceId: 'source-a', jobId: 'job-a' });
    assert.equal(result.get.success, true);
    assert.equal(result.get.status, 200);
    assert.equal(result.post.success, true);
    assert.equal(calls[0].url, '/healthz');
    assert.equal(calls[0].options.mode, 'same-origin');
    assert.equal(calls[1].url, '/api/meeting/transcription/diagnostic');
    assert.equal(JSON.parse(calls[1].options.body).probeMethod, 'GET');
    assert.equal(JSON.parse(calls[2].options.body).probeMethod, 'POST');
  } finally {
    if (originalLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
  }
});

test('browser Meeting Gateway client binary probe preserves Blob byte length and SHA256', async () => {
  const sourceBytes = new Uint8Array(538_970);
  for (let index = 0; index < sourceBytes.length; index += 1) sourceBytes[index] = index % 251;
  let receivedHash = '';
  let receivedBytes = 0;
  const provider = createMeetingSpeechGatewayClient({
    fetchImpl: async (url, options) => {
      if (url !== '/api/meeting/transcription/diagnostic') throw new Error('unexpected endpoint');
      const bytes = new Uint8Array(await options.body.arrayBuffer());
      receivedBytes = bytes.byteLength;
      receivedHash = sha256(bytes);
      return new Response(JSON.stringify({ ok: true, receivedBytes }), { status: 200 });
    }
  });
  const result = await provider.probeBinaryTransport({ traceId: 'meeting-trace-binary', bytes: sourceBytes });
  assert.equal(result.success, true);
  assert.equal(result.clientBlobSize, 538_970);
  assert.equal(result.serverReceivedBytes, 538_970);
  assert.equal(receivedBytes, sourceBytes.byteLength);
  assert.equal(receivedHash, sha256(sourceBytes));
});
