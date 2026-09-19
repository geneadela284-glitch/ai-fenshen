import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMeetingSpeechGateway } from '../../core/meeting/stage3a/meetingSpeechGateway.js';
import {
  createXfyunAsrLlmMeetingProvider,
  createXfyunSignature,
  resolveMeetingSourceDuration,
  validateMeetingSourceWindows
} from './xfyunAsrLlmMeetingProvider.js';

const credentials = Object.freeze({
  appId: 'app-id-for-test',
  accessKeyId: 'access-key-for-test',
  accessKeySecret: 'access-secret-for-test'
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function request() {
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
      endMs: 60_000,
      durationMs: 60_000,
      bytes: Buffer.from('normalized-16k-mono-audio'),
      fileName: 'meeting-smoke.wav',
      mimeType: 'audio/wav',
      format: 'wav',
      sourceChunkRefs: ['source-asset-0']
    }
  };
}

function finishedResult() {
  return {
    code: '000000',
    descInfo: 'success',
    content: {
      orderInfo: {
        orderId: 'order-for-test',
        status: 4,
        failType: 0,
        originalDuration: 60_000
      },
      orderResult: JSON.stringify({
        lattice: [
          {
            json_1best: JSON.stringify({
              st: {
                bg: '120',
                ed: '1680',
                rt: [{ ws: [{ cw: [{ w: '项目', wp: 'n', wc: '0.98' }, { w: '预算', wp: 'n', wc: '0.96' }] }] }]
              }
            })
          }
        ]
      })
    }
  };
}

function diarizedFinishedResult({ role = 2 } = {}) {
  return {
    code: '000000',
    descInfo: 'success',
    content: {
      orderInfo: {
        orderId: 'order-for-diarization-test',
        status: 4,
        failType: 0,
        originalDuration: 60_000
      },
      orderResult: JSON.stringify({
        lattice: [
          {
            json_1best: JSON.stringify({
              st: {
                bg: '120',
                ed: '1680',
                rl: String(role),
                rt: [{ ws: [{ cw: [{ w: '项目', wp: 'n', wc: '0.98' }, { w: '预算', wp: 'n', wc: '0.96' }] }] }]
              }
            })
          }
        ]
      })
    }
  };
}

test('XFYUN source duration drift uses a bounded decoded-duration tolerance', () => {
  const exact = resolveMeetingSourceDuration({ declaredDurationMs: 100_000, decodedDurationMs: 100_000 });
  assert.equal(exact.effectiveDurationMs, 100_000);
  assert.equal(exact.durationDifferenceMs, 0);

  const drift = resolveMeetingSourceDuration({ declaredDurationMs: 100_000, decodedDurationMs: 100_073 });
  assert.equal(drift.effectiveDurationMs, 100_073);
  assert.equal(drift.durationDifferenceMs, 73);
  assert.equal(drift.toleranceMs, 500.365);

  const twoHundredMs = resolveMeetingSourceDuration({ declaredDurationMs: 100_000, decodedDurationMs: 100_200 });
  assert.equal(twoHundredMs.effectiveDurationMs, 100_200);

  assert.throws(
    () => resolveMeetingSourceDuration({ declaredDurationMs: 100_000, decodedDurationMs: 101_000 }),
    (error) => error.code === 'TRANSCRIPTION_SOURCE_DURATION_DRIFT_TOO_LARGE'
  );
});

test('AAC/MP4 source duration uses decoded duration as the processing boundary for reasonable positive drift', () => {
  const duration = resolveMeetingSourceDuration({
    declaredDurationMs: 48_000,
    decodedDurationMs: 49_250,
    sourceFormat: 'm4a',
    sourceMimeType: 'audio/mp4;codecs=mp4a.40.2'
  });

  assert.equal(duration.codecAware, 'aac-mp4');
  assert.equal(duration.driftDirection, 'positive');
  assert.equal(duration.effectiveDurationMs, 49_250);
  assert.equal(duration.durationDifferenceMs, 1_250);
  assert.equal(duration.durationToleranceApplied, true);

  assert.throws(
    () => resolveMeetingSourceDuration({
      declaredDurationMs: 48_000,
      decodedDurationMs: 49_501,
      sourceFormat: 'm4a',
      sourceMimeType: 'audio/mp4;codecs=mp4a.40.2'
    }),
    (error) => error.code === 'TRANSCRIPTION_SOURCE_DURATION_DRIFT_TOO_LARGE'
  );
});

test('AAC/MP4 60-minute duration contract accepts bounded encoder drift and keeps decoded boundary', () => {
  const duration = resolveMeetingSourceDuration({
    declaredDurationMs: 3_600_000,
    decodedDurationMs: 3_601_250,
    sourceFormat: 'm4a',
    sourceMimeType: 'audio/mp4;codecs=mp4a.40.2'
  });

  assert.equal(duration.effectiveDurationMs, 3_601_250);
  assert.equal(duration.durationDifferenceMs, 1_250);
  assert.equal(duration.codecAware, 'aac-mp4');
  assert.equal(duration.driftDirection, 'positive');
});

test('AAC/MP4 source duration still fails closed on material decoded loss', () => {
  assert.throws(
    () => resolveMeetingSourceDuration({
      declaredDurationMs: 60_000,
      decodedDurationMs: 58_000,
      sourceFormat: 'm4a',
      sourceMimeType: 'audio/mp4;codecs=mp4a.40.2'
    }),
    (error) => error.code === 'TRANSCRIPTION_SOURCE_DURATION_DRIFT_TOO_LARGE'
  );
});

test('WebM/Opus keeps the original strict duration contract', () => {
  assert.throws(
    () => resolveMeetingSourceDuration({
      declaredDurationMs: 48_000,
      decodedDurationMs: 49_250,
      sourceFormat: 'webm-opus',
      sourceMimeType: 'audio/webm;codecs=opus'
    }),
    (error) => error.code === 'TRANSCRIPTION_SOURCE_DURATION_DRIFT_TOO_LARGE'
  );
});

test('XFYUN source windows validate against decoded duration without relaxing timeline rules', () => {
  assert.equal(validateMeetingSourceWindows({
    decodedDurationMs: 100_073,
    windows: [
      { sequence: 0, startMs: 0, endMs: 60_000, durationMs: 60_000 },
      { sequence: 1, startMs: 60_000, endMs: 100_073, durationMs: 40_073 }
    ]
  }).endMs, 100_073);

  const invalidCases = [
    [{ sequence: 1, startMs: 0, endMs: 60_000, durationMs: 60_000 }, { sequence: 1, startMs: 60_000, endMs: 100_073, durationMs: 40_073 }],
    [{ sequence: 0, startMs: 0, endMs: 60_000, durationMs: 60_000 }, { sequence: 1, startMs: 59_900, endMs: 100_073, durationMs: 40_173 }],
    [{ sequence: 0, startMs: 0, endMs: 60_000, durationMs: 60_000 }, { sequence: 1, startMs: 60_000, endMs: 59_999, durationMs: -1 }],
    [{ sequence: 0, startMs: 0, endMs: 60_000, durationMs: 60_000 }, { sequence: 1, startMs: 60_000, endMs: 100_074, durationMs: 40_074 }],
    [{ sequence: 0, startMs: 0, endMs: 60_000, durationMs: 60_000 }, { sequence: 1, startMs: 60_000, endMs: 100_000, durationMs: 40_000 }]
  ];
  for (const windows of invalidCases) {
    assert.throws(
      () => validateMeetingSourceWindows({ decodedDurationMs: 100_073, windows }),
      (error) => error.code === 'TRANSCRIPTION_SOURCE_WINDOW_INVALID'
    );
  }
});

test('XFYUN provider signs, uploads, polls and maps raw timestamps through meeting_transcription', async () => {
  const calls = [];
  const provider = createXfyunAsrLlmMeetingProvider({
    credentials,
    now: () => new Date('2026-08-07T04:00:00.000Z'),
    randomString: () => 'ABCDEFGHIJKLMNOP',
    pollIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      if (new URL(url).pathname.endsWith('/upload')) {
        return response({
          code: '000000',
          descInfo: 'success',
          content: { orderId: 'order-for-test', taskEstimateTime: 10 }
        });
      }
      return response(finishedResult());
    }
  });
  const gateway = createMeetingSpeechGateway({ provider });
  const result = await gateway.transcribeChunk(request());

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(typeof calls[0].options.headers.signature, 'string');
  assert.ok(calls[0].options.headers.signature.length > 0);
  assert.equal(calls[0].url.searchParams.has('signature'), false);
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ['Content-Length', 'Content-Type', 'signature'].sort());
  assert.deepEqual(Buffer.from(calls[0].options.body), request().chunk.bytes);
  assert.equal(calls[0].url.searchParams.get('roleType'), '0');
  assert.equal(calls[0].url.searchParams.get('audioMode'), 'fileStream');
  assert.equal(calls[0].url.searchParams.get('fileSize'), String(request().chunk.bytes.length));
  assert.equal(calls[0].url.searchParams.get('duration'), '60000');
  assert.equal(calls[0].url.searchParams.get('signatureRandom'), calls[1].url.searchParams.get('signatureRandom'));
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].options.body), {});
  assert.deepEqual(result.segments.map(({ startMs, endMs, text, confidence, speakerRef }) => ({ startMs, endMs, text, confidence, speakerRef })), [
    { startMs: 120, endMs: 1680, text: '项目预算', confidence: null, speakerRef: null }
  ]);
  assert.deepEqual(result.segments[0].sourceChunkRefs, ['source-asset-0']);
  assert.equal(result.lease.orderIdHash.length, 64);
  assert.equal(JSON.stringify(result).includes('order-for-test'), false);
});

test('XFYUN provider enables official role separation only for explicit diarization mode', async () => {
  const calls = [];
  const provider = createXfyunAsrLlmMeetingProvider({
    credentials,
    randomString: () => 'ABCDEFGHIJKLMNOP',
    pollIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return new URL(url).pathname.endsWith('/upload')
        ? response({ code: '000000', content: { orderId: 'order-diarization' } })
        : response(diarizedFinishedResult({ role: 2 }));
    }
  });
  const result = await provider.transcribeChunk({ ...request(), mode: 'diarization', speakerCount: 2 });

  assert.equal(calls[0].url.searchParams.get('roleType'), '1');
  assert.equal(calls[0].url.searchParams.get('roleNum'), '2');
  assert.equal(result.segments[0].providerRole, 2);
  assert.equal(result.segments[0].speakerRef, undefined);
});

test('XFYUN automatic diarization records the actual role request in safe diagnostics', async () => {
  const calls = [];
  const diagnostics = [];
  const provider = createXfyunAsrLlmMeetingProvider({
    credentials,
    randomString: () => 'ABCDEFGHIJKLMNOP',
    pollIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return new URL(url).pathname.endsWith('/upload')
        ? response({ code: '000000', content: { orderId: 'order-diarization-auto' } })
        : response(diarizedFinishedResult({ role: 2 }));
    }
  });
  const result = await provider.transcribeChunk({
    ...request(),
    mode: 'diarization',
    speakerCount: 0,
    traceId: 'diarization-trace-auto',
    diagnostic: { log: async (event) => diagnostics.push(event) }
  });

  assert.equal(calls[0].url.searchParams.get('roleType'), '1');
  assert.equal(calls[0].url.searchParams.get('roleNum'), '0');
  assert.equal(result.segments[0].providerRole, 2);
  assert.deepEqual(diagnostics.map((event) => ({ phase: event.phase, gate: event.gate, providerInvoked: event.providerInvoked, roleType: event.roleType, roleNum: event.roleNum })), [
    { phase: 'xfyun_upload', gate: 'G5', providerInvoked: true, roleType: 1, roleNum: 0 },
    { phase: 'xfyun_get_result', gate: 'G5', providerInvoked: true, roleType: 1, roleNum: 0 }
  ]);
});

test('XFYUN provider normalizes WebM/Opus before upload and does not send original bytes', async () => {
  const calls = [];
  const normalizedBytes = Buffer.from('validated-16k-mono-wav');
  const normalizeCalls = [];
  const provider = createXfyunAsrLlmMeetingProvider({
    credentials,
    randomString: () => 'ABCDEFGHIJKLMNOP',
    pollIntervalMs: 0,
    audioNormalizer: {
      async normalizeChunk(chunk) {
        normalizeCalls.push(chunk);
        return {
          ...chunk,
          bytes: normalizedBytes,
          fileName: 'meeting-smoke.wav',
          mimeType: 'audio/wav',
          format: 'wav',
          normalized: true
        };
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return new URL(url).pathname.endsWith('/upload')
        ? response({ code: '000000', content: { orderId: 'order-normalized' } })
        : response(finishedResult());
    }
  });
  const webmRequest = request();
  webmRequest.chunk = {
    ...webmRequest.chunk,
    bytes: Buffer.from('original-webm-opus-container'),
    fileName: 'iphone-recording.webm',
    mimeType: 'audio/webm;codecs=opus',
    format: 'webm-opus'
  };

  await provider.transcribeChunk(webmRequest);
  assert.equal(normalizeCalls.length, 1);
  assert.deepEqual(Buffer.from(normalizeCalls[0].bytes), webmRequest.chunk.bytes);
  assert.equal(normalizeCalls[0].format, 'webm-opus');
  assert.deepEqual(Buffer.from(calls[0].options.body), normalizedBytes);
  assert.equal(calls[0].url.searchParams.get('fileName'), 'meeting-smoke.wav');
  assert.equal(calls[0].url.searchParams.get('fileSize'), String(normalizedBytes.length));
  assert.equal(calls[0].url.searchParams.get('durationCheckDisable'), 'true');
  assert.equal(calls[0].url.searchParams.has('duration'), false);
});

test('XFYUN provider does not call HTTP when WebM normalization fails', async () => {
  let fetchCalls = 0;
  const provider = createXfyunAsrLlmMeetingProvider({
    credentials,
    audioNormalizer: {
      async normalizeChunk() {
        throw Object.assign(new Error('MEETING_AUDIO_NORMALIZATION_FAILED'), { code: 'MEETING_AUDIO_NORMALIZATION_FAILED' });
      }
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return response({ code: '000000', content: { orderId: 'must-not-be-created' } });
    }
  });
  const webmRequest = request();
  webmRequest.chunk = {
    ...webmRequest.chunk,
    bytes: Buffer.from('original-webm-opus-container'),
    fileName: 'iphone-recording.webm',
    mimeType: 'audio/webm;codecs=opus',
    format: 'webm-opus'
  };
  await assert.rejects(
    provider.transcribeChunk(webmRequest),
    (error) => error.code === 'MEETING_AUDIO_NORMALIZATION_FAILED'
  );
  assert.equal(fetchCalls, 0);
});

test('XFYUN provider reconstructs a continuous WebM source, decodes once, then uploads WAV windows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xfyun-source-provider-test-'));
  const windowPaths = [path.join(root, 'window-0.wav'), path.join(root, 'window-1.wav')];
  await writeFile(windowPaths[0], Buffer.from('wav-window-0'));
  await writeFile(windowPaths[1], Buffer.from('wav-window-1'));
  const calls = [];
  let cleanupCalls = 0;
  try {
    const provider = createXfyunAsrLlmMeetingProvider({
      credentials,
      randomString: () => 'ABCDEFGHIJKLMNOP',
      pollIntervalMs: 0,
      audioNormalizer: {
        async normalizeChunk() {
          throw new Error('chunk normalizer should not be used for source transcription');
        },
        async normalizeSourceFile(input) {
          assert.equal(input.format, 'webm-opus');
          return {
            path: input.inputPath,
            fileName: 'continuous-source.wav',
            mimeType: 'audio/wav',
            format: 'wav',
            normalized: true,
            metadata: { durationMs: 100_073, sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
            async cleanup() { cleanupCalls += 1; }
          };
        },
        async splitWavFile({ normalized }) {
          assert.equal(normalized.format, 'wav');
          return [
            { sequence: 0, startMs: 0, endMs: 60_000, durationMs: 60_000, path: windowPaths[0], fileName: 'window-0.wav', mimeType: 'audio/wav', format: 'wav' },
            { sequence: 1, startMs: 60_000, endMs: 100_073, durationMs: 40_073, path: windowPaths[1], fileName: 'window-1.wav', mimeType: 'audio/wav', format: 'wav' }
          ];
        }
      },
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/upload')) {
          return response({ code: '000000', content: { orderId: `order-window-${calls.length}` } });
        }
        return response(finishedResult());
      }
    });

    const result = await provider.transcribeSource({
      ownerId: 'owner-a',
      meetingId: 'meeting-a',
      sourceId: 'source-a',
      sourceRevision: 1,
      requestId: 'request-source-a',
      attempt: 1,
      sourcePath: path.join(root, 'source.webm'),
      source: { fileName: 'iphone-recording.webm', mimeType: 'audio/webm;codecs=opus', format: 'webm-opus', durationMs: 100_000 },
      sourceChunks: [
        { sourceChunkId: 'segment-0', sequence: 0, durationMs: 20_000 },
        { sourceChunkId: 'segment-1', sequence: 1, durationMs: 20_000 },
        { sourceChunkId: 'segment-2', sequence: 2, durationMs: 20_000 },
        { sourceChunkId: 'segment-3', sequence: 3, durationMs: 20_000 },
        { sourceChunkId: 'segment-4', sequence: 4, durationMs: 20_000 }
      ]
    });

    assert.equal(calls.length, 4);
    assert.deepEqual(Buffer.from(calls[0].options.body), Buffer.from('wav-window-0'));
    assert.deepEqual(Buffer.from(calls[2].options.body), Buffer.from('wav-window-1'));
    assert.equal(calls[0].url.searchParams.get('fileName'), 'window-0.wav');
    assert.equal(calls[2].url.searchParams.get('durationCheckDisable'), 'true');
    assert.deepEqual(result.chunks.map((chunk) => [chunk.sequence, chunk.startMs, chunk.endMs, chunk.sourceChunkRefs]), [
      [0, 0, 60_000, ['segment-0', 'segment-1', 'segment-2']],
      [1, 60_000, 100_073, ['segment-3', 'segment-4']]
    ]);
    assert.equal(result.effectiveDurationMs, 100_073);
    assert.equal(cleanupCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('XFYUN diarization source mode uploads one continuous normalized source to preserve role continuity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xfyun-diarization-source-test-'));
  const normalizedPath = path.join(root, 'continuous.wav');
  await writeFile(normalizedPath, Buffer.from('continuous-wav-for-diarization'));
  const calls = [];
  let cleanupCalls = 0;
  try {
    const provider = createXfyunAsrLlmMeetingProvider({
      credentials,
      randomString: () => 'ABCDEFGHIJKLMNOP',
      pollIntervalMs: 0,
      audioNormalizer: {
        async normalizeChunk() {
          throw new Error('chunk normalizer should not be used for source diarization');
        },
        async normalizeSourceFile() {
          return {
            path: normalizedPath,
            fileName: 'continuous.wav',
            mimeType: 'audio/wav',
            format: 'wav',
            normalized: true,
            metadata: { durationMs: 120_000, sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
            async cleanup() { cleanupCalls += 1; }
          };
        },
        async splitWavFile() {
          throw new Error('diarization must not split the source into independent role sessions');
        }
      },
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return new URL(url).pathname.endsWith('/upload')
          ? response({ code: '000000', content: { orderId: 'order-diarization-source' } })
          : response(diarizedFinishedResult({ role: 3 }));
      }
    });

    const result = await provider.transcribeSource({
      ...request(),
      mode: 'diarization',
      speakerCount: 3,
      sourcePath: path.join(root, 'source.webm'),
      source: { fileName: 'source.webm', mimeType: 'audio/webm;codecs=opus', format: 'webm-opus', durationMs: 120_000 },
      sourceChunks: [{ sourceChunkId: 'segment-0', sequence: 0, durationMs: 120_000 }]
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get('roleType'), '1');
    assert.equal(calls[0].url.searchParams.get('roleNum'), '3');
    assert.equal(calls[0].url.searchParams.get('fileName'), 'continuous.wav');
    assert.deepEqual(result.chunks.map((chunk) => [chunk.startMs, chunk.endMs, chunk.sourceChunkRefs]), [[0, 120_000, ['segment-0']]]);
    assert.equal(result.chunks[0].segments[0].providerRole, 3);
    assert.equal(cleanupCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('XFYUN AAC/MP4 source mode uses decoded duration for the single diarization window', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xfyun-aac-duration-source-test-'));
  const normalizedPath = path.join(root, 'continuous-aac.wav');
  await writeFile(normalizedPath, Buffer.from('continuous-aac-wav-for-duration-contract'));
  const calls = [];
  try {
    const provider = createXfyunAsrLlmMeetingProvider({
      credentials,
      randomString: () => 'ABCDEFGHIJKLMNOP',
      pollIntervalMs: 0,
      audioNormalizer: {
        async normalizeChunk() {
          throw new Error('chunk normalizer should not be used for source diarization');
        },
        async normalizeSourceFile() {
          return {
            path: normalizedPath,
            fileName: 'continuous-aac.wav',
            mimeType: 'audio/wav',
            format: 'wav',
            normalized: true,
            metadata: { durationMs: 49_250, sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
            async cleanup() {}
          };
        },
        async splitWavFile() {
          throw new Error('AAC diarization must not split the source into independent role sessions');
        }
      },
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return new URL(url).pathname.endsWith('/upload')
          ? response({ code: '000000', content: { orderId: 'order-aac-duration' } })
          : response(diarizedFinishedResult({ role: 1 }));
      }
    });

    const result = await provider.transcribeSource({
      ...request(),
      mode: 'diarization',
      speakerCount: 0,
      sourcePath: path.join(root, 'source.m4a'),
      source: { fileName: 'source.m4a', mimeType: 'audio/mp4;codecs=mp4a.40.2', format: 'm4a', durationMs: 48_000 },
      sourceChunks: [{ sourceChunkId: 'segment-0', sequence: 0, durationMs: 48_000 }]
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get('roleType'), '1');
    assert.equal(calls[0].url.searchParams.get('roleNum'), '0');
    assert.equal(result.effectiveDurationMs, 49_250);
    assert.deepEqual(result.chunks.map((chunk) => [chunk.startMs, chunk.endMs, chunk.sourceChunkRefs]), [[0, 49_250, ['segment-0']]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('XFYUN provider fails closed before HTTP when signature generation is empty', async () => {
  let fetchCalls = 0;
  const provider = createXfyunAsrLlmMeetingProvider({
    credentials,
    signatureImpl: () => '',
    fetchImpl: async () => {
      fetchCalls += 1;
      return response({ code: '000000', content: { orderId: 'should-not-be-created' } });
    }
  });
  await assert.rejects(
    provider.transcribeChunk(request()),
    (error) => error.code === 'XFYUN_SIGNATURE_GENERATION_FAILED'
  );
  assert.equal(fetchCalls, 0);
});

test('XFYUN provider retries bounded in-progress polling and keeps the same task correlation', async () => {
  const queryUrls = [];
  let queryCount = 0;
  let sleeps = 0;
  const provider = createXfyunAsrLlmMeetingProvider({
    credentials,
    randomString: () => 'ABCDEFGHIJKLMNOP',
    pollIntervalMs: 1,
    sleepImpl: async () => { sleeps += 1; },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/upload')) return response({ code: '000000', content: { orderId: 'order-poll' } });
      queryUrls.push(parsed);
      queryCount += 1;
      return response(queryCount === 1
        ? { code: '000000', content: { orderInfo: { status: 3, failType: 0 }, orderResult: '' } }
        : finishedResult());
    }
  });

  await provider.transcribeChunk(request());
  assert.equal(sleeps, 1);
  assert.equal(queryUrls.length, 2);
  assert.equal(queryUrls[0].searchParams.get('signatureRandom'), queryUrls[1].searchParams.get('signatureRandom'));
});

test('XFYUN provider exposes official errorCode without leaking credentials', async () => {
  const provider = createXfyunAsrLlmMeetingProvider({
    credentials,
    fetchImpl: async () => response({ code: '100007', descInfo: 'permission denied' })
  });
  await assert.rejects(
    provider.transcribeChunk(request()),
    (error) => {
      assert.equal(error.code, 'XFYUN_PROVIDER_ERROR');
      assert.equal(error.providerErrorCode, '100007');
      assert.equal(error.reason, 'permission denied');
      assert.equal(String(error.message).includes(credentials.accessKeySecret), false);
      return true;
    }
  );
});

test('XFYUN signature uses sorted URL-encoded parameters and HMAC-SHA1', () => {
  const params = { zeta: 'two words', alpha: 'a+b', empty: '' };
  const expectedBase = 'alpha=a%2Bb&zeta=two%20words';
  const expected = createHmac('sha1', credentials.accessKeySecret).update(expectedBase).digest('base64');
  assert.equal(createXfyunSignature(params, credentials.accessKeySecret), expected);
});
